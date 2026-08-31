import { describe, expect, it } from 'vitest';
import { AgentRegistry, type Agent } from '../src/agent.ts';
import * as Kernel from '../src/kernel.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { AgentRunner } from '../src/runner.ts';
import { Services } from '../src/services.ts';
import { StaticSkillProvider } from '../src/skill-providers/static.ts';
import { renderSkills, SkillRequiredError, type Skill, type SkillBinding } from '../src/skills.ts';
import type { AgentState } from '../src/state.ts';
import type { TrajectoryNode } from '../src/trajectory.ts';
import { tool, zeroUsage, type AnyTool, type ToolCall, type ToolSchema } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const gemQuote = tool<{ carats: number }>({
    name: 'gem_quote',
    description: 'Prices a stone.',
    parameters: {
        type: 'object',
        properties: { carats: { type: 'number' } },
        required: ['carats'],
        additionalProperties: false,
    },
    execute: ({ carats }) => ({ priceEur: carats * 100 }),
});

const gemPricing: Skill = {
    name: 'gem_pricing',
    description: 'How stones are priced.',
    content: 'Quote every stone with gem_quote.',
    tools: [gemQuote],
};

/** A second owner of the same tool, so the ambiguous branch has a fixture. */
const estateValuation: Skill = {
    name: 'estate_valuation',
    description: 'Valuing inherited jewellery.',
    content: 'Quote inherited stones with gem_quote too.',
    tools: [gemQuote],
};

const plainSkill: Skill = {
    name: 'plain',
    description: 'Unlocks nothing.',
    content: 'Be brief.',
};

function provider(...skills: Skill[]): StaticSkillProvider {
    return new StaticSkillProvider(skills.length ? skills : [gemPricing, plainSkill], 'catalog');
}

interface Harness {
    state: AgentState;
    reg: AgentRegistry;
    env: Kernel.KernelEnv;
    agent: Agent;
}

async function harness(
    skills: StaticSkillProvider,
    opts: { binding?: Partial<SkillBinding>; tools?: AnyTool[] } = {},
): Promise<Harness> {
    const reg = new AgentRegistry();
    const agent = reg.agent({
        name: 'appraiser',
        tools: opts.tools,
        skills: { provider: skills.id, discovery: 'index', ...opts.binding },
    });
    const env: Kernel.KernelEnv = { services: new Services({ skills: [skills] }) };
    const state = await Kernel.createState({ agent: agent.name, input: 'hi' }, env);
    return { state, reg, env, agent };
}

/** Exactly the three fields the provider is sent. */
function schemas(tools: AnyTool[]): ToolSchema[] {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}

function resolve(h: Harness, state = h.state): Promise<AnyTool[]> {
    return Kernel.resolveTools(state, h.reg, h.env);
}

async function find(h: Harness, state: AgentState, name: string): Promise<AnyTool> {
    const t = (await resolve(h, state)).find((x) => x.name === name);
    if (!t) {
        throw new Error(
            `tool ${name} is not declared (have: ${(await resolve(h, state)).map((x) => x.name).join(', ')})`,
        );
    }
    return t;
}

