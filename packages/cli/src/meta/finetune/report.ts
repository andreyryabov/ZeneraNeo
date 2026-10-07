import { MERMAID_URL } from '@zenera/neo';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { safe } from '../host.ts';
import { DatasetStore } from './dataset/store.ts';
import { type Case, DATASET_DIR } from './dataset/types.ts';
import { type Feedback, feedbackId, type Phase, readFeedback } from './feedback.ts';
import type { AppliedFile } from './improvements.ts';
import { resultOf, selection } from './sampler.ts';
import type { Run } from './train.ts';
import { readJson, type Tuning, type Worker } from './tuning.ts';
import {
    type ByModel,
    type ByStage,
    envelopesIn,
    mergeModels,
    mergeStages,
    type ModelMetrics,
    type RunMetrics,
    runMetrics,
    runTokens,
    short,
    STAGES,
    total,
} from './usage.ts';

// ---------------------------------------------------------------------------
// What a person reads
//
// Two pages, both written by code from what is on disk and in hand, never by
// an agent: STATUS.md for the whole tuning, FEEDBACK.md for one case. Diagrams
// carry only ids, numbers and fixed words - free text goes in tables, escaped -
// so nothing a model wrote can break a render.
// ---------------------------------------------------------------------------

export interface Attempt {
    phase: Phase;
    attempt: number;
    dir: string;
    run?: Run;
    feedback?: Feedback;
}

type Decisions = Record<string, Record<string, { decision?: string; note?: string }>>;

const PHASE_WORD: Record<Phase, string> = { nomem: 'no memory', mem: 'with memory' };

function atomic(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
}

/** A table cell: one line, no column breaks. */
export const cell = (text: string | number | undefined): string =>
    String(text ?? '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim() || '-';

/** A link from `from` (a directory) to `to`, safe for spaces. */
const link = (label: string, from: string, to: string): string =>
    `[${label}](<${relative(from, to).split(sep).join('/')}>)`;

export function since(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    }
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function attemptsOf(t: Tuning, c: Case): Attempt[] {
    const dir = t.caseDir(c);
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => /^\d{2}-(nomem|mem)$/.test(n));
    } catch {
        return [];
    }
    return names
        .map((name) => {
            const [n, phase] = name.split('-') as [string, Phase];
            const at = join(dir, name);
            const read = readFeedback(join(at, 'feedback.json'), t.known(c, phase, Number(n)));
            return {
                phase,
                attempt: Number(n),
                dir: at,
                run: readJson<Run>(join(at, 'run.json')),
                ...('feedback' in read ? { feedback: read.feedback } : {}),
            };
        })
        .sort(
            (a, b) =>
                Number(a.phase === 'mem') - Number(b.phase === 'mem') || a.attempt - b.attempt,
        );
}

function decisions(t: Tuning): Decisions {
    const all: Decisions = {};
    for (const a of t.improvements.applies()) {
        Object.assign(all, readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {});
    }
    return all;
}

/** A run's tokens per model: recorded at the run, or read from its trajectory. */
function runByModel(run: Run | undefined): ByModel | undefined {
    if (!run) {
        return undefined;
    }
    const by = run.tokens ?? runTokens(run.dir);
    if (by && Object.keys(by).length > 0) {
        return by;
    }
    return run.usage
        ? {
              '?': {
                  calls: run.turns ?? 0,
                  input: run.usage.inputTokens,
                  cached: run.usage.cachedInputTokens ?? 0,
                  output: run.usage.outputTokens,
                  reasoning: run.usage.reasoningTokens ?? 0,
              },
          }
        : undefined;
}

/** Every try of a case, per stage and model. Applies serve many cases at once, so they are not split. */
export function caseTokens(t: Tuning, c: Case): ByStage {
    const attempts = attemptsOf(t, c);
    return mergeStages(
        ...attempts.map((a) => ({
            run: runByModel(a.run),
            analyze: envelopesIn(a.dir, 'analyze'),
        })),
    );
}

/** `in / out`, the input counting cached tokens. */
const inOut = (by: ByModel | undefined): string => {
    const s = total(by);
    return s.input + s.output > 0 ? `${short(s.input)} / ${short(s.output)}` : '-';
};

