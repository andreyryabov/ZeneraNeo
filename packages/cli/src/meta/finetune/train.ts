import type { TokenUsage } from '@zenera/neo';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { sessionKept } from '../tokens.ts';
import { batchInput } from './dataset/export.ts';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { type Feedback, type Phase, readFeedback } from './feedback.ts';
import { caseTokens, writeFeedback } from './report.ts';
import type { Result } from './sampler.ts';
import { readJson, type Seat, type Tuning } from './tuning.ts';
import { type ByModel, type RunMetrics, runMetrics, tokensOf } from './usage.ts';

// ---------------------------------------------------------------------------
// One case, start to finish
//
// `train` is the whole method: tries without memory until the case passes,
// then tries with the memory that passing run wrote. Every step leaves its
// result in the attempt's folder and is skipped when that result is already
// there, so calling `train` again after a stop carries on where it was.
// ---------------------------------------------------------------------------

export async function train(t: Tuning, s: Seat, c: Case): Promise<void> {
    let passed: Run | undefined;
    for (let attempt = 1; attempt <= t.config.tries; attempt++) {
        const run = await zenRun(t, s, c, 'nomem', attempt);
        const feedback = await analyze(t, s, c, 'nomem', attempt, run);
        if (feedback.done) {
            passed = run;
            break;
        }
        if (attempt < t.config.tries) {
            await t.improvements.apply(feedback, s);
        }
    }
    if (!passed) {
        return markDifficult(t, c, 'nomem', 'wrong');
    }

    let cheaper = false;
    for (let attempt = 1; attempt <= t.config.memTries; attempt++) {
        const run = await zenRun(t, s, c, 'mem', attempt, passed.memory);
        const feedback = await analyze(t, s, c, 'mem', attempt, run);
        if (feedback.done) {
            cheaper = true;
            t.memories.submit(c, attempt, run);
            break;
        }
        if (attempt < t.config.memTries) {
            await t.improvements.apply(feedback, s);
        }
    }
    if (!cheaper) {
        return markDifficult(t, c, 'mem', 'memory');
    }

    markCompleted(t, c);
}

// ---------------------------------------------------------------------------
// zen run
// ---------------------------------------------------------------------------

export interface Run {
    /** the run directory under sessions/ */
    dir: string;
    /** the memory it ran with and committed into */
    memory: string;
    /** its own empty directory, the root of the agent's file tools */
    workspace?: string;
    /** the system version it ran on */
    system: number;
    report?: string;
    graph?: string;
    /** the run's own error, when it failed - still worth analyzing */
    failed?: string;
    turns?: number;
    usage?: TokenUsage;
    /** per model, from the run's trajectory */
    tokens?: ByModel;
    metrics?: RunMetrics;
    durationMs?: number;
}

export class VoidRun extends Error {}

/** Killed for memory, or nothing to show for it: the run says nothing about the prose. */
const VOIDS = 3;

async function zenRun(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    memory?: string,
): Promise<Run> {
    const dir = t.attemptDir(c, phase, attempt);
    const file = join(dir, 'run.json');
    for (let tries = 1; !existsSync(file); tries++) {
        if (tries > VOIDS) {
            throw new VoidRun(`${VOIDS} runs in a row were void`);
        }
        await t.improvements.notApplying();
        t.at(s, phase, attempt, 'run');
        t.improvements.runs++;
        try {
            const why = await t.journal.step({ kind: 'run', dir }, () =>
                runOnce(t, c, dir, memory),
            );
            if (why) {
                t.event({
                    what: 'void',
                    worker: s.worker?.slot,
                    case: c.id,
                    phase,
                    attempt,
                    detail: why,
                });
            }
        } finally {
            t.improvements.runs--;
        }
    }
    return readJson<Run>(file)!;
}

