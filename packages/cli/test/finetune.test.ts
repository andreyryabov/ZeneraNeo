import { type ChildProcess, spawn } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remember } from '../src/meta/finetune/children.ts';
import { runFinetune } from '../src/meta/finetune/command.ts';
import { runDataset } from '../src/meta/finetune/dataset/command.ts';
import { readFeedback } from '../src/meta/finetune/feedback.ts';
import { Journal } from '../src/meta/finetune/journal.ts';
import { markdownPage } from '../src/meta/finetune/report.ts';
import { SystemVersions } from '../src/meta/finetune/system.ts';
import { FAILURES_IN_A_ROW, type Zen } from '../src/meta/finetune/tuning.ts';
import { runMetrics } from '../src/meta/finetune/usage.ts';

let root: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-finetune-')));
    writeFileSync(join(root, 'agents.yaml'), 'agents:\n  - name: default\n');
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'instructions.md'), '# Rules\n');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        return await fn();
    } finally {
        out.mockRestore();
        err.mockRestore();
    }
};

async function dataset(ids: string[]): Promise<void> {
    writeFileSync(
        join(root, 'proposal.json'),
        JSON.stringify({
            cases: ids.map((id) => ({
                id,
                class: id[0],
                input: `question ${id}`,
                rubric: ['answers it'],
            })),
        }),
    );
    await quiet(() =>
        runDataset(
            { args: ['apply', 'proposal.json', '--why', 'test'], json: true, cwd: root },
            { dir: root, name: 'acme' },
        ),
    );
}

interface Verdict {
    done: boolean;
    improvements?: number;
    /** milliseconds the run takes */
    slow?: number;
    /** milliseconds the analysis takes */
    slowAnalyze?: number;
    /** the analysis dies before it writes feedback, as on a provider outage */
    broken?: boolean;
    /** `zen run` exits with this code before it starts, as when podman is down */
    exit?: number;
    /** a sandbox tool got this error from the container engine mid-run */
    sandbox?: string;
    /** the analysis finds the run void, for this reason */
    infra?: string;
}

/** What `zen meta run --json` reports about itself. */
const META_ENVELOPE = {
    model: 'vertex/gemini-meta',
    tokens: {
        calls: 2,
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
    },
};

/**
 * A stand-in for the `zen` binary. `decide` says how each try's analysis comes
 * out, given the case, phase, attempt and how many applies have happened.
 */
