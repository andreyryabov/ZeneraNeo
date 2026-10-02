#!/usr/bin/env node
// @ts-check
//
// Say what to do next in the fine-tuning, read off .finetune/.
//
// This is how an interrupted session finds its place. Everything it reads is on
// disk - the dataset, the config, the selection, the README, the difficult list,
// the memory pointers, every run directory and the verdict heading of every
// findings.md - so it never guesses.
//
// Every batch goes the same way:
//
//   no-memory runs     run, grade, fix the prose, run again - until one PASSES
//   memory.mjs candidate   last good memory + what that run's cases committed
//   with-memory runs   every case from its own copy of the candidate; grade the
//                      memory use, fix the memory policy, run again - until one PASSES
//   memory.mjs checkpoint  the candidate becomes the last good memory
//   the next batch
//
// A PASSED is only accepted from a run whose findings.md has the review its kind
// needs - `## Cost review` without memory, `## Memory review` with it - and which
// applied no edits of its own (no changes.md): edits are a guess until the next
// run confirms them. Each kind gets at most MAX_RUNS runs per batch.
//
// The number of batches is not fixed: the tuning goes on while the selection has
// unused cases or the difficult list has open ones.
//
// When .finetune/README.md is older than the newest thing a run wrote, it says
// so first: the README is written by hand and is only useful if it is current.
//
// Run directories are `batch<NN>-<nomem|mem>-run<N>`; anything else is ignored.
// Run it from anywhere; it finds the project root from its own location.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'next.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

for (const arg of process.argv.slice(2)) {
    if (arg === '-h' || arg === '--help') {
        console.log(`Say what to do next in the fine-tuning, read off .finetune/.\n\n  ${NAME}`);
        process.exit(0);
    }
    console.error(`${NAME}: unknown argument ${arg}`);
    process.exit(2);
}

const DATASET = '.finetune/dataset.json';
const CONFIG = '.finetune/config.json';
const SELECTION = '.finetune/selection.json';
const README = '.finetune/README.md';
const DIFFICULT = '.finetune/difficult.json';
const LAST_GOOD = '.finetune/memory/last-good.json';
const CANDIDATE = '.finetune/memory/candidate.json';
const RUNS = '.finetune/runs';
const FINAL = `${RUNS}/final-check`;
const SCRIPTS = '.github/skills/zen-finetune/scripts';
const MAX_RUNS = 4;
const RUN_NAME = /^batch(\d{2})-(nomem|mem)-run(\d+)$/;

/** @param {string} path @returns {any} */
function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

/** @param {string} path @returns {number} */
const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);

const datasetDoc = json(DATASET);
const datasetSize = (datasetDoc?.cases ?? datasetDoc?.samples ?? []).length;
const config = json(CONFIG);
/** @type {string[]} */
const selection = (json(SELECTION)?.batch ?? []).map((/** @type {{ id: string }} */ c) => c.id);
const maxRetries = Number(config?.maxRetries) || 3;
const concurrency = Number(config?.concurrency) || 16;

/**
 * The verdict heading of a run's findings.md, or '' if it has none.
 *
 * @param {string} dir
 * @returns {string}
 */
function verdict(dir) {
    const path = join(dir, 'findings.md');
    if (!existsSync(path)) {
        return '';
    }
    const match = /^## ([A-Z][A-Z ]*[A-Z])/m.exec(readFileSync(path, 'utf8'));
    return match ? match[1].trimEnd() : '';
}

/** @typedef {{ name: string, batch: number, kind: 'nomem' | 'mem', run: number }} Run */

/** Every run directory whose name parses, in the order they ran. @type {Run[]} */
const runs = (() => {
    try {
        return readdirSync(RUNS, { withFileTypes: true })
            .filter((e) => e.isDirectory() && RUN_NAME.test(e.name))
            .map((e) => {
                const m = /** @type {RegExpExecArray} */ (RUN_NAME.exec(e.name));
                return {
                    name: e.name,
                    batch: +m[1],
                    kind: /** @type {'nomem' | 'mem'} */ (m[2]),
                    run: +m[3],
                };
            })
            .sort(
                (a, b) =>
                    a.batch - b.batch ||
                    Number(a.kind === 'mem') - Number(b.kind === 'mem') ||
                    a.run - b.run,
            );
    } catch {
        return [];
    }
})();

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** @param {number} batch @param {'nomem' | 'mem'} kind @param {number} run */
const runDir = (batch, kind, run) => `${RUNS}/batch${pad(batch)}-${kind}-run${run}`;
/** @param {'nomem' | 'mem'} kind */
const memoryFlag = (kind) =>
    kind === 'nomem'
        ? '--memory .finetune/empty'
        : `--memory "$(${SCRIPTS}/memory.mjs path --candidate)"`;
