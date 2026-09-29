#!/usr/bin/env node
// @ts-check
//
// Keep the list of difficult cases: the ones that caused the most trouble.
//
// A case goes on the list when grading shows it is hard for the project - it
// stayed wrong after a fix, it broke as a recheck case, it flipped between right
// and wrong on the same prose, or it costs far more than its batch. batch.mjs
// puts open cases first in every later batch's rechecks, and fills whole batches
// with them once the selection is used up, until they are fixed; fixed ones stay
// ahead of the random rechecks, because what was hard once breaks again first.
//
// A case is `stuck` once `maxRetries` batches (config.json, default 3) have held
// it since it was added, without it being fixed: that is the model's ceiling or a
// rubric problem, and it is reported rather than retried forever.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md, "Difficult cases".

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'difficult.mjs';

const REASONS = ['wrong', 'regressed', 'flaky', 'costly'];

const USAGE = `Keep the list of difficult cases: the ones that caused the most trouble.

  ${NAME}                                      the list: status, reasons, retries
  ${NAME} add <id...> --why <reason> --run <run> [--note <text>]
  ${NAME} fix <id...> --run <run>

  reasons   wrong       still wrong after a run that tried to fix it
            regressed   a recheck case that failed
            flaky       right in one run, wrong in a later run of the same cases
            costly      over 2x the batch's median llm calls in its passing run

  status    open        comes first in every later batch until fixed
            fixed       right in a PASSED run; still preferred as a recheck case
            stuck       open after maxRetries batches; reported, not retried`;

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const FILE = '.finetune/difficult.json';
const CONFIG = '.finetune/config.json';
const RUNS = '.finetune/runs';
const RUN_NAME = /^stage([12])-batch(\d{2})-run(\d+)$/;

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

/**
 * @typedef {{ id: string, stage: number, reasons: string[], added: string,
 *             notes: string[], fixed?: string }} Entry
 */

/** @type {{ cases: Entry[] }} */
const doc = json(FILE) ?? { cases: [] };
const maxRetries = Number(json(CONFIG)?.maxRetries) || 3;

/**
 * How many batches of the entry's stage have held it since it was added, read
 * off the run 1 of every batch.
 *
 * @param {Entry} e
 * @returns {number}
 */
function retries(e) {
    const since = Number(RUN_NAME.exec(e.added)?.[2] ?? 0);
    /** @type {string[]} */
    let names = [];
    try {
        names = readdirSync(RUNS);
    } catch {
        names = [];
    }
    let count = 0;
    for (const name of names) {
        const m = RUN_NAME.exec(name);
        if (!m || +m[1] !== e.stage || +m[3] !== 1 || +m[2] <= since) {
            continue;
        }
        const ids = (json(join(RUNS, name, 'cases.json'))?.batch ?? []).map(
            (/** @type {{ id: string }} */ c) => c.id,
        );
        if (ids.includes(e.id)) {
            count++;
        }
    }
    return count;
}

/** @param {Entry} e @returns {'open' | 'fixed' | 'stuck'} */
function status(e) {
    if (e.fixed) {
        return 'fixed';
    }
    return retries(e) >= maxRetries ? 'stuck' : 'open';
}

function save() {
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(tmp, FILE);
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? /** @type {string} */ (argv.shift()) : 'list';

/** @type {string[]} */
const ids = [];
let why = '';
let run = '';
let note = '';
while (argv.length > 0) {
    const arg = /** @type {string} */ (argv.shift());
    const value = () => argv.shift() ?? die(`${arg} needs a value`);
    if (arg === '--why') {
        why = value();
    } else if (arg === '--run') {
        run = value();
    } else if (arg === '--note') {
        note = value();
    } else if (arg === '-h' || arg === '--help') {
        console.log(USAGE);
        process.exit(0);
    } else if (arg.startsWith('-')) {
        die(`unknown flag ${arg}`);
    } else {
        ids.push(arg);
    }
}

if (command === 'add' || command === 'fix') {
    if (ids.length === 0) {
        die(`${command} needs at least one case id`);
    }
    const m = RUN_NAME.exec(run);
    if (!m) {
        die('--run must name a run, e.g. stage1-batch03-run2');
    }
    if (!existsSync(join(RUNS, run))) {
        die(`no ${RUNS}/${run}`);
    }
    const stage = +m[1];

    if (command === 'add') {
        if (!REASONS.includes(why)) {
            die(`--why must be one of: ${REASONS.join(', ')}`);
        }
        for (const id of ids) {
            const held = doc.cases.find((e) => e.id === id && e.stage === stage);
            if (held) {
                held.reasons = [...new Set([...held.reasons, why])];
                // Back on the list after a fix: it was not fixed, and its retries start again.
                if (held.fixed) {
                    delete held.fixed;
                    held.added = run;
                }
                if (note) {
                    held.notes.push(`${run}: ${note}`);
                }
            } else {
                doc.cases.push({
                    id,
                    stage,
                    reasons: [why],
                    added: run,
                    notes: note ? [`${run}: ${note}`] : [],
                });
            }
        }
    } else {
        for (const id of ids) {
            const held = doc.cases.find((e) => e.id === id && e.stage === stage);
            if (!held) {
                die(`${id} is not on the stage-${stage} list`);
            }
            held.fixed = run;
        }
    }
    save();
    console.error(`${NAME}: ${command === 'add' ? 'added' : 'fixed'} ${ids.join(' ')}`);
    process.exit(0);
}

if (command !== 'list') {
    console.error(`${NAME}: unknown command ${command}`);
    console.error(USAGE);
    process.exit(2);
}

if (doc.cases.length === 0) {
    console.log('no difficult cases yet');
    process.exit(0);
}

const rows = doc.cases.map((e) => [
    e.id,
    String(e.stage),
    status(e),
    e.reasons.join(','),
    String(retries(e)),
    e.added,
    e.fixed ?? '-',
]);
const header = ['CASE', 'STAGE', 'STATUS', 'WHY', 'RETRIES', 'ADDED', 'FIXED'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const row of [header, ...rows]) {
    console.log(
        row
            .map((cell, i) => cell.padEnd(widths[i]))
            .join('  ')
            .trimEnd(),
    );
}
const count = (/** @type {string} */ s) => doc.cases.filter((e) => status(e) === s).length;
console.log('');
console.log(
    `${count('open')} open · ${count('fixed')} fixed · ${count('stuck')} stuck (max ${maxRetries} retries)`,
);
