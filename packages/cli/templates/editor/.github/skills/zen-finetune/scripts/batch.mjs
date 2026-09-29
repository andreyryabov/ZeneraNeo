#!/usr/bin/env node
// @ts-check
//
// Build the next batch: the cases the next run of the tuning will work on.
//
// There is no plan of batches drawn up in advance. Each batch is decided when it
// is needed, from what has happened so far:
//
//   new       up to batchSize cases from the selection that no batch has used,
//             taken in selection order - which already takes classes in turn
//   recheck   up to `recheck` cases from earlier batches: open difficult cases
//             first, then fixed difficult ones, then a seeded random draw
//
// When the selection is used up, a batch is made of open difficult cases only,
// up to batchSize, plus the rechecks. So the whole selection is covered and the
// cases that caused trouble keep coming back until they are fixed, or `stuck`
// after `maxRetries` further batches. When nothing new and nothing open is left,
// the stage is over.
//
// Stage 2 replays the stage-1 batches in order, so each is compared against the
// same cases, then adds batches for its own open difficult cases.
//
// A batch is built once, for its run 1; every later run of it gets a copy of run
// 1's cases.json, because the difficult list - and so the rechecks - moves.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'batch.mjs';

const USAGE = `Build the next batch: the cases the next run of the tuning will work on.

  ${NAME}                                  progress: cases used, left, difficult open
  ${NAME} next -o <file>                   the next stage-1 batch
  ${NAME} next --stage 2 -o <file>         the next stage-2 batch

  -m <size>     new cases per batch; default config.json "batchSize", else 8
  -r <count>    recheck cases per batch; default config.json "recheck", else 3
  -o <file>     where to write; default stdout
  --seed <n>    default config.json "seed", else 1`;

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const CONFIG = '.finetune/config.json';
const SELECTION = '.finetune/selection.json';
const DIFFICULT = '.finetune/difficult.json';
const RUNS = '.finetune/runs';
const RUN_NAME = /^stage([12])-batch(\d{2})-run(\d+)$/;
const SEVERITY = ['wrong', 'regressed', 'flaky', 'costly'];

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
let stage = 1;
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
        case '--stage':
            stage = whole('--stage');
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

if (stage !== 1 && stage !== 2) {
    die('--stage is 1 or 2');
}

/** @type {{ id: string }[]} */
const selection = json(SELECTION)?.batch ?? die(`no ${SELECTION} - run select.mjs first`);

const config = json(CONFIG) ?? {};
/** @param {string} key @param {number} fallback @returns {number} */
const cfg = (key, fallback) => {
    const n = Number(config[key]);
    return Number.isFinite(n) ? n : fallback;
};
const SIZE = size ?? cfg('batchSize', 8);
const RECHECK = recheck ?? cfg('recheck', 3);
const SEED = seed ?? cfg('seed', 1);
const MAX_RETRIES = cfg('maxRetries', 3);

if (SIZE < 1) {
    die('-m must be at least 1');
}

// ---------------------------------------------------------------------------
// What has happened so far
// ---------------------------------------------------------------------------

/**
 * The case ids of every batch of `s`, by batch number, read off run 1.
 *
 * @param {number} s
 * @returns {Map<number, string[]>}
 */
function batches(s) {
    /** @type {Map<number, string[]>} */
    const found = new Map();
    /** @type {string[]} */
    let names = [];
    try {
        names = readdirSync(RUNS);
    } catch {
        names = [];
    }
    for (const name of names) {
        const m = RUN_NAME.exec(name);
        if (m && +m[1] === s && +m[3] === 1) {
            const ids = json(join(RUNS, name, 'cases.json'))?.batch?.map(
                (/** @type {{ id: string }} */ c) => c.id,
            );
            if (ids) {
                found.set(+m[2], ids);
            }
        }
    }
    return found;
}

const done = batches(stage);
const number = done.size === 0 ? 1 : Math.max(...done.keys()) + 1;
const used = new Set([...batches(1).values()].flat());

