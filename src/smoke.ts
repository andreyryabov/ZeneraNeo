import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentRunner } from './runner.ts';
import { InMemoryMemoryStore } from './memory.ts';
import type { Model, ModelRequest, ModelResponse } from './model.ts';
import { exportRun, importRun, InMemoryPayloadStore } from './payload.ts';
import { StaticSkillProvider } from './skills.ts';
import { assertState, turns, type AgentState } from './state.ts';
import { projectMessages } from './trajectory.ts';
import { tool, zeroUsage, type ToolCall } from './types.ts';

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

// ---------------------------------------------------------------------------

async function testHandoffAndTools() {
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
        (req) => (req.system?.includes('ROUTER') ? callTool('transfer_to_worker', {}) : undefined),
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

    assert.equal(res.output, 'the answer is 5');
    assert.equal(res.agent, 'worker');
    assert.equal(res.stopReason, 'final');
    assert.equal(turns(res.state), 3);
    assert.ok(seen.includes('handoff'), 'handoff event');
    assert.ok(seen.includes('before_tool_call') && seen.includes('after_tool_call'));
    assert.equal(res.usage.inputTokens, 30);
    // Two system prompts (one per agent) — the second one supersedes the first.
    const { system, messages } = await projectMessages(
        res.state.trajectory,
        runner.services.payloads,
    );
    assert.equal(system, 'WORKER');
    assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
    console.log('ok  handoff + tools');
}

async function testTypedOutputRepair() {
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
    assert.deepEqual(res.output, { steps: ['a', 'b'], cost: 42 });
    assert.equal(model.calls, 2, 'the model repaired its own output');
    assert.equal(res.state.phase, 'done');
    console.log('ok  typed output + repair loop');
}

async function testForkJoin() {
    const model = new RuleModel(
        (req) => (hasToolResult(req, 'fork') ? say('combined answer') : undefined),
        (req) => (lastUser(req).startsWith('branch:') ? say(`done ${lastUser(req)}`) : undefined),
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

    assert.equal(res.output, 'combined answer');
    const join = res.state.trajectory.find((n) => n.type === 'join');
    assert.ok(join && join.type === 'join');
    // Declared order, not completion order.
    assert.deepEqual(
        join.results.map((r) => r.name),
        ['left', 'right'],
    );
    assert.ok(join.results.every((r) => r.status === 'ok'));
    // Branch tokens are folded into the parent's total.
    assert.equal(res.usage.inputTokens, 10 + join.usage.inputTokens + 10);
    assert.ok(branchEvents.some((e) => e.startsWith('left:')));
    // The parent sees the whole episode as one tool call + one tool result.
    const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
    const forkResults = messages.filter((m) => m.role === 'tool' && m.name === 'fork');
    assert.equal(forkResults.length, 1);
    assert.ok(forkResults[0].role === 'tool' && forkResults[0].content.includes('done branch: left'));
    console.log('ok  fork + join');
}

async function testMemory() {
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
    assert.equal(first.output, 'noted');
    const op = first.state.trajectory.find((n) => n.type === 'memory_op');
    assert.ok(op && op.type === 'memory_op' && op.op === 'write' && op.scope === 'user:u1');

    const second = await runner.run('assistant', 'how should I travel by trains?');
    const recall = second.state.trajectory.find((n) => n.type === 'memory_recall');
    assert.ok(recall && recall.type === 'memory_recall' && recall.hits.length === 1);
    assert.equal(second.output, 'I remember you like trains');
    console.log('ok  memory write + auto-recall');
}

async function testSkills() {
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
    const load = res.state.trajectory.find((n) => n.type === 'load_skills');
    assert.ok(load && load.type === 'load_skills');
    assert.deepEqual(load.toolNames, ['cheap_hotels']);
    assert.equal(res.output, 'stay at hostel one');
    // The instructions reached the model through the node, not the tool result.
    const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
    assert.ok(JSON.stringify(messages).includes('Prefer trains'));
    console.log('ok  skills: on-demand load + unlocked tools');
}

async function testCheckpointResume() {
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
    assert.ok(snapshot, 'checkpoint captured');
    assert.equal(snapshot.phase, 'awaiting_tools');
    assert.equal(snapshot.pendingToolCalls.length, 1);

    const resumed = await runner.resume(snapshot);
    assert.equal(resumed.output, 'pong received');

    // Portability: state + blobs travel as one artifact.
    const bundle = await exportRun(resumed.state, runner.services.payloads);
    const restored = importRun<AgentState>(bundle, new InMemoryPayloadStore('mem'));
    assert.equal(restored.runId, resumed.state.runId);
    assert.ok(Object.keys(bundle.blobs).length > 3);
    console.log('ok  checkpoint resume + export/import');
}

async function testCompactionMasking() {
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
    const toolResult = res.state.trajectory.find((n) => n.type === 'tool_result');
    assert.ok(toolResult);

    const { Kernel } = await import('./index.ts');
    const compacted = await Kernel.applyCompaction(
        res.state,
        {
            maskFrom: toolResult.seq,
            maskTo: toolResult.seq,
            summary: 'the tool returned a long blob',
            reason: 'token_budget',
        },
        { services: runner.services },
    );
    const { messages } = await projectMessages(compacted.trajectory, runner.services.payloads);
    const text = JSON.stringify(messages);
    assert.ok(!text.includes('xxxxx'), 'masked node is hidden from the projection');
    assert.ok(text.includes('the tool returned a long blob'));
    // The orphaned tool call was dropped, so the request stays provider-valid.
    assert.ok(!text.includes('"noisy"') || !text.includes('tool_call'));
    // The original node is still there for audit.
    assert.ok(compacted.trajectory.some((n) => n.seq === toolResult.seq));
    console.log('ok  compaction masks without deleting');
}

async function main() {
    await testHandoffAndTools();
    await testTypedOutputRepair();
    await testForkJoin();
    await testMemory();
    await testSkills();
    await testCheckpointResume();
    await testCompactionMasking();
    console.log('\nall smoke tests passed');
}

void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