function tokenTable(by: ByStage): string[] {
    const rows: string[] = [];
    for (const stage of STAGES) {
        const models = Object.entries(by[stage] ?? {}).sort(([a], [b]) => a.localeCompare(b));
        for (const [model, s] of models) {
            rows.push(
                `| ${stage} | ${cell(model)} | ${s.calls} | ${short(s.input)} | ${short(s.cached)} | ${short(s.output)} | ${short(s.reasoning)} |`,
            );
        }
    }
    if (rows.length === 0) {
        return [];
    }
    return [
        '| Stage | Model | Calls | Input | Cached | Output | Reasoning |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ];
}

const rubricScore = (f: Attempt['feedback']): string => {
    const r = Object.values(f?.rubric ?? {});
    return r.length ? `${r.filter((x) => x === 'pass').length}/${r.length}` : '-';
};

// ---------------------------------------------------------------------------
// What a run did, and how it moved from the try it is compared with
// ---------------------------------------------------------------------------

const FLAT_KEYS = [
    'calls',
    'input',
    'cached',
    'output',
    'reasoning',
    'peak',
    'llmMs',
    'wallMs',
    'toolMs',
    'tools',
    'toolErrors',
    'recall',
    'load',
    'grep',
    'commit',
    'forget',
    'forks',
    'branches',
    'compactions',
    'handoffs',
] as const;

/** One run, one model of it, or a sum of several. */
type Flat = Record<(typeof FLAT_KEYS)[number], number>;

const blank = (): Flat => Object.fromEntries(FLAT_KEYS.map((k) => [k, 0])) as Flat;

function addFlat(...all: (Flat | undefined)[]): Flat {
    const out = blank();
    for (const f of all) {
        for (const k of FLAT_KEYS) {
            out[k] += f?.[k] ?? 0;
        }
    }
    return out;
}

/** Recorded at the run, or read from its trajectory when the run predates that. */
const metricsOf = (run: Run | undefined): RunMetrics | undefined =>
    run ? (run.metrics ?? runMetrics(run.dir)) : undefined;

const modelFlat = (x: ModelMetrics | undefined): Flat => ({
    ...blank(),
    ...(x
        ? {
              calls: x.calls,
              input: x.input,
              cached: x.cached,
              output: x.output,
              reasoning: x.reasoning,
              peak: x.peak,
              llmMs: x.ms,
          }
        : {}),
});

function runFlat(run: Run | undefined): Flat | undefined {
    const m = metricsOf(run);
    if (!run || !m) {
        return undefined;
    }
    const models = Object.values(m.models);
    return {
        ...addFlat(...models.map(modelFlat)),
        peak: Math.max(0, ...models.map((x) => x.peak)),
        llmMs: m.llmMs,
        wallMs: run.durationMs ?? 0,
        toolMs: m.toolMs,
        tools: m.toolCalls,
        toolErrors: m.toolErrors,
        ...m.memory,
        forks: m.forks,
        branches: m.branches,
        compactions: m.compactions,
        handoffs: m.handoffs,
    };
}

type Kind = 'tokens' | 'time' | 'count' | 'share';

interface Metric {
    label: string;
    kind: Kind;
    /** absent where a move either way is not by itself good or bad */
    better?: 'lower' | 'higher';
    of: (f: Flat) => number;
}

const tokensIn = (f: Flat): number => f.input + f.output;

const MODEL_METRICS: Metric[] = [
    { label: 'LLM calls', kind: 'count', better: 'lower', of: (f) => f.calls },
    { label: 'Input', kind: 'tokens', better: 'lower', of: (f) => f.input },
    { label: 'Cached', kind: 'tokens', of: (f) => f.cached },
    { label: 'Uncached input', kind: 'tokens', better: 'lower', of: (f) => f.input - f.cached },
    {
        label: 'Cache hit',
        kind: 'share',
        better: 'higher',
        of: (f) => (f.input ? (f.cached / f.input) * 100 : 0),
    },
    { label: 'Output', kind: 'tokens', better: 'lower', of: (f) => f.output },
    { label: 'Reasoning', kind: 'tokens', better: 'lower', of: (f) => f.reasoning },
    { label: 'Peak input', kind: 'tokens', better: 'lower', of: (f) => f.peak },
    { label: 'LLM time', kind: 'time', better: 'lower', of: (f) => f.llmMs },
];

const RUN_METRICS: Metric[] = [
    { label: 'Wall clock', kind: 'time', better: 'lower', of: (f) => f.wallMs },
    ...MODEL_METRICS,
    { label: 'Tool calls', kind: 'count', better: 'lower', of: (f) => f.tools },
    { label: 'Tool errors', kind: 'count', better: 'lower', of: (f) => f.toolErrors },
    { label: 'Tool time', kind: 'time', better: 'lower', of: (f) => f.toolMs },
    { label: 'Memory recalls', kind: 'count', of: (f) => f.recall },
    { label: 'Memory loads', kind: 'count', of: (f) => f.load },
    { label: 'Memory greps', kind: 'count', of: (f) => f.grep },
    { label: 'Memory commits', kind: 'count', of: (f) => f.commit },
    { label: 'Memory forgets', kind: 'count', of: (f) => f.forget },
    { label: 'Forks', kind: 'count', of: (f) => f.forks },
    { label: 'Branches', kind: 'count', of: (f) => f.branches },
    { label: 'Compactions', kind: 'count', of: (f) => f.compactions },
    { label: 'Handoffs', kind: 'count', of: (f) => f.handoffs },
];

const SUMMARY_METRICS = RUN_METRICS.filter((m) =>
    [
        'Wall clock',
        'LLM calls',
        'Tool calls',
        'Tool errors',
        'Input',
        'Uncached input',
        'Cache hit',
        'Output',
        'LLM time',
        'Tool time',
    ].includes(m.label),
);

function show(kind: Kind, n: number): string {
    switch (kind) {
        case 'tokens':
            return short(n);
        case 'time':
            return since(n);
        case 'share':
            return `${Math.round(n)}%`;
        default:
            return String(n);
    }
}

/** Percent for amounts, points for a share, a plain difference for a count unless `relative`. */
function change(kind: Kind, now: number, before: number, relative = kind !== 'count'): string {
    const signed = (d: number, unit: string): string =>
        d === 0 ? '=' : `${d > 0 ? '+' : ''}${d}${unit}`;
    if (kind === 'share') {
        return signed(Math.round(now - before), 'pt');
    }
    if (!relative) {
        return signed(now - before, '');
    }
    if (before === 0) {
        return now === 0 ? '=' : 'new';
    }
    return signed(Math.round(((now - before) / before) * 100), '%');
}

/** Within this many percent (points, for a share) is noise, not a trend. */
const SAME = 5;

function trend(m: Metric, now: number, before: number): string {
    if (!m.better) {
        return '';
    }
    const d =
        m.kind === 'share'
            ? now - before
            : before === 0
              ? Math.sign(now) * Infinity
              : ((now - before) / before) * 100;
    if (Number.isNaN(d) || Math.abs(d) < SAME) {
        return 'same';
    }
    return d < 0 === (m.better === 'lower') ? 'better' : 'worse';
}

interface Column {
    label: string;
    now?: Flat;
    base?: Flat;
}

interface Pair {
    now?: Flat;
    base?: Flat;
}

/** Rows are metrics, columns tries; a metric that is zero everywhere is left out. */
function matrix(metrics: Metric[], cols: Column[], effect?: Pair): string[] {
    const all = [...cols.map((c) => c.now), effect?.now, effect?.base];
    const shown = metrics.filter((m) => all.some((f) => f && m.of(f) !== 0));
    if (shown.length === 0) {
        return [];
    }
    const both = effect?.now && effect.base ? { now: effect.now, base: effect.base } : undefined;
    const head = ['Metric', ...cols.map((c) => c.label), ...(both ? ['Memory effect'] : [])];
    const rows = shown.map((m) => {
        const cells = cols.map((c) => {
            if (!c.now) {
                return '-';
            }
            const v = show(m.kind, m.of(c.now));
            return c.base ? `${v} (${change(m.kind, m.of(c.now), m.of(c.base))})` : v;
        });
        if (both) {
            const now = m.of(both.now);
            const before = m.of(both.base);
            const word = trend(m, now, before);
            cells.push(`${change(m.kind, now, before, true)}${word ? ` ${word}` : ''}`);
        }
        return `| ${m.label} | ${cells.join(' | ')} |`;
    });
    return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows, ''];
}

/** The no-memory try that passed: the one every try with memory is measured against. */
const passedWithout = (attempts: Attempt[]): Attempt | undefined =>
    attempts.find((a) => a.phase === 'nomem' && a.feedback?.done);

const latestWith = (attempts: Attempt[]): Attempt | undefined =>
    [...attempts].reverse().find((a) => a.phase === 'mem' && a.run);

/** Each try against the one before it in its phase; the first with memory against the passing one without. */
function tryColumns(
    attempts: Attempt[],
    flat: (a: Attempt) => Flat | undefined,
): { cols: Column[]; effect?: Pair } {
    const passed = passedWithout(attempts);
    const cols = attempts.map((a, i) => {
        const base =
            attempts
                .slice(0, i)
                .reverse()
                .find((b) => b.phase === a.phase) ?? (a.phase === 'mem' ? passed : undefined);
        return {
            label: `${PHASE_WORD[a.phase]}, try ${a.attempt}`,
            now: flat(a),
            base: base && flat(base),
        };
    });
    const mem = latestWith(attempts);
    return {
        cols,
        ...(passed && mem ? { effect: { now: flat(mem), base: flat(passed) } } : {}),
    };
}

/** Before and after, one row per metric, with whether it moved the right way. */
function compareTable(before: string, after: string, a: Flat, b: Flat): string[] {
    const rows = SUMMARY_METRICS.filter((m) => m.of(a) !== 0 || m.of(b) !== 0).map(
        (m) =>
            `| ${m.label} | ${show(m.kind, m.of(a))} | ${show(m.kind, m.of(b))} | ${change(m.kind, m.of(b), m.of(a), true)} | ${trend(m, m.of(b), m.of(a)) || '-'} |`,
    );
    return [
        `| Metric | ${before} | ${after} | Change | Trend |`,
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ];
}

function stateOf(t: Tuning, c: Case): string {
    const r = resultOf(t, c);
    if (r) {
        if (r.state === 'failed') {
            return `failed (${r.reason ?? r.phase}) - resumes at the next start`;
        }
        return r.state === 'completed' ? 'completed' : `difficult (${r.reason ?? r.phase})`;
    }
    const w = t.workers.find((x) => x.case?.id === c.id);
    if (w) {
        return `${PHASE_WORD[w.phase ?? 'nomem']} · try ${w.attempt} · ${w.step}`;
    }
    const parked = t.improvements.pending.find((f) => f.case === c.id);
    if (parked) {
        return `${PHASE_WORD[parked.phase]} · try ${parked.attempt} · parked`;
    }
    const applying = t.improvements.inApply.find((f) => f.case === c.id);
    if (applying) {
        return `${PHASE_WORD[applying.phase]} · try ${applying.attempt} · parked, being applied`;
    }
    if (t.claimed.has(c.id)) {
        return 'waiting for a worker';
    }
    return attemptsOf(t, c).length > 0 ? 'stopped' : 'queued';
}

// ---------------------------------------------------------------------------
// FEEDBACK.md - one case
// ---------------------------------------------------------------------------

export function feedbackPath(t: Tuning, c: { id: string }): string {
    return join(t.dir, 'cases', c.id, 'FEEDBACK.md');
}

