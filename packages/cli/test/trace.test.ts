import { zeroUsage, type Payload, type TokenUsage, type TrajectoryNode } from '@zenera/neo';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    readQuestion,
    renderAskExchange,
    renderNode,
    repeatQuestions,
    replayableCalls,
    wholeParts,
} from '../src/commands/inspect.ts';
import { runPathsAt } from '../src/session.ts';
import { CliError, choose, deferBanner, plain } from '../src/term.ts';
import { parseNodeIds, safe, traceIndex, traceMermaid, traceOf } from '../src/trace.ts';

// ---------------------------------------------------------------------------
// The trajectory as a diagram
//
// Two things are worth a test here and the rest is formatting.
//
// The first is the numbering. A branch runs between the fork and the join, so
// its nodes are numbered there — which means a reader who sees `n9` inside a
// subgraph and `n12` as the join can trust that n9 really did happen first.
// Get that wrong and every id in the diagram points at the wrong node.
//
// The second is that the diagram is built out of text a model wrote. Tool
// arguments and tool results are attacker input as far as the Mermaid parser
// is concerned, so there is a test here that feeds it a payload made of
// nothing but delimiters and checks that none of them survive.
// ---------------------------------------------------------------------------

let seq = 0;

const payload = (preview: string): Payload => ({
    store: 'file',
    sha256: `sha${seq++}`,
    size: preview.length,
    preview,
});

const usage: TokenUsage = { ...zeroUsage(), inputTokens: 100, outputTokens: 20 };

/** Nodes are stamped a second apart, so every duration in the output is 1.0s. */
const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();

let clock = 0;

const node = <T extends Partial<TrajectoryNode>>(body: T, agent = 'lead'): TrajectoryNode =>
    ({ id: `id${seq++}`, ts: at(clock++), agent, ...body }) as TrajectoryNode;

const state = (trajectory: TrajectoryNode[]) => ({
    version: 1 as const,
    runId: '20260101-120000-aaaa',
    spec: { startAgent: 'lead', forkDepth: 0, maxForkDepth: 3 },
    agentName: 'lead',
    phase: 'done' as const,
    trajectory,
    pendingToolCalls: [],
    usage: zeroUsage(),
});

const call = (callId: string, name: string, preview: string): TrajectoryNode[] => [
    node({ type: 'tool_call', callId, name, args: payload(preview) }),
    node({
        type: 'tool_result',
        callId,
        name,
        result: payload('exit 0'),
        isError: false,
    }),
];

beforeEach(() => {
    seq = 0;
    clock = 0;
});

// ---------------------------------------------------------------------------

