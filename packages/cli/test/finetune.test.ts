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
import { runFinetune } from '../src/meta/finetune/command.ts';
import { runDataset } from '../src/meta/finetune/dataset/command.ts';
import type { Zen } from '../src/meta/finetune/tuning.ts';

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
    const zen: Zen = async (args) => {
        calls.push(args);
        if (args[0] === 'run') {
            const input = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
                .input as string;
            const v = decideFor(args, decide, applies, input.replace('question ', ''));
            if (v.slow) {
                await new Promise((r) => setTimeout(r, v.slow));
            }
            const dir = join(root, 'sessions', 's', 'runs', String(++runs));
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, 'meta.json'),
                JSON.stringify({
                    turns: 5,
                    durationMs: 1200,
                    usage: { inputTokens: 900, outputTokens: 100 },
                }),
            );
            writeFileSync(join(dir, 'graph.mmd'), 'flowchart TD\n');
            const call = (id: string, model: string) => ({
                id,
                type: 'llm_call',
                model,
                usage: { inputTokens: 300, outputTokens: 30 },
            });
            // c1 appears again inside a branch: it must be counted once.
            writeFileSync(
                join(dir, 'state.json'),
                JSON.stringify({
                    trajectory: [
                        call('c1', 'gemini-a'),
                        call('c2', 'gemini-a'),
                        call('c3', 'gemini-b'),
                        { branches: [{ trajectory: [call('c1', 'gemini-a')] }] },
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

describe('zen meta finetune', () => {
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
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toContain('## History');
        expect(page).toContain('**Run** - fine.');

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
        // The overview, then one per worker.
        expect(diagrams).toHaveLength(1 + 2);
        expect(diagrams.join('\n')).not.toContain('misses it');
        expect(status).not.toMatch(/misses it \| badly/);
        expect(readdirSync(join(root, 'finetune', 'cases'))).toEqual(['a1', 'b1']);
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
        expect(result.tokens.run['gemini-a']).toMatchObject({ calls: 4, input: 1200 });
        expect(result.tokens.run['gemini-b']).toMatchObject({ calls: 2, input: 600 });
        expect(result.tokens.analyze['gemini-meta']).toMatchObject({ calls: 4, input: 1000 });
        expect(result.tokens.apply).toBeUndefined();

        const feedback = readFileSync(join(root, 'finetune', 'cases', 'b1', 'FEEDBACK.md'), 'utf8');
        expect(feedback).toContain('## Tokens');
        expect(feedback).toMatch(/\| run \| gemini-a \| 4 \| 1k \|/);
    });
});

async function quietJson(args: string[]): Promise<unknown> {
    const out: string[] = [];
    const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
            out.push(String(chunk));
            return true;
        });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await runDataset({ args, json: true, cwd: root }, { dir: root, name: 'acme' });
    } finally {
        write.mockRestore();
        err.mockRestore();
    }
    return JSON.parse(out.join(''));
}
