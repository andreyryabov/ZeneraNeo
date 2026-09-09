import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT } from '../src/inspect/client.ts';
import { buildRunReport, renderReportHtml, renderRunReport } from '../src/inspect/index.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { PayloadResolver } from '../src/payload.ts';
import { AgentRunner } from '../src/runner.ts';
import type { AgentState } from '../src/state.ts';
import { tool, zeroUsage, type ToolCall } from '../src/types.ts';

// A model that calls a tool once, then answers.
class ScriptModel implements Model {
    readonly id = 'scripted';
    #calls = 0;

    async generate(_req: ModelRequest): Promise<ModelResponse> {
        this.#calls++;
        const usage = { ...zeroUsage(), inputTokens: 10, outputTokens: 4 };
        if (this.#calls === 1) {
            const call: ToolCall = { id: 'c1', name: 'echo', args: '{"value":"hi"}' };
            return { text: '', toolCalls: [call], stopReason: 'tool_calls', usage };
        }
        return { text: 'done', toolCalls: [], stopReason: 'stop', usage };
    }
}

const echo = tool<{ value: string }>({
    name: 'echo',
    description: 'echoes',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    execute: ({ value }) => value,
});

async function runOnce(recordRequests: boolean): Promise<AgentState> {
    const runner = new AgentRunner({ model: new ScriptModel(), recordRequests });
    runner.agent({ name: 'worker', instructions: 'WORKER', tools: [echo] });
    const stream = runner.run('worker', 'say hi');
    const res = await stream.final();
    return res.state;
}