/** One `zen run`. Writes run.json, or says why the run was void. */
async function runOnce(
    t: Tuning,
    c: Case,
    dir: string,
    memory?: string,
): Promise<string | undefined> {
    mkdirSync(dir, { recursive: true });
    const mem = join(dir, 'memory');
    rmSync(mem, { recursive: true, force: true });
    if (memory && existsSync(memory)) {
        cpSync(memory, mem, { recursive: true, filter: (src) => basename(src) !== '.lock' });
    }
    // Else `zen run` roots the agent's files at its cwd: the project, shared by every run.
    const workspace = join(dir, 'workspace');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const request = join(dir, 'request.json');
    const envelope = join(dir, 'envelope.json');
    const events = join(dir, 'events.jsonl');
    rmSync(envelope, { force: true });
    rmSync(events, { force: true });
    writeFileSync(
        request,
        `${JSON.stringify({ input: batchInput([c], t.root, request).batch[0].input }, null, 2)}\n`,
    );

    const log = join(dir, 'run.log');
    const from = existsSync(log) ? statSync(log).size : 0;
    await t.zen(
        [
            'run',
            '--plain',
            '--new',
            '--yes',
            '--json',
            '--input',
            request,
            '--memory',
            mem,
            '--workspace',
            workspace,
            '--out',
            envelope,
            '--events',
            events,
        ],
        log,
    );

    const out = readJson<{ run?: { dir: string; report?: string; graph?: string } }>(envelope);
    let runDir = out?.run?.dir;
    let failed: string | undefined;
    if (!runDir) {
        // A failed run throws before the envelope; its directory is in the hint.
        const text = existsSync(log) ? readFileSync(log).subarray(from).toString('utf8') : '';
        const report = /report: (\S+report\.html)/.exec(text)?.[1];
        if (!report) {
            return 'no run directory';
        }
        runDir = dirname(report);
        failed = /error\s+(.+)/.exec(text)?.[1]?.trim() ?? 'the run failed';
    }
    const graph = join(runDir, 'graph.mmd');
    if (existsSync(graph) && /exit code 137/.test(readFileSync(graph, 'utf8'))) {
        return 'a command was killed for memory (exit 137)';
    }
    const meta = readJson<{
        turns?: number;
        usage?: TokenUsage;
        durationMs?: number;
        error?: string;
    }>(join(runDir, 'meta.json'));
    const metrics = runMetrics(runDir);
    const run: Run = {
        dir: runDir,
        memory: mem,
        workspace,
        system: t.system.version(),
        ...(existsSync(join(runDir, 'report.html')) ? { report: join(runDir, 'report.html') } : {}),
        ...(existsSync(graph) ? { graph } : {}),
        ...(failed || meta?.error ? { failed: failed ?? meta?.error } : {}),
        ...(meta?.turns !== undefined ? { turns: meta.turns } : {}),
        ...(meta?.usage ? { usage: meta.usage } : {}),
        ...(metrics ? { tokens: tokensOf(metrics), metrics } : {}),
        ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
    };
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    return undefined;
}

// ---------------------------------------------------------------------------
// zen meta run /analyze
// ---------------------------------------------------------------------------

/** The case keeps one analyze session per revision, so each analysis remembers the last. */
export function sessionOf(t: Tuning, c: Case): string | undefined {
    const file = join(t.caseDir(c), 'session');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}

async function analyze(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    run: Run,
): Promise<Feedback> {
    const dir = t.attemptDir(c, phase, attempt);
    const file = join(dir, 'feedback.json');
    const known = { case: c.id, caseRev: c.rev, phase, attempt };
    const kept = readFeedback(file, known);
    let feedback: Feedback;
    if ('feedback' in kept) {
        feedback = kept.feedback;
    } else {
        t.checkStopping();
        t.at(s, phase, attempt, 'analyze');
        feedback = await t.journal.step({ kind: 'analyze', dir }, () =>
            analyzeOnce(t, s, c, phase, attempt, run, file),
        );
    }
    writeFeedback(t, c);
    return feedback;
}