export function writeFeedback(t: Tuning, c: Case): void {
    const file = feedbackPath(t, c);
    const here = dirname(file);
    const attempts = attemptsOf(t, c);
    const latest = [...attempts].reverse().find((a) => a.feedback);
    const decided = decisions(t);
    const session = existsSync(join(t.caseDir(c), 'session'))
        ? readFileSync(join(t.caseDir(c), 'session'), 'utf8').trim()
        : undefined;
    const lines: string[] = [];
    const say = (...more: string[]): void => {
        lines.push(...more);
    };

    say(`# ${c.id}`, '', `${link('← status', here, join(t.dir, 'STATUS.md'))}`, '');
    say(
        '| Class | Complexity | Dataset rev | State | System | Session |',
        '| --- | --- | --- | --- | --- | --- |',
        `| ${cell(c.class)} | ${cell(c.complexity)} | ${c.rev} | ${cell(stateOf(t, c))} | v${t.system.version()} | ${
            session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'
        } |`,
        '',
    );
    if (c.rubric.length > 0) {
        say('## Rubric', '', ...c.rubric.map((r) => `- **${r.id}** ${r.text}`), '');
    }
    const input =
        typeof c.input === 'string'
            ? c.input
            : c.input
                  .map((p) =>
                      typeof p === 'string' ? p : 'text' in p ? p.text : `[${Object.keys(p)[0]}]`,
                  )
                  .join(' ');
    say(
        '## Input',
        '',
        ...input
            .slice(0, 800)
            .split('\n')
            .map((l) => `> ${l}`),
        '',
    );

    if (latest?.feedback) {
        const f = latest.feedback;
        say(
            `## Latest analysis - ${PHASE_WORD[latest.phase]}, try ${latest.attempt}: ${f.verdict ?? '?'}, rubric ${rubricScore(f)}${f.done ? ', done' : ''}`,
            '',
        );
        if (f.summary) {
            say(`> ${cell(f.summary)}`, '');
        }
        const id = feedbackId(c.id, latest.phase, latest.attempt, t.round(c));
        const improvements = f.improvements ?? [];
        if (improvements.length > 0) {
            say(
                '### Improvements',
                '',
                '| # | Change | File | Decision |',
                '| --- | --- | --- | --- |',
            );
            for (const i of improvements) {
                const d = decided[id]?.[i.id];
                const decision = d?.decision
                    ? `${d.decision}${d.note ? `: ${d.note}` : ''}`
                    : t.improvements.isApplied(id)
                      ? 'applied (no decision recorded)'
                      : 'waiting for an apply';
                say(`| ${cell(i.id)} | ${cell(i.change)} | ${cell(i.file)} | ${cell(decision)} |`);
            }
            say('');
        }
        const analysis = join(latest.dir, 'analysis.md');
        if (existsSync(analysis)) {
            say('### The analysis', '', readFileSync(analysis, 'utf8').trim(), '');
        }
    }

    if (attempts.length > 0) {
        say(
            '## History',
            '',
            '| Phase | Try | Verdict | Rubric | LLM calls | Tool calls | Run tokens | Analyze tokens | Seconds | System | Links |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...attempts].reverse()) {
            const links = [
                a.run ? link('run', here, a.run.dir) : '',
                a.run?.report ? link('report', here, a.run.report) : '',
                existsSync(join(a.dir, 'analysis.md'))
                    ? link('analysis', here, join(a.dir, 'analysis.md'))
                    : '',
                existsSync(join(a.dir, 'feedback.json'))
                    ? link('feedback', here, join(a.dir, 'feedback.json'))
                    : '',
            ].filter(Boolean);
            say(
                `| ${PHASE_WORD[a.phase]} | ${a.attempt} | ${cell(a.feedback?.verdict ?? (a.run ? 'analyzing' : 'running'))} | ${rubricScore(a.feedback)} | ${cell(a.run?.turns)} | ${cell(metricsOf(a.run)?.toolCalls)} | ${inOut(runByModel(a.run))} | ${inOut(envelopesIn(a.dir, 'analyze'))} | ${a.run?.durationMs ? Math.round(a.run.durationMs / 1000) : '-'} | ${a.run ? `v${a.run.system}` : '-'} | ${links.join(' · ') || '-'} |`,
            );
        }
        say('');
    }
    const byRun = tryColumns(attempts, (a) => runFlat(a.run));
    const runRows = matrix(RUN_METRICS, byRun.cols, byRun.effect);
    if (runRows.length > 0) {
        say(
            '## Metrics',
            '',
            'Each try against the one before it in its phase, the first try with memory against the passing try without; Memory effect is the latest try with memory against that same passing try. LLM and tool time are summed over parallel branches.',
            '',
            ...runRows,
        );
        const models = [
            ...new Set(attempts.flatMap((a) => Object.keys(metricsOf(a.run)?.models ?? {}))),
        ].sort();
        if (models.length > 1) {
            for (const model of models) {
                const per = tryColumns(attempts, (a) => {
                    const m = metricsOf(a.run);
                    return m && modelFlat(m.models[model]);
                });
                say(`### ${cell(model)}`, '', ...matrix(MODEL_METRICS, per.cols, per.effect));
            }
        }
    }
    const byStage = caseTokens(t, c);
    if (Object.keys(byStage).length > 0) {
        say('## Tokens', '', ...tokenTable(byStage));
    }
    const submitted = t.memories.submissions().find((s) => s.key === `${c.id}@r${c.rev}`);
    if (submitted) {
        const merges = t.memories
            .merges()
            .filter((m) => m.ok && m.includes.includes(submitted.key));
        say(
            '## Memory',
            '',
            submitted.empty
                ? `The passing run with memory (try ${submitted.attempt}) committed nothing, so there was nothing to keep.`
                : `Kept ${submitted.at.slice(0, 16).replace('T', ' ')} from the passing run with memory (try ${submitted.attempt}): ${link('the copy', here, submitted.dir)}.`,
            '',
        );
        if (!submitted.empty) {
            say(
                merges.length > 0
                    ? `In merges: ${merges.map((m) => link(m.name, here, m.dir)).join(', ')}.`
                    : 'Not merged yet.',
                '',
            );
        }
    }
    const md = `${lines.join('\n')}\n`;
    atomic(file, md);
    atomic(
        join(here, 'FEEDBACK.html'),
        markdownPage(`${c.id} - ${basename(t.root)}`, md, !t.finished && !resultOf(t, c)),
    );
}

// ---------------------------------------------------------------------------
// APPLY.md - one apply: every request, every decision, every file it changed
// ---------------------------------------------------------------------------

