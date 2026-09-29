#!/usr/bin/env node
// @ts-check
//
// Say what to do next in the fine-tuning, read off .finetune/.
//
// This is how an interrupted session finds its place. Everything it reads is on
// disk - the dataset, the config, the selection, the README, the difficult list,
// every run directory and the verdict heading of every findings.md - so it never
// guesses.
//
// A PASSED is only accepted from a run whose findings.md has a `## Cost review`
// section and which applied no edits of its own (no changes.md): edits are a
// guess until the next run confirms them. A batch gets at most MAX_RUNS runs.
// A passed stage-1 batch must be checkpointed into the last good memory before
// the next batch is built.
//
// The number of batches is not fixed: a stage goes on while the selection has
// unused cases or the difficult list has open ones.
//
// When .finetune/README.md is older than the newest thing a run wrote, it says
// so first: the README is written by hand and is only useful if it is current.
//
// Run directories are `stage<1|2>-batch<NN>-run<N>`; anything else is ignored.
// Run it from anywhere; it finds the project root from its own location.

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
const RUNS = '.finetune/runs';
const SCRIPTS = '.github/skills/zen-finetune/scripts';
const MAX_RUNS = 4;
const RUN_NAME = /^stage([12])-batch(\d{2})-run(\d+)$/;

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
const concurrency = Number(config?.concurrency) || Math.min(Number(config?.batchSize) || 8, 16);

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

/** @typedef {{ name: string, stage: number, batch: number, run: number }} Run */

/** Every run directory whose name parses, in the order they ran. @type {Run[]} */
const runs = (() => {
    try {
        return readdirSync(RUNS, { withFileTypes: true })
            .filter((e) => e.isDirectory() && RUN_NAME.test(e.name))
            .map((e) => {
                const m = /** @type {RegExpExecArray} */ (RUN_NAME.exec(e.name));
                return { name: e.name, stage: +m[1], batch: +m[2], run: +m[3] };
            })
            .sort((a, b) => a.stage - b.stage || a.batch - b.batch || a.run - b.run);
    } catch {
        return [];
    }
})();

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** @param {number} stage @param {number} batch @param {number} run */
const runDir = (stage, batch, run) => `${RUNS}/stage${stage}-batch${pad(batch)}-run${run}`;

/** @param {Run} r @returns {number} runs of r's batch up to r, not counting void ones */
const tuned = (r) =>
    runs.filter(
        (x) =>
            x.stage === r.stage &&
            x.batch === r.batch &&
            x.run <= r.run &&
            verdict(join(RUNS, x.name)) !== 'VOID',
    ).length;