function call(h: Harness, t: AnyTool, state: AgentState, args: unknown): unknown {
    return t.execute(args, {
        ctx: undefined,
        state,
        agent: h.agent,
        callId: 'c1',
        services: h.env.services,
    });
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

describe('what a loaded skill reads as', () => {
    const body = (path?: string): string =>
        renderSkills([
            { name: 'greet', description: 'Greets.', content: 'Say hello.', ...(path && { path }) },
        ]);

    it('says nothing about files when the skill has none of its own', () => {
        expect(body()).toBe('## Skill: greet\nSay hello.');
    });

    it('names the directory the skill ships, once, when the host mounted it', () => {
        const said = body('/skills/greet');
        expect(said).toContain('## Skill: greet');
        expect(said).toContain('Say hello.');
        // The one thing the model cannot work out for itself: where the files
        // the instructions talk about actually are, and that it cannot write there.
        expect(said).toContain('/skills/greet');
        expect(said).toContain('read-only');
        expect(said.match(/\/skills\/greet/g)).toHaveLength(1);
    });
});

describe('locked skill tools', () => {
    it('declares the same tool schemas before and after a skill load', async () => {
        const skills = provider();
        const h = await harness(skills);

        const before = schemas(await resolve(h));
        expect(before.map((t) => t.name)).toContain('gem_quote');

        const after = schemas(
            await resolve(h, await Kernel.applySkillLoad(h.state, skills.id, [gemPricing], h.env)),
        );

        // The whole point: the array the provider caches on does not move.
        expect(after).toEqual(before);
    });

    it('rejects a call whose skill is not active, naming the skill to load', async () => {
        const skills = provider();
        const h = await harness(skills);
        const gem = await find(h, h.state, 'gem_quote');

        expect(() => call(h, gem, h.state, { carats: 3 })).toThrow(SkillRequiredError);
        try {
            call(h, gem, h.state, { carats: 3 });
            expect.unreachable();
        } catch (e) {
            const err = e as SkillRequiredError;
            expect(err.code).toBe('SKILL_REQUIRED');
            expect(err.candidates.map((c) => c.name)).toEqual(['gem_pricing']);
            expect(err.message).toContain('PREREQUISITE_MISSING');
            expect(err.message).toContain('skill_load({"names":["gem_pricing"]})');
        }

        // The static description already says which skill unlocks it, so the
        // well-behaved path never reaches the error at all.
        expect(gem.description).toContain('gem_pricing');
    });

    it('executes once the skill is active', async () => {
        const skills = provider();
        const h = await harness(skills);
        const loaded = await Kernel.applySkillLoad(h.state, skills.id, [gemPricing], h.env);

        const gem = await find(h, loaded, 'gem_quote');
        expect(call(h, gem, loaded, { carats: 3 })).toEqual({ priceEur: 300 });
    });

    it('reads the state at call time, not at declaration time', async () => {
        const skills = provider();
        const h = await harness(skills);

        // Resolved before the load, called after it. The runner resolves once
        // per batch but advances the state between calls, so a `skill_load` and
        // a use of what it unlocks can land in the same batch.
        const gem = await find(h, h.state, 'gem_quote');
        const loaded = await Kernel.applySkillLoad(h.state, skills.id, [gemPricing], h.env);

        expect(call(h, gem, loaded, { carats: 3 })).toEqual({ priceEur: 300 });
        expect(() => call(h, gem, h.state, { carats: 3 })).toThrow(SkillRequiredError);
    });

    it('keeps the schema but re-locks when a compaction covers the activation', async () => {
        const skills = provider();
        const h = await harness(skills);
        const loaded = await Kernel.applySkillLoad(h.state, skills.id, [gemPricing], h.env);
        const compacted = await Kernel.applyCompaction(
            loaded,
            {
                covers: [findNode(loaded, 'load_skills').id],
                summary: 'earlier steps',
                reason: 'budget',
            },
            h.env,
        );

        expect(schemas(await resolve(h, compacted))).toEqual(schemas(await resolve(h, h.state)));
        const gem = await find(h, compacted, 'gem_quote');
        expect(() => call(h, gem, compacted, { carats: 3 })).toThrow(SkillRequiredError);
    });

    it('does not declare tools of skills the binding disallows', async () => {
        const h = await harness(provider(), { binding: { allow: ['plain'] } });
        const names = (await resolve(h)).map((t) => t.name);
        expect(names).not.toContain('gem_quote');
    });

    it('lets an agent-level tool of the same name win, ungated', async () => {
        const own = { ...gemQuote, description: 'Agent-owned pricing.' };
        const h = await harness(provider(), { tools: [own] });

        const declared = (await resolve(h)).filter((t) => t.name === 'gem_quote');
        expect(declared).toHaveLength(1);
        expect(declared[0].description).toBe('Agent-owned pricing.');
        expect(call(h, declared[0], h.state, { carats: 2 })).toEqual({ priceEur: 200 });
    });

    it('offers every owner when a tool is declared by more than one skill', async () => {
        const skills = provider(gemPricing, estateValuation, plainSkill);
        const h = await harness(skills);

        const declared = (await resolve(h)).filter((t) => t.name === 'gem_quote');
        expect(declared).toHaveLength(1);
        expect(declared[0].description).toContain('gem_pricing');
        expect(declared[0].description).toContain('estate_valuation');

        try {
            call(h, declared[0], h.state, { carats: 1 });
            expect.unreachable();
        } catch (e) {
            const err = e as SkillRequiredError;
            // Catalog order, with each description, so the model can choose.
            expect(err.candidates.map((c) => c.name)).toEqual(['estate_valuation', 'gem_pricing']);
            expect(err.message).toContain('Valuing inherited jewellery.');
            expect(err.message).toContain('How stones are priced.');
        }

        // Either owner is sufficient.
        const loaded = await Kernel.applySkillLoad(h.state, skills.id, [estateValuation], h.env);
        const gem = await find(h, loaded, 'gem_quote');
        expect(call(h, gem, loaded, { carats: 1 })).toEqual({ priceEur: 100 });
    });
});

// ---------------------------------------------------------------------------
// End to end: the model recovers from the error on its own
// ---------------------------------------------------------------------------

class ScriptedModel implements Model {
    readonly id = 'scripted';
    /** tool name lists, one per call, in order */
    readonly seen: string[][] = [];
    #seq = 0;

    async generate(req: ModelRequest): Promise<ModelResponse> {
        this.seen.push(req.tools.map((t) => t.name));
        const blocked = req.messages.some(
            (m) => m.role === 'tool' && m.content.includes('PREREQUISITE_MISSING'),
        );
        const loaded = req.messages.some((m) => m.role === 'tool' && m.name === 'skill_load');

        if (!blocked) {
            return this.#call('gem_quote', { carats: 3 });
        }
        if (!loaded) {
            return this.#call('skill_load', { names: ['gem_pricing'] });
        }
        const priced = req.messages.some(
            (m) => m.role === 'tool' && m.name === 'gem_quote' && m.content.includes('300'),
        );
        return priced
            ? { text: '300 EUR', toolCalls: [], stopReason: 'stop', usage: zeroUsage() }
            : this.#call('gem_quote', { carats: 3 });
    }

    #call(name: string, args: unknown): ModelResponse {
        const c: ToolCall = { id: `c${++this.#seq}`, name, args: JSON.stringify(args) };
        return { text: '', toolCalls: [c], stopReason: 'tool_calls', usage: zeroUsage() };
    }
}