function fakeZen(decide: (c: string, phase: string, attempt: number, applies: number) => Verdict) {
    const calls: string[][] = [];
    let runs = 0;
    let applies = 0;
    let failChecks = 0;
    let applyMs = 0;
    let editDuringAnalyze = false;
    const zen: Zen = async (args, log) => {
        calls.push(args);
        if (args[0] === 'run') {
            const input = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
                .input as string;
            const v = decideFor(args, decide, applies, input.replace('question ', ''));
            if (v.exit) {
                appendFileSync(log, 'error   podman is installed but not responding\n');
                return { code: v.exit, stdout: '' };
            }
            if (v.slow) {
                await new Promise((r) => setTimeout(r, v.slow));
            }
            const dir = join(root, 'sessions', 's', 'runs', String(++runs));
            mkdirSync(dir, { recursive: true });
            // With memory the run recalls instead of researching: one call and one error fewer.
            const withMemory = /\/\d{2}-mem\//.test(args[args.indexOf('--input') + 1]);
            writeFileSync(
                join(dir, 'meta.json'),
                JSON.stringify({
                    turns: 5,
                    durationMs: withMemory ? 600 : 1200,
                    usage: { inputTokens: 900, outputTokens: 100 },
                }),
            );
            writeFileSync(join(dir, 'graph.mmd'), 'flowchart TD\n');
            const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
            const call = (id: string, model: string, s = 0) => ({
                id,
                ts: at(s),
                type: 'llm_call',
                model,
                usage: { inputTokens: 300, outputTokens: 30 },
            });
            // c1 appears again inside a branch: it must be counted once.
            writeFileSync(
                join(dir, 'state.json'),
                JSON.stringify({
                    trajectory: [
                        call('c1', 'gemini-a', 2),
                        ...(v.sandbox
                            ? [
                                  {
                                      id: 'tb',
                                      ts: at(3),
                                      type: 'tool_result',
                                      isError: true,
                                      result: {
                                          store: 'mem',
                                          sha256: 'x',
                                          size: 1,
                                          preview: JSON.stringify({ error: v.sandbox }),
                                      },
                                  },
                              ]
                            : []),
                        {
                            id: 't1',
                            ts: at(5),
                            type: 'tool_result',
                            isError: !withMemory,
                            durationMs: 3000,
                        },
                        ...(withMemory
                            ? [{ id: 'm1', ts: at(5), type: 'memory_recall' }]
                            : [call('c2', 'gemini-a', 7)]),
                        call('c3', 'gemini-b', 9),
                        {
                            id: 'j1',
                            ts: at(9),
                            type: 'join',
                            branches: [{ nodes: [call('c1', 'gemini-a', 2)] }],
                        },
                    ],
                }),
            );
            writeFileSync(join(dir, 'report.html'), '<html></html>');
            const memory = args[args.indexOf('--memory') + 1];
            mkdirSync(memory, { recursive: true });
            writeFileSync(join(memory, 'manifest.json'), '{}');
            writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ run: { dir } }));
            return { code: 0, stdout: '' };
        }
        if (args[0] === 'check') {
            return { code: failChecks-- > 0 ? 3 : 0, stdout: '' };
        }
        if (args[0] === 'memory' && args[1] === 'merge') {
            const target = args[args.indexOf('--dir') + 1];
            const sources = args.slice(2, args.indexOf('--dir'));
            mkdirSync(target, { recursive: true });
            writeFileSync(
                join(target, 'manifest.json'),
                JSON.stringify({ nodes: sources.length * 10, edges: sources.length }),
            );
            return { code: 0, stdout: '' };
        }
        if (args[0] === 'meta' && args.includes('/finetune-apply')) {
            const dir = args.at(-1)!;
            appendFileSync(join(root, 'agents', 'instructions.md'), `- rule ${++applies}\n`);
            if (applyMs) {
                await new Promise((r) => setTimeout(r, applyMs));
            }
            const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')) as {
                id: string;
                improvements: { id: string }[];
            }[];
            writeFileSync(
                join(dir, 'decisions.json'),
                JSON.stringify(
                    Object.fromEntries(
                        inputs.map((f) => [
                            f.id,
                            Object.fromEntries(
                                f.improvements.map((i) => [
                                    i.id,
                                    { decision: 'applied', note: 'agents/instructions.md' },
                                ]),
                            ),
                        ]),
                    ),
                ),
            );
            writeFileSync(join(dir, 'changes.md'), '# changes\n');
            return { code: 0, stdout: JSON.stringify(META_ENVELOPE) };
        }
        if (args[0] === 'meta' && args.includes('/analyze')) {
            const word = (k: string) =>
                args.find((a) => a.startsWith(`${k}=`))!.slice(k.length + 1);
            const v = decide(word('case'), word('phase'), Number(word('attempt')), applies);
            if (v.slowAnalyze) {
                await new Promise((r) => setTimeout(r, v.slowAnalyze));
            }
            if (editDuringAnalyze) {
                appendFileSync(join(root, 'agents', 'instructions.md'), '- sneaky\n');
            }
            if (v.broken) {
                return { code: 1, stdout: '' };
            }
            if (v.infra) {
                writeFileSync(
                    word('feedback'),
                    JSON.stringify({
                        verdict: 'void',
                        infra: v.infra,
                        rubric: {},
                        done: false,
                        summary: '',
                        improvements: [],
                    }),
                );
                return { code: 0, stdout: JSON.stringify(META_ENVELOPE) };
            }
            writeFileSync(
                word('feedback'),
                JSON.stringify({
                    verdict: v.done ? 'right' : 'wrong',
                    rubric: { r1: v.done ? 'pass' : 'fail' },
                    done: v.done,
                    summary: v.done ? 'fine' : 'misses it | badly',
                    improvements: Array.from(
                        { length: v.improvements ?? (v.done ? 0 : 1) },
                        (_, i) => ({
                            id: `i${i + 1}`,
                            change: `say it ${i + 1}`,
                        }),
                    ),
                }),
            );
            const answer = join(root, '.tmp', `answer-${calls.length}.md`);
            mkdirSync(join(root, '.tmp'), { recursive: true });
            writeFileSync(answer, '**Run** - fine.\n');
            const session =
                args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
            return {
                code: 0,
                stdout: JSON.stringify({
                    ...META_ENVELOPE,
                    sessionId: session,
                    answerFile: answer,
                }),
            };
        }
        return { code: 0, stdout: '{}' };
    };
    return {
        zen,
        calls,
        get applies() {
            return applies;
        },
        failChecks(n: number) {
            failChecks = n;
        },
        slowApply(ms: number) {
            applyMs = ms;
        },
        editDuringAnalyze() {
            editDuringAnalyze = true;
        },
    };
}