async function analyzeOnce(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    run: Run,
    file: string,
): Promise<Feedback> {
    const dir = dirname(file);
    const known = { case: c.id, caseRev: c.rev, phase, attempt };
    let session = sessionOf(t, c);
    if (!session) {
        session = randomUUID();
        mkdirSync(t.caseDir(c), { recursive: true });
        writeFileSync(join(t.caseDir(c), 'session'), `${session}\n`);
    }
    const hash = t.system.hash();
    const applies = t.improvements.started;
    const events = join(dir, 'analyze.events.jsonl');
    rmSync(events, { force: true });
    const continuing = (): string[] => [
        'meta',
        'run',
        '--no-refresh',
        '--json',
        '--events',
        events,
        ...(sessionKept(session!) ? ['--resume', session!] : ['--session-id', session!]),
    ];

    const res = await t.zen(
        [
            ...continuing(),
            '/analyze',
            run.dir,
            `case=${c.id}`,
            `rev=${c.rev}`,
            `phase=${phase}`,
            `attempt=${attempt}`,
            `feedback=${file}`,
        ],
        join(dir, 'analyze.log'),
    );
    keepAnalysis(dir, res.stdout);

    const rubricIds = c.rubric.map((r) => r.id);
    let read = readFeedback(file, known, rubricIds);
    if (!('feedback' in read)) {
        const again = await t.zen(
            [
                ...continuing(),
                `The feedback file ${file} is ${read.problem}. Write it again exactly as section 7 of the zen-analyze-run skill describes, then stop.`,
            ],
            join(dir, 'analyze.log'),
        );
        keepAnalysis(dir, again.stdout, false);
        read = readFeedback(file, known, rubricIds);
    }
    // Any apply that overlapped this analysis owns the change; undoing it would gut the apply.
    const overlapped = t.improvements.applying || t.improvements.started !== applies;
    if (t.system.hash() !== hash && !overlapped) {
        t.system.restore(t.system.version());
        t.event({
            what: 'analyze edited the system - undone',
            worker: s.worker?.slot,
            case: c.id,
            phase,
            attempt,
        });
    }
    if (!('feedback' in read)) {
        throw new Error(`analysis wrote no usable feedback (${read.problem})`);
    }
    note(t, c, read.feedback, run, session);
    return read.feedback;
}

/** The meta agent's answer is the human report: kept as analysis.md beside the feedback. A retry keeps its own envelope, so its tokens are counted too. */
function keepAnalysis(dir: string, stdout: string, replace = true): void {
    let envelope: { answerFile?: string } | undefined;
    try {
        envelope = JSON.parse(stdout) as { answerFile?: string };
    } catch {
        return;
    }
    writeFileSync(join(dir, replace ? 'analyze.json' : 'analyze-2.json'), stdout);
    if (
        envelope.answerFile &&
        existsSync(envelope.answerFile) &&
        (replace || !existsSync(join(dir, 'analysis.md')))
    ) {
        copyFileSync(envelope.answerFile, join(dir, 'analysis.md'));
    }
}

function note(t: Tuning, c: Case, f: Feedback, run: Run, session: string): void {
    const ids = new Set(c.rubric.map((r) => r.id));
    const rubric = Object.fromEntries(Object.entries(f.rubric).filter(([id]) => ids.has(id)));
    DatasetStore.open(t.root).note(c.id, {
        type: 'note',
        at: new Date().toISOString(),
        kind: 'graded',
        caseRev: c.rev,
        run: run.dir,
        verdict: f.verdict,
        ...(Object.keys(rubric).length > 0 ? { rubric } : {}),
        text: f.summary || f.verdict,
        by: { session, prompt: 'analyze', host: hostname() },
    });
}

// ---------------------------------------------------------------------------
// The end of a case
// ---------------------------------------------------------------------------

function finish(t: Tuning, c: Case, result: Omit<Result, 'caseRev' | 'at'>): void {
    const full: Result = {
        ...result,
        caseRev: c.rev,
        at: new Date().toISOString(),
        tokens: caseTokens(t, c),
    };
    mkdirSync(t.caseDir(c), { recursive: true });
    writeFileSync(join(t.caseDir(c), 'result.json'), `${JSON.stringify(full, null, 2)}\n`);
    t.event({
        what: result.state,
        case: c.id,
        rev: c.rev,
        phase: result.phase,
        detail: result.reason,
    });
    writeFeedback(t, c);
}

export function markCompleted(t: Tuning, c: Case): void {
    finish(t, c, { state: 'completed', phase: 'mem' });
}

export function markDifficult(t: Tuning, c: Case, phase: Phase, reason: string): void {
    finish(t, c, { state: 'difficult', phase, reason });
    DatasetStore.open(t.root).note(c.id, {
        type: 'note',
        at: new Date().toISOString(),
        kind: 'difficult',
        caseRev: c.rev,
        text: `${phase === 'nomem' ? 'without memory' : 'with memory'}: ${reason}`,
        by: { prompt: 'finetune', host: hostname() },
    });
}