/** @param {string} run @returns {number} */
const batchOf = (run) => Number(RUN_NAME.exec(run)?.[2] ?? 0);

/**
 * @typedef {{ id: string, stage: number, reasons: string[], added: string,
 *             fixed?: string }} Entry
 */

/** How many batches since it was added have held it; `maxRetries` of them is stuck. */
const retries = (/** @type {Entry} */ e) =>
    [...done.entries()].filter(([n, ids]) => n > batchOf(e.added) && ids.includes(e.id)).length;

/** @type {Entry[]} */
const listed = (json(DIFFICULT)?.cases ?? []).filter((/** @type {Entry} */ e) => e.stage === stage);
const worst = (/** @type {Entry} */ e) => Math.min(...e.reasons.map((r) => SEVERITY.indexOf(r)));
const open = listed
    .filter((e) => !e.fixed && retries(e) < MAX_RETRIES)
    .sort((a, b) => worst(a) - worst(b) || retries(a) - retries(b) || a.id.localeCompare(b.id));
const fixed = listed.filter((e) => e.fixed);
const stuck = listed.filter((e) => !e.fixed && retries(e) >= MAX_RETRIES);

const unused = selection.filter((c) => !used.has(c.id));

if (mode === 'status') {
    const stage1 = batches(1).size;
    console.log(`selection     ${selection.length} cases`);
    console.log(`used          ${used.size}, ${unused.length} not yet in any batch`);
    console.log(`batches       stage 1: ${stage1}, stage 2: ${batches(2).size}`);
    console.log(
        `difficult     ${open.length} open · ${fixed.length} fixed · ${stuck.length} stuck (stage ${stage})`,
    );
    console.log(
        `ahead         at least ${Math.ceil(unused.length / SIZE)} more stage-1 batch(es) for new cases`,
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

const replay = stage === 2 ? batches(1).get(number) : undefined;
if (replay) {
    const source = join(RUNS, `stage1-batch${String(number).padStart(2, '0')}-run1`, 'cases.json');
    if (out) {
        mkdirSync(dirname(resolve(out)), { recursive: true });
        cpSync(source, out);
    } else {
        process.stdout.write(readFileSync(source, 'utf8'));
    }
    console.error(`${NAME}: stage-2 batch ${number} replays stage-1 batch ${number} -> ${target}`);
    process.exit(0);
}

if (stage === 1 && unused.length > 0) {
    fresh = unused.slice(0, SIZE);
} else {
    fresh = open
        .slice(0, SIZE)
        .map((e) => byId.get(e.id))
        .filter((c) => c !== undefined);
    kind = 'difficult';
}
if (fresh.length === 0) {
    die(
        `stage ${stage} has nothing left: no unused cases and no open difficult ones` +
            (stuck.length ? ` (${stuck.length} stuck)` : ''),
        1,
    );
}

const inBatch = new Set(fresh.map((c) => c.id));
const pool = [...used].filter((id) => !inBatch.has(id) && byId.has(id));
const first = [...open, ...fixed].map((e) => e.id).filter((id) => pool.includes(id));
const drawKeys = keys(((SEED * 7919 + stage * 7 + number * 104729) % 2147483646) + 1, pool.length);
const drawn = pool
    .map((id, i) => ({ id, key: drawKeys[i] }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.id)
    .filter((id) => !first.includes(id));
const rechecked = [...first, ...drawn]
    .slice(0, RECHECK)
    .map((id) => /** @type {{ id: string }} */ (byId.get(id)));

const body = `${JSON.stringify({ batch: [...fresh, ...rechecked] }, null, 2)}\n`;
if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, body);
} else {
    process.stdout.write(body);
}

// On stderr so it survives a redirect of stdout.
const left = kind === 'new' ? unused.length - fresh.length : 0;
console.error('');
console.error(`${NAME}: stage-${stage} batch ${number} -> ${target}`);
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
