#!/usr/bin/env node
// @ts-check
//
// Report on one run's batch: what each case did, and where its trajectory is.
//
// `index`, `graphs` and `compare` each open by saying which memory the run had -
// NO MEMORY (stage 1), WITH MEMORY (stage 2) or MEMORY OFF - because the same
// trajectory means opposite things either way.
//
// Run `oom` first, and do not expect `failures` to have caught it: a case whose
// command was killed usually recovers, answers anyway and is recorded `ok`. A
// run can read "16 items, 16 ok, 0 failed" with six of them OOM-killed inside,
// and then nothing it did is evidence about the prompt. See the
// zen-finetune SKILL.md: the fix is half the concurrency, never below 4.
//
// `graphs` saves the most: every case's graph.mmd with its id, verdict and
// rubric above it - one read instead of one `zen inspect graph` per case.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'report.mjs';

const USAGE = `Report on one run's batch: what each case did, and where its trajectory is.

  ${NAME}                    index: ok, agent, stop reason, cost per case
  ${NAME} graphs [id...]     every trajectory graph, with its rubric above it
  ${NAME} paths [id...]      id <TAB> trajectory directory, for zen inspect
  ${NAME} failures           only the cases that did not finish, with errors
  ${NAME} oom                were commands killed - is this run gradeable at all
  ${NAME} compare            the per-case table findings.md opens with

  -d <dir>    the batch directory; default the newest .finetune/runs/*/batch
  -p <dir>    the batch to compare against, for \`compare\`
  -s <file>   the dataset, for rubrics; default .finetune/dataset.json`;

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

const MODES = ['index', 'graphs', 'paths', 'failures', 'oom', 'compare'];

let mode = '';
let batch = '';
let prev = '';
let dataset = '.finetune/dataset.json';
/** @type {string[]} */
const wanted = [];

const argv = process.argv.slice(2);
/** @param {string} flag @returns {string} */
const next = (flag) => {
    const value = argv.shift();
    if (value === undefined) {
        die(`${flag} needs a value`);
    }
    return value;
};

while (argv.length > 0) {
    const arg = /** @type {string} */ (argv.shift());
    if (arg === '-d') {
        batch = next('-d');
    } else if (arg === '-p') {
        prev = next('-p');
    } else if (arg === '-s') {
        dataset = next('-s');
    } else if (arg === '-h' || arg === '--help') {
        console.log(USAGE);
        process.exit(0);
    } else if (MODES.includes(arg)) {
        if (mode) {
            die('one mode at a time');
        }
        mode = arg;
    } else if (arg.startsWith('-')) {
        console.error(`${NAME}: unknown flag ${arg}`);
        console.error(USAGE);
        process.exit(2);
    } else {
        wanted.push(arg);
    }
}

mode ||= 'index';

// Without -d, the batch written most recently - by time, not by name, since
// `run10` sorts before `run2`.
if (!batch) {
    let newest = 0;
    /** @type {string[]} */
    let names = [];
    try {
        names = readdirSync('.finetune/runs');
    } catch {
        names = [];
    }
    for (const name of names) {
        const dir = join('.finetune/runs', name, 'batch');
        const file = join(dir, 'batch.json');
        if (existsSync(file) && statSync(file).mtimeMs > newest) {
            newest = statSync(file).mtimeMs;
            batch = dir;
        }
    }
}