/** @param {number} stage @returns {Map<number, string[]>} case ids of every batch, from run 1 */
function batches(stage) {
    /** @type {Map<number, string[]>} */
    const found = new Map();
    for (const r of runs) {
        if (r.stage === stage && r.run === 1) {
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
 * Open and stuck difficult cases of a stage. Stuck: `maxRetries` batches have
 * held it since it was added, and it is still not fixed.
 *
 * @param {number} stage
 * @returns {{ open: number, stuck: number }}
 */
function difficulty(stage) {
    const held = batches(stage);
    const unfixed = (json(DIFFICULT)?.cases ?? []).filter(
        (/** @type {any} */ e) => e.stage === stage && !e.fixed,
    );
    const stuck = unfixed.filter((/** @type {any} */ e) => {
        const since = Number(RUN_NAME.exec(e.added)?.[2] ?? 0);
        const retries = [...held.entries()].filter(
            ([n, ids]) => n > since && ids.includes(e.id),
        ).length;
        return retries >= maxRetries;
    }).length;
    return { open: unfixed.length - stuck, stuck };
}

/**
 * Why a run that says PASSED may not pass its batch, or '' if it may.
 *
 * @param {Run} r
 * @returns {string}
 */
function refusal(r) {
    const dir = join(RUNS, r.name);
    const findings = existsSync(join(dir, 'findings.md'))
        ? readFileSync(join(dir, 'findings.md'), 'utf8')
        : '';
    if (!/^## Cost review/m.test(findings)) {
        return (
            `${r.name}: says PASSED but has no "## Cost review" - review llm calls, ` +
            'forks and discovery for every case before passing the batch'
        );
    }
    if (existsSync(join(dir, 'changes.md')) && tuned(r) < MAX_RUNS) {
        return (
            `${r.name}: says PASSED but applied edits, which nothing has confirmed - ` +
            `copy its cases.json into ${runDir(r.stage, r.batch, r.run + 1)}/ and run it`
        );
    }
    return '';
}

/**
 * After a batch of `stage` passed: the next batch while there is anything left
 * to do in the stage, else the end of the stage.
 *
 * @param {Run} last
 * @returns {string}
 */
function afterPass(last) {
    const stage = last.stage;
    const { open, stuck } = difficulty(stage);
    const used = new Set([...batches(1).values()].flat());
    const unused = selection.filter((id) => !used.has(id)).length;
    const replay = stage === 2 ? batches(1).size - batches(2).size : 0;
    const n = last.batch + 1;

    if ((stage === 1 && unused > 0) || replay > 0 || open > 0) {
        const left =
            stage === 1
                ? `${unused} unused case(s), ${open} difficult open`
                : `${replay} stage-1 batch(es) to replay, ${open} difficult open`;
        return (
            `batch ${last.batch} passed (${left}) - build batch ${n}: ` +
            `${SCRIPTS}/batch.mjs next${stage === 2 ? ' --stage 2' : ''} ` +
            `-o ${runDir(stage, n, 1)}/cases.json`
        );
    }
    const stuckNote = stuck > 0 ? ` (${stuck} difficult case(s) stuck - report them)` : '';
    if (stage === 1) {
        return (
            `stage 1 is done: every case used, none open${stuckNote} - check the last good ` +
            `memory (${SCRIPTS}/memory.mjs), then start stage 2: ` +
            `${SCRIPTS}/batch.mjs next --stage 2 -o ${runDir(2, 1, 1)}/cases.json`
        );
    }
    return verdict(join(RUNS, 'final-check')) === 'VERIFIED'
        ? 'done - the final check is VERIFIED and nothing is left to tune'
        : `stage 2 is done${stuckNote} - run the final check into ${RUNS}/final-check/`;
}

/** @returns {string} */
function nextStep() {
    if (datasetSize === 0) {
        return `build ${DATASET} from the whole training set - every case, no limit`;
    }
    if (!config) {
        return `write ${CONFIG}: limit, batchSize, recheck, concurrency = min(batchSize, 16), seed, maxRetries`;
    }
    if (selection.length === 0) {
        return `choose the cases: ${SCRIPTS}/select.mjs -o ${SELECTION}`;
    }
    if (!existsSync(README)) {
        return `write ${README}: the plan - before anything runs`;
    }
    const last = runs.at(-1);
    if (!last) {
        return `build batch 1: ${SCRIPTS}/batch.mjs next -o ${runDir(1, 1, 1)}/cases.json`;
    }

    const dir = join(RUNS, last.name);
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
                `copy ${dir}/cases.json into ${runDir(last.stage, last.batch, last.run + 1)}/ ` +
                `and run it with --concurrency ${Math.min(concurrency, halved)}`
            );
        }
        case 'PASSED':
        case 'VERIFIED': {
            if (refusal(last)) {
                return refusal(last);
            }
            if (last.stage === 1 && !(json(LAST_GOOD)?.runs ?? []).includes(last.name)) {
                return (
                    `batch ${last.batch} passed - keep what it learned first: ` +
                    `${SCRIPTS}/memory.mjs checkpoint ${last.name}`
                );
            }
            return afterPass(last);
        }
        default:
            if (tuned(last) >= MAX_RUNS) {
                return (
                    `batch ${last.batch} has had ${MAX_RUNS} runs - stop tuning it: revert what ` +
                    `${last.name} did not confirm, add what is still wrong to difficult.mjs, ` +
                    'and write PASSED'
                );
            }
            return existsSync(join(dir, 'changes.md'))
                ? `edits applied - confirm them: copy ${dir}/cases.json into ` +
                      `${runDir(last.stage, last.batch, last.run + 1)}/ and run it`
                : `${last.name}: graded, nothing applied - generalise the findings and write changes.md`;
    }
}

// The README is patched by hand after every step; say so when it fell behind.
if (existsSync(README)) {
    const written = mtime(README);
    const newer = [
        CONFIG,
        SELECTION,
        DIFFICULT,
        LAST_GOOD,
        ...runs.flatMap((r) =>
            ['batch/batch.json', 'findings.md', 'changes.md'].map((f) => join(RUNS, r.name, f)),
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

console.log(nextStep());
