import { describe, expect, it } from 'vitest';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { AgentRunner } from '../src/runner.ts';
import { StaticSkillProvider } from '../src/skill-providers/static.ts';
import { tool, zeroUsage } from '../src/types.ts';

class StubModel implements Model {
    readonly id: string;
    constructor(id: string) {
        this.id = id;
    }
    async generate(_req: ModelRequest): Promise<ModelResponse> {
        return { text: '', toolCalls: [], stopReason: 'stop', usage: zeroUsage() };
    }
}

type Ctx = { user: string };

const lookup = tool<{ id: string }, Ctx>({
    name: 'lookup',
    description: 'looks up',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: ({ id }) => id,
});

const quote = tool<Record<string, never>, Ctx>({
    name: 'duty_quote',
    description: 'quotes duty',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => 'ok',
});

function build(): AgentRunner<Ctx> {
    const skills = new StaticSkillProvider(
        [
            { name: 'refunds', description: 'refund policy', content: 'R', tools: [quote] },
            { name: 'shipping', description: 'shipping delays', content: 'S' },
            { name: 'internal', description: 'not for this agent', content: 'I' },
        ],
        'catalog',
    );
    const runner = new AgentRunner<Ctx>({
        model: new StubModel('default-model'),
        context: { user: 'u-1' },
        skills: [skills],
    });
    runner.agent({
        name: 'router',
        description: 'routes',
        tools: [lookup],
        handoffs: ['resolver'],
        skills: {
            provider: 'catalog',
            discovery: 'index',
            preload: ['shipping'],
            allow: ['refunds', 'shipping'],
        },
        memory: [{ store: 'notes', scope: (c) => `user:${c.user}`, access: 'read-write' }],
    });
    runner.agent({
        name: 'resolver',
        model: new StubModel('pinned-model'),
        fork: { maxBranches: 2 },
    });
    return runner;
}

describe('architecture snapshot', () => {
    it('describes the declared wiring', async () => {
        const arch = await build().describe();
        expect(arch.source).toBe('declared');
        expect(arch.agents.map((a) => a.name)).toEqual(['router', 'resolver']);

        const router = arch.agents[0]!;
        expect(router.description).toBe('routes');
        expect(router.handoffs).toEqual(['resolver']);
        expect(router.memory).toEqual([
            { store: 'notes', scope: 'user:u-1', access: 'read-write', autoRecall: undefined },
        ]);

        const resolver = arch.agents[1]!;
        expect(resolver.fork).toEqual({ agents: undefined, maxBranches: 2 });
    });

    it('takes the runner model only when the agent does not pin one', async () => {
        const arch = await build().describe();
        expect(arch.agents[0]!.model).toBe('default-model');
        expect(arch.agents[0]!.inheritedModel).toBe(true);
        expect(arch.agents[1]!.model).toBe('pinned-model');
        expect(arch.agents[1]!.inheritedModel).toBeUndefined();
    });

    it('lists the skill catalog the binding allows, and the tools it unlocks', async () => {
        const arch = await build().describe();
        const router = arch.agents[0]!;
        expect(router.skills?.provider).toBe('catalog');
        expect(router.skills?.catalog.map((s) => s.name)).toEqual(['refunds', 'shipping']);
        expect(router.skills?.catalog[1]!.preload).toBe(true);

        // A locked tool belongs to the skill that unlocks it, not to the agent.
        expect(router.tools).toEqual([
            { name: 'lookup', description: 'looks up' },
            { name: 'duty_quote', description: 'quotes duty', skill: 'refunds' },
        ]);
    });

    it('leaves hand-offs out of the tool list', async () => {
        const arch = await build().describe();
        expect(arch.agents[0]!.tools.some((t) => t.name.startsWith('transfer_to_'))).toBe(false);
    });

    it('marks a catalog it cannot reach instead of throwing', async () => {
        const runner = new AgentRunner();
        runner.agent({ name: 'a', skills: { provider: 'missing', discovery: 'index' } });
        const arch = await runner.describe();
        expect(arch.agents[0]!.skills).toEqual({
            provider: 'missing',
            discovery: 'index',
            catalog: [],
            unresolved: true,
        });
    });

    it('keeps a context-dependent scope symbolic when there is no context', async () => {
        const runner = new AgentRunner<{ user: string }>();
        runner.agent({
            name: 'a',
            memory: [{ store: 'notes', scope: (c) => `user:${c.user}`, access: 'read' }],
        });
        const arch = await runner.describe();
        expect(arch.agents[0]!.memory[0]!.scope).toBe('(per run)');
    });
});