/** A fence longer than any run of backticks in `text`, so nothing inside can close it. */
function fence(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

export function patchFiles(
    patch: string,
): { file: string; added: number; removed: number; text: string }[] {
    return patch
        .split(/^(?=diff --git )/m)
        .filter((p) => p.startsWith('diff --git '))
        .map((text) => {
            const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(text);
            const file = (m?.[2] ?? '?').replace(/^v\d+\//, '');
            let added = 0;
            let removed = 0;
            for (const line of text.split('\n')) {
                if (line.startsWith('+++') || line.startsWith('---')) {
                    continue;
                }
                if (line.startsWith('+')) {
                    added++;
                } else if (line.startsWith('-')) {
                    removed++;
                }
            }
            return { file, added, removed, text: text.trimEnd() };
        });
}

export function applyPath(dir: string): string {
    return join(dir, 'APPLY.md');
}

export function writeApply(t: Tuning, dir: string): void {
    const name = basename(dir);
    const here = dir;
    const inputs = readJson<(Feedback & { file?: string })[]>(join(dir, 'inputs.json')) ?? [];
    const applied = readJson<AppliedFile>(join(dir, 'applied.json'));
    const failed = readJson<{ at: string; startedAt?: string; error: string }>(
        join(dir, 'failed.json'),
    );
    const decided = readJson<Decisions>(join(dir, 'decisions.json')) ?? {};
    const envelope = readJson<{ sessionId?: string; answer?: string }>(join(dir, 'apply.json'));
    const retried = existsSync(join(dir, 'apply-2.json'));
    const patch = existsSync(join(dir, 'diff.patch'))
        ? readFileSync(join(dir, 'diff.patch'), 'utf8')
        : '';
    const files = patchFiles(patch);
    const improvements = inputs.reduce((n, f) => n + f.improvements.length, 0);
    const status = failed
        ? 'failed - the project was put back as it was'
        : applied
          ? applied.skipped
              ? 'nothing to change'
              : 'applied'
          : 'in progress';
    const started =
        applied?.startedAt ??
        failed?.startedAt ??
        (existsSync(join(dir, 'inputs.json'))
            ? statSync(join(dir, 'inputs.json')).mtime.toISOString()
            : undefined);
    const finished = applied?.at ?? failed?.at;
    const when = (iso: string | undefined): string =>
        iso ? iso.slice(0, 19).replace('T', ' ') : '-';
    const took = started && finished ? since(Date.parse(finished) - Date.parse(started)) : '-';

    const tally: Record<string, number> = {};
    for (const f of inputs) {
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id]?.decision ?? 'undecided';
            tally[d] = (tally[d] ?? 0) + 1;
        }
    }

    const out: string[] = [
        `# Apply ${name}${applied ? ` - v${applied.from} → v${applied.to}` : ''}`,
        '',
        link('← status', here, join(t.dir, 'STATUS.md')),
        '',
        '| Status | Started | Finished | Took | Requests | Improvements | Files changed | Retried |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${status} | ${when(started)} | ${when(finished)} | ${took} | ${inputs.length} | ${improvements} | ${files.length} | ${retried ? 'yes - the first attempt failed zen check' : 'no'} |`,
        '',
    ];
    if (failed) {
        out.push(`> ${cell(failed.error)}`, '');
    }
    if (envelope?.sessionId) {
        out.push(
            `The apply session: \`zen meta resume ${basename(t.root)} ${envelope.sessionId}\` - ask it why it changed what it changed.`,
            '',
        );
    }
    out.push(
        '## Decisions',
        '',
        '| Applied | Merged | Rejected | Structural | Undecided |',
        '| --- | --- | --- | --- | --- |',
        `| ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.structural ?? 0} | ${tally.undecided ?? 0} |`,
        '',
        '## Requests',
        '',
    );
    inputs.forEach((f, n) => {
        const tryDir = f.file
            ? dirname(f.file)
            : t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt);
        const run = readJson<Run>(join(tryDir, 'run.json'));
        const links = [
            link('case', here, feedbackPath(t, { id: f.case })),
            existsSync(join(tryDir, 'analysis.md'))
                ? link('analysis', here, join(tryDir, 'analysis.md'))
                : '',
            existsSync(join(tryDir, 'feedback.json'))
                ? link('feedback', here, join(tryDir, 'feedback.json'))
                : '',
            run ? link('run', here, run.dir) : '',
            run?.report ? link('report', here, run.report) : '',
        ].filter(Boolean);
        out.push(
            `### ${n + 1}. ${f.case} - ${PHASE_WORD[f.phase]}, try ${f.attempt}: ${f.verdict}, rubric ${rubricScore(f)}`,
            '',
            `\`${f.id}\` · ${links.join(' · ')}`,
            '',
        );
        if (f.summary) {
            out.push(`> ${cell(f.summary)}`, '');
        }
        if (f.improvements.length === 0) {
            out.push('No improvements asked for.', '');
            return;
        }
        out.push(
            '| # | Kind | File | Change | Why | Expect | Decision | Note |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id];
            out.push(
                `| ${cell(i.id)} | ${cell(i.kind)} | ${cell(i.file)} | ${cell(i.change)} | ${cell(i.why)} | ${cell(i.expect)} | ${cell(d?.decision ?? (applied || failed ? 'undecided' : 'pending'))} | ${cell(d?.note)} |`,
            );
        }
        out.push('');
    });

    out.push('## What the apply agent did', '');
    const changes = join(dir, 'changes.md');
    out.push(
        existsSync(changes)
            ? readFileSync(changes, 'utf8').trim().replace(/^#/gm, '###')
            : '_The apply agent wrote no changes.md._',
        '',
    );
    if (envelope?.answer) {
        out.push(
            '### Its answer',
            '',
            ...envelope.answer
                .trim()
                .split('\n')
                .map((l) => `> ${l}`),
            '',
        );
    }

    out.push('## Files changed', '');
    if (files.length === 0) {
        out.push(applied ? '_None: the system is unchanged._' : '_Not yet._', '');
    } else {
        out.push(
            '| File | Added | Removed |',
            '| --- | --- | --- |',
            ...files.map((f) => `| \`${f.file}\` | +${f.added} | -${f.removed} |`),
            '',
        );
        for (const f of files) {
            const tick = fence(f.text);
            out.push(`### \`${f.file}\``, '', `${tick}diff`, f.text, tick, '');
        }
    }

    out.push('## zen check', '');
    const check = join(dir, 'check.log');
    if (existsSync(check)) {
        const tail = readFileSync(check, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
        const verdict = failed
            ? 'failed on both attempts'
            : retried
              ? 'failed once; the edit was undone and the second attempt passed'
              : applied
                ? 'passed'
                : 'running';
        const tick = fence(tail);
        out.push(verdict, '', `${tick}text`, tail || '(no output)', tick, '');
    } else {
        out.push(applied?.skipped ? '_Not run: nothing was changed._' : '_Not run yet._', '');
    }

    if (applied) {
        out.push(
            '## Cases sent back to run',
            '',
            ...inputs.map(
                (f) =>
                    `- ${link(f.case, here, feedbackPath(t, { id: f.case }))} - ${PHASE_WORD[f.phase]}, try ${f.attempt + 1} on v${applied.to}`,
            ),
            '',
        );
    }
    atomic(applyPath(dir), `${out.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// The memory section of STATUS.md
// ---------------------------------------------------------------------------

function memorySection(t: Tuning, here: string): string[] {
    const m = t.memories;
    const submissions = m.submissions();
    const merges = m.merges();
    if (submissions.length === 0 && merges.length === 0) {
        return [];
    }
    const caseLink = (key: string): string => {
        const id = key.replace(/@r\d+$/, '');
        return link(id, here, feedbackPath(t, { id }));
    };
    const waiting = m.unmerged();
    const out = [
        '## Memory',
        '',
        'No run shares a memory: every try runs on its own private directory. A case whose',
        `with-memory run passes keeps a copy of that memory; every ${t.config.mergeEvery} kept memories are`,
        'merged, with the last merge, into a new numbered graph.',
        '',
        `kept **${submissions.length}** (${submissions.filter((s) => s.empty).length} committed nothing) · merges **${merges.filter((x) => x.ok).length}** · waiting to merge **${waiting.length} of ${t.config.mergeEvery}**${waiting.length ? `: ${waiting.map((s) => caseLink(s.key)).join(', ')}` : ''}`,
        '',
    ];
    if (merges.length > 0) {
        out.push(
            '| Merge | At | Cases in it | New in this merge | Nodes | Edges | Graph | Log |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const x of [...merges].reverse()) {
            out.push(
                `| ${x.name}${x.ok ? '' : ' (failed)'} | ${x.at.slice(11, 16)} | ${x.includes.length}: ${x.includes.map(caseLink).join(', ')} | ${x.added.map(caseLink).join(', ')} | ${x.nodes ?? '-'} | ${x.edges ?? '-'} | ${x.ok ? link('graph', here, x.dir) : '-'} | ${link('log', here, x.log)} |`,
            );
        }
        out.push('');
    }
    return out;
}

// ---------------------------------------------------------------------------
// STATUS.md - the whole tuning
// ---------------------------------------------------------------------------

const STEP_CLASS: Record<Worker['step'], string> = {
    idle: 'idle',
    run: 'run',
    analyze: 'analyze',
    parked: 'parked',
};

// One diagram per worker: the path its case takes through both phases, with
// the step it is on now filled in.
function idleWord(t: Tuning): string {
    if (t.improvements.applying) {
        return 'idle - no run starts during an apply';
    }
    return t.drained ? 'idle - no case left to start' : 'idle';
}

function workerDiagram(t: Tuning, w: Worker): string[] {
    if (!w.case) {
        return [
            '```mermaid',
            'flowchart LR',
            `    w["worker ${w.slot} · ${idleWord(t)} · ${since(Date.now() - w.since)}"]`,
            '    classDef idle fill:#6e7781,color:#fff',
            '    class w idle',
            '```',
        ];
    }
    const phase = w.phase ?? 'nomem';
    const p = phase === 'mem' ? 'm' : 'n';
    const current = `${p}${w.step === 'analyze' ? 'a' : w.step === 'parked' ? 'p' : 'r'}`;
    const q = t.improvements;
    const tries = phase === 'mem' ? t.config.memTries : t.config.tries;
    const extra = (id: string): string => {
        if (id !== current) {
            return '';
        }
        const now = ` · try ${w.attempt} of ${tries} · ${since(Date.now() - w.since)}`;
        return w.step === 'parked'
            ? `${now} · queue ${q.pending.length} of ${t.config.applyAt}${q.applying ? ' · applying' : ''}`
            : now;
    };
    const node = (id: string, text: string): string => `    ${id}["${text}${extra(id)}"]`;
    const out = [
        '```mermaid',
        'flowchart LR',
        node('nr', 'no memory run'),
        node('na', 'no memory analyze'),
        node('np', 'no memory parked'),
        node('mr', 'with memory run'),
        node('ma', 'with memory analyze'),
        node('mp', 'with memory parked'),
        '    cd["completed"]',
        '    df["difficult"]',
        '    nr --> na',
        '    na -->|"passed"| mr',
        '    na -->|"failed, tries left"| np',
        '    np -->|"applied"| nr',
        '    na -->|"no tries left"| df',
        '    mr --> ma',
        '    ma -->|"cheaper"| cd',
        '    ma -->|"failed, tries left"| mp',
        '    mp -->|"applied"| mr',
        '    ma -->|"no tries left"| df',
        '    classDef run fill:#0969da,color:#fff',
        '    classDef analyze fill:#8250df,color:#fff',
        '    classDef parked fill:#9a6700,color:#fff',
        '    classDef past fill:#d0d7de,color:#24292f',
        '    classDef done fill:#1a7f37,color:#fff',
        '    classDef bad fill:#cf222e,color:#fff',
        '    class cd done',
        '    class df bad',
    ];
    if (phase === 'mem') {
        out.push('    class nr,na,np past');
    }
    out.push(`    class ${current} ${STEP_CLASS[w.step]}`, '```');
    return out;
}

