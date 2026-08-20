import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRunner } from '../src/runner.ts';
import { InMemoryMemoryStore } from '../src/memory-stores/in-memory.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { exportRun, importRun } from '../src/payload.ts';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { StaticSkillProvider } from '../src/skill-providers/static.ts';
import { assertState, turns, type AgentState } from '../src/state.ts';
import { projectMessages, totalUsage, type TrajectoryNode } from '../src/trajectory.ts';
import { tool, zeroUsage, type ToolCall } from '../src/types.ts';

// ---------------------------------------------------------------------------
// A scripted model: rules inspect the projected request, so the tests exercise
// the real loop (projection, tool dispatch, kernel transitions) end to end.
// ---------------------------------------------------------------------------

type Rule = (req: ModelRequest) => ModelResponse | undefined;

class RuleModel implements Model {
    readonly id = 'scripted';
    calls = 0;
    readonly #rules: Rule[];

    constructor(...rules: Rule[]) {
        this.#rules = rules;
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        this.calls++;
        for (const rule of this.#rules) {
            const res = rule(req);
            if (res) {
                return { usage: { ...zeroUsage(), inputTokens: 10, outputTokens: 5 }, ...res };
            }
        }
        throw new Error(`no rule matched (last user: ${lastUser(req)})`);
    }
}

let callSeq = 0;

function say(text: string): ModelResponse {
    return { text, toolCalls: [], stopReason: 'stop' };
}

function callTool(name: string, args: unknown): ModelResponse {
    const call: ToolCall = { id: `c${++callSeq}`, name, args: JSON.stringify(args) };
    return { text: '', toolCalls: [call], stopReason: 'tool_calls' };
}

function lastUser(req: ModelRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i];
        if (m.role === 'user') {
            return m.content.map((p) => (p.type === 'text' ? p.text : p.url)).join('\n');
        }
    }
    return '';
}

function hasToolResult(req: ModelRequest, name: string): boolean {
    return req.messages.some((m) => m.role === 'tool' && m.name === name);
}

function allText(req: ModelRequest): string {
    return JSON.stringify(req.messages) + (req.system ?? '');
}

function findNode<T extends TrajectoryNode['type']>(
    state: AgentState,
    type: T,
): Extract<TrajectoryNode, { type: T }> {
    const node = state.trajectory.find((n) => n.type === type);
    if (!node) {
        throw new Error(`no ${type} node in the trajectory`);
    }
    return node as Extract<TrajectoryNode, { type: T }>;
}

// ---------------------------------------------------------------------------

