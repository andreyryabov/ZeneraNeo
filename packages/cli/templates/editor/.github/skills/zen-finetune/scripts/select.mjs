#!/usr/bin/env node
// @ts-check
//
// Choose the cases this tuning will use: up to the limit, out of the whole dataset.
//
// The dataset is every case the training set holds and is never cut down. This
// is where the limit is applied, and it is applied evenly by class: one case
// from each class in turn, so a limit of 12 over 4 classes is 3 of each, not
// the first 12 in the file. Inside a class the picks rotate across complexity
// levels, and cases with a rubric come first, because a graded case says why it
// failed and an ungraded one only says what it did. A class that runs out stops
// taking turns and the others carry on.
//
// Deterministic: the same --seed over the same dataset chooses the same cases,
// so an interrupted session rebuilds the same selection.
//
// Writes { "batch": [ {id, input} ] } - the shape `zen run batch --input` takes,
// though it is not run as one: batch.mjs takes it a batch at a time.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'select.mjs';

const USAGE = `Choose the cases this tuning will use: up to the limit, out of the whole dataset.

  ${NAME} -o .finetune/selection.json         the limit from config.json
  ${NAME} -n 40 -o .finetune/selection.json   forty, evenly by class
  ${NAME} -n 12 --class planning              twelve out of one class, to stdout

  -d <file>           dataset; default .finetune/dataset.json
  -n, --limit <n>     how many cases; default config.json "limit", else all
  -o <file>           where to write; default stdout
  --class <name>      one class only
  --complexity <lvl>  one complexity level only
  --rubric-only       only cases that have a rubric
  --seed <n>          default config.json "seed", else 1`;

const CONFIG = '.finetune/config.json';
const LEVELS = ['simple', 'medium', 'complex'];

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

/** @param {string} msg @param {number} [code] @returns {never} */
function die(msg, code = 2) {
    console.error(`${NAME}: ${msg}`);
    process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

let dataset = '.finetune/dataset.json';
/** @type {number | undefined} */
let limit;
let klass = '';
let complexity = '';
let rubricOnly = false;
/** @type {number | undefined} */
let seed;
let out = '';

const argv = process.argv.slice(2);
/** @param {string} flag @returns {string} */
const next = (flag) => {
    const value = argv.shift();
    if (value === undefined) {
        die(`${flag} needs a value`);
    }
    return value;
};
/** @param {string} flag @returns {number} */
const whole = (flag) => {
    const raw = next(flag);
    if (!/^\d+$/.test(raw)) {
        die(`${flag} takes a whole number`);
    }
    return Number(raw);
};

while (argv.length > 0) {
    const arg = /** @type {string} */ (argv.shift());
    switch (arg) {
        case '-d':
            dataset = next('-d');
            break;
        case '-n':
        case '--limit':
            limit = whole(arg);
            break;
        case '-o':
            out = next('-o');
            break;
        case '--class':
            klass = next('--class');
            break;
        case '--complexity':
            complexity = next('--complexity');
            break;
        case '--rubric-only':
            rubricOnly = true;
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

/** @type {Record<string, unknown>} */
const config = (() => {
    try {
        return JSON.parse(readFileSync(CONFIG, 'utf8'));
    } catch {
        return {};
    }
})();
/** @param {string} key @param {number} fallback @returns {number} */
const cfg = (key, fallback) => {
    const value = Number(config[key]);
    return Number.isFinite(value) ? value : fallback;
};
const LIMIT = limit ?? cfg('limit', 0);
const SEED = seed ?? cfg('seed', 1);

/**
 * @typedef {{ id?: unknown, input?: unknown, class?: string, complexity?: string,
 *             rubric?: string[] }} Case
 */

/** @type {{ cases?: Case[], samples?: Case[] }} */
let doc;
try {
    doc = JSON.parse(readFileSync(dataset, 'utf8'));
} catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        console.error(`${NAME}: no ${dataset}`);
        console.error('  build it first: see .github/skills/zen-finetune/SKILL.md, phase 1');
        process.exit(2);
    }
    die(`${dataset} is not valid JSON: ${/** @type {Error} */ (err).message}`);
}

// `samples` is the key datasets were written with before the rename.
const cases = doc.cases ?? doc.samples;
if (!Array.isArray(cases) || cases.length === 0) {
    die(`${dataset} has no non-empty "cases" array`);
}

// ---------------------------------------------------------------------------
// The dataset has to be sound before anything is chosen from it. An id names a
// directory under the batch dir, and `zen run batch` refuses a bad one item by
// item, halfway through a long run. Refuse it here instead, all at once.
// ---------------------------------------------------------------------------

/** @param {string[]} ids @param {string} headline @param {string} [hint] */
const refuse = (ids, headline, hint) => {
    if (ids.length === 0) {
        return;
    }
    console.error(`${NAME}: ${headline}`);
    for (const id of ids) {
        console.error(`  ${id}`);
    }
    if (hint) {
        console.error(`  ${hint}`);
    }
    process.exit(2);
};

refuse(
    cases
        .filter(
            (c) =>
                typeof c.id !== 'string' ||
                !/^[A-Za-z0-9_.-]+$/.test(c.id) ||
                c.id === '.' ||
                c.id === '..',
        )
        .map((c) => String(c.id)),
    'these ids cannot name a directory:',
    'letters, digits, dot, dash and underscore only',
);

const seen = new Set();
const dupes = new Set();
for (const c of cases) {
    const id = String(c.id);
    if (seen.has(id)) {
        dupes.add(id);
    }
    seen.add(id);
}
refuse([...dupes], `duplicate ids in ${dataset}:`);

refuse(
    cases.filter((c) => c.input === null || c.input === undefined).map((c) => String(c.id)),
    'these cases have no "input":',
);

// ---------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------

/** @param {Case} c */
const classOf = (c) => c.class ?? 'unclassified';
/** @param {Case} c */
const levelOf = (c) => c.complexity ?? 'unrated';
/** @param {Case} c */
const graded = (c) => (c.rubric ?? []).length > 0;

const matching = cases.filter(
    (c) =>
        (klass === '' || classOf(c) === klass) &&
        (complexity === '' || levelOf(c) === complexity) &&
        (!rubricOnly || graded(c)),
);

// Lehmer's generator, s * 48271 mod 2^31-1: exact in a double, so the same order
// on every machine.
let state = (SEED % 2147483646) + 1;
const key = new Map(
    matching.map((c) => {
        state = (state * 48271) % 2147483647;
        return [c, state];
    }),
);

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} by
 * @returns {Map<string, T[]>}
 */
