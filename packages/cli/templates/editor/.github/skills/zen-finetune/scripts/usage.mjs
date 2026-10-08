#!/usr/bin/env node
// @ts-check
//
// What the tuning has cost, in tokens: finetune/USAGE.md and finetune/usage.json.
//
// Three things spend tokens during a tuning, and only one of them is the
// project under test:
//
//   project agents   every case of every run - read off each run's batch.json
//                    and output.json, so runs from before the ledger count too
//   meta agent       the agent doing the tuning - one ledger row per model call,
//                    from the spans `zen meta` records as it runs
//   inspect ask      every `zen inspect ask` the grading made - one row each
//
// The ledger is finetune/usage/ledger.jsonl. `zen meta`, `zen run`, `zen run
// batch` and `zen inspect ask` append to it whenever the project has a
// finetune/; nothing here writes to it.
//
// A meta agent call is put on the stage it happened in, by time: while a run
// executes it is "waiting" on that run, after it until the next run starts it is
// "grading" it, and before the first run it is "setup". An ask goes to the run
// whose trajectory it asked about.
//
// The report is rewritten whole every time - by next.mjs, and by a running
// `zen meta` every few minutes. Never edit it by hand.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md, "The usage report".

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'usage.mjs';

const USAGE = `What the tuning has cost, in tokens: finetune/USAGE.md and finetune/usage.json.

  ${NAME}             write both, and print one summary line
  ${NAME} -q          write both, print nothing
  ${NAME} --stdout    print the markdown instead of writing anything`;

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const RUNS = 'finetune/runs';
const LEDGER = 'finetune/usage/ledger.jsonl';
const REPORT = 'finetune/USAGE.md';
const DATA = 'finetune/usage.json';
const RUN_NAME = /^batch(\d{2})-(nomem|mem)-run(\d+)$/;
const FINAL = 'final-check';
const COSTLIEST = 10;

let quiet = false;
let toStdout = false;
for (const arg of process.argv.slice(2)) {
    if (arg === '-q') {
        quiet = true;
    } else if (arg === '--stdout') {
        toStdout = true;
    } else if (arg === '-h' || arg === '--help') {
        console.log(USAGE);
        process.exit(0);
    } else {
        console.error(`${NAME}: unknown argument ${arg}`);
        console.error(USAGE);
        process.exit(2);
    }
}