describe('smoke', () => {
    it('runs a handoff and a tool call end to end', async () => {
        const add = tool<{ a: number; b: number }>({
            name: 'add',
            description: 'adds',
            parameters: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
            },
            execute: ({ a, b }) => a + b,
        });

        const model = new RuleModel(
            (req) =>
                req.system?.includes('ROUTER') ? callTool('transfer_to_worker', {}) : undefined,
            (req) => (hasToolResult(req, 'add') ? say('the answer is 5') : undefined),
            () => callTool('add', { a: 2, b: 3 }),
        );

        const runner = new AgentRunner({ model });
        runner.agent({ name: 'worker', instructions: 'WORKER', tools: [add] });
        runner.agent({ name: 'router', instructions: 'ROUTER', handoffs: ['worker'] });

        const seen: string[] = [];
        const stream = runner.run('router', 'add two and three');
        for await (const e of stream) {
            seen.push(e.type);
        }
        const res = await stream.final();

        expect(res.output).toBe('the answer is 5');
        expect(res.agent).toBe('worker');
        expect(res.stopReason).toBe('final');
        expect(turns(res.state)).toBe(3);
        expect(seen).toContain('handoff');
        expect(seen).toContain('before_tool_call');
        expect(seen).toContain('after_tool_call');
        expect(res.usage.inputTokens).toBe(30);
        // Two system prompts (one per agent) — the second one supersedes the first.
        const { system, messages } = await projectMessages(
            res.state.trajectory,
            runner.services.payloads,
        );
        expect(system).toBe('WORKER');
        expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('repairs a typed output that violates the schema', async () => {
        const Plan = z.object({ steps: z.array(z.string()).min(1), cost: z.number() });

        const model = new RuleModel(
            (req) =>
                hasToolResult(req, 'final_output')
                    ? callTool('final_output', { steps: ['a', 'b'], cost: 42 })
                    : undefined,
            // First attempt violates the schema: cost is a string.
            () => callTool('final_output', { steps: ['a'], cost: 'free' }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'planner', instructions: 'PLAN' });

        const res = await runner.run('planner', 'plan it', { output: Plan });
        expect(res.output).toEqual({ steps: ['a', 'b'], cost: 42 });
        expect(model.calls, 'the model repaired its own output').toBe(2);
        expect(res.state.phase).toBe('done');
    });

    it('forks branches and joins them in declared order', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'fork') ? say('combined answer') : undefined),
            (req) =>
                lastUser(req).startsWith('branch:') ? say(`done ${lastUser(req)}`) : undefined,
            () =>
                callTool('fork', {
                    branches: [
                        { name: 'left', instructions: 'branch: left' },
                        { name: 'right', instructions: 'branch: right' },
                    ],
                    context: 'compact',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'lead', instructions: 'LEAD', fork: { maxBranches: 3 } });

        const branchEvents: string[] = [];
        const stream = runner.run('lead', 'do both');
        for await (const e of stream) {
            if (e.branch) {
                branchEvents.push(`${e.branch.name}:${e.type}`);
            }
        }
        const res = await stream.final();

        expect(res.output).toBe('combined answer');
        const join = findNode(res.state, 'join');
        // Declared order, not completion order.
        expect(join.branches.map((b) => b.name)).toEqual(['left', 'right']);
        expect(join.branches.every((b) => b.status === 'ok')).toBe(true);
        // Branch tokens are folded into the parent's total.
        expect(res.usage.inputTokens).toBe(10 + join.usage.inputTokens + 10);
        expect(branchEvents.some((e) => e.startsWith('left:'))).toBe(true);
        // The parent sees the whole episode as one tool call + one tool result.
        const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
        const forkResults = messages.filter((m) => m.role === 'tool' && m.name === 'fork');
        expect(forkResults).toHaveLength(1);
        const [forkResult] = forkResults;
        expect(forkResult.role === 'tool' && forkResult.content).toContain('done branch: left');

        // The branches' own history hangs off the join — there for audit, and
        // structurally out of the parent's scope.
        const raw = res.state.trajectory;
        expect(join.branches.map((b) => b.nodes.length).every((n) => n > 0)).toBe(true);
        expect(raw.filter((n) => n.type === 'llm_call'), 'parent calls only').toHaveLength(2);
        expect(turns(res.state), 'branch turns are not the parent\u2019s').toBe(2);
        // Accounting is the one thing that crosses the boundary, by recursion.
        expect(totalUsage(raw).inputTokens).toBe(40);

        // Export reaches branch payloads through the generic deep walk.
        const bundle = await exportRun(res.state, runner.services.payloads);
        expect(Object.values(bundle.blobs)).toContain('done branch: left');
    });

    it('keeps a branch agent out of the parent after the join', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'fork') ? say('merged') : undefined),
            (req) => (req.system === 'SCOUT' ? say('scouted') : undefined),
            () =>
                callTool('fork', {
                    branches: [
                        { name: 'a', instructions: 'go a', agent: 'scout' },
                        { name: 'b', instructions: 'go b', agent: 'scout' },
                    ],
                    context: 'none',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'scout', instructions: 'SCOUT' });
        runner.agent({
            name: 'lead',
            instructions: 'LEAD',
            fork: { agents: ['scout'], maxBranches: 4 },
        });

        const res = await runner.run('lead', 'delegate');
        expect(res.output).toBe('merged');
        expect(res.agent).toBe('lead');

        // The prompt in force after the join is the one from before the fork.
        const { system } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(system).toBe('LEAD');
        expect(res.state.trajectory.some((n) => n.agent === 'scout')).toBe(false);
        // … while the branch's own prompt is still on record, one level down.
        const join = findNode(res.state, 'join');
        expect(
            join.branches.every((b) =>
                b.nodes.some((n) => n.type === 'system_prompt' && n.agent === 'scout'),
            ),
        ).toBe(true);
    });

    it('writes memory and recalls it on a later run', async () => {
        const store = new InMemoryMemoryStore('mem');
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'memory_write') ? say('noted') : undefined),
            (req) =>
                allText(req).includes('Relevant memories')
                    ? say('I remember you like trains')
                    : undefined,
            () => callTool('memory_write', { text: 'the user prefers trains over planes' }),
        );
        const runner = new AgentRunner({ model, memory: [store] });
        runner.agent({
            name: 'assistant',
            instructions: 'ASSIST',
            memory: [
                {
                    store: 'mem',
                    scope: 'user:u1',
                    access: 'read-write',
                    autoRecall: { query: 'last_user_input', limit: 3 },
                },
            ],
        });

        const first = await runner.run('assistant', 'remember that I prefer trains');
        expect(first.output).toBe('noted');
        const op = findNode(first.state, 'memory_op');
        expect(op.op).toBe('write');
        expect(op.scope).toBe('user:u1');

        const second = await runner.run('assistant', 'how should I travel by trains?');
        const recall = findNode(second.state, 'memory_recall');
        expect(recall.hits).toHaveLength(1);
        expect(second.output).toBe('I remember you like trains');
    });

    it('loads a skill on demand and unlocks its tools', async () => {
        const cheapHotels = tool<Record<string, never>>({
            name: 'cheap_hotels',
            description: 'lists cheap hotels',
            parameters: { type: 'object', properties: {} },
            execute: () => ['hostel one', 'hostel two'],
        });
        const provider = new StaticSkillProvider([
            {
                name: 'budget_travel',
                description: 'plan on a budget',
                content: 'Prefer trains. Book outside the centre.',
                tools: [cheapHotels],
            },
        ]);

        const model = new RuleModel(
            (req) => (hasToolResult(req, 'cheap_hotels') ? say('stay at hostel one') : undefined),
            (req) =>
                req.tools.some((t) => t.name === 'cheap_hotels')
                    ? callTool('cheap_hotels', {})
                    : undefined,
            () => callTool('skill_load', { names: ['budget_travel'] }),
        );
        const runner = new AgentRunner({ model, skills: [provider] });
        runner.agent({
            name: 'guide',
            instructions: 'GUIDE',
            skills: { provider: 'static', discovery: 'index' },
        });

        const res = await runner.run('guide', 'cheap trip please');
        const load = findNode(res.state, 'load_skills');
        expect(load.toolNames).toEqual(['cheap_hotels']);
        expect(res.output).toBe('stay at hostel one');
        // The instructions reached the model through the node, not the tool result.
        const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(JSON.stringify(messages)).toContain('Prefer trains');
    });

    it('resumes from a checkpoint and exports the run', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'ping') ? say('pong received') : undefined),
            () => callTool('ping', {}),
        );
        const ping = tool<Record<string, never>>({
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {} },
            execute: () => 'pong',
        });
        const blobs = new InMemoryPayloadStore();
        const runner = new AgentRunner({ model, payloads: blobs });
        runner.agent({ name: 'echo', instructions: 'ECHO', tools: [ping] });

        // Stop at the checkpoint taken *before* the tool executes, persist it, and
        // continue from the snapshot alone.
        let snapshot: AgentState | undefined;
        const stream = runner.run('echo', 'ping please');
        for await (const e of stream) {
            if (e.type === 'before_tool_call') {
                snapshot = assertState(JSON.parse(JSON.stringify(e.state)));
                break;
            }
        }
        if (!snapshot) {
            throw new Error('no checkpoint captured');
        }
        expect(snapshot.phase).toBe('awaiting_tools');
        expect(snapshot.pendingToolCalls).toHaveLength(1);

        const resumed = await runner.resume(snapshot);
        expect(resumed.output).toBe('pong received');

        // Portability: state + blobs travel as one artifact.
        const bundle = await exportRun(resumed.state, runner.services.payloads);
        const restored = await importRun<AgentState>(bundle, new InMemoryPayloadStore('mem'));
        expect(restored.runId).toBe(resumed.state.runId);
        expect(Object.keys(bundle.blobs).length).toBeGreaterThan(3);
    });

    it('hides a compacted node without deleting it', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'noisy') ? say('final') : undefined),
            () => callTool('noisy', {}),
        );
        const noisy = tool<Record<string, never>>({
            name: 'noisy',
            description: 'noisy',
            parameters: { type: 'object', properties: {} },
            execute: () => 'x'.repeat(500),
        });
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'a', instructions: 'A', tools: [noisy] });

        const res = await runner.run('a', 'go');
        const toolResult = findNode(res.state, 'tool_result');

        const { Kernel } = await import('../src/index.ts');
        const env = { services: runner.services };
        const compacted = await Kernel.applyCompaction(
            res.state,
            {
                covers: [toolResult.id],
                summary: 'the tool returned a long blob',
                reason: 'token_budget',
            },
            env,
        );
        const { messages } = await projectMessages(
            compacted.trajectory,
            runner.services.payloads,
        );
        const text = JSON.stringify(messages);
        expect(text, 'covered node is hidden from the projection').not.toContain('xxxxx');
        expect(text).toContain('the tool returned a long blob');
        // The orphaned tool call was dropped, so the request stays provider-valid.
        expect(!text.includes('"noisy"') || !text.includes('tool_call')).toBe(true);
        // The original node is still there for audit — the log is append-only.
        expect(compacted.trajectory.some((n) => n.id === toolResult.id)).toBe(true);
        expect(compacted.trajectory.length).toBe(res.state.trajectory.length + 1);

        // A second compaction covering the first must not resurrect what the
        // first one hid: the covered set is a union, so compaction is monotone.
        const first = compacted.trajectory[compacted.trajectory.length - 1];
        const twice = await Kernel.applyCompaction(
            compacted,
            { covers: [first.id], summary: 'even shorter', reason: 'token_budget' },
            env,
        );
        const again = JSON.stringify(
            (await projectMessages(twice.trajectory, runner.services.payloads)).messages,
        );
        expect(again).toContain('even shorter');
        expect(again).not.toContain('the tool returned a long blob');
        expect(again, 'a covered node stays covered').not.toContain('xxxxx');
    });

    it('compacts a hand-off through a policy and an async summarizer', async () => {
        const model = new RuleModel(
            (req) => (req.system === 'B' ? say('done by b') : undefined),
            () => callTool('transfer_to_b', {}),
        );
        const runner = new AgentRunner({
            model,
            handoffPolicy: {
                // Everything the outgoing agent produced, by node identity.
                select: (state) =>
                    state.trajectory.filter(
                        (n) => n.agent === 'a' && n.type !== 'user_input',
                    ),
            },
            summarizer: {
                summarize: (nodes, reason) =>
                    Promise.resolve(`[${reason}] a did ${nodes.length} things`),
            },
        });
        runner.agent({ name: 'b', instructions: 'B' });
        runner.agent({ name: 'a', instructions: 'A', handoffs: ['b'] });

        const res = await runner.run('a', 'start');
        expect(res.output).toBe('done by b');
        const compaction = findNode(res.state, 'compaction');
        expect(compaction.reason).toBe('handoff_noise');
        expect(compaction.covers.length).toBeGreaterThan(0);

        const { system, messages } = await projectMessages(
            res.state.trajectory,
            runner.services.payloads,
        );
        expect(system).toBe('B');
        // The summary reaches the model as a tool result, not as a user turn.
        const summary = messages.find((m) => m.role === 'tool' && m.name === 'compact');
        expect(summary && summary.role === 'tool' && summary.content).toContain('handoff_noise');
        expect(messages.some((m) => m.role === 'user' && JSON.stringify(m).includes('a did'))).toBe(
            false,
        );
    });
});
