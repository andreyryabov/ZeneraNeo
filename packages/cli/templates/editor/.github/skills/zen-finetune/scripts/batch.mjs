#!/usr/bin/env node
// @ts-check
//
// Build the next batch: the cases the next run of the tuning will work on.
//
// There is no plan of batches drawn up in advance. Each batch is decided when it
// is needed, from what has happened so far:
//
//   size      batch 1 takes minBatch new cases - a smoke test of the project and
//             the loop. Each later batch doubles the size of the one before, up
//             to maxBatch, when that one went smoothly: at most 2 no-memory runs,
//             at most 2 with-memory runs, and no case put on the difficult list.
//             Otherwise it keeps the size it had.
//   new       that many cases from the selection that no batch has used, in
//             selection order - classes in turn, rubric and complex cases first
//   recheck   up to `recheck` cases from earlier batches: open difficult cases
//             first, then fixed difficult ones, then complex cases, then the
//             rest - each group in a seeded random order
//
// When the selection is used up, a batch is made of open difficult cases only,
// up to the size, plus the rechecks. So the whole selection is covered and the
// cases that caused trouble keep coming back until they are fixed, or `stuck`
// after `maxRetries` further batches. When nothing new and nothing open is left,
// the tuning goes to the final check.
//
// It writes the batch's cases.json, and plan.json beside it: the size, which
// cases are new, which are rechecks, and why the size is what it is. A batch is
// built once, for its first no-memory run; every later run of it - no memory or
// with memory - gets a copy of that cases.json, because the difficult list - and
// so the rechecks - moves.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'batch.mjs';

const USAGE = `Build the next batch: the cases the next run of the tuning will work on.

  ${NAME}                                  progress: cases used, left, difficult open
  ${NAME} next -o <run>/cases.json         the next batch, and <run>/plan.json beside it

  -m <size>     new cases in this batch, overriding the growth rule
  -r <count>    recheck cases per batch; default config.json "recheck", else 3
  -o <file>     where to write; default stdout (and no plan.json)
  --seed <n>    default config.json "seed", else 1`;

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const CONFIG = 'finetune/config.json';
const SELECTION = 'finetune/selection.json';
const DATASET = 'finetune/dataset.json';
const DIFFICULT = 'finetune/difficult.json';
const RUNS = 'finetune/runs';
const RUN_NAME = /^batch(\d{2})-(nomem|mem)-run(\d+)$/;
const SEVERITY = ['wrong', 'regressed', 'flaky', 'memory', 'costly'];
// A batch that needed more runs than this, of either kind, does not grow the next one.
const SMOOTH_RUNS = 2;

/** @param {string} msg @param {number} [code] @returns {never} */
function die(msg, code = 2) {
    console.error(`${NAME}: ${msg}`);
    process.exit(code);
}

/** @param {string} path @returns {any} */
function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

let mode = 'status';
/** @type {number | undefined} */
let size;
/** @type {number | undefined} */
let recheck;
/** @type {number | undefined} */
let seed;
let out = '';

const argv = process.argv.slice(2);
/** @param {string} flag @returns {string} */
const value = (flag) => argv.shift() ?? die(`${flag} needs a value`);
/** @param {string} flag @returns {number} */
const whole = (flag) => {
    const raw = value(flag);
    if (!/^\d+$/.test(raw)) {
        die(`${flag} takes a whole number`);
    }
    return Number(raw);
};

while (argv.length > 0) {
    const arg = /** @type {string} */ (argv.shift());
    switch (arg) {
        case 'next':
            mode = 'next';
            break;
        case '-m':
            size = whole('-m');
            break;
        case '-r':
            recheck = whole('-r');
            break;
        case '-o':
            out = value('-o');
            break;
        case '--seed':
            seed = whole('--seed');
            break;
        case '-h':
        case '--help':
            console.log(USAGE);
            process.exit(0);
            break;
        default:
            console.error(`${NAME}: unknown argument ${arg}`);
            console.error(USAGE);
            process.exit(2);
    }
}

/** @type {{ id: string }[]} */
const selection = json(SELECTION)?.batch ?? die(`no ${SELECTION} - run select.mjs first`);