/** @param {number} batch @param {'nomem' | 'mem'} kind @param {number} run @param {number} [c] */
const runIt = (batch, kind, run, c = concurrency) => {
    const dir = runDir(batch, kind, run);
    const copy =
        kind === 'nomem' && run === 1
            ? ''
            : `mkdir -p ${dir} && cp ${runDir(batch, 'nomem', 1)}/cases.json ${dir}/ && `;
    return (
        `${copy}zen run batch --input ${dir}/cases.json --batch-dir ${dir}/batch ` +
        `${memoryFlag(kind)} --concurrency ${c}`
    );
};

/** @param {Run} r @returns {number} runs of r's batch and kind up to r, not counting void ones */
const tuned = (r) =>
    runs.filter(
        (x) =>
            x.batch === r.batch &&
            x.kind === r.kind &&
            x.run <= r.run &&
            verdict(join(RUNS, x.name)) !== 'VOID',
    ).length;

/** @returns {Map<number, string[]>} case ids of every batch, from its first no-memory run */
function batches() {
    /** @type {Map<number, string[]>} */
    const found = new Map();
    for (const r of runs) {
        if (r.kind === 'nomem' && r.run === 1) {
            found.set(
                r.batch,
                (json(join(RUNS, r.name, 'cases.json'))?.batch ?? []).map(
                    (/** @type {{ id: string }} */ c) => c.id,
                ),
            );
        }
    }
    return found;
}

/**
 * Open and stuck difficult cases. Stuck: `maxRetries` batches have held it
 * since it was added, and it is still not fixed.
 *
 * @returns {{ open: number, stuck: number }}
 */
function difficulty() {
    const held = batches();
    const unfixed = (json(DIFFICULT)?.cases ?? []).filter((/** @type {any} */ e) => !e.fixed);
    const stuck = unfixed.filter((/** @type {any} */ e) => {
        const since = Number(RUN_NAME.exec(e.added)?.[1] ?? 0);
        const retries = [...held.entries()].filter(
            ([n, ids]) => n > since && ids.includes(e.id),
        ).length;
        return retries >= maxRetries;
    }).length;
    return { open: unfixed.length - stuck, stuck };
}

/**
 * Why a run that says PASSED may not pass, or '' if it may.
 *
 * @param {Run} r
 * @returns {string}
 */
function refusal(r) {
    const dir = join(RUNS, r.name);
    const findings = existsSync(join(dir, 'findings.md'))
        ? readFileSync(join(dir, 'findings.md'), 'utf8')
        : '';
    const review = r.kind === 'nomem' ? 'Cost review' : 'Memory review';
    if (!new RegExp(`^## ${review}`, 'm').test(findings)) {
        return r.kind === 'nomem'
            ? `${r.name}: says PASSED but has no "## Cost review" - review llm calls, ` +
                  'forks and discovery for every case before passing'
            : `${r.name}: says PASSED but has no "## Memory review" - review recall, ` +
                  're-commits and savings for every case before passing';
    }
    if (existsSync(join(dir, 'changes.md')) && tuned(r) < MAX_RUNS) {
        return (
            `${r.name}: says PASSED but applied edits, which nothing has confirmed - ` +
            `run it again: ${runIt(r.batch, r.kind, r.run + 1)}`
        );
    }
    return '';
}

/**
 * After a batch passed with memory: the next batch while there is anything left,
 * else the final check.
 *
 * @param {number} batch
 * @returns {string}
 */
function afterPass(batch) {
    const { open, stuck } = difficulty();
    const used = new Set([...batches().values()].flat());
    const unused = selection.filter((id) => !used.has(id)).length;
    const n = batch + 1;

    if (unused > 0 || open > 0) {
        return (
            `batch ${batch} passed (${unused} unused case(s), ${open} difficult open) - ` +
            `build batch ${n}: ${SCRIPTS}/batch.mjs next -o ${runDir(n, 'nomem', 1)}/cases.json`
        );
    }
    const stuckNote = stuck > 0 ? ` (${stuck} difficult case(s) stuck - report them)` : '';
    if (!existsSync(FINAL)) {
        return (
            `every case used, none open${stuckNote} - run the final check into ${FINAL}/: ` +
            `the whole selection, with the last good memory`
        );
    }
    if (!existsSync(join(FINAL, 'batch', 'batch.json'))) {
        return `${FINAL}: the run never finished - move batch/ aside and re-run it`;
    }
    switch (verdict(FINAL)) {
        case 'VERIFIED':
            return 'done - the final check is VERIFIED and nothing is left to tune';
        case '':
            return `${FINAL}: not graded yet - ${SCRIPTS}/report.mjs -d ${FINAL}/batch oom, then grade`;
        default:
            return (
                `${FINAL}: not VERIFIED - report what regressed under "Open problems" and ` +
                'tell the user; the tuning does not re-open itself'
            );
    }
}

/**
 * The step after `last`, the latest run of the latest batch.
 *
 * @param {Run} last
 * @returns {string}
 */