describe('numbering', () => {
    it('numbers a branch before the join that reports it', () => {
        const branch = [
            node({ type: 'llm_call', ...llm(['read_file']) }, 'researcher'),
            ...call('c9', 'read_file', 'path=notes.md'),
        ];
        const trace = traceOf(
            state([
                node({ type: 'user_input', content: [{ type: 'text', text: payload('go') }] }),
                node({
                    type: 'fork',
                    callId: 'f1',
                    contextMode: 'inherit',
                    branches: [
                        {
                            name: 'review',
                            agent: 'researcher',
                            instructions: payload('look'),
                            childRunId: 'r2',
                        },
                    ],
                }),
                node({
                    type: 'join',
                    callId: 'f1',
                    usage: zeroUsage(),
                    branches: [
                        {
                            name: 'review',
                            agent: 'researcher',
                            status: 'ok',
                            output: payload('done'),
                            usage: zeroUsage(),
                            nodes: branch,
                        },
                    ],
                }),
                node({ type: 'final_output', output: payload('answer') }),
            ]),
        );

        // user_input, fork, [branch: llm, call, result], join, final_output
        expect(traceIndex(trace).map((n) => `${n.id} ${n.kind}`)).toEqual([
            'n1 user_input',
            'n2 fork',
            'n3 llm_call',
            'n4 tool_call',
            'n5 tool_result',
            'n6 join',
            'n7 final_output',
        ]);
        // The branch's nodes are the branch's, and say so.
        expect(traceIndex(trace).map((n) => n.branch)).toEqual([
            null,
            null,
            'review',
            'review',
            'review',
            null,
            null,
        ]);
    });

    it('recurses into a fork inside a branch', () => {
        const inner = [node({ type: 'llm_call', ...llm([]) }, 'deep')];
        const branch = [
            node({ type: 'join', callId: 'f2', usage: zeroUsage(), branches: [b('sub', inner)] }),
        ];
        const trace = traceOf(
            state([
                node({
                    type: 'join',
                    callId: 'f1',
                    usage: zeroUsage(),
                    branches: [b('a', branch)],
                }),
            ]),
        );
        expect(traceIndex(trace).map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
        expect(traceIndex(trace).map((n) => n.kind)).toEqual(['llm_call', 'join', 'join']);
    });
});

describe('interactive ask choices', () => {
    it('offers only LLM calls with a recorded request', () => {
        const trace = traceOf(
            state([
                node({ type: 'llm_call', ...llm([]) }),
                node({ type: 'tool_call', callId: 'c1', name: 'read_file', args: payload('{}') }),
                node({ type: 'llm_call', ...llm([]), request: payload('recorded request') }),
            ]),
        );

        expect(replayableCalls(trace).map(({ entry }) => entry.key)).toEqual(['n3']);
    });

    it('separates the question and markdown answer in labelled panels', () => {
        const answer = '# Finding\n\n- **Cause:** `python -c`';
        const rendered = plain(renderAskExchange('Why?', answer, 40).join('\n'));

        expect(rendered).toContain('╭─ Question ');
        expect(rendered).toContain('│ Why?');
        expect(rendered).toContain('╭─ Answer ');
        expect(rendered).toContain('│ Finding');
        expect(rendered).toContain('│ • Cause: python -c');
    });

    it('keeps asking until the person submits an empty question', async () => {
        const answered: string[] = [];
        const next = ['second', ''];

        await repeatQuestions(
            'first',
            async () => next.shift() ?? '',
            async (question) => {
                answered.push(question);
            },
        );

        expect(answered).toEqual(['first', 'second']);
    });

    it('reads the question from a file verbatim', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-ask-'));
        try {
            const body = "Why didn't you run `npm test`? (it's in $SKILL)\n";
            writeFileSync(join(dir, 'q.md'), body);

            expect(await readQuestion([], 'q.md', dir)).toBe(body.trim());
            expect(await readQuestion(['why', 'not?'], undefined, dir)).toBe('why not?');
            await expect(readQuestion(['why'], 'q.md', dir)).rejects.toThrow(/not both/);
            await expect(readQuestion([], 'missing.md', dir)).rejects.toThrow(/ENOENT/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the diagram', () => {
    it('never reports a node as starting before its own turn', () => {
        // A trajectory that begins mid-conversation has no `user_input` to
        // count from. The origin is then the first node, not whatever the
        // lane's predecessor was — otherwise the second node reads `t+-1.0s`.
        const text = traceMermaid(state(trunk().slice(1)));
        expect(text).not.toContain('t+-');
    });

    it('declares every node before any edge', () => {
        const text = traceMermaid(state(trunk()));
        const lines = text.split('\n');
        const lastDeclaration = lines.findLastIndex((l) => /^\s+n\d+[[({]/.test(l));
        const firstEdge = lines.findIndex((l) => /-->|-\.->/.test(l));
        expect(firstEdge).toBeGreaterThan(lastDeclaration);
    });

    it('counts the tools so a loop is a number', () => {
        const repeated = [
            node({ type: 'user_input', content: [{ type: 'text', text: payload('go') }] }),
            ...call('a', 'run_command', 'command=ls'),
            ...call('b', 'run_command', 'command=ls'),
            ...call('c', 'run_command', 'command=ls'),
            ...call('d', 'read_file', 'path=x'),
        ];
        expect(traceMermaid(state(repeated))).toContain('run_command x3, read_file x1');
    });

    it('marks a failed call by outcome, not by type', () => {
        const failed = [
            node({
                type: 'tool_result',
                callId: 'a',
                name: 'run_command',
                result: payload('no such file'),
                isError: true,
            }),
        ];
        const text = traceMermaid(state(failed));
        expect(text).toContain('class n1 err;');
        expect(text).toContain('ERROR run_command');
    });

    it('draws a call to the answer only when they are apart', () => {
        // Two calls issued together and answered in order: the second pair is
        // separated by the first answer, which is exactly when the edge helps.
        const parallel = [
            node({ type: 'llm_call', ...llm(['run_command', 'read_file'], ['x', 'y']) }),
            node({ type: 'tool_call', callId: 'x', name: 'run_command', args: payload('c=ls') }),
            node({ type: 'tool_call', callId: 'y', name: 'read_file', args: payload('p=a') }),
            node({
                type: 'tool_result',
                callId: 'x',
                name: 'run_command',
                result: payload('ok'),
                isError: false,
            }),
            node({
                type: 'tool_result',
                callId: 'y',
                name: 'read_file',
                result: payload('ok'),
                isError: false,
            }),
        ];
        const text = traceMermaid(state(parallel));
        expect(text).toContain('n2 -.-> n4'); // call x to its answer, two apart
        expect(text).toContain('n3 -.-> n5');
        expect(text).toContain('n1 -.-> n3'); // llm to the second call it made
        expect(text).not.toContain('n1 -.-> n2'); // adjacent: the flow says it
    });

    it('keeps a compacted node numbered and says it is hidden', () => {
        const nodes = trunk();
        const covered = nodes[1] as TrajectoryNode;
        nodes.push(
            node({
                type: 'compaction',
                callId: 'k',
                covers: [covered.id],
                summary: payload('gist'),
                reason: 'token_budget',
                usage: zeroUsage(),
            }),
        );
        const text = traceMermaid(state(nodes));
        expect(text).toContain('class n2 llm,covered;');
        // Named, not just marked: "compacted" alone reads as "did not happen".
        expect(text).toContain('hidden by n6');
    });

    it('explains itself in comments Mermaid ignores', () => {
        const text = traceMermaid(state(trunk()), { dir: '/tmp/runs/x' });
        const head = text.split('flowchart TD')[0] as string;
        expect(head).toContain('%% run');
        expect(head).toContain('zen inspect node');
        // A comment, never a directive: `%%{` would be parsed as configuration.
        for (const line of head.split('\n').filter(Boolean)) {
            expect(line.startsWith('%%')).toBe(true);
            expect(line.startsWith('%%{')).toBe(false);
            // Mermaid only strips a comment line that has something after the
            // marker; a bare `%%` reaches the parser and fails the whole graph.
            expect(line.trimEnd()).not.toBe('%%');
        }
    });

    // The reader of a graph is somewhere else by the time it has a question,
    // and reconstructing these three from a run id is work nobody should do.
    it('names the directories the run used, and leaves out the ones it had none of', () => {
        const head = (opts: object): string =>
            traceMermaid(state(trunk()), opts).split('flowchart TD')[0] as string;

        const full = head({ dir: '/p/sessions/s/runs/r', workspace: '/p/ws', memory: '/p/memory' });
        expect(full).toContain('%% dir       /p/sessions/s/runs/r');
        expect(full).toContain('%% workspace /p/ws');
        expect(full).toContain('%% memory    /p/memory');

        expect(head({ workspace: '/p/ws' })).not.toContain('%% memory');
    });

    // A run that thought and a run that did not are otherwise identical here:
    // the trajectory records reasoning tokens and the diagram used to drop
    // them, leaving "is thinking on?" unanswerable from the run itself.
    it('counts thinking, and says nothing when there was none', () => {
        const head = (nodes: TrajectoryNode[]): string =>
            traceMermaid(state(nodes)).split('flowchart TD')[0] as string;

        expect(head(trunk())).not.toContain('%% thinking');

        const thought = trunk();
        thought[1] = node({
            type: 'llm_call',
            ...llm(['run_command']),
            thinking: payload('first, list the files'),
            usage: { ...usage, reasoningTokens: 900 },
        });
        expect(head(thought)).toContain('%% thinking  1 of 1 llm calls · 900 thinking tokens');
    });

    // The question a reader has after finding a node they distrust is "why",
    // and `ask` is the verb for it. Nothing else in the output names it.
    it('points at both the command that opens a node and the one that asks about it', () => {
        const head = traceMermaid(state(trunk()), { dir: '/p/runs/r' }).split(
            'flowchart TD',
        )[0] as string;
        expect(head).toContain('zen inspect node n1 n2 n5..n9 --dir /p/runs/r');
        expect(head).toContain('zen inspect ask n5 "why did you do that?" --dir /p/runs/r');
    });
});

describe('untrusted text', () => {
    // The whole point: the labels are made from what a model wrote.
    const hostile = [
        '"] --> evil[" click n1 href "http://x"',
        'a\nb\r\nc',
        '%%{init: {"theme":"dark"}}%%',
        'subgraph end;;',
        '<script>alert(1)</script>',
        '-. text .-> n99',
    ].join(' ');

    it('lets no delimiter through', () => {
        // Not "no dangerous words" — the text is a model's and its words are
        // allowed to appear. What must not survive is anything Mermaid reads
        // as punctuation: a quote, a bracket, an arrow head, a comment mark.
        expect(safe(hostile)).not.toMatch(/["'`[\]{}<>#;%\\|&$]/);
        expect(safe(hostile)).not.toContain('\n');
    });

    it('survives a payload made entirely of delimiters', () => {
        const nasty = [
            node({ type: 'tool_call', callId: 'a', name: hostile, args: payload(hostile) }),
            node({
                type: 'tool_result',
                callId: 'a',
                name: hostile,
                result: payload(hostile),
                isError: false,
            }),
        ];
        const text = traceMermaid(state(nasty));
        for (const line of text.split('\n')) {
            if (!line.trim().startsWith('n')) {
                continue;
            }
            // Exactly two quotes per declaration: the ones we wrote.
            expect(line.split('"').length - 1).toBeLessThanOrEqual(2);
        }
        // The words survive — they are the model's and it may say what it likes
        // inside a label. What must not survive is a second *statement*: every
        // line of the diagram is still one this code meant to write.
        const grammar =
            /^(flowchart TD|classDef \w+ .*;|n\d+[[({].*[\])}]|class n\d+(,n\d+)* [\w,]+;|n\d+ (-->|-\.->) n\d+)$/;
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('%%')) {
                continue;
            }
            expect(trimmed).toMatch(grammar);
        }
        expect(text.split('\n').filter((l) => /-->|-\.->/.test(l))).toEqual(['    n1 --> n2']);
    });

    it('keeps a label to one line and one screen', () => {
        const long = 'word '.repeat(200);
        expect(safe(long)).not.toContain('\n');
        expect(safe(long).length).toBeLessThanOrEqual(110);
    });
});

describe('asking for nodes', () => {
    const known = new Map(['n1', 'n2', 'n3', 'n4', 'n5'].map((k) => [k, k]));

    it('takes ids and ranges', () => {
        expect(parseNodeIds(['n2', 'n4..n5'], known)).toEqual(['n2', 'n4', 'n5']);
    });

    it('does not repeat one asked for twice', () => {
        expect(parseNodeIds(['n2', 'n1..n2'], known)).toEqual(['n2', 'n1']);
    });

    it('frames a payload that impersonates the framing', () => {
        // Payloads are reproduced whole and unmodified, so one can contain a
        // line that looks exactly like the end of itself. The byte count is
        // what makes the real boundary findable, so it has to be the truth.
        const text = ['--- end args', '=== n2 · llm_call · nobody', 'µ'].join('\n');
        const out = renderNode({
            id: 'n1',
            nodeId: 'id0',
            kind: 'tool_call',
            agent: 'lead',
            branch: null,
            ts: '2026-01-01T12:00:00.000Z',
            label: 'run_command',
            facts: { tool: 'run_command' },
            parts: [{ name: 'args', text }],
        });
        const open = `--- part args · ${Buffer.byteLength(text)} bytes`;
        expect(out.split('\n').filter((l) => l.startsWith('--- part '))).toEqual([open]);
        const count = Number(/--- part args · (\d+) bytes/.exec(out)?.[1]);
        // Bytes, not characters: the payload holds multi-byte ones.
        expect(count).toBeGreaterThan(text.length);
        // And counting that many from the marker lands exactly on the payload.
        const body = Buffer.from(out.slice(out.indexOf(open) + open.length + 1));
        expect(body.subarray(0, count).toString()).toBe(text);
        expect(body.subarray(count).toString()).toBe('\n--- end args');
    });

    it('refuses what is not there', () => {
        expect(() => parseNodeIds(['n9'], known)).toThrow(/not in this run/);
        expect(() => parseNodeIds(['7'], known)).toThrow(/not a node id/);
        expect(() => parseNodeIds(['n5..n1'], known)).toThrow(/backwards/);
    });

    // A part left out has to leave a hole the reader can see and reverse. The
    // failure this prevents is silent truncation: a node that looks complete,
    // is not, and is reasoned about as though it were.
    it('names an elided part with its size instead of dropping it', () => {
        const detail = {
            id: 'n1',
            nodeId: 'id0',
            kind: 'llm_call',
            agent: 'lead',
            branch: null,
            ts: '2026-01-01T12:00:00.000Z',
            label: 'call',
            facts: {},
            parts: [
                { name: 'request', text: 'x'.repeat(5000) },
                { name: 'text', text: 'the answer' },
            ],
        };
        const out = renderNode(detail, (name) => name !== 'request');
        expect(out).toContain('--- part request · 5000 bytes · elided (--part request)');
        expect(out).not.toContain('--- end request');
        expect(out).toContain('--- part text · 10 bytes');
        expect(out).toContain('the answer');

        // And asked for, it comes back whole.
        expect(renderNode(detail)).toContain(`--- part request · 5000 bytes\n${'x'.repeat(5000)}`);
    });

    it('chooses parts by prefix, and says which exist when none matches', () => {
        const found = [
            {
                id: 'n7',
                parts: [{ name: 'request' }, { name: 'call run_command (toolu_1)' }],
            },
        ] as unknown as Parameters<typeof wholeParts>[0];

        // The default is the one part that is both huge and near-identical
        // between calls; everything else the node carries is printed.
        const byDefault = wholeParts(found, {});
        expect(byDefault('request')).toBe(false);
        expect(byDefault('call run_command (toolu_1)')).toBe(true);

        // A prefix, because the tool-call parts carry an id nobody can type.
        const asked = wholeParts(found, { part: ['call'] });
        expect(asked('call run_command (toolu_1)')).toBe(true);
        expect(asked('request')).toBe(false);

        expect(wholeParts(found, { full: true })('request')).toBe(true);

        // A name that matches nothing is a mistake, not an empty result: the
        // alternative is a node printed with every part elided and no reason.
        let thrown: unknown;
        try {
            wholeParts(found, { part: ['nope'] });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(CliError);
        expect((thrown as CliError).message).toContain('no part starts with "nope" in n7');
        // And it says what it could have been asked for.
        expect((thrown as CliError).hint).toContain('call run_command (toolu_1)');
    });
});

// ---------------------------------------------------------------------------

describe('a deferred banner', () => {
    const was = [process.stdin.isTTY, process.stderr.isTTY];

    afterEach(() => {
        process.stdin.isTTY = was[0];
        process.stderr.isTTY = was[1];
        deferBanner(() => {});
    });

    it('waits for a question that never comes', async () => {
        process.stdin.isTTY = false;
        process.stderr.isTTY = false;
        let shown = 0;
        deferBanner(() => void shown++);
        // Handing it over is not printing it.
        expect(shown).toBe(0);
        // One choice is not a question, so still nobody to show it to.
        expect(await choose('which', [{ label: 'only', value: 1 }])).toBe(1);
        expect(shown).toBe(0);
        // A real question without a terminal fails instead of blocking, and a
        // banner over that failure would be decorating an error.
        await expect(
            choose('which', [
                { label: 'a', value: 1 },
                { label: 'b', value: 2 },
            ]),
        ).rejects.toThrow(/without a terminal/);
        expect(shown).toBe(0);
    });
});

// ---------------------------------------------------------------------------

describe('runPathsAt', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'zen-trace-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const layout = (session: string, run: string): string => {
        const dir = join(root, 'sessions', session, 'runs', run);
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    it('reads the ids back out of the path', () => {
        const dir = layout('20260101-120000-aaaa', '20260101-120500-bbbb');
        writeFileSync(join(dir, 'state.json'), '{}');
        const found = runPathsAt(dir);
        expect(found.project).toBe(root);
        expect(found.session.id).toBe('20260101-120000-aaaa');
        expect(found.run.id).toBe('20260101-120500-bbbb');
        // Blobs are per session, which is the reason both halves come back.
        expect(found.session.blobs).toBe(
            join(root, 'sessions', '20260101-120000-aaaa', '.data', 'blobs'),
        );
    });

    it('names the graph beside the report', () => {
        const dir = layout('20260101-120000-aaaa', '20260101-120500-bbbb');
        writeFileSync(join(dir, 'state.json'), '{}');
        const { run } = runPathsAt(dir);
        expect(run.report).toBe(join(dir, 'report.html'));
        expect(run.graph).toBe(join(dir, 'graph.mmd'));
    });

    it('refuses a directory this layout never made', () => {
        const dir = join(root, 'somewhere', 'else');
        mkdirSync(dir, { recursive: true });
        expect(() => runPathsAt(dir)).toThrow(CliError);
    });

    it('refuses a run that never saved state', () => {
        const dir = layout('20260101-120000-aaaa', '20260101-120500-bbbb');
        expect(() => runPathsAt(dir)).toThrow(/no state.json/);
    });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function llm(names: string[], ids: string[] = names.map((_, i) => `c${i}`)) {
    return {
        model: 'test-model',
        requestDigest: 'd',
        text: payload('thinking about it'),
        toolCalls: names.map((name, i) => ({
            callId: ids[i] as string,
            name,
            args: payload('{}'),
        })),
        usage,
        stopReason: (names.length ? 'tool_calls' : 'stop') as 'tool_calls' | 'stop',
    };
}

function b(name: string, nodes: TrajectoryNode[]) {
    return {
        name,
        agent: 'worker',
        status: 'ok' as const,
        output: payload('done'),
        usage: zeroUsage(),
        nodes,
    };
}

function trunk(): TrajectoryNode[] {
    return [
        node({ type: 'user_input', content: [{ type: 'text', text: payload('go') }] }),
        node({ type: 'llm_call', ...llm(['run_command']) }),
        ...call('c0', 'run_command', 'command=ls -la'),
        node({ type: 'final_output', output: payload('answer') }),
    ];
}