const config = json(CONFIG) ?? {};
/** @param {string} key @param {number} fallback @returns {number} */
const cfg = (key, fallback) => {
    const n = Number(config[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MIN = cfg('minBatch', 3);
const MAX = Math.max(MIN, cfg('maxBatch', 10));
const RECHECK = recheck ?? (Number.isFinite(Number(config.recheck)) ? Number(config.recheck) : 3);
const SEED = seed ?? cfg('seed', 1);
const MAX_RETRIES = cfg('maxRetries', 3);

if (size !== undefined && size < 1) {
    die('-m must be at least 1');
}

/** @type {Map<string, string>} */
const complexity = new Map(
    (json(DATASET)?.cases ?? json(DATASET)?.samples ?? []).map(
        (/** @type {{ id: string, complexity?: string }} */ c) => [c.id, c.complexity ?? ''],
    ),
);

// ---------------------------------------------------------------------------
// What has happened so far
// ---------------------------------------------------------------------------

/** @type {string[]} */
const names = (() => {
    try {
        return readdirSync(RUNS);
    } catch {
        return [];
    }
})();

/** @param {string} dir @returns {string} the verdict heading of a run's findings.md */
function verdict(dir) {
    const path = join(dir, 'findings.md');
    const match = existsSync(path)
        ? /^## ([A-Z][A-Z ]*[A-Z])/m.exec(readFileSync(path, 'utf8'))
        : null;
    return match ? match[1].trimEnd() : '';
}

/**
 * The case ids of every batch, by batch number, read off its first no-memory run.
 *
 * @type {Map<number, string[]>}
 */
const done = new Map();
for (const name of names) {
    const m = RUN_NAME.exec(name);
    if (m && m[2] === 'nomem' && +m[3] === 1) {
        const ids = json(join(RUNS, name, 'cases.json'))?.batch?.map(
            (/** @type {{ id: string }} */ c) => c.id,
        );
        if (ids) {
            done.set(+m[1], ids);
        }
    }
}

const number = done.size === 0 ? 1 : Math.max(...done.keys()) + 1;
const used = new Set([...done.values()].flat());
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** @param {string} run @returns {number} */
const batchOf = (run) => Number(RUN_NAME.exec(run)?.[1] ?? 0);

/**
 * @typedef {{ id: string, reasons: string[], added: string, fixed?: string }} Entry
 */

/** How many batches since it was added have held it; `maxRetries` of them is stuck. */
const retries = (/** @type {Entry} */ e) =>
    [...done.entries()].filter(([n, ids]) => n > batchOf(e.added) && ids.includes(e.id)).length;

/** @type {Entry[]} */
const listed = json(DIFFICULT)?.cases ?? [];
const worst = (/** @type {Entry} */ e) => Math.min(...e.reasons.map((r) => SEVERITY.indexOf(r)));
const open = listed
    .filter((e) => !e.fixed && retries(e) < MAX_RETRIES)
    .sort((a, b) => worst(a) - worst(b) || retries(a) - retries(b) || a.id.localeCompare(b.id));
const fixed = listed.filter((e) => e.fixed);
const stuck = listed.filter((e) => !e.fixed && retries(e) >= MAX_RETRIES);

const unused = selection.filter((c) => !used.has(c.id));

/**
 * The size of batch `n`, and why. Batch 1 is the smoke test. A later batch
 * doubles the one before when that one went smoothly, and keeps its size when
 * it did not.
 *
 * @param {number} n
 * @returns {{ size: number, why: string }}
 */
function sizeOf(n) {
    if (n === 1) {
        return { size: MIN, why: `batch 1 is the smoke test: minBatch ${MIN}` };
    }
    const prev = n - 1;
    const plan = json(join(RUNS, `batch${pad(prev)}-nomem-run1`, 'plan.json'));
    const was = Number(plan?.size) || MIN;
    /** @param {string} kind */
    const runs = (kind) =>
        names.filter((name) => {
            const m = RUN_NAME.exec(name);
            return m && +m[1] === prev && m[2] === kind && verdict(join(RUNS, name)) !== 'VOID';
        }).length;
    const nomem = runs('nomem');
    const mem = runs('mem');
    const added = listed.filter((e) => batchOf(e.added) === prev && !e.fixed).length;
    if (nomem <= SMOOTH_RUNS && mem <= SMOOTH_RUNS && added === 0) {
        const grown = Math.min(MAX, was * 2);
        return {
            size: grown,
            why:
                grown > was
                    ? `batch ${prev} went smoothly (${nomem} no-memory + ${mem} with-memory runs, no new difficult case): ${was} -> ${grown}`
                    : `batch ${prev} went smoothly; already at maxBatch ${MAX}`,
        };
    }
    return {
        size: was,
        why: `batch ${prev} did not go smoothly (${nomem} no-memory + ${mem} with-memory runs, ${added} difficult case(s) added and open): stays at ${was}`,
    };
}

const planned = size !== undefined ? { size, why: `set by -m ${size}` } : sizeOf(number);

if (mode === 'status') {
    console.log(`selection     ${selection.length} cases`);
    console.log(`used          ${used.size}, ${unused.length} not yet in any batch`);
    console.log(`batches       ${done.size} built`);
    console.log(`next size     ${planned.size} - ${planned.why}`);
    console.log(
        `difficult     ${open.length} open · ${fixed.length} fixed · ${stuck.length} stuck`,
    );
    console.log(
        `ahead         at least ${Math.ceil(unused.length / MAX)} more batch(es) for new cases` +
            (open.length ? `, plus what the ${open.length} open difficult case(s) need` : ''),
    );
    process.exit(0);
}

// ---------------------------------------------------------------------------
// The next batch
// ---------------------------------------------------------------------------

/**
 * `n` successive Lehmer values, s * 48271 mod 2^31-1: exact in a double, so the
 * same draw on every machine.
 *
 * @param {number} start
 * @param {number} n
 */
function keys(start, n) {
    const out = [];
    let s = start;
    for (let i = 0; i < n; i++) {
        s = (s * 48271) % 2147483647;
        out.push(s);
    }
    return out;
}

const byId = new Map(selection.map((c) => [c.id, c]));
const target = out || '-';
/** @type {{ id: string }[]} */
let fresh = [];
let kind = 'new';

if (unused.length > 0) {
    fresh = unused.slice(0, planned.size);
} else {
    fresh = open
        .slice(0, planned.size)
        .map((e) => byId.get(e.id))
        .filter((c) => c !== undefined);
    kind = 'difficult';
}
if (fresh.length === 0) {
    die(
        'nothing left: no unused cases and no open difficult ones' +
            (stuck.length ? ` (${stuck.length} stuck)` : '') +
            ' - run the final check',
        1,
    );
}

const inBatch = new Set(fresh.map((c) => c.id));
const pool = [...used].filter((id) => !inBatch.has(id) && byId.has(id));
const drawKeys = keys(((SEED * 7919 + number * 104729) % 2147483646) + 1, pool.length);
const order = new Map(pool.map((id, i) => [id, drawKeys[i]]));
const first = [...open, ...fixed].map((e) => e.id).filter((id) => order.has(id));
const rest = pool
    .filter((id) => !first.includes(id))
    .sort(
        (a, b) =>
            Number(complexity.get(b) === 'complex') - Number(complexity.get(a) === 'complex') ||
            /** @type {number} */ (order.get(a)) - /** @type {number} */ (order.get(b)),
    );
const rechecked = [...first, ...rest]
    .slice(0, RECHECK)
    .map((id) => /** @type {{ id: string }} */ (byId.get(id)));

const body = `${JSON.stringify({ batch: [...fresh, ...rechecked] }, null, 2)}\n`;
if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, body);
    // Beside cases.json, never inside it: `zen run batch` allows nothing else there.
    const plan = {
        batch: number,
        size: planned.size,
        why: planned.why,
        kind,
        new: fresh.map((c) => c.id),
        recheck: rechecked.map((c) => c.id),
    };
    writeFileSync(join(dirname(out), 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
} else {
    process.stdout.write(body);
}

// On stderr so it survives a redirect of stdout.
const left = kind === 'new' ? unused.length - fresh.length : 0;
console.error('');
console.error(`${NAME}: batch ${number} -> ${target}`);
console.error(`  size      ${planned.size} - ${planned.why}`);
console.error(
    `  ${kind === 'new' ? 'new      ' : 'difficult'} ${fresh.map((c) => c.id).join(' ')}`,
);
console.error(
    `  recheck   ${rechecked.length ? rechecked.map((c) => c.id).join(' ') : '(none - nothing used yet)'}`,
);
console.error(
    `  after it: ${left} unused case(s), ${open.length} difficult open` +
        (existsSync(DIFFICULT) ? '' : ' (no difficult.json yet)'),
);
if (out && !RUN_NAME.test(dirname(out).split(/[\\/]/).pop() ?? '')) {
    console.error(
        `  warning: ${dirname(out)} is not named batch<NN>-nomem-run1 - next.mjs will not see it`,
    );
} else if (out && dirname(out).split(/[\\/]/).pop() !== `batch${pad(number)}-nomem-run1`) {
    console.error(
        `  warning: this is batch ${number}; write it to batch${pad(number)}-nomem-run1/`,
    );
}