describe('locked tool recovery loop', () => {
    it('blocks, loads the named skill, retries and succeeds', async () => {
        const skills = provider();
        const model = new ScriptedModel();
        const runner = new AgentRunner({ model, skills: [skills], stream: false });
        runner.agent({
            name: 'appraiser',
            skills: { provider: skills.id, discovery: 'index' },
        });

        const res = await runner.run('appraiser', 'What is a 3 carat stone worth?');
        expect(res.state.phase).toBe('done');

        const results = res.state.trajectory.filter((n) => n.type === 'tool_result');
        expect(results.map((n) => `${n.name}:${n.isError}`)).toEqual([
            'gem_quote:true',
            'skill_load:false',
            'gem_quote:false',
        ]);

        const blocked = await runner.services.payloads.get(results[0].result);
        expect(blocked).toContain('PREREQUISITE_MISSING');
        expect(blocked).toContain('gem_pricing');

        const priced = await runner.services.payloads.get(results[2].result);
        expect(priced).toContain('300');

        // Every turn saw the identical tool list.
        expect(model.seen.length).toBeGreaterThanOrEqual(4);
        for (const names of model.seen) {
            expect(names).toEqual(model.seen[0]);
        }
    });
});

// ---------------------------------------------------------------------------
// Preload
// ---------------------------------------------------------------------------

/** Answers immediately, recording what it was shown. */
class RecordingModel implements Model {
    readonly id = 'recording';
    readonly systems: (string | undefined)[] = [];
    /** whole transcripts, flattened — user content is parts, not a string */
    readonly transcripts: string[] = [];
    #turns: number;

    constructor(turns = 1) {
        this.#turns = turns;
    }

    generate(req: ModelRequest): Promise<ModelResponse> {
        this.systems.push(req.system);
        this.transcripts.push(JSON.stringify(req.messages));
        if (--this.#turns > 0) {
            const c: ToolCall = { id: 'c1', name: 'noop', args: '{}' };
            return Promise.resolve({
                text: '',
                toolCalls: [c],
                stopReason: 'tool_calls',
                usage: zeroUsage(),
            });
        }
        return Promise.resolve({
            text: 'done',
            toolCalls: [],
            stopReason: 'stop',
            usage: zeroUsage(),
        });
    }
}

const noop = tool({
    name: 'noop',
    description: 'Does nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
});

function loadNodes(state: AgentState, agent?: string) {
    return state.trajectory.filter(
        (n) => n.type === 'load_skills' && (!agent || n.agent === agent),
    ) as Extract<TrajectoryNode, { type: 'load_skills' }>[];
}