function overviewDiagram(counts: Record<string, number>): string[] {
    return [
        '```mermaid',
        'flowchart LR',
        `    Q["queued · ${counts.queued}"] --> N["no memory · ${counts.nomem}"]`,
        `    N --> M["with memory · ${counts.mem}"]`,
        `    M --> C["completed · ${counts.completed}"]`,
        `    N --> D["difficult · ${counts.difficult}"]`,
        '    M --> D',
        `    Q -.-> S["stopped · ${counts.stopped}"]`,
        ...(counts.failed ? [`    N -.-> F["failed · ${counts.failed}"]`, '    M -.-> F'] : []),
        '    classDef done fill:#1a7f37,color:#fff',
        '    classDef bad fill:#cf222e,color:#fff',
        '    classDef live fill:#0969da,color:#fff',
        '    classDef broke fill:#9a6700,color:#fff',
        '    class C done',
        '    class D bad',
        '    class N,M live',
        ...(counts.failed ? ['    class F broke'] : []),
        '```',
    ];
}

const LANE: Record<Worker['step'], string> = {
    idle: 'fill:#f6f8fa,stroke:#d0d7de',
    parked: 'fill:#f6f8fa,stroke:#d0d7de',
    run: 'fill:#ddf4ff,stroke:#0969da,stroke-width:2px',
    analyze: 'fill:#fbefff,stroke:#8250df,stroke-width:2px',
};

// A subgraph linked from outside drops its own direction; invisible links keep the slots in order.
const inOrder = (prefix: string, n: number): string[] =>
    n > 1
        ? [`        ${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(' ~~~ ')}`]
        : [];

// A markdown label: real newlines, since some previews swallow `<br/>` before Mermaid sees it.
const lines = (...parts: string[]): string => `\`${parts.join('\n')}\``;

// The whole machine right now: every worker, the queue filling toward an apply, the merge.
// Each node links to what it is working on.
function systemDiagram(t: Tuning, counts: Record<string, number>): string[] {
    const q = t.improvements;
    const m = t.memories;
    const lit: Record<string, string[]> = {
        case: [],
        run: [],
        analyze: [],
        off: [],
        full: [],
        empty: [],
        busy: [],
        kept: [],
    };
    const clicks: string[] = [];
    const click = (id: string, to: string | undefined, tip: string): void => {
        if (to && (to.startsWith('#') || existsSync(to))) {
            const url = to.startsWith('#')
                ? to
                : encodeURI(relative(t.dir, to).split(sep).join('/'));
            clicks.push(`    click ${id} href "${url}" "${tip}"`);
        }
    };
    const out = [
        '```mermaid',
        '---',
        'config:',
        '  flowchart:',
        '    wrappingWidth: 480',
        '---',
        'flowchart TB',
        `    DS[("dataset · ${counts.queued} queued")] --> D["${lines('dispatcher', 'seats a case on a free worker', 'woken cases first')}"]`,
        `    subgraph WORKERS["workers · ${t.busy()} of ${t.workers.length} busy"]`,
        '        direction LR',
    ];
    click('DS', join(t.root, DATASET_DIR), 'the dataset');
    click('D', join(t.dir, 'events.jsonl'), 'every step, in order');
    const lanes: string[] = [];
    for (const w of t.workers) {
        const n = w.slot;
        const step = w.case ? w.step : 'idle';
        let label = idleWord(t);
        if (w.case) {
            const tries = w.phase === 'mem' ? t.config.memTries : t.config.tries;
            label =
                w.attempt === undefined
                    ? lines(`**${safe(w.case.id, 48)}**`, 'starting')
                    : lines(
                          `**${safe(w.case.id, 48)}**`,
                          `${PHASE_WORD[w.phase ?? 'nomem']} · try ${w.attempt} of ${tries} · ${step} ${since(Date.now() - w.since)}`,
                      );
            click(`C${n}`, feedbackPath(t, w.case), 'the case: rubric, tries, decisions');
            if (w.attempt !== undefined) {
                const dir = t.attemptDir(w.case, w.phase ?? 'nomem', w.attempt);
                const run = readJson<Run>(join(dir, 'run.json'));
                if (run) {
                    click(`R${n}`, run.report ?? run.dir, 'the run report');
                } else {
                    click(`R${n}`, join(dir, 'run.log'), 'the run log, live');
                }
                if (existsSync(join(dir, 'analysis.md'))) {
                    click(`A${n}`, join(dir, 'analysis.md'), 'the analysis');
                } else {
                    click(`A${n}`, join(dir, 'analyze.log'), 'the analysis log, live');
                }
            }
        }
        out.push(
            `        subgraph W${n}["worker ${n}"]`,
            '            direction TB',
            `            C${n}["${label}"] --> R${n}["run"] --> A${n}["analyze"]`,
            '        end',
        );
        lit[w.case ? 'case' : 'empty'].push(`C${n}`);
        lit[step === 'run' ? 'run' : 'off'].push(`R${n}`);
        lit[step === 'analyze' ? 'analyze' : 'off'].push(`A${n}`);
        lanes.push(`    style W${n} ${LANE[step]}`);
    }
    // Edges go to the box, not its nodes, so it keeps LR and the chain puts the lanes in slot order.
    out.push(
        ...inOrder('W', t.workers.length),
        '    end',
        '    D --> WORKERS',
        // Not a diamond: an edge to a box ends at the node's bounding box, short of a diamond's sides.
        '    WORKERS --> V(["feedback done?"])',
        `    V -.->|"${lines('passed without memory:', 'again with memory')}"| WORKERS`,
        `    V -->|"${lines('failed, tries left:', 'park, free the worker')}"| Q`,
        `    V -->|"no tries left"| X["difficult · ${counts.difficult}"]`,
        `    V -->|"passed with memory"| CD["completed · ${counts.completed}"]`,
        `    subgraph Q["improvement queue · ${q.pending.length} of ${t.config.applyAt}"]`,
        '        direction LR',
    );
    click('X', '#difficult-cases', 'the difficult cases');
    click('CD', '#cases', 'every case');
    const slots = Math.max(t.config.applyAt, q.pending.length);
    for (let i = 0; i < slots; i++) {
        const f = q.pending[i];
        out.push(
            f
                ? `        Q${i + 1}["${lines(`**${safe(f.case, 40)}**`, `${PHASE_WORD[f.phase]} try ${f.attempt} · ${f.improvements.length} improvement(s)`)}"]`
                : `        Q${i + 1}["empty"]`,
        );
        lit[f ? 'full' : 'empty'].push(`Q${i + 1}`);
        if (f) {
            const dir = t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt);
            click(`Q${i + 1}`, join(dir, 'analysis.md'), 'the analysis asking for these');
        }
    }
    out.push(...inOrder('Q', slots));

    const last = q.applies().at(-1);
    const applier = !q.applying
        ? `idle${last ? ` · last ${last.name}` : ''}`
        : q.inApply.length > 0
          ? `applying ${q.inApply.length} request(s) · no run starts`
          : 'waiting for runs · no run starts';
    out.push(
        '    end',
        // AP's own nodes link outside, so Mermaid cannot end an edge on the AP box itself.
        '    Q -->|"full, or nothing left to start"| P1',
        `    subgraph AP["applier · ${applier}"]`,
        `        P1["wait for runs in flight · ${q.runs}"] --> P2["${lines('meta run /finetune-apply', 'then zen check')}"]`,
        `        P2 --> P3["${lines('applied.json', 'wake the batch')}"]`,
        '    end',
        `    P2 -->|"writes the next version"| S[("${lines(`system prose · v${t.system.version()}`, 'read by every new run')}")]`,
        '    P3 -->|"wake"| D',
    );
    const active = !q.applying ? undefined : q.runs > 0 ? 'P1' : 'P2';
    for (const p of ['P1', 'P2', 'P3']) {
        lit[p === active ? 'busy' : 'off'].push(p);
    }
    if (last) {
        click('P2', applyPath(last.dir), q.applying ? 'this apply' : 'the last apply');
        click('P3', join(last.dir, 'diff.patch'), 'what the last apply changed');
    }
    click('S', t.system.snapshotDir(t.system.version()), 'this version of the prose');

    const waiting = m.unmerged();
    const kept = Math.max(t.config.mergeEvery, waiting.length);
    out.push(
        '    CD -->|"keep its memory"| M',
        `    subgraph M["memory to merge · ${waiting.length} of ${t.config.mergeEvery}"]`,
        '        direction LR',
    );
    for (let i = 0; i < kept; i++) {
        const s = waiting[i];
        out.push(`        K${i + 1}["${s ? safe(s.case, 40) : 'empty'}"]`);
        lit[s ? 'kept' : 'empty'].push(`K${i + 1}`);
        if (s) {
            click(`K${i + 1}`, s.dir, 'the kept memory');
        }
    }
    const merged = m.merges().filter((x) => x.ok);
    click('MG', merged.at(-1)?.dir, 'the latest merged graph');
    out.push(
        ...inOrder('K', kept),
        '    end',
        `    M -->|"full, or tuning ends"| MG[("merged graphs · ${merged.length}")]`,
        ...clicks,
        '    classDef case fill:#ffffff,stroke:#57606a,color:#24292f',
        '    classDef run fill:#0969da,stroke:#0550ae,color:#ffffff',
        '    classDef analyze fill:#8250df,stroke:#6639ba,color:#ffffff',
        '    classDef off fill:#ffffff,stroke:#d0d7de,color:#8c959f',
        '    classDef full fill:#d4a72c,stroke:#9a6700,color:#ffffff',
        '    classDef empty fill:#ffffff,stroke:#d0d7de,stroke-dasharray:4 3,color:#8c959f',
        '    classDef busy fill:#e16f24,stroke:#bc4c00,color:#ffffff',
        '    classDef kept fill:#1b7c83,stroke:#136061,color:#ffffff',
        '    classDef done fill:#1a7f37,stroke:#116329,color:#ffffff',
        '    classDef bad fill:#cf222e,stroke:#a40e26,color:#ffffff',
        '    classDef store fill:#ddf4ff,stroke:#54aeff,color:#0a3069',
        '    classDef hub fill:#eaeef2,stroke:#57606a,color:#24292f',
        ...Object.entries(lit)
            .filter(([, ids]) => ids.length > 0)
            .map(([cls, ids]) => `    class ${ids.join(',')} ${cls}`),
        '    class CD done',
        '    class X bad',
        '    class DS,S,MG store',
        '    class D,V hub',
        '    style WORKERS fill:#ffffff,stroke:#8c959f',
        ...lanes,
        `    style Q fill:#fff8c5,stroke:#d4a72c${q.pending.length >= t.config.applyAt ? ',stroke-width:3px' : ''}`,
        `    style AP ${q.applying ? 'fill:#fff1e5,stroke:#e16f24,stroke-width:3px' : 'fill:#f6f8fa,stroke:#d0d7de'}`,
        '    style M fill:#e6f6f5,stroke:#1b7c83',
        '```',
    );
    const running = lit.run.length;
    const analyzing = lit.analyze.length;
    const now = [
        running > 0 && `- **Blue** - ${running} worker(s) running a case`,
        analyzing > 0 && `- **Purple** - ${analyzing} worker(s) analyzing the run just finished`,
        q.applying &&
            '- **Orange** - fixes are being applied to the agent instructions; no new run starts until that is done',
        q.pending.length > 0 &&
            `- **Yellow** - ${q.pending.length} failed case(s) waiting for fixes; they are applied when ${t.config.applyAt} wait, or when no other case can run`,
        waiting.length > 0 &&
            `- **Teal** - memory from ${waiting.length} passed case(s) waiting to be merged; merged when ${t.config.mergeEvery} wait`,
    ].filter((x): x is string => typeof x === 'string');
    return [
        ...(now.length > 0 ? ['Now:', '', ...now] : ['Nothing is in progress right now.']),
        '',
        'Click a box to open it.',
        '',
        ...out,
    ];
}