function groupBy(items, by) {
    /** @type {Map<string, T[]>} */
    const groups = new Map();
    for (const item of items) {
        const name = by(item);
        groups.set(name, [...(groups.get(name) ?? []), item]);
    }
    return groups;
}

/**
 * Take one from each list in turn until every list is empty.
 *
 * @template T
 * @param {T[][]} lists
 * @returns {T[]}
 */
function roundRobin(lists) {
    const out = [];
    const deepest = lists.reduce((max, l) => Math.max(max, l.length), 0);
    for (let i = 0; i < deepest; i++) {
        for (const list of lists) {
            if (i < list.length) {
                out.push(list[i]);
            }
        }
    }
    return out;
}

/** @param {string} a @param {string} b */
const byLevel = (a, b) => {
    const rank = (/** @type {string} */ l) => (LEVELS.includes(l) ? LEVELS.indexOf(l) : 99);
    return rank(a) - rank(b) || a.localeCompare(b);
};

const byClass = groupBy(matching, classOf);
const ordered = roundRobin(
    [...byClass.keys()].sort().map((name) => {
        const byLevelGroups = groupBy(/** @type {Case[]} */ (byClass.get(name)), levelOf);
        return roundRobin(
            [...byLevelGroups.keys()]
                .sort(byLevel)
                .map((level) =>
                    /** @type {Case[]} */ (byLevelGroups.get(level)).sort(
                        (a, b) =>
                            Number(graded(b)) - Number(graded(a)) ||
                            /** @type {number} */ (key.get(a)) - /** @type {number} */ (key.get(b)),
                    ),
                ),
        );
    }),
);

const chosen = LIMIT > 0 ? ordered.slice(0, LIMIT) : ordered;

if (chosen.length === 0) {
    console.error(`${NAME}: nothing matched`);
    console.error('  the filters may be narrower than the dataset; what is in it:');
    for (const line of tally(cases.map((c) => `${classOf(c)} / ${levelOf(c)}`))) {
        console.error(line);
    }
    process.exit(1);
}

// Only `id` and `input`: a rubric is not part of a run request, and the dataset
// stays the one place it is written down.
const body = `${JSON.stringify({ batch: chosen.map(({ id, input }) => ({ id, input })) }, null, 2)}\n`;

if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, body);
} else {
    process.stdout.write(body);
}

// On stderr so it survives a redirect of stdout.
console.error('');
console.error(
    `${NAME}: ${chosen.length} of ${cases.length} cases, seed ${SEED}${out ? ` -> ${out}` : ''}`,
);
console.error('');
console.error('  class                    chosen / in dataset');
const inDataset = groupBy(cases, classOf);
const inChoice = groupBy(chosen, classOf);
for (const name of [...inDataset.keys()].sort()) {
    const got = inChoice.get(name)?.length ?? 0;
    const has = inDataset.get(name)?.length ?? 0;
    console.error(`  ${name.padEnd(24)} ${String(got).padStart(6)} / ${has}`);
}
console.error('');
console.error(`  ${chosen.filter(graded).length} of ${chosen.length} have a rubric`);

/**
 * Counts per distinct line, sorted: `sort | uniq -c`.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function tally(lines) {
    return [...groupBy(lines, (l) => l).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([line, all]) => `${String(all.length).padStart(6)}  ${line}`);
}