if (!existsSync('finetune')) {
    console.error(`${NAME}: no finetune/ - nothing is being tuned here`);
    process.exit(2);
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
// Tokens
// ---------------------------------------------------------------------------

/**
 * Calls and tokens. `cached` is part of `input`, `reasoning` part of `output`.
 *
 * @typedef {{ calls: number, input: number, cached: number, output: number, reasoning: number }} Spend
 */

/** @returns {Spend} */
const zero = () => ({ calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

/**
 * A zen `TokenUsage` and a call count, as a Spend.
 *
 * @param {any} usage
 * @param {number} calls
 * @returns {Spend}
 */
const spendOf = (usage, calls) => ({
    calls,
    input: Number(usage?.inputTokens ?? 0),
    cached: Number(usage?.cachedInputTokens ?? 0),
    output: Number(usage?.outputTokens ?? 0),
    reasoning: Number(usage?.reasoningTokens ?? 0),
});

/** @param {Spend} into @param {Spend} add */
function plus(into, add) {
    into.calls += add.calls;
    into.input += add.input;
    into.cached += add.cached;
    into.output += add.output;
    into.reasoning += add.reasoning;
    return into;
}

/** @param {Map<string, Spend>} map @param {string} key @param {Spend} add */
function bump(map, key, add) {
    map.set(key, plus(map.get(key) ?? zero(), add));
}

/** @param {Spend} s */
const total = (s) => s.input + s.output;

/** 950, 12.3k, 1.84M. @param {number} n */
function hum(n) {
    if (n >= 1e9) {
        return `${(n / 1e9).toFixed(2)}B`;
    }
    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(2)}M`;
    }
    if (n >= 1e3) {
        return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    }
    return String(Math.round(n));
}

/** @param {number} part @param {number} whole */
const pct = (part, whole) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '-');

/** @param {number} ms */
function clock(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/**
 * The cells every token table shares.
 *
 * @param {Spend} s
 * @returns {string[]}
 */
const cells = (s) => [
    String(s.calls),
    hum(s.input),
    pct(s.cached, s.input),
    hum(s.output),
    hum(s.reasoning),
    hum(total(s)),
];
const HEAD = ['calls', 'input', 'cached', 'output', 'reasoning', 'total'];

/** @param {string[]} head @param {string[][]} rows */
function table(head, rows) {
    if (rows.length === 0) {
        return ['_none yet_'];
    }
    const right = head.map((_, i) =>
        rows.every((r) => /^[−\d.,%kMB+-]+[smh]?$|^-$/.test(r[i] ?? '')),
    );
    return [
        `| ${head.join(' | ')} |`,
        `| ${head.map((_, i) => (right[i] ? '---:' : '---')).join(' | ')} |`,
        ...rows.map((r) => `| ${r.join(' | ')} |`),
    ];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, batch: number, kind: 'nomem' | 'mem' | 'final', run: number,
 *             start: number, end: number, durationMs: number, items: number, ok: number,
 *             verdict: string, models: Map<string, Spend>, spend: Spend }} Run
 */

/** @param {string} dir */
function verdict(dir) {
    const path = join(dir, 'findings.md');
    const m = existsSync(path) ? /^## ([A-Z][A-Z ]*[A-Z])/m.exec(readFileSync(path, 'utf8')) : null;
    return m ? m[1].trimEnd() : '';
}

/** Every run that finished, in the order it started. @type {Run[]} */
const runs = [];
/** run dir of a case's trajectory -> [finetune run, case id] @type {Map<string, [string, string]>} */
const trajectories = new Map();
/** @type {{ run: string, id: string, spend: Spend, durationMs: number }[]} */
const cases = [];

for (const name of existsSync(RUNS) ? readdirSync(RUNS) : []) {
    const m = RUN_NAME.exec(name);
    if (!m && name !== FINAL) {
        continue;
    }
    const doc = json(join(RUNS, name, 'batch', 'batch.json'));
    if (!doc?.batch) {
        continue;
    }
    const b = doc.batch;
    /** @type {Map<string, Spend>} */
    const models = new Map();
    for (const one of b.models ?? []) {
        bump(models, one.model, spendOf(one.usage, Number(one.calls ?? 0)));
    }
    const spend = [...models.values()].reduce(plus, zero());
    runs.push({
        name,
        batch: m ? +m[1] : Infinity,
        kind: m ? /** @type {'nomem' | 'mem'} */ (m[2]) : 'final',
        run: m ? +m[3] : 1,
        start: Date.parse(b.startedAt),
        end: Date.parse(b.finishedAt),
        durationMs: Number(b.durationMs ?? 0),
        items: Number(b.items ?? 0),
        ok: Number(b.ok ?? 0),
        verdict: verdict(join(RUNS, name)),
        models,
        spend,
    });
    for (const r of doc.batch_results ?? []) {
        const out = json(join(RUNS, name, 'batch', String(r.id), 'output.json'));
        if (!out) {
            continue;
        }
        if (out.run?.dir) {
            trajectories.set(resolve(out.run.dir), [name, String(r.id)]);
        }
        if (out.usage) {
            cases.push({
                run: name,
                id: String(r.id),
                spend: spendOf(out.usage, 0),
                durationMs: Number(out.durationMs ?? 0),
            });
        }
    }
}
runs.sort((a, b) => a.start - b.start);
const byName = new Map(runs.map((r) => [r.name, r]));

/** @type {any[]} */
const ledger = existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .flatMap((l) => {
              try {
                  return [JSON.parse(l)];
              } catch {
                  return [];
              }
          })
    : [];
const since = ledger.length > 0 ? ledger.map((r) => String(r.ts)).sort()[0] : undefined;

/** The finetune run a batch directory belongs to. @param {string | undefined} dir */
function runOfBatchDir(dir) {
    const m = /\finetune\/runs\/([^/]+)\/batch\/?$/.exec(dir ?? '');
    return m && byName.has(m[1]) ? m[1] : undefined;
}

/**
 * Which stage a moment of the tuning belongs to: `waiting <run>` while it ran,
 * `grading <run>` from its end until the next run starts, `setup` before any.
 *
 * @param {number} t
 * @returns {{ stage: string, run?: string }}
 */
function stageAt(t) {
    let last;
    for (const r of runs) {
        if (t >= r.start && t <= r.end) {
            return { stage: 'waiting', run: r.name };
        }
        if (r.end < t) {
            last = r;
        }
    }
    return last ? { stage: 'grading', run: last.name } : { stage: 'setup' };
}

/** The batch label a run belongs to: `batch 3`, `final check`, `setup`. @param {string | undefined} run */
function batchOf(run) {
    const r = run ? byName.get(run) : undefined;
    if (!r) {
        return 'setup';
    }
    return r.kind === 'final' ? 'final check' : `batch ${r.batch}`;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/** actor -> model -> spend @type {Map<string, Map<string, Spend>>} */
const actors = new Map();
/** @param {string} actor @param {string} model @param {Spend} s */
function spend(actor, model, s) {
    const models = actors.get(actor) ?? new Map();
    bump(models, model, s);
    actors.set(actor, models);
}
const PROJECT = 'project agents';
const META = 'meta agent';
const ASK = 'inspect ask';
const SINGLE = 'zen run (single)';

for (const r of runs) {
    for (const [model, s] of r.models) {
        spend(PROJECT, model, s);
    }
}

/** finetune run -> what the meta agent and the asks spent on it @type {Map<string, { meta: Spend, waiting: Spend, ask: Spend, asks: number }>} */
const onRun = new Map();
const runSide = (/** @type {string} */ name) => {
    const had = onRun.get(name) ?? { meta: zero(), waiting: zero(), ask: zero(), asks: 0 };
    onRun.set(name, had);
    return had;
};
/** stage label -> meta spend @type {Map<string, Spend>} */
const metaStages = new Map();
/** case -> llm calls, where the ledger has them @type {Map<string, number>} */
const caseCalls = new Map();

/**
 * @typedef {{ session: string, first: string, last: string, resumes: number, exitCode: number,
 *             spans: Spend, totals?: Spend, models?: any[] }} MetaSession
 */
/** @type {Map<string, MetaSession>} */
const sessions = new Map();
/** @param {string} id @param {string} ts */
const sessionOf = (id, ts) => {
    const had = sessions.get(id) ?? {
        session: id,
        first: ts,
        last: ts,
        resumes: 0,
        exitCode: 0,
        spans: zero(),
    };
    had.first = ts < had.first ? ts : had.first;
    had.last = ts > had.last ? ts : had.last;
    sessions.set(id, had);
    return had;
};

for (const row of ledger) {
    if (row.kind === 'meta.call') {
        const s = spendOf(row.usage, 1);
        spend(META, String(row.model), s);
        const { stage, run } = stageAt(Date.parse(row.startedAt));
        bump(metaStages, run ? `${batchOf(run)} · ${stage} ${run}` : stage, s);
        if (run) {
            plus(stage === 'waiting' ? runSide(run).waiting : runSide(run).meta, s);
        }
        if (row.session) {
            plus(sessionOf(String(row.session), String(row.ts)).spans, s);
        }
    } else if (row.kind === 'meta.session') {
        const one = sessionOf(String(row.session), String(row.ts));
        // Cumulative over resumes: the latest row is the whole session.
        if (!one.models || String(row.ts) >= one.last) {
            one.models = row.models;
            one.totals = (row.models ?? []).reduce(
                (/** @type {Spend} */ acc, /** @type {any} */ m) =>
                    plus(acc, spendOf(m.usage, Number(m.calls ?? 0))),
                zero(),
            );
            one.exitCode = Number(row.exitCode ?? 0);
        }
        one.resumes = Math.max(one.resumes, Number(row.resumes ?? 0));
    } else if (row.kind === 'ask') {
        const s = spendOf(row.usage, 1);
        spend(ASK, String(row.model), s);
        const run =
            trajectories.get(resolve(String(row.runDir)))?.[0] ??
            stageAt(Date.parse(row.startedAt)).run;
        if (run) {
            plus(runSide(run).ask, s);
            runSide(run).asks += 1;
        }
    } else if (row.kind === 'run') {
        const run = runOfBatchDir(row.batchDir);
        if (!row.batchDir) {
            for (const m of row.models ?? []) {
                spend(SINGLE, String(m.model), spendOf(m.usage, Number(m.calls ?? 0)));
            }
        }
        if (run) {
            caseCalls.set(
                `${run}/${row.item}`,
                (row.models ?? []).reduce(
                    (/** @type {number} */ n, /** @type {any} */ m) => n + Number(m.calls ?? 0),
                    0,
                ),
            );
        }
    }
}

/** @param {Map<string, Spend>} models */
const sum = (models) => [...models.values()].reduce((acc, s) => plus(acc, { ...s }), zero());
/** @param {Map<string, Spend>} map */
const heaviest = (map) => [...map.entries()].sort((a, b) => total(b[1]) - total(a[1]));

const ORDER = [PROJECT, META, ASK, SINGLE];
const totals = new Map(
    ORDER.filter((a) => actors.has(a)).map((a) => [
        a,
        sum(/** @type {Map<string, Spend>} */ (actors.get(a))),
    ]),
);
const grand = [...totals.values()].reduce((acc, s) => plus(acc, { ...s }), zero());

/** @type {Map<string, Spend>} */
const overall = new Map();
for (const models of actors.values()) {
    for (const [model, s] of models) {
        bump(overall, model, { ...s });
    }
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/**
 * @typedef {{ label: string, nomem: Run[], mem: Run[], project: Spend, meta: Spend, ask: Spend,
 *             asks: number, saving: string }} Batch
 */
/** @type {Map<string, Batch>} */
const batches = new Map();
for (const r of runs) {
    const label = batchOf(r.name);
    const b = batches.get(label) ?? {
        label,
        nomem: [],
        mem: [],
        project: zero(),
        meta: zero(),
        ask: zero(),
        asks: 0,
        saving: '-',
    };
    (r.kind === 'mem' ? b.mem : b.nomem).push(r);
    plus(b.project, r.spend);
    const side = onRun.get(r.name);
    if (side) {
        plus(b.meta, side.meta);
        plus(b.meta, side.waiting);
        plus(b.ask, side.ask);
        b.asks += side.asks;
    }
    batches.set(label, b);
}
for (const b of batches.values()) {
    const lastNomem = b.nomem.at(-1);
    const lastMem = b.mem.at(-1);
    if (lastNomem && lastMem && total(lastNomem.spend) > 0) {
        const delta = 1 - total(lastMem.spend) / total(lastNomem.spend);
        b.saving = `${delta >= 0 ? '−' : '+'}${Math.abs(Math.round(delta * 100))}%`;
    }
}

const setup = metaStages.get('setup') ?? zero();

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
/** @type {string[]} */
const md = [
    '<!-- Written by .github/skills/zen-finetune/scripts/usage.mjs - do not edit; it is rewritten whole. -->',
    '',
    '# Token usage',
    '',
    `Updated ${now.replace('T', ' ').slice(0, 16)} UTC. ` +
        (since
            ? `Meta agent and ask accounting since ${since.replace('T', ' ').slice(0, 16)} UTC; `
            : 'No ledger rows yet - meta agent and ask spend is not counted; ') +
        'project agents for every run on disk.',
    '',
    `**${hum(total(grand))} tokens** in **${grand.calls} model calls**: ` +
        [...totals.entries()].map(([a, s]) => `${a} ${pct(total(s), total(grand))}`).join(', ') +
        '.',
    '',
    '## Totals',
    '',
    ...table(
        ['who', ...HEAD],
        [...totals.entries()]
            .map(([a, s]) => [a, ...cells(s)])
            .concat([['**all**', ...cells(grand)]]),
    ),
    '',
    `Project agents ran for ${clock(runs.reduce((acc, r) => acc + r.durationMs, 0))} over ${runs.length} run(s).`,
    '',
    '## By model',
    '',
    ...table(
        ['model', ...HEAD],
        heaviest(overall).map(([m, s]) => [`\`${m}\``, ...cells(s)]),
    ),
    '',
    ...[...actors.entries()]
        .filter(([, models]) => models.size > 1 || actors.size > 1)
        .flatMap(([actor, models]) => [
            `### ${actor}`,
            '',
            ...table(
                ['model', ...HEAD],
                heaviest(models).map(([m, s]) => [`\`${m}\``, ...cells(s)]),
            ),
            '',
        ]),
    '## By batch',
    '',
    '"project" is the cases themselves, every run of the batch; "meta" is the meta agent while it',
    'waited on and graded those runs; "saving" is the last with-memory run against the last',
    'no-memory run.',
    '',
    ...table(
        ['batch', 'runs (no mem / mem)', 'project', 'meta', 'ask', 'total', 'saving'],
        [
            ...(total(setup) > 0
                ? [['setup', '-', '-', hum(total(setup)), '-', hum(total(setup)), '-']]
                : []),
            ...[...batches.values()].map((b) => [
                b.label,
                `${b.nomem.length} / ${b.mem.length}`,
                hum(total(b.project)),
                total(b.meta) > 0 ? hum(total(b.meta)) : '-',
                b.asks > 0 ? `${hum(total(b.ask))} (${b.asks})` : '-',
                hum(total(b.project) + total(b.meta) + total(b.ask)),
                b.saving,
            ]),
        ],
    ),
    '',
    '## By run',
    '',
    ...table(
        [
            'run',
            'verdict',
            'cases',
            'calls',
            'input',
            'cached',
            'output',
            'reasoning',
            'project',
            'time',
            'meta',
            'asks',
        ],
        runs.map((r) => {
            const side = onRun.get(r.name);
            const meta = side ? plus({ ...side.meta }, side.waiting) : zero();
            return [
                r.name,
                r.verdict || '-',
                `${r.ok}/${r.items}`,
                String(r.spend.calls),
                hum(r.spend.input),
                pct(r.spend.cached, r.spend.input),
                hum(r.spend.output),
                hum(r.spend.reasoning),
                hum(total(r.spend)),
                clock(r.durationMs),
                total(meta) > 0 ? hum(total(meta)) : '-',
                side?.asks ? `${side.asks} · ${hum(total(side.ask))}` : '-',
            ];
        }),
    ),
    '',
    `## Costliest cases`,
    '',
    ...table(
        ['run', 'case', 'calls', 'input', 'cached', 'output', 'total', 'time'],
        [...cases]
            .sort((a, b) => total(b.spend) - total(a.spend))
            .slice(0, COSTLIEST)
            .map((c) => [
                c.run,
                `\`${c.id}\``,
                String(caseCalls.get(`${c.run}/${c.id}`) ?? '-'),
                hum(c.spend.input),
                pct(c.spend.cached, c.spend.input),
                hum(c.spend.output),
                hum(total(c.spend)),
                clock(c.durationMs),
            ]),
    ),
    '',
    '## Meta agent',
    '',
    '### By stage',
    '',
    ...table(
        ['stage', ...HEAD],
        [...metaStages.entries()].map(([stage, s]) => [stage, ...cells(s)]),
    ),
    '',
    '### Sessions',
    '',
    '"copilot says" is the session\'s own total, written when it exits; "calls seen" is the sum of',
    'the calls recorded while it ran. They should agree; a gap is calls made while nothing was',
    'recording.',
    '',
    ...table(
        ['session', 'from', 'to', 'resumes', 'exit', 'calls seen', 'tokens seen', 'copilot says'],
        [...sessions.values()]
            .sort((a, b) => a.first.localeCompare(b.first))
            .map((s) => [
                `\`${s.session.slice(0, 8)}\``,
                s.first.replace('T', ' ').slice(5, 16),
                s.last.replace('T', ' ').slice(5, 16),
                String(s.resumes),
                String(s.exitCode),
                String(s.spans.calls),
                hum(total(s.spans)),
                s.totals ? `${s.totals.calls} · ${hum(total(s.totals))}` : '-',
            ]),
    ),
    '',
    '## Not counted',
    '',
    '- embeddings: memory recall and commit, and `zen memory merge`',
    '- `zen rag` searches the agents run inside the sandbox',
    '- anything the meta agent did before the ledger started, and any meta agent not run',
    '  through `zen meta`',
    '',
];