function summarySection(
    spent: Record<Phase, { runs: number; f: Flat }>,
    tuning: { passed: number; first: number; before: Flat; after: Flat },
    memory: { cases: number; cheaper: number; before: Flat; after: Flat },
): string[] {
    const phases = (['nomem', 'mem'] as const).filter((p) => spent[p].runs > 0);
    if (phases.length === 0) {
        return [];
    }
    const row = (label: string, runs: number, f: Flat): string =>
        `| ${label} | ${runs} | ${since(f.wallMs)} | ${f.calls} | ${f.tools} | ${short(f.input)} | ${short(f.cached)} | ${short(f.output)} | ${short(Math.round(tokensIn(f) / runs))} / ${since(f.wallMs / runs)} |`;
    const out = [
        '## Summary',
        '',
        `Trend compares totals over the same cases; within ${SAME}% is \`same\`. Run time is the wall clock of \`zen run\`.`,
        '',
        '| Phase | Runs | Run time | LLM calls | Tool calls | Input | Cached | Output | Per run: tokens / time |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...phases.map((p) => row(PHASE_WORD[p], spent[p].runs, spent[p].f)),
        ...(phases.length > 1
            ? [
                  row(
                      '**total**',
                      spent.nomem.runs + spent.mem.runs,
                      addFlat(spent.nomem.f, spent.mem.f),
                  ),
              ]
            : []),
        '',
    ];
    if (tuning.passed > 0) {
        const fixed = tuning.passed - tuning.first;
        out.push(
            '### Tuning effect - first try without memory → passing try',
            '',
            `${tuning.passed} case(s) passed without memory, ${tuning.first} on the first try.${fixed > 0 ? ` The ${fixed} that needed fixes, totalled:` : ''}`,
            '',
            ...(fixed > 0
                ? compareTable('First try', 'Passing try', tuning.before, tuning.after)
                : []),
        );
    }
    if (memory.cases > 0) {
        out.push(
            '### Memory effect - passing try without memory → passing try with memory',
            '',
            `${memory.cases} completed case(s), cheaper in tokens with memory in ${memory.cheaper}. Totalled:`,
            '',
            ...compareTable('Without memory', 'With memory', memory.before, memory.after),
        );
    }
    return out;
}

