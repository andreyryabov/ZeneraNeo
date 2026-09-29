#!/usr/bin/env node
// @ts-check
//
// Keep the last good memory: everything the passed stage-1 runs committed,
// merged into one graph that is always whole on disk.
//
// After a batch passes in stage 1, `checkpoint <run>` folds the memory each of
// that run's cases wrote into a NEW directory, starting from a copy of the last
// good one, and only when that merge has succeeded does it repoint
// .finetune/memory/last-good.json at the new directory. `zen memory merge` writes
// its files one after another, so a merge killed half-way can leave a graph
// whose files disagree - but never the one the pointer names. Stop the tuning at
// any moment and `memory.mjs path` still names a usable graph.
//
// Stage 2 runs from that graph (`--memory "$(memory.mjs path)"`) and never
// checkpoints: its copies are not merged back.
//
// Needs `zen` on PATH. Run it from anywhere; it finds the project root from its
// own location. See .github/skills/zen-finetune/SKILL.md, "The last good memory".

import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'memory.mjs';

const USAGE = `Keep the last good memory: what the passed stage-1 runs committed, merged.

  ${NAME}                     which graph is last good, and what built it
  ${NAME} path                just its directory, for --memory "$(${NAME} path)"
  ${NAME} checkpoint <run>    fold a PASSED stage-1 run's memory into a new last good graph`;

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const ROOT = '.finetune/memory';
const POINTER = `${ROOT}/last-good.json`;
const RUNS = '.finetune/runs';
const RUN_NAME = /^stage1-batch(\d{2})-run(\d+)$/;
// Older graphs are kept to roll back to; beyond this many they are only disk.
const KEEP = 3;

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

/** @typedef {{ dir: string, runs: string[], nodes: number, at: string }} Pointer */

/** @type {Pointer | undefined} */
const pointer = json(POINTER);

const [command = 'status', run] = process.argv.slice(2);

if (command === '-h' || command === '--help') {
    console.log(USAGE);
    process.exit(0);
}

if (command === 'path') {
    if (!pointer) {
        die('no last good memory yet - checkpoint a PASSED stage-1 run first', 1);
    }
    console.log(pointer.dir);
    process.exit(0);
}

if (command === 'status') {
    if (!pointer) {
        console.log('no last good memory yet');
        process.exit(0);
    }
    console.log(`last good   ${pointer.dir}`);
    console.log(`nodes       ${pointer.nodes}`);
    console.log(`updated     ${pointer.at}`);
    console.log(`built from  ${pointer.runs.length} run(s)`);
    for (const name of pointer.runs) {
        console.log(`  ${name}`);
    }
    process.exit(0);
}

if (command !== 'checkpoint') {
    console.error(`${NAME}: unknown command ${command}`);
    console.error(USAGE);
    process.exit(2);
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

if (!run || !RUN_NAME.test(run)) {
    die('checkpoint needs a stage-1 run, e.g. stage1-batch03-run2');
}
const runDir = join(RUNS, run);
const findings = existsSync(join(runDir, 'findings.md'))
    ? readFileSync(join(runDir, 'findings.md'), 'utf8')
    : '';
if (!/^## PASSED/m.test(findings)) {
    die(`${run} does not say PASSED - only a passing run's memory is kept`);
}
if (pointer?.runs.includes(run)) {
    console.error(`${NAME}: ${run} is already in the last good memory`);
    process.exit(0);
}

// Only case memories with a manifest: a case that committed nothing has none.
const batch = join(runDir, 'batch');
const sources = (existsSync(batch) ? readdirSync(batch, { withFileTypes: true }) : [])
    .filter((e) => e.isDirectory() && existsSync(join(batch, e.name, 'memory', 'manifest.json')))
    .map((e) => join(batch, e.name, 'memory'));

const target = join(ROOT, `after-${run}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
if (pointer && existsSync(pointer.dir)) {
    cpSync(pointer.dir, target, {
        recursive: true,
        filter: (src) => !src.endsWith('/.lock'),
    });
}

if (sources.length > 0) {
    const merged = spawnSync('zen', ['memory', 'merge', ...sources, '--dir', target, '--yes'], {
        stdio: 'inherit',
    });
    if (merged.error) {
        die(`could not run zen: ${merged.error.message}`);
    }
    if (merged.status !== 0) {
        rmSync(target, { recursive: true, force: true });
        die(
            `zen memory merge failed - the last good memory is unchanged (${pointer?.dir ?? 'none'})`,
            1,
        );
    }
} else {
    mkdirSync(target, { recursive: true });
}

const manifest = json(join(target, 'manifest.json'));
/** @type {Pointer} */
const next = {
    dir: target,
    runs: [...(pointer?.runs ?? []), run],
    nodes: Number(manifest?.nodes) || 0,
    at: new Date().toISOString(),
};
const tmp = `${POINTER}.tmp`;
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
renameSync(tmp, POINTER);

const kept = new Set(
    readdirSync(ROOT)
        .filter((name) => name.startsWith('after-'))
        .map((name) => join(ROOT, name)),
);
const history = [...(pointer?.runs ?? []), run].map((name) => join(ROOT, `after-${name}`));
for (const dir of history.slice(0, -KEEP)) {
    if (kept.has(dir) && dir !== next.dir) {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.error(
    `${NAME}: last good memory is now ${target} - ${next.nodes} nodes, ` +
        `${sources.length} case memor${sources.length === 1 ? 'y' : 'ies'} from ${run}`,
);