function decideFor(
    args: string[],
    decide: (c: string, phase: string, attempt: number, applies: number) => Verdict,
    applies: number,
    id: string,
): Verdict {
    const m = /(\d{2})-(nomem|mem)/.exec(args[args.indexOf('--input') + 1])!;
    return decide(id, m[2], Number(m[1]), applies);
}

async function start(zen: Zen, ...flags: string[]): Promise<void> {
    await quiet(() =>
        runFinetune(
            { args: ['start', ...flags], json: true, cwd: root },
            { dir: root, name: 'acme' },
            { zen, tickMs: 5 },
        ),
    );
}

const result = (id: string): { state: string; reason?: string } | undefined => {
    const file = join(root, 'finetune', 'cases', id, 'r1', 'result.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};

const runsOf = (calls: string[][], id: string) =>
    calls.filter((a) => a[0] === 'run' && a[a.indexOf('--input') + 1].includes(`/cases/${id}/`));

// An analysis once graded memory "ok" on a run that saved nothing; a rubric
// left half-graded is the same failure, and the loop is where it is caught.
describe('feedback', () => {
    const known = { case: 'a1', caseRev: 2, phase: 'nomem' as const, attempt: 1 };
    const read = (body: object, ids: string[] = ['r1', 'r2']) => {
        const file = join(root, 'feedback.json');
        writeFileSync(file, JSON.stringify({ improvements: [], summary: 's', ...body }));
        return readFeedback(file, known, ids);
    };

    it('refuses a rubric line left ungraded, naming it and the command', () => {
        const r = read({ verdict: 'right', done: true, rubric: { r1: 'pass' } });
        expect(r).toEqual({ problem: expect.stringContaining('rubric lines r2') });
        expect(r).toEqual({ problem: expect.stringContaining('zen meta dataset show a1@2') });
    });

    it('is never done while a rubric line fails', () => {
        const r = read({ verdict: 'right', done: true, rubric: { r1: 'pass', r2: 'fail' } });
        expect('feedback' in r && r.feedback.done).toBe(false);
    });

    it('lets a void run go ungraded, but not unexplained', () => {
        expect(read({ verdict: 'void', done: false, rubric: {} })).toEqual({
            problem: expect.stringContaining('"infra"'),
        });
        const r = read({ verdict: 'void', done: false, rubric: {}, infra: 'n4: no DNS' });
        expect('feedback' in r && r.feedback.infra).toBe('n4: no DNS');
    });
});

describe('zen meta finetune', () => {
    it('measures a run from its trajectory, branches as their own lanes', () => {
        const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
        const call = (id: string, model: string, s: number, input: number) => ({
            id,
            ts: at(s),
            type: 'llm_call',
            model,
            usage: { inputTokens: input, cachedInputTokens: 100, outputTokens: 10 },
        });
        writeFileSync(
            join(root, 'state.json'),
            JSON.stringify({
                trajectory: [
                    { id: 'u', ts: at(0), type: 'user_input' },
                    call('c1', 'vertex/gemini-a', 2, 300),
                    { id: 'r1', ts: at(5), type: 'tool_result', isError: true, durationMs: 2500 },
                    call('c2', 'gemini-a', 7, 500),
                    { id: 'm1', ts: at(7), type: 'memory_op', op: 'commit' },
                    { id: 'f1', ts: at(7), type: 'fork', branches: [{}, {}] },
                    {
                        id: 'j1',
                        ts: at(12),
                        type: 'join',
                        branches: [
                            {
                                nodes: [
                                    call('c4', 'gemini-b', 10, 200),
                                    call('c1', 'gemini-a', 2, 300),
                                ],
                            },
                            { nodes: [call('c5', 'gemini-b', 11, 100)] },
                        ],
                    },
                    {
                        id: 'k1',
                        ts: at(13),
                        type: 'compaction',
                        usage: { inputTokens: 50, outputTokens: 5 },
                    },
                    { id: 'h1', ts: at(13), type: 'handoff' },
                ],
            }),
        );
        const m = runMetrics(root)!;
        expect(m.models['gemini-a']).toEqual({
            calls: 2,
            input: 800,
            cached: 200,
            output: 20,
            reasoning: 0,
            peak: 500,
            ms: 4000,
        });
        expect(m.models['gemini-b']).toMatchObject({ calls: 2, peak: 200, ms: 7000 });
        expect(m.models.summarizer).toMatchObject({ calls: 1, input: 50, ms: 1000 });
        expect(m).toMatchObject({
            llmMs: 12000,
            toolMs: 2500,
            toolCalls: 1,
            toolErrors: 1,
            memory: { commit: 1, recall: 0 },
            forks: 1,
            branches: 2,
            compactions: 1,
            handoffs: 1,
        });
    });

    it('completes cases that pass first time, without memory and then with it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '2');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
        expect(
            runsOf(fake.calls, 'a1').map((a) => a[a.indexOf('--input') + 1].match(/\d{2}-\w+/)![0]),
        ).toEqual(['01-nomem', '01-mem']);
        expect(fake.applies).toBe(0);
        const run = runsOf(fake.calls, 'a1')[0];
        expect(run[run.indexOf('--events') + 1]).toMatch(
            /\/cases\/a1\/r1\/01-nomem\/events\.jsonl$/,
        );
        const analyze = fake.calls.find((a) => a.includes('/analyze'))!;
        expect(analyze[analyze.indexOf('--events') + 1]).toMatch(
            /\/cases\/\w+\/r1\/01-nomem\/analyze\.events\.jsonl$/,
        );
    });

    it('moves a tuning kept in .finetune/ to finetune/ and resumes it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '2');
        rmSync(join(root, 'finetune', 'loop.lock'), { force: true });
        renameSync(join(root, 'finetune'), join(root, '.finetune'));
        await start(fake.zen, '-N', '2');
        expect(existsSync(join(root, '.finetune'))).toBe(false);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(runsOf(fake.calls, 'a1')).toHaveLength(2);
    });

    it('parks a case, applies its feedback, and runs it again on the new system', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, phase, attempt, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        expect(fake.applies).toBe(1);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        const second = JSON.parse(
            readFileSync(
                join(root, 'finetune', 'cases', 'a1', 'r1', '02-nomem', 'run.json'),
                'utf8',
            ),
        );
        expect(second.system).toBe(2);
        expect(existsSync(join(root, 'finetune', 'applies', '001', 'diff.patch'))).toBe(true);
        const applyCall = fake.calls.find((a) => a.includes('/finetune-apply'))!;
        const applyDir = join(root, 'finetune', 'applies', '001');
        expect(applyCall[applyCall.indexOf('--session-id') + 1]).toBe(
            readFileSync(join(applyDir, 'session'), 'utf8').trim(),
        );
        expect(applyCall[applyCall.indexOf('--events') + 1]).toBe(
            join(applyDir, 'apply.events.jsonl'),
        );
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toContain('## History');
        expect(page).toContain('**Run** - fine.');
        const html = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.html'), 'utf8');
        expect(html).toContain('## History');
        expect(html).not.toContain('http-equiv="refresh"');

        const apply = readFileSync(join(root, 'finetune', 'applies', '001', 'APPLY.md'), 'utf8');
        expect(apply).toContain('# Apply 001 - v1 → v2');
        expect(apply).toMatch(/### 1\. a1 - no memory, try 1: wrong/);
        expect(apply).toMatch(
            /\| i1 \| - \| - \| say it 1 \| - \| - \| applied \| agents\/instructions\.md \|/,
        );
        expect(apply).toContain('## What the apply agent did');
        expect(apply).toContain('| `agents/instructions.md` | +1 | -0 |');
        expect(apply).toMatch(/```diff\n[\s\S]*\+- rule 1/);
        expect(apply).toMatch(/\[a1\]\(<[^>]+>\) - no memory, try 2 on v2/);
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('[001](<applies/001/APPLY.md>)');
    });

    it('applies once M requests wait, while another case is still running', async () => {
        await dataset(['a1', 'b1', 'c1']);
        const fake = fakeZen((c, _phase, _attempt, applies) =>
            c === 'c1' ? { done: true, slow: 300 } : { done: applies > 0 },
        );
        await start(fake.zen, '-N', '3', '-M', '2');
        const inputs = JSON.parse(
            readFileSync(join(root, 'finetune', 'applies', '001', 'inputs.json'), 'utf8'),
        );
        expect(inputs.map((f: { id: string }) => f.id).sort()).toEqual([
            'a1@nomem-1',
            'b1@nomem-1',
        ]);
    });

    it('lets another case use the worker while a case is parked', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '1', '-M', '2');
        const index = (pred: (a: string[]) => boolean) => fake.calls.findIndex(pred);
        const b1Run = index((a) => a[0] === 'run' && a.some((x) => x.includes('/cases/b1/')));
        const apply = index((a) => a.includes('/finetune-apply'));
        expect(b1Run).toBeGreaterThan(-1);
        expect(b1Run).toBeLessThan(apply);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
    });

    it('marks a case difficult when its tries run out, and skips the memory phase', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        await start(fake.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'difficult', reason: 'wrong' });
        expect(runsOf(fake.calls, 'a1')).toHaveLength(2);
        expect(fake.applies).toBe(1);
        const log = (await quietJson(['log', 'a1'])) as { kind?: string }[];
        expect(log.some((r) => r.kind === 'difficult')).toBe(true);
    });

    it('marks a case failed when its analysis breaks, and resumes it at the next start', async () => {
        await dataset(['a1']);
        let outage = true;
        const fake = fakeZen(() => ({ done: true, broken: outage }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(result('a1')!.reason).toMatch(/^error: analysis wrote no usable feedback/);

        outage = false;
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        // The run itself had gone through: only the analysis is done again.
        const first = runsOf(fake.calls, 'a1').filter((a) =>
            a[a.indexOf('--input') + 1].includes('01-nomem'),
        );
        expect(first).toHaveLength(1);
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).toContain('"what":"resumed"');
    });

    it('reads an old void or error "difficult" as failed, and resumes it', async () => {
        await dataset(['a1']);
        const dir = join(root, 'finetune', 'cases', 'a1', 'r1');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'result.json'),
            JSON.stringify({
                state: 'difficult',
                phase: 'nomem',
                reason: 'void: 3 runs in a row were void',
            }),
        );
        await start(fakeZen(() => ({ done: true })).zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
    });

    it(`stops after ${FAILURES_IN_A_ROW} cases fail in a row, and leaves the rest alone`, async () => {
        await dataset(['a1', 'b1', 'c1', 'd1']);
        const fake = fakeZen(() => ({ done: true, broken: true }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/3 cases failed in a row/);
        const states = ['a1', 'b1', 'c1', 'd1'].map((id) => result(id)?.state);
        expect(states.filter((s) => s === 'failed')).toHaveLength(3);
        expect(states.filter((s) => s === undefined)).toHaveLength(1);
    });

    it('retries a difficult case as a new round, with feedback ids of its own', async () => {
        await dataset(['a1', 'b1']);
        const first = fakeZen((c) => ({ done: c === 'b1' }));
        await start(first.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'difficult' });
        expect(first.applies).toBe(1);

        await expect(quietJson(['retry'], runFinetune)).rejects.toThrow(/retry which cases/);
        const out = (await quietJson(['retry', '--difficult', 'b1', '--yes'], runFinetune)) as {
            retried: string[];
            skipped: unknown[];
        };
        expect(out.retried).toEqual(['a1']);
        expect(out.skipped).toHaveLength(1);
        const cases = join(root, 'finetune', 'cases');
        expect(existsSync(join(cases, 'a1', 'rounds', 'r1.1', '01-nomem', 'run.json'))).toBe(true);
        expect(result('a1')).toBeUndefined();
        expect(result('b1')).toMatchObject({ state: 'completed' });

        // Round 2 fails its first try too: its feedback must not pass for round 1's, already applied.
        const second = fakeZen((c, _p, _a, applies) => ({ done: c === 'b1' || applies > 0 }));
        await start(second.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(second.applies).toBe(1);
        const apply = second.calls.find((a) => a.includes('/finetune-apply'))!;
        const inputs = JSON.parse(readFileSync(join(apply.at(-1)!, 'inputs.json'), 'utf8'));
        expect(inputs.map((f: { id: string }) => f.id)).toEqual(['a1#2@nomem-1']);
    });

    it('stops at once when the container engine is down, and carries on once it is up', async () => {
        await dataset(['a1', 'b1', 'c1']);
        let down = true;
        const fake = fakeZen(() => ({ done: true, exit: down ? 5 : undefined }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(
            /sandbox failed: podman is installed but not responding/,
        );
        expect(result('a1')?.reason).toMatch(/^sandbox: /);
        expect(result('b1')).toBeUndefined();
        expect(runsOf(fake.calls, 'b1')).toHaveLength(0);

        down = false;
        await start(fake.zen, '-N', '1');
        expect(['a1', 'b1', 'c1'].map((id) => result(id)?.state)).toEqual([
            'completed',
            'completed',
            'completed',
        ]);
    });

    it('stops when a sandbox tool met a broken container engine, before any analysis', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({
            done: true,
            sandbox: 'could not create container zn-1: allocating lock: exceeded num_locks (2048)',
        }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/exceeded num_locks/);
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(fake.calls.some((a) => a.includes('/analyze'))).toBe(false);
    });

    it('sets aside a run its analysis finds void, and runs the try again', async () => {
        await dataset(['a1']);
        const analyses = () => fake.calls.filter((a) => a.includes('/analyze')).length;
        const fake = fakeZen(() =>
            analyses() === 1
                ? { done: false, infra: 'n4: run_command - Could not resolve host' }
                : { done: true },
        );
        await start(fake.zen, '-N', '1', '--tries', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(fake.applies).toBe(0);
        const tries = join(root, 'finetune', 'cases', 'a1', 'r1');
        expect(existsSync(join(tries, '01-nomem.void-1', 'run.json'))).toBe(true);
        expect(existsSync(join(tries, '01-nomem', 'feedback.json'))).toBe(true);
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).toContain('Could not resolve host');
    });

    it('fails a case whose runs keep coming back void', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false, infra: 'n4: the mock API answered 503' }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(result('a1')!.reason).toMatch(/^void: 3 analyses in a row found the run void/);
        expect(fake.applies).toBe(0);
    });

    it('reuses one analyze session for every try of a case', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1');
        const analyses = fake.calls.filter((a) => a.includes('/analyze'));
        const ids = analyses.map(
            (a) => a[a.indexOf(a.includes('--session-id') ? '--session-id' : '--resume') + 1],
        );
        expect(new Set(ids).size).toBe(1);
    });

    it('carries on where it stopped, repeating nothing that finished', async () => {
        await dataset(['a1', 'b1']);
        let stopped = false;
        const fake = fakeZen((c, _p, _a, applies) => {
            if (!stopped && c === 'a1') {
                stopped = true;
                writeFileSync(join(root, 'finetune', 'stop'), 'now\n');
            }
            return { done: applies > 0 || c === 'b1' };
        });
        await start(fake.zen, '-N', '1');
        const first = fake.calls.length;
        expect(result('a1')).toBeUndefined();

        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
        const a1First = runsOf(fake.calls, 'a1').filter((a) =>
            a[a.indexOf('--input') + 1].includes('01-nomem'),
        );
        expect(a1First).toHaveLength(1);
        expect(fake.calls.length).toBeGreaterThan(first);
    });

    it('rolls back the steps a kill cut off, and does them again', async () => {
        await dataset(['a1']);
        const ft = join(root, 'finetune');
        const journal = new Journal(join(ft, 'journal.jsonl'));
        // A run that wrote run.json but was killed before it committed.
        const attempt = join(ft, 'cases', 'a1', 'r1', '01-nomem');
        mkdirSync(join(attempt, 'memory'), { recursive: true });
        writeFileSync(join(attempt, 'run.json'), '{"dir":"/nowhere"}');
        writeFileSync(join(attempt, 'events.jsonl'), '{"type":"say","text":"half"}\n');
        journal.begin({ kind: 'run', dir: attempt });
        // An apply killed halfway through its edit.
        new SystemVersions(root, join(ft, 'systems')).record('start');
        const apply = join(ft, 'applies', '001');
        mkdirSync(apply, { recursive: true });
        writeFileSync(join(apply, 'inputs.json'), '[]');
        journal.begin({ kind: 'apply', dir: apply, from: 1 });
        appendFileSync(join(root, 'agents', 'instructions.md'), '- half an edit\n');

        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1');

        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(
            runsOf(fake.calls, 'a1').filter((a) =>
                a[a.indexOf('--input') + 1].includes('01-nomem'),
            ),
        ).toHaveLength(1);
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe(
            '# Rules\n- rule 1\n',
        );
        const inputs = JSON.parse(readFileSync(join(apply, 'inputs.json'), 'utf8'));
        expect(inputs.map((f: { id: string }) => f.id)).toEqual(['a1@nomem-1']);
        const events = readFileSync(join(ft, 'events.jsonl'), 'utf8');
        expect(events.match(/"what":"rolled back"/g)).toHaveLength(2);
        expect(existsSync(join(attempt, 'events.jsonl'))).toBe(false);
        expect(journal.open()).toEqual([]);
    });

    it('stops what a dead loop left running before it rolls anything back', async () => {
        await dataset(['a1']);
        const ft = join(root, 'finetune');
        const exited = (p: ChildProcess) =>
            new Promise((r) => p.once('exit', (_code, signal) => r(signal)));
        const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        const gone = exited(orphan);
        remember(ft, orphan.pid!, 'sleep');
        // Its pid was taken by something else since: never ours to kill.
        const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        remember(ft, stranger.pid!, 'not-its-command');
        try {
            await start(fakeZen(() => ({ done: true })).zen, '-N', '1');
            await expect(gone).resolves.toBe('SIGTERM');
            expect(stranger.exitCode).toBeNull();
            expect(stranger.signalCode).toBeNull();
            expect(existsSync(join(ft, 'children'))).toBe(false);
            const log = readFileSync(join(ft, 'events.jsonl'), 'utf8');
            expect(log).toContain('"what":"stopped leftovers"');
        } finally {
            stranger.kill();
        }
    });

    it('undoes an analysis that edited the project', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: true }));
        fake.editDuringAnalyze();
        await start(fake.zen, '-N', '1');
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe('# Rules\n');
    });

    it('keeps an apply in progress when an analysis ends during it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) =>
            c === 'b1' ? { done: true, slowAnalyze: 150 } : { done: applies > 0 },
        );
        fake.slowApply(400);
        await start(fake.zen, '-N', '2', '-M', '1');
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toContain('- rule 1');
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).not.toContain('analyze edited the system');
    });

    it('restores the system when an apply breaks the project, and stops after a second time', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        fake.failChecks(2);
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/broken twice/);
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe('# Rules\n');
    });

    it('keeps every passing memory privately and merges them every K', async () => {
        await dataset(['a1', 'b1', 'c1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '1', '--merge-every', '2');

        const memories = fake.calls
            .filter((a) => a[0] === 'run')
            .map((a) => a[a.indexOf('--memory') + 1]);
        expect(new Set(memories).size).toBe(memories.length);
        for (const m of memories) {
            expect(m).toMatch(/\/cases\/\w+\/r1\/\d{2}-(nomem|mem)\/memory$/);
        }
        const workspaces = fake.calls
            .filter((a) => a[0] === 'run')
            .map((a) => a[a.indexOf('--workspace') + 1]);
        expect(new Set(workspaces).size).toBe(workspaces.length);
        for (const w of workspaces) {
            expect(w).toMatch(/\/cases\/\w+\/r1\/\d{2}-(nomem|mem)\/workspace$/);
        }

        const dir = join(root, 'finetune', 'memories');
        const kept = readFileSync(join(dir, 'submissions.jsonl'), 'utf8').trim().split('\n');
        expect(kept).toHaveLength(3);
        const merges = readFileSync(join(dir, 'merges.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(merges.map((m) => [m.name, m.includes.length, m.added.length])).toEqual([
            ['m01', 2, 2],
            ['m02', 3, 1],
        ]);
        const second = fake.calls.filter((a) => a[0] === 'memory').at(-1)!;
        expect(second).toContain(merges[0].dir);

        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Memory');
        expect(status).toMatch(/\| m02 \| [\d:]+ \| 3: /);
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toMatch(/In merges: \[m0\d\]/);
    });

    it('writes a status page whose diagrams carry no free text', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Workers');
        expect(status).toContain('## Applies');
        const diagrams = status.match(/```mermaid[\s\S]*?```/g) ?? [];
        // The overview, the system, then one per worker.
        expect(diagrams).toHaveLength(2 + 2);
        expect(diagrams.join('\n')).not.toContain('misses it');
        expect(status).not.toMatch(/misses it \| badly/);
        expect(readdirSync(join(root, 'finetune', 'cases'))).toEqual(['a1', 'b1']);

        const html = readFileSync(join(root, 'finetune', 'STATUS.html'), 'utf8');
        expect(html).toContain('## Workers');
        expect(html).toContain('```mermaid');
    });

    it('keeps model text in STATUS.html inert', () => {
        const html = markdownPage('t', '| </script><img src=x onerror=alert(1)> |\n', false);
        expect(html.match(/<\/script>/g)).toHaveLength(2);
        expect(html).not.toContain('<img');
        expect(html).not.toContain('http-equiv="refresh"');
    });

    it('reports tokens per stage and model, for the tuning and for each case', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Tokens');
        expect(status).toMatch(/\| run \| gemini-a \| \d+ \|/);
        expect(status).toMatch(/\| run \| gemini-b \| \d+ \|/);
        expect(status).toMatch(/\| analyze \| gemini-meta \| \d+ \|/);
        expect(status).toMatch(/\| apply \| gemini-meta \| \d+ \|/);

        // b1 passes at once: one run and one analysis per phase.
        const result = JSON.parse(
            readFileSync(join(root, 'finetune', 'cases', 'b1', 'r1', 'result.json'), 'utf8'),
        ) as { tokens: Record<string, Record<string, { calls: number; input: number }>> };
        expect(result.tokens.run['gemini-a']).toMatchObject({ calls: 3, input: 900 });
        expect(result.tokens.run['gemini-b']).toMatchObject({ calls: 2, input: 600 });
        expect(result.tokens.analyze['gemini-meta']).toMatchObject({ calls: 4, input: 1000 });
        expect(result.tokens.apply).toBeUndefined();

        const feedback = readFileSync(join(root, 'finetune', 'cases', 'b1', 'FEEDBACK.md'), 'utf8');
        expect(feedback).toContain('## Tokens');
        expect(feedback).toMatch(/\| run \| gemini-a \| 3 \| 900 \|/);
    });

    it('reports each try against the one it is compared with, and sums the trend', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');

        const b1 = readFileSync(join(root, 'finetune', 'cases', 'b1', 'FEEDBACK.md'), 'utf8');
        expect(b1).toContain('| Metric | no memory, try 1 | with memory, try 1 | Memory effect |');
        expect(b1).toContain('| LLM calls | 3 | 2 (-1) | -33% better |');
        expect(b1).toContain('| Tool errors | 1 | 0 (-1) | -100% better |');
        expect(b1).toContain('| Memory recalls | 0 | 1 (+1) | new |');
        expect(b1).toContain('### gemini-a');
        expect(b1).toMatch(/\| Tool calls \| 1 \|/);

        // a1 needed a fix: its second try is measured against its first.
        const a1 = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(a1).toContain('| LLM calls | 3 | 3 (=) | 2 (-1) | -33% better |');

        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Summary');
        expect(status).toMatch(/\| no memory \| 3 \| 4s \| 9 \| 3 \|/);
        expect(status).toContain('2 case(s) passed without memory, 1 on the first try.');
        expect(status).toContain('2 completed case(s), cheaper in tokens with memory in 2.');
        expect(status).toContain('| LLM calls | 6 | 4 | -33% | better |');
        expect(status).toContain('| Tool errors | 2 | 0 | -100% | better |');
        expect(status).toMatch(/\| -33% tokens · -50% time \|/);
    });
});

async function quietJson(args: string[], run: typeof runDataset = runDataset): Promise<unknown> {
    const out: string[] = [];
    const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
            out.push(String(chunk));
            return true;
        });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await run({ args, json: true, cwd: root }, { dir: root, name: 'acme' });
    } finally {
        write.mockRestore();
        err.mockRestore();
    }
    return JSON.parse(out.join(''));
}