export function writeStatus(t: Tuning): void {
    const here = t.dir;
    const cases = selection(t);
    const store = DatasetStore.open(t.root);
    const counts = {
        queued: 0,
        nomem: 0,
        mem: 0,
        completed: 0,
        difficult: 0,
        failed: 0,
        stopped: 0,
    };
    const rows: string[] = [];
    const difficult: string[] = [];
    const failed: string[] = [];
    let everything: ByStage = {};
    const spent: Record<Phase, { runs: number; f: Flat }> = {
        nomem: { runs: 0, f: blank() },
        mem: { runs: 0, f: blank() },
    };
    const tuning = { passed: 0, first: 0, before: blank(), after: blank() };
    const memory = { cases: 0, cheaper: 0, before: blank(), after: blank() };
    for (const c of cases) {
        const w = t.workers.find((x) => x.case?.id === c.id);
        const parked =
            t.improvements.pending.find((f) => f.case === c.id) ??
            t.improvements.inApply.find((f) => f.case === c.id);
        const r = resultOf(t, c);
        const attempts = attemptsOf(t, c);
        if (r) {
            counts[r.state]++;
        } else if (w) {
            counts[w.phase ?? 'nomem']++;
        } else if (parked) {
            counts[parked.phase]++;
        } else if (attempts.length > 0 && !t.claimed.has(c.id)) {
            counts.stopped++;
        } else {
            counts.queued++;
        }
        const nomem = attempts.filter((a) => a.phase === 'nomem');
        const mem = attempts.filter((a) => a.phase === 'mem');
        const last = [...attempts].reverse().find((a) => a.feedback);
        const calls = nomem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const memCalls = mem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const caseBy = caseTokens(t, c);
        everything = mergeStages(everything, caseBy);
        for (const a of attempts) {
            const f = runFlat(a.run);
            if (f) {
                spent[a.phase].runs++;
                spent[a.phase].f = addFlat(spent[a.phase].f, f);
            }
        }
        const passed = passedWithout(attempts);
        const firstFlat = runFlat(nomem[0]?.run);
        const passedFlat = runFlat(passed?.run);
        if (passed) {
            tuning.passed++;
        }
        if (passed?.attempt === 1) {
            tuning.first++;
        } else if (firstFlat && passedFlat) {
            tuning.before = addFlat(tuning.before, firstFlat);
            tuning.after = addFlat(tuning.after, passedFlat);
        }
        const withMem = runFlat(
            r?.state === 'completed'
                ? mem.find((a) => a.feedback?.done)?.run
                : latestWith(attempts)?.run,
        );
        if (r?.state === 'completed' && withMem && passedFlat) {
            memory.cases++;
            memory.cheaper += tokensIn(withMem) < tokensIn(passedFlat) ? 1 : 0;
            memory.before = addFlat(memory.before, passedFlat);
            memory.after = addFlat(memory.after, withMem);
        }
        const effect =
            withMem && passedFlat
                ? `${change('tokens', tokensIn(withMem), tokensIn(passedFlat))} tokens · ${change('time', withMem.wallMs, passedFlat.wallMs)} time${r?.state === 'completed' ? '' : ' (so far)'}`
                : '-';
        rows.push(
            `| ${link(c.id, here, feedbackPath(t, c))} | ${cell(c.class)} | ${c.rubric.length} | ${cell(stateOf(t, c))} | ${nomem.length} / ${mem.length} | ${cell(last?.feedback?.verdict)} ${rubricScore(last?.feedback)} | ${calls.length ? `${calls[0]} → ${calls.at(-1)}` : '-'} | ${memCalls.length ? memCalls.at(-1) : '-'} | ${effect} | ${inOut(caseBy.run)} | ${inOut(caseBy.analyze)} | ${attempts.at(-1)?.run ? `v${attempts.at(-1)!.run!.system}` : '-'} |`,
        );
        if (r?.state === 'difficult') {
            difficult.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${PHASE_WORD[r.phase]} | ${cell(r.reason)} | ${r.phase === 'nomem' ? nomem.length : mem.length} | ${cell(last?.feedback?.summary)} | ${last && existsSync(join(last.dir, 'analysis.md')) ? link('last analysis', here, join(last.dir, 'analysis.md')) : '-'} |`,
            );
        }
        if (r?.state === 'failed') {
            failed.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${PHASE_WORD[r.phase]}, try ${(r.phase === 'nomem' ? nomem : mem).length || 1} | ${cell(r.reason)} | ${r.at.slice(11, 16)} |`,
            );
        }
    }

    const done = counts.completed + counts.difficult;
    const bar = cases.length ? Math.round((done / cases.length) * 20) : 0;
    const state = t.finished ? 'finished' : t.stopping ? 'stopping' : 'running';
    const q = t.improvements;
    const out: string[] = [
        `# Fine-tuning - ${basename(t.root)}`,
        '',
        `**${state}** · started ${new Date(t.startedAt).toISOString().slice(0, 16).replace('T', ' ')} · elapsed ${since(Date.now() - t.startedAt)} · updated ${new Date().toISOString().slice(11, 19)}`,
        `system **v${t.system.version()}** (applies: ${q.applies().length}) · dataset rev **${store.manifest.revision}** · workers **${t.workers.filter((w) => w.case).length} / ${t.workers.length}** · apply at **${t.config.applyAt}** · tries ${t.config.tries} without memory, ${t.config.memTries} with`,
        '',
        `\`${'█'.repeat(bar)}${'░'.repeat(20 - bar)}\` ${done} of ${cases.length} cases done - ${counts.completed} completed, ${counts.difficult} difficult${counts.failed ? ` · ${counts.failed} failed, they resume at the next start` : ''}`,
        '',
        ...summarySection(spent, tuning, memory),
        '## Overview',
        '',
        ...overviewDiagram(counts),
        '',
        '## System',
        '',
        ...systemDiagram(t, counts),
        '',
        '## Workers',
        '',
        ...t.workers.flatMap((w) => [
            `### Worker ${w.slot}${w.case ? ` - ${link(w.case.id, here, feedbackPath(t, w.case))}` : ''}`,
            '',
            ...workerDiagram(t, w),
            '',
            ...(w.case ? tokenTable(caseTokens(t, w.case)) : []),
        ]),
        '| Worker | Case | Class | Phase | Try | Step | Since | Run | Analysis | Session |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const w of t.workers) {
        if (!w.case) {
            out.push(
                `| ${w.slot} | - | - | - | - | ${idleWord(t)} | ${since(Date.now() - w.since)} | - | - | - |`,
            );
            continue;
        }
        const dir = t.attemptDir(w.case, w.phase ?? 'nomem', w.attempt ?? 1);
        const run = readJson<Run>(join(dir, 'run.json'));
        const session = existsSync(join(t.caseDir(w.case), 'session'))
            ? readFileSync(join(t.caseDir(w.case), 'session'), 'utf8').trim()
            : undefined;
        out.push(
            `| ${w.slot} | ${link(w.case.id, here, feedbackPath(t, w.case))} | ${cell(w.case.class)} | ${PHASE_WORD[w.phase ?? 'nomem']} | ${w.attempt} / ${w.phase === 'mem' ? t.config.memTries : t.config.tries} | ${w.step} | ${since(Date.now() - w.since)} | ${run ? `${link('run', here, run.dir)}${run.report ? ` · ${link('report', here, run.report)}` : ''}` : '-'} | ${existsSync(join(dir, 'analysis.md')) ? link('analysis', here, join(dir, 'analysis.md')) : '-'} | ${session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'} |`,
        );
    }

    out.push('', `## Improvement queue - ${q.pending.length} of ${t.config.applyAt} parked`, '');
    out.push(
        q.applying
            ? 'Applying now: no new run starts until it is done.'
            : `A parked case gives its worker back, so another case runs meanwhile. The next apply comes when ${Math.max(0, t.config.applyAt - q.pending.length)} more park, or once nothing is running and no case is left to start; woken cases take a worker before new ones.`,
        '',
    );
    if (q.pending.length > 0) {
        out.push(
            '| Request | Case | Phase | Try | Improvements | Summary |',
            '| --- | --- | --- | --- | --- | --- |',
        );
        for (const f of q.pending) {
            out.push(
                `| ${cell(f.id)} | ${link(f.case, here, feedbackPath(t, { id: f.case }))} | ${PHASE_WORD[f.phase]} | ${f.attempt} | ${f.improvements.length} | ${cell(f.summary)} |`,
            );
        }
        out.push('');
    }

    const applies = q.applies();
    if (applies.length > 0) {
        out.push(
            '## Applies',
            '',
            'Each apply links to its own page: every request, every decision, every file changed and why.',
            '',
            '| Apply | Versions | At | Requests | Applied | Merged | Rejected | Structural | Files changed | Tokens | Details |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...applies].reverse()) {
            const d = readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {};
            const tally: Record<string, number> = {};
            for (const byImprovement of Object.values(d)) {
                for (const x of Object.values(byImprovement)) {
                    tally[x.decision ?? '?'] = (tally[x.decision ?? '?'] ?? 0) + 1;
                }
            }
            const patch = join(a.dir, 'diff.patch');
            const files = existsSync(patch)
                ? (readFileSync(patch, 'utf8').match(/^diff --git /gm) ?? []).length
                : 0;
            const details = [
                existsSync(join(a.dir, 'changes.md'))
                    ? link('changes', here, join(a.dir, 'changes.md'))
                    : '',
                existsSync(patch) ? link('diff', here, patch) : '',
                existsSync(join(a.dir, 'decisions.json'))
                    ? link('decisions', here, join(a.dir, 'decisions.json'))
                    : '',
            ].filter(Boolean);
            out.push(
                `| ${link(a.name, here, applyPath(a.dir))} | ${a.applied ? `v${a.applied.from} → v${a.applied.to}` : existsSync(join(a.dir, 'failed.json')) ? 'failed' : 'in progress'} | ${a.applied?.at.slice(11, 16) ?? '-'} | ${a.inputs?.length ?? 0} | ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.structural ?? 0} | ${files} | ${inOut(envelopesIn(a.dir, 'apply'))} | ${details.join(' · ') || (a.applied?.skipped ? 'nothing to change' : '-')} |`,
            );
        }
        out.push('');
    }

    const allStages = mergeStages(everything, {
        apply: mergeModels(...applies.map((a) => envelopesIn(a.dir, 'apply'))),
    });
    const tokenRows = tokenTable(allStages);
    if (tokenRows.length > 0) {
        out.push(
            '## Tokens',
            '',
            'Every try of every case so far, and every apply.',
            '',
            ...tokenRows,
        );
    }

    out.push(...memorySection(t, here));

    out.push(
        '## Cases',
        '',
        '| Case | Class | Rubric | State | Tries without / with | Last verdict | LLM calls without memory | With memory | Memory effect | Run tokens | Analyze tokens | System |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    );
    if (difficult.length > 0) {
        out.push(
            '## Difficult cases',
            '',
            '| Case | Phase | Reason | Tries | Last summary | Details |',
            '| --- | --- | --- | --- | --- | --- |',
            ...difficult,
            '',
        );
    }
    if (failed.length > 0) {
        out.push(
            '## Failed cases',
            '',
            'Something outside the prose broke - the sandbox, a provider, a key - so these taught nothing. They keep their tries and carry on from the step that failed at the next `zen meta finetune start`.',
            '',
            '| Case | Stopped at | Reason | At |',
            '| --- | --- | --- | --- |',
            ...failed,
            '',
        );
    }
    out.push('## Recent events', '');
    for (const e of t.recent.slice(0, 20)) {
        const who = [
            e.worker ? `worker ${e.worker}` : '',
            e.case ?? '',
            e.phase ? `${PHASE_WORD[e.phase]}${e.attempt ? ` try ${e.attempt}` : ''}` : '',
        ].filter(Boolean);
        out.push(
            `- ${e.at.slice(11, 19)} · ${[...who, e.what].join(' · ')}${e.detail ? ` - ${cell(e.detail)}` : ''}`,
        );
    }
    out.push(
        `- … everything in ${link('events.jsonl', here, join(t.dir, 'events.jsonl'))}`,
        '',
        '## Files',
        '',
        '- `cases/<id>/FEEDBACK.md` - one case: rubric, latest analysis, decisions, history',
        '- `cases/<id>/r<rev>/<NN>-<phase>/` - one try: `request.json`, `run.json`, `memory/`, `workspace/`, `feedback.json`, `analysis.md`, logs',
        '- `applies/<NNN>/APPLY.md` - one apply: requests, decisions, files changed with their diffs, zen check',
        '- `applies/<NNN>/` - `inputs.json`, `apply.log`, `check.log`, `changes.md`, `decisions.json`, `diff.patch`',
        '- `memories/` - `submissions.jsonl`, `merges.jsonl`, `submitted/<case>@r<rev>/`, `merged/mNN/`',
        '- `systems/` - `systems.jsonl` and a copy of `agents.yaml` + `agents/` per version',
        '- `events.jsonl` - every step, in order; `loop.json` - the settings',
        '- `journal.jsonl` - steps begun and not yet closed; a restart rolls back what a kill cut off',
        '- `STATUS.html`, `cases/<id>/FEEDBACK.html` - the same pages, rendered for a browser',
        '',
    );
    const md = `${out.join('\n')}\n`;
    atomic(join(t.dir, 'STATUS.md'), md);
    atomic(
        join(t.dir, 'STATUS.html'),
        markdownPage(`Fine-tuning - ${basename(t.root)}`, md, !t.finished),
    );
}