describe('skill preload', () => {
    it('activates the skill before the first model call', async () => {
        const skills = provider();
        const model = new RecordingModel();
        const runner = new AgentRunner({ model, skills: [skills], stream: false });
        runner.agent({
            name: 'appraiser',
            skills: { provider: skills.id, discovery: 'none', preload: ['gem_pricing'] },
        });

        const res = await runner.run('appraiser', 'hello');

        // The activation exists, and its content reached the very first call.
        expect(loadNodes(res.state)).toHaveLength(1);
        expect(model.transcripts[0]).toContain('Quote every stone with gem_quote');
    });

    it('unlocks the skill s tools without the model asking for them', async () => {
        const skills = provider();
        const h = await harness(skills, { binding: { preload: ['gem_pricing'] } });
        const runner = new AgentRunner({
            model: new RecordingModel(),
            skills: [skills],
            stream: false,
        });
        runner.add(h.agent);

        const res = await runner.run('appraiser', 'hello');
        const gem = await find(h, res.state, 'gem_quote');
        expect(call(h, gem, res.state, { carats: 2 })).toEqual({ priceEur: 200 });
    });

    it('keeps a preloaded skill out of the index it is offered', async () => {
        const skills = provider();
        const model = new RecordingModel();
        const runner = new AgentRunner({ model, skills: [skills], stream: false });
        runner.agent({
            name: 'appraiser',
            skills: { provider: skills.id, discovery: 'index', preload: ['gem_pricing'] },
        });

        await runner.run('appraiser', 'hello');

        // Offering something already active is an invitation to spend a turn
        // re-fetching it.
        const system = model.systems[0] ?? '';
        expect(system).toContain('plain:');
        expect(system).not.toContain('gem_pricing:');
    });

    it('does not repeat the activation on later turns', async () => {
        const skills = provider();
        const runner = new AgentRunner({
            model: new RecordingModel(3),
            skills: [skills],
            stream: false,
        });
        runner.agent({
            name: 'appraiser',
            tools: [noop],
            skills: { provider: skills.id, discovery: 'none', preload: ['gem_pricing'] },
        });

        const res = await runner.run('appraiser', 'hello');
        expect(res.state.trajectory.filter((n) => n.type === 'llm_call').length).toBe(3);
        expect(loadNodes(res.state)).toHaveLength(1);
    });

    it('applies the incoming agent s own set after a hand-off', async () => {
        const skills = provider();
        const model = new HandingOffModel();
        const runner = new AgentRunner({ model, skills: [skills], stream: false });
        runner.agent({
            name: 'front',
            handoffs: ['appraiser'],
            skills: { provider: skills.id, discovery: 'none', preload: ['plain'] },
        });
        runner.agent({
            name: 'appraiser',
            skills: { provider: skills.id, discovery: 'none', preload: ['gem_pricing'] },
        });

        const res = await runner.run('front', 'hello');

        // Each agent got its own, and neither inherited the other's.
        expect(loadNodes(res.state, 'front').flatMap((n) => n.skills.map((s) => s.name))).toEqual([
            'plain',
        ]);
        expect(
            loadNodes(res.state, 'appraiser').flatMap((n) => n.skills.map((s) => s.name)),
        ).toEqual(['gem_pricing']);
    });

    it('re-activates when a compaction covers the activation', async () => {
        const skills = provider();
        const h = await harness(skills, { binding: { preload: ['gem_pricing'] } });
        const runner = new AgentRunner({
            model: new RecordingModel(),
            skills: [skills],
            stream: false,
        });
        runner.add(h.agent);
        // The compaction has to write into the store the runner will read from.
        const env: Kernel.KernelEnv = { services: runner.services };

        const first = await runner.run('appraiser', 'hello');
        const compacted = await Kernel.applyCompaction(
            first.state,
            {
                covers: loadNodes(first.state).map((n) => n.id),
                summary: 'earlier steps',
                reason: 'budget',
            },
            env,
        );

        // The preload is not a one-off: dropping the node makes the skill
        // inactive, so continuing the run puts it back.
        const gem = await find(h, compacted, 'gem_quote');
        expect(() => call(h, gem, compacted, { carats: 2 })).toThrow(SkillRequiredError);

        const resumed = await runner.send(compacted, 'and again?').final();
        expect(call(h, gem, resumed.state, { carats: 2 })).toEqual({ priceEur: 200 });
    });
});

/** Hands off once, then answers. */
class HandingOffModel implements Model {
    readonly id = 'handing-off';
    #done = false;

    generate(): Promise<ModelResponse> {
        if (this.#done) {
            return Promise.resolve({
                text: 'done',
                toolCalls: [],
                stopReason: 'stop',
                usage: zeroUsage(),
            });
        }
        this.#done = true;
        const c: ToolCall = { id: 'h1', name: 'transfer_to_appraiser', args: '{}' };
        return Promise.resolve({
            text: '',
            toolCalls: [c],
            stopReason: 'tool_calls',
            usage: zeroUsage(),
        });
    }
}