function afterRun(last) {
    const dir = join(RUNS, last.name);
    if (!existsSync(join(dir, 'batch'))) {
        return `${last.name}: not run yet - ${runIt(last.batch, last.kind, last.run)}`;
    }
    if (!existsSync(join(dir, 'batch', 'batch.json'))) {
        return `${last.name}: the run never finished - move batch/ aside and re-run it`;
    }

    switch (verdict(dir)) {
        case '':
            return `${last.name}: not graded yet - ${SCRIPTS}/report.mjs -d ${dir}/batch oom, then grade`;
        case 'VOID': {
            // What the void run actually ran at, not the config: the agent may
            // already have halved that.
            const ran =
                Number(json(join(dir, 'batch', 'batch.json'))?.batch?.concurrency) || concurrency;
            if (ran <= 4) {
                return (
                    `${last.name}: void - out of memory at concurrency ${ran}, the floor: ` +
                    'the machine cannot run this batch - stop and tell the user'
                );
            }
            const halved = Math.max(4, Math.floor(ran / 2));
            const setIt =
                concurrency <= halved ? '' : `set "concurrency": ${halved} in ${CONFIG}, then `;
            return (
                `${last.name}: void - out of memory at concurrency ${ran}: ${setIt}` +
                `run the same cases again: ${runIt(last.batch, last.kind, last.run + 1, Math.min(concurrency, halved))}`
            );
        }
        case 'PASSED': {
            if (refusal(last)) {
                return refusal(last);
            }
            if (last.kind === 'nomem') {
                if (json(CANDIDATE)?.from !== last.name) {
                    return (
                        `${last.name}: passed without memory - build the candidate memory: ` +
                        `${SCRIPTS}/memory.mjs candidate ${last.name}`
                    );
                }
                return (
                    `batch ${last.batch} passed without memory and the candidate is built - ` +
                    `run it with memory: ${runIt(last.batch, 'mem', 1)}`
                );
            }
            if (!(json(LAST_GOOD)?.batches ?? []).includes(last.batch)) {
                return (
                    `batch ${last.batch} passed with memory - keep its memory first: ` +
                    `${SCRIPTS}/memory.mjs checkpoint ${last.name}`
                );
            }
            return afterPass(last.batch);
        }
        default: {
            const what = last.kind === 'nomem' ? 'no-memory' : 'with-memory';
            if (tuned(last) >= MAX_RUNS) {
                return (
                    `batch ${last.batch} has had ${MAX_RUNS} ${what} runs - stop tuning it: revert what ` +
                    `${last.name} did not confirm, add what is still wrong to difficult.mjs, ` +
                    'and write PASSED'
                );
            }
            return existsSync(join(dir, 'changes.md'))
                ? `edits applied - confirm them: ${runIt(last.batch, last.kind, last.run + 1)}`
                : `${last.name}: graded, nothing applied - merge the proposals and write changes.md`;
        }
    }
}

/** @returns {string} */
function nextStep() {
    if (datasetSize === 0) {
        return `build ${DATASET} from the whole training set - every case, no limit`;
    }
    if (!config) {
        return `write ${CONFIG}: limit, minBatch, maxBatch, recheck, concurrency, seed, maxRetries`;
    }
    if (selection.length === 0) {
        return `choose the cases: ${SCRIPTS}/select.mjs -o ${SELECTION}`;
    }
    if (!existsSync(README)) {
        return `write ${README}: the plan - before anything runs`;
    }
    const last = runs.at(-1);
    if (!last) {
        return `build batch 1: ${SCRIPTS}/batch.mjs next -o ${runDir(1, 'nomem', 1)}/cases.json`;
    }
    return afterRun(last);
}

// The README is patched by hand after every step; say so when it fell behind.
if (existsSync(README)) {
    const written = mtime(README);
    const newer = [
        CONFIG,
        SELECTION,
        DIFFICULT,
        LAST_GOOD,
        CANDIDATE,
        ...[...runs.map((r) => join(RUNS, r.name)), FINAL].flatMap((dir) =>
            ['batch/batch.json', 'findings.md', 'changes.md'].map((f) => join(dir, f)),
        ),
    ].filter((path) => mtime(path) > written);
    if (newer.length > 0) {
        const latest = newer.sort((a, b) => mtime(b) - mtime(a))[0];
        console.log(`first: patch ${README} - ${latest} is newer than it`);
    }
}

// A cut dataset is only right if the user asked for one; never let it pass unseen.
if (selection.length > 0 && selection.length < datasetSize) {
    console.log(
        `note: limit ${selection.length} of ${datasetSize} cases - ${datasetSize - selection.length} ` +
            `are never tuned against. Unless the user asked for that, set "limit": ${datasetSize} ` +
            `in ${CONFIG} and re-run select.mjs -o ${SELECTION}`,
    );
}

// Every step passes through here, so the usage report never lags by more than one.
if (existsSync(`${SCRIPTS}/usage.mjs`)) {
    spawnSync(process.execPath, [`${SCRIPTS}/usage.mjs`, '-q'], {
        stdio: 'ignore',
        timeout: 30_000,
    });
}

console.log(nextStep());