if (!batch || !existsSync(join(batch, 'batch.json'))) {
    console.error(`${NAME}: no batch.json${batch ? ` in ${batch}` : ''}`);
    console.error('  name one with -d, or run a batch first');
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** @param {string} path @returns {any} */
function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

const batchDoc = json(join(batch, 'batch.json'));

/**
 * `{ id, ok }` per case, in batch order, filtered to the ids asked for.
 *
 * @param {string} dir
 * @returns {{ id: string, ok: boolean }[]}
 */
function roster(dir) {
    const doc = dir === batch ? batchDoc : json(join(dir, 'batch.json'));
    /** @type {{ id: string, ok: boolean }[]} */
    const all = (doc?.batch_results ?? []).map((/** @type {any} */ r) => ({
        id: String(r.id),
        ok: r.ok === true,
    }));
    return wanted.length === 0 ? all : all.filter((r) => wanted.includes(r.id));
}

/** @param {string} id */
const output = (id) => json(join(batch, id, 'output.json'));

/**
 * What one case cost. The counts come from the graph's own header row -
 *   %% nodes     103 · 33 llm · 30 tool calls · 1 forks
 * - because counting state.json nodes over-counts tool calls about threefold.
 *
 * @param {string} dir
 * @param {string} id
 * @returns {{ tokens: number, secs: number, llm: number, tools: number, forks: number }}
 */
function metrics(dir, id) {
    const out = json(join(dir, id, 'output.json'));
    const zero = { tokens: 0, secs: 0, llm: 0, tools: 0, forks: 0 };
    if (!out) {
        return zero;
    }
    const tokens = (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0);
    const secs = Math.floor((out.durationMs ?? 0) / 1000);
    const graph = out.run?.graph;
    if (!graph || !existsSync(graph)) {
        return { ...zero, tokens, secs };
    }
    const row = readFileSync(graph, 'utf8')
        .split('\n')
        .find((line) => /^%% nodes\s/.test(line));
    if (!row) {
        return { ...zero, tokens, secs };
    }
    const parts = row.replace(/^%% nodes\s+/, '').split(' · ');
    const n = (/** @type {number} */ i) => Number.parseInt(parts[i] ?? '', 10) || 0;
    return { tokens, secs, llm: n(1), tools: n(2), forks: n(3) };
}

/** 1.09M, 812k, 94. @param {number} n */
function hum(n) {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(2)}M`;
    }
    if (n >= 1000) {
        return `${Math.trunc(n / 1000)}k`;
    }
    return String(n);
}

/**
 * "33 → 30 (−3)" against a previous run, "33" without one. Tokens and seconds
 * move continuously and read as a percentage; calls and forks read as a count.
 *
 * @param {number} was
 * @param {number} now
 * @param {'tok' | 'sec' | 'num'} kind
 * @returns {string}
 */
function cell(was, now, kind) {
    const show = (/** @type {number} */ v) =>
        kind === 'tok' ? hum(v) : kind === 'sec' ? `${v}s` : String(v);
    if (!prev) {
        return show(now);
    }
    const delta = now - was;
    const size = Math.abs(delta);
    const sign = delta >= 0 ? '+' : '−';
    if (size === 0) {
        return `${show(now)} (=)`;
    }
    if (kind === 'num') {
        return `${show(was)} → ${show(now)} (${sign}${size})`;
    }
    if (was > 0) {
        return `${show(was)} → ${show(now)} (${sign}${((size * 100) / was).toFixed(0)}%)`;
    }
    return `${show(was)} → ${show(now)}`;
}

/**
 * `memory off` / `no memory` / `with memory`, for a batch directory.
 *
 * batch.json records `--memory .finetune/empty` as mode `copied`, exactly like
 * a stage-2 run. What differs is whether the source held a graph.
 *
 * @param {string} dir
 * @returns {{ kind: string, line: string }}
 */
function memory(dir) {
    const mem = json(join(dir, 'batch.json'))?.batch?.memory ?? {};
    const mode = mem.mode ?? 'none';
    const source = mem.source ?? '';
    if (mode === 'none') {
        return {
            kind: 'memory off',
            line: 'MEMORY OFF — no memory was given to this batch, and none was written',
        };
    }
    if (mode === 'read-only') {
        return {
            kind: 'with memory',
            line: `WITH MEMORY — one shared graph, read-only, every case read it and none wrote (${source})`,
        };
    }
    if (mode === 'copied') {
        return source && existsSync(join(source, 'graph.json'))
            ? {
                  kind: 'with memory',
                  line: `WITH MEMORY — each case got its own copy of an existing graph (${source})`,
              }
            : {
                  kind: 'no memory',
                  line: `NO MEMORY — every case started from an empty graph and wrote its own (${source || 'none'})`,
              };
    }
    return { kind: mode, line: `${mode}${source ? ` (${source})` : ''}` };
}

const datasetDoc = json(dataset);

/**
 * The rubric from the dataset, joined on the id; empty when there is none.
 *
 * @param {string} id
 * @returns {string[]}
 */
function rubric(id) {
    const all = datasetDoc?.cases ?? datasetDoc?.samples ?? [];
    const found = all.find((/** @type {any} */ c) => c.id === id);
    return (found?.rubric ?? []).map((/** @type {string} */ line) => `  - ${line}`);
}

/** @param {(string | number)[]} cells @param {number[]} widths */
const row = (cells, widths) =>
    cells
        .map((c, i) =>
            widths[i] < 0 ? String(c).padStart(-widths[i]) : String(c).padEnd(widths[i]),
        )
        .join(' ')
        .replace(/ +$/, '');

const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

if (mode === 'index') {
    const b = batchDoc?.batch ?? {};
    say(
        `batch  ${b.items} items, ${b.ok} ok, ${b.failed} failed` +
            `  ·  ${Math.floor((b.durationMs ?? 0) / 1000)}s`,
    );
    say(`dir    ${batch}`);
    say(`memory ${memory(batch).line}`);
    say('');
    const widths = [24, 5, 12, 12, -7, -5, -6];
    say(row(['ID', 'OK', 'AGENT', 'STOP', 'TOKENS', 'SEC', 'RUBRIC'], widths));
    for (const { id, ok } of roster(batch)) {
        const out = output(id);
        const lines = rubric(id).length;
        say(
            row(
                [
                    id,
                    String(ok),
                    out?.agent || '-',
                    out?.stopReason || '-',
                    out ? (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0) : '-',
                    out ? Math.floor((out.durationMs ?? 0) / 1000) : '-',
                    lines === 0 ? '-' : lines,
                ],
                widths,
            ),
        );
    }
    say('');
    say(`next: ${NAME} -d ${batch} graphs | less`);
} else if (mode === 'graphs') {
    say(`== memory: ${memory(batch).line}`);
    for (const { id, ok } of roster(batch)) {
        const out = output(id);
        say('================================================================');
        say(`== ${id}   ok=${ok}`);
        const lines = rubric(id);
        if (lines.length > 0) {
            say('== rubric:');
            for (const line of lines) {
                say(`== ${line}`);
            }
        }
        say('================================================================');
        const graph = out?.run?.graph;
        if (graph && existsSync(graph)) {
            process.stdout.write(readFileSync(graph, 'utf8'));
        } else if (out) {
            say(out.error?.message ?? 'no graph was written');
        } else {
            say('no output.json');
        }
        say('');
    }
} else if (mode === 'paths') {
    for (const { id } of roster(batch)) {
        say(`${id}\t${output(id)?.run?.dir || '-'}`);
    }
} else if (mode === 'failures') {
    const items = roster(batch);
    if (items.every((r) => r.ok)) {
        say('nothing failed');
        process.exit(0);
    }
    for (const { id, ok } of items) {
        if (ok) {
            continue;
        }
        say(`-- ${id}`);
        const out = output(id);
        if (out) {
            say(`   ${out.error?.message ?? 'unknown'}`);
            if (out.error?.hint) {
                say(`   hint: ${out.error.hint}`);
            }
        }
    }
} else if (mode === 'compare') {
    if (prev && !existsSync(join(prev, 'batch.json'))) {
        die(`no batch.json in ${prev}`);
    }

    // Part of the table, not a footnote: a pasted table loses what follows it.
    say(`memory: ${memory(batch).line}`);
    if (prev) {
        say(`prev memory: ${memory(prev).line}`);
    }
    say('');
    say('| case | verdict | tokens | llm calls | tool calls | forks | time |');
    say('| --- | --- | --- | --- | --- | --- | --- |');

    const sum = { tokens: 0, secs: 0, llm: 0, tools: 0, forks: 0 };
    const was = { tokens: 0, secs: 0, llm: 0, tools: 0, forks: 0 };
    for (const { id, ok } of roster(batch)) {
        const now = metrics(batch, id);
        const before = prev
            ? metrics(prev, id)
            : { tokens: 0, secs: 0, llm: 0, tools: 0, forks: 0 };
        for (const k of /** @type {const} */ (['tokens', 'secs', 'llm', 'tools', 'forks'])) {
            sum[k] += now[k];
            was[k] += before[k];
        }
        // The verdict is the grader's: no script can read it off a trajectory.
        say(
            `| ${id} | ${ok ? '?' : '**did not finish**'} ` +
                `| ${cell(before.tokens, now.tokens, 'tok')} ` +
                `| ${cell(before.llm, now.llm, 'num')} ` +
                `| ${cell(before.tools, now.tools, 'num')} ` +
                `| ${cell(before.forks, now.forks, 'num')} ` +
                `| ${cell(before.secs, now.secs, 'sec')} |`,
        );
    }

    say(
        `| **total** | — ` +
            `| **${cell(was.tokens, sum.tokens, 'tok')}** ` +
            `| **${cell(was.llm, sum.llm, 'num')}** ` +
            `| **${cell(was.tools, sum.tools, 'num')}** ` +
            `| **${cell(was.forks, sum.forks, 'num')}** ` +
            `| **${cell(was.secs, sum.secs, 'sec')}** |`,
    );

    say('');
    say(`this  ${batch}`);
    if (prev) {
        say(`prev  ${prev}`);
    }
    say('note: wall time is concurrent — the totals are machine load, not a sum anybody waited.');
    const a = memory(batch).kind;
    const b = prev ? memory(prev).kind : a;
    if (a !== b) {
        say('');
        say(`note: these two runs did not have the same memory (${b} → ${a}).`);
        say('  No memory against with memory is the stage-2 measurement and reads as one;');
        say('  otherwise the wrong -p was given, or the numbers will be read as the effect');
        say('  of an instruction that did nothing.');
    }
} else if (mode === 'oom') {
    // The graph is where an exit code survives: a killed `run_command` reads
    // `= exit code 137`. Never grep the batch directory - a workspace is full of
    // data files with 137 in them.
    /** @type {{ id: string, killed: number, timedout: number }[]} */
    const scan = [];
    for (const { id } of roster(batch)) {
        const graph = output(id)?.run?.graph;
        if (!graph || !existsSync(graph)) {
            continue;
        }
        const lines = readFileSync(graph, 'utf8').split('\n');
        const killed = lines.filter((l) => l.includes('exit code 137')).length;
        const timedout = lines.filter((l) => l.includes('exit code 124')).length;
        if (killed > 0 || timedout > 0) {
            scan.push({ id, killed, timedout });
        }
    }

    if (scan.length === 0) {
        say('no killed commands in this run — it is gradeable');
        process.exit(0);
    }

    const widths = [32, -8, -8];
    say(row(['CASE', 'OOM 137', 'TIME 124'], widths));
    for (const { id, killed, timedout } of scan) {
        say(row([id, killed, timedout], widths));
    }
    say('');

    const casesKilled = scan.filter((s) => s.killed > 0).length;
    const totalKilled = scan.reduce((n, s) => n + s.killed, 0);
    const totalTimedout = scan.reduce((n, s) => n + s.timedout, 0);
    const config = json('.finetune/config.json') ?? {};
    const current = Number(config.concurrency) || Math.min(Number(config.batchSize) || 8, 16);
    const halved = Math.max(4, Math.floor(current / 2));

    if (casesKilled > 0) {
        say(`${totalKilled} command(s) across ${casesKilled} case(s) were OOM-killed.`);
        say('');
        say('THIS RUN IS VOID, NOT GRADED.');
        say('  Nothing here is evidence about the prompt. Do not grade it, do not');
        say('  change instructions on it, and do not compare its tokens to another');
        say('  run.');
        say('');
        if (current <= 4) {
            say(`  It ran at concurrency ${current}, the floor. The machine cannot run this`);
            say('  batch: stop and tell the user.');
        } else {
            say(`  Halve the concurrency and run the same cases again: set`);
            say(
                `  "concurrency": ${halved} in .finetune/config.json (was ${current}; never below 4).`,
            );
        }
        process.exit(1);
    }

    say(`${totalTimedout} command(s) hit the timeout; none was OOM-killed.`);
    say('  Under memory pressure 124 is 137 wearing a different number, and raising');
    say('  the timeout converts one into the other rather than fixing either. If it');
    say(
        `  repeats in the next run, halve the concurrency: ${current} -> ${halved} (never below 4).`,
    );
}