// ---------------------------------------------------------------------------
// STATUS.html, FEEDBACK.html - the same Markdown, rendered in the browser
// ---------------------------------------------------------------------------

const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js';
const PURIFY_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.es.mjs';

// As in neo's inspect page: no byte of the payload can close the script element.
const embed = (v: unknown): string =>
    JSON.stringify(v)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

export function markdownPage(title: string, md: string, live: boolean): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${live ? '<meta http-equiv="refresh" content="10">\n' : ''}<title>${title.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#24292f}
main{margin-left:240px;padding:1em 2em;max-width:1600px}
#toc{position:fixed;top:0;left:0;bottom:0;width:220px;overflow:auto;padding:1em 6px;box-sizing:border-box;border-right:1px solid #d0d7de;background:#f6f8fa;font-size:13px}
#toc a{display:block;padding:2px 8px;border-radius:4px;color:#24292f;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#toc a.top{font-weight:600;margin-bottom:6px}
#toc a.sub{padding-left:22px;color:#57606a}
#toc a:hover{background:#eaeef2}
#toc a.on{background:#ddf4ff;color:#0969da;font-weight:600}
h1,h2,h3{scroll-margin-top:8px}
@media (max-width:800px){#toc{display:none}main{margin-left:0}}
table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top}
th{background:#f6f8fa}code{background:#f6f8fa;padding:0 4px;border-radius:4px}
pre{background:#f6f8fa;padding:8px;overflow:auto}pre.mermaid{background:none}
a{color:#0969da}
</style>
</head>
<body>
<nav id="toc"></nav>
<main id="doc">loading…</main>
<script id="md" type="application/json">${embed(md)}</script>
<script type="module">
const md = JSON.parse(document.getElementById('md').textContent);
const [{ marked }, { default: DOMPurify }, { default: mermaid }] = await Promise.all([
    import(${embed(MARKED_URL)}),
    import(${embed(PURIFY_URL)}),
    import(${embed(MERMAID_URL)}),
]);
const doc = document.getElementById('doc');
doc.innerHTML = DOMPurify.sanitize(marked.parse(md));
// GitHub's slugs, so the diagrams' #anchors land as they do in the .md.
for (const h of doc.querySelectorAll('h1, h2, h3, h4')) {
    h.id = h.textContent.trim().toLowerCase().replace(/[^\\w\\s-]/g, '').replace(/\\s/g, '-');
}
const toc = document.getElementById('toc');
const heads = [...doc.querySelectorAll('h1, h2, h3')];
for (const h of heads) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;
    a.title = h.textContent;
    a.className = h.tagName === 'H1' ? 'top' : h.tagName === 'H3' ? 'sub' : '';
    toc.append(a);
}
for (const code of doc.querySelectorAll('code.language-mermaid')) {
    const pre = document.createElement('pre');
    pre.className = 'mermaid';
    pre.textContent = code.textContent;
    code.parentElement.replaceWith(pre);
}
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
await mermaid.run({ querySelector: 'pre.mermaid' });
// A page with an .html twin links to it; any other .md opens as the file it is.
for (const a of doc.querySelectorAll('a')) {
    for (const at of ['href', 'xlink:href']) {
        const v = a.getAttribute(at);
        if (v) {
            a.setAttribute(at, v.replace(/(^|\\/)(STATUS|FEEDBACK)\\.md(?=#|$)/, '$1$2.html'));
        }
    }
}
// The live refresh would otherwise drop the reader back at the top every 10 s.
const key = 'scroll:' + location.pathname;
history.scrollRestoration = 'manual';
addEventListener('beforeunload', () => sessionStorage.setItem(key, String(scrollY)));
const kept = sessionStorage.getItem(key);
if (kept !== null) {
    scrollTo(0, Number(kept));
} else if (location.hash) {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}
const mark = () => {
    let current = heads[0];
    for (const h of heads) {
        if (h.getBoundingClientRect().top > 80) break;
        current = h;
    }
    for (const a of toc.children) {
        a.classList.toggle('on', a.hash === '#' + current?.id);
    }
    const on = toc.querySelector('a.on');
    if (on && (on.offsetTop < toc.scrollTop || on.offsetTop + on.offsetHeight > toc.scrollTop + toc.clientHeight)) {
        toc.scrollTop = on.offsetTop - toc.clientHeight / 2;
    }
};
addEventListener('scroll', mark, { passive: true });
mark();
</script>
</body>
</html>
`;
}