describe('run inspector', () => {
    it('records the request behind the llm_call node when asked', async () => {
        const state = await runOnce(true);
        const calls = state.trajectory.filter((n) => n.type === 'llm_call');
        expect(calls.length).toBe(2);
        for (const call of calls) {
            expect(call.request).toBeDefined();
            expect(call.requestDigest).toMatch(/^[0-9a-f]{64}$/);
        }
        // The second request carries the first call's tool result, so it is larger.
        expect(calls[1].request!.size).toBeGreaterThan(calls[0].request!.size);
    });

    it('leaves the request out by default', async () => {
        const state = await runOnce(false);
        for (const n of state.trajectory) {
            if (n.type === 'llm_call') {
                expect(n.request).toBeUndefined();
            }
        }
    });

    it('renders a self-contained page whose payloads are all resolved', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore('blobs'));
        const runner = new AgentRunner({
            model: new ScriptModel(),
            payloads,
            recordRequests: true,
        });
        runner.agent({ name: 'worker', instructions: 'WORKER', tools: [echo] });
        const res = await runner.run('worker', 'say hi').final();

        const report = await buildRunReport(res.state, runner.services.payloads);
        expect(Object.keys(report.blobs).length).toBeGreaterThan(0);
        expect(report.truncated).toEqual([]);

        const html = await renderRunReport(res.state, runner.services.payloads, { title: 'T' });
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('<title>T</title>');
        expect(html).toContain('flowchart TD');
    });

    it('carries the declared architecture when the runner is asked for it', async () => {
        const runner = new AgentRunner({ model: new ScriptModel() });
        runner.agent({
            name: 'worker',
            instructions: 'WORKER',
            tools: [echo],
            handoffs: ['other'],
        });
        runner.agent({ name: 'other', instructions: 'OTHER' });
        const res = await runner.run('worker', 'say hi').final();

        const report = await buildRunReport(res.state, runner.services.payloads, {
            architecture: await runner.describe(),
        });
        expect(report.architecture?.source).toBe('declared');
        // 'other' was never handed to, so only the snapshot knows it exists.
        expect(report.architecture?.agents.map((a) => a.name)).toEqual(['worker', 'other']);
        expect(res.state.trajectory.some((n) => n.agent === 'other')).toBe(false);

        const html = renderReportHtml(report);
        expect(html).toContain('data-view="agents"');
    });

    it('renders the agents tab with no architecture to work from', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;
        const html = await renderRunReport(state, payloads);
        expect(html).toContain('data-view="agents"');
        expect(html).toContain('observedArchitecture');
    });

    it('truncates an oversized payload instead of inlining it', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const big = 'x'.repeat(5000);
        const ref = await payloads.put(big);
        const state = { runId: 'r', trajectory: [{ blob: ref }] } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { maxBlobBytes: 100 });
        expect(report.truncated).toEqual([ref.sha256]);
        expect(report.blobs[ref.sha256].length).toBe(100);
    });

    it('inlines an image once, however many turns re-send it', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const photo = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(400);
        // The same picture as the run holds it, and as two requests replay it.
        const ref = await payloads.put(JSON.stringify({ url: photo, again: photo }));
        const state = {
            runId: 'r',
            trajectory: [
                { type: 'user_input', content: [{ type: 'image', url: photo }] },
                { request: ref },
            ],
        } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { maxBlobBytes: 2000 });
        expect(report.media).toEqual([photo]);
        expect(report.truncated).toEqual([]);
        expect(report.blobs[ref.sha256]).toBe('{"url":"media:0","again":"media:0"}');
        const input = report.state.trajectory[0] as unknown as {
            content: { url: string }[];
        };
        expect(input.content[0].url).toBe('media:0');
    });

    it('cannot be escaped by payload content', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const hostile = '</script><img src=x onerror=alert(1)>\u2028';
        const ref = await payloads.put(hostile);
        const state = { runId: 'r', trajectory: [{ blob: ref }] } as unknown as AgentState;

        const html = await renderRunReport(state, payloads);
        const embedded = html.slice(html.indexOf('id="run-data"'));
        expect(embedded).not.toContain('</script><img');
        expect(embedded).not.toContain('\u2028');
        expect(html).toContain('\\u003c/script\\u003e');
    });

    // The page's whole brain is a string, which no type checker reads. Parsing
    // it here is the difference between a typo and a blank report.
    it('embeds a client a browser can parse', () => {
        expect(() => new Function('MERMAID_URL', CLIENT)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// The memory view
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

const AT = '2026-01-01T00:00:00.000Z';

async function memory(noteText = 'written by this run'): Promise<MemoryStore> {
    const dir = mkdtempSync(join(tmpdir(), 'zn-runmem-'));
    dirs.push(dir);
    const store = await MemoryStore.open(dir, { lock: false });
    const all = ['*'];
    store.graph.add({ id: 'task', kind: 'task', text: 'reconcile the ledger', audience: all }, AT);
    store.graph.add({ id: 'plan', kind: 'plan', text: 'diff, then explain', audience: all }, AT);
    store.graph.add({ id: 'note', kind: 'fact', text: noteText, audience: all }, AT);
    store.graph.add({ id: 'other', kind: 'fact', text: 'not this run', audience: all }, AT);
    store.graph.link('task', 'plan', 'PRODUCED', AT);
    store.graph.link('plan', 'other', 'INFORMED', AT);
    return store;
}

/** A run that recalled two nodes and committed a third. */
function touched(): AgentState {
    return {
        runId: 'r',
        trajectory: [
            {
                type: 'memory_recall',
                id: 'n1',
                agent: 'worker',
                ts: AT,
                query: { text: 'ledger' },
                seeds: ['task'],
                nodes: [
                    { id: 'task', kind: 'task', score: 0.82 },
                    { id: 'plan', kind: 'plan', score: 0 },
                ],
                edges: [{ source: 'task', target: 'plan', relation: 'PRODUCED' }],
            },
            {
                type: 'memory_op',
                id: 'n2',
                agent: 'worker',
                ts: AT,
                op: 'commit',
                opId: 'o1',
                nodes: [{ id: 'note', kind: 'fact', revision: 1 }],
                edges: [],
                files: 0,
            },
        ],
    } as unknown as AgentState;
}

describe('the run report memory view', () => {
    it('carries the nodes the run touched, and no others', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const report = await buildRunReport(touched(), payloads, { memory: await memory() });

        expect(report.memory?.nodes.map((n) => n.id).sort()).toEqual(['note', 'plan', 'task']);
        expect(report.memory?.nodes.find((n) => n.id === 'task')?.text).toBe(
            'reconcile the ledger',
        );
        // An edge with one end outside the run is not an edge this page can draw.
        expect(report.memory?.edges).toEqual([
            { source: 'task', target: 'plan', relation: 'PRODUCED' },
        ]);
        // Degree is a fact about the memory, not about the cut.
        expect(report.memory?.nodes.find((n) => n.id === 'plan')?.degree).toBe(2);
    });

    it('finds the memory a branch touched too', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = {
            runId: 'r',
            trajectory: [
                {
                    type: 'join',
                    id: 'j',
                    agent: 'worker',
                    ts: AT,
                    branches: [{ name: 'b', agent: 'worker', nodes: touched().trajectory }],
                },
            ],
        } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { memory: await memory() });
        expect(report.memory?.nodes.map((n) => n.id).sort()).toEqual(['note', 'plan', 'task']);
    });

    it('says nothing when there is no memory to say it about', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;

        expect((await buildRunReport(touched(), payloads)).memory).toBeUndefined();
        expect(
            (await buildRunReport(state, payloads, { memory: await memory() })).memory,
        ).toBeUndefined();
    });

    it('renders the tab, and hides node text behind the same escaping', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const html = renderReportHtml(
            await buildRunReport(touched(), payloads, {
                memory: await memory('</script><img src=x>'),
            }),
        );

        expect(html).toContain('data-view="memory"');
        expect(html).toContain('id="mdetail"');
        expect(html).not.toContain('</script><img');
    });
});