/** @param {Map<string, Spend>} map */
const plain = (map) => Object.fromEntries(heaviest(map));
const data = {
    generatedAt: now,
    ledgerSince: since ?? null,
    totals: { all: grand, ...Object.fromEntries(totals) },
    models: Object.fromEntries([...actors.entries()].map(([a, m]) => [a, plain(m)])),
    batches: [...batches.values()].map((b) => ({
        batch: b.label,
        nomemRuns: b.nomem.length,
        memRuns: b.mem.length,
        project: b.project,
        meta: b.meta,
        ask: b.ask,
        asks: b.asks,
        saving: b.saving,
    })),
    runs: runs.map((r) => ({
        run: r.name,
        verdict: r.verdict,
        items: r.items,
        ok: r.ok,
        durationMs: r.durationMs,
        project: r.spend,
        models: plain(r.models),
        meta: onRun.get(r.name) ?? null,
    })),
    meta: {
        stages: Object.fromEntries(metaStages),
        sessions: [...sessions.values()],
    },
};

if (toStdout) {
    process.stdout.write(`${md.join('\n')}\n`);
    process.exit(0);
}

/** @param {string} path @param {string} text */
function writeAtomic(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
}
writeAtomic(REPORT, `${md.join('\n')}\n`);
writeAtomic(DATA, `${JSON.stringify(data, null, 2)}\n`);
if (!quiet) {
    console.log(
        `${NAME}: ${hum(total(grand))} tokens, ${grand.calls} calls - ` +
            [...totals.entries()].map(([a, s]) => `${a} ${hum(total(s))}`).join(', ') +
            ` - ${REPORT}`,
    );
}
