import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../src/model.ts';
import { createModel } from '../src/models/factory.ts';
import { AgentRunner } from '../src/runner.ts';
import { FileSkillProvider } from '../src/skill-providers/file.ts';
import type { AgentState } from '../src/state.ts';
import type { TrajectoryNode } from '../src/trajectory.ts';
import { tool } from '../src/types.ts';

const live = process.env.OPENAI_API_KEY ? describe : describe.skip;

async function createSkillIndexDir() {
    const dir = await mkdtemp(join(tmpdir(), 'zenera-live-openai-index-'));
    const skillDir = join(dir, 'skills');

    const alphaDir = join(skillDir, 'alpha_orchid');
    await mkdir(alphaDir, { recursive: true });
    await writeFile(
        join(alphaDir, 'SKILL.md'),
        [
            '---',
            'description: museum-heavy plan with expensive taxis',
            '---',
            '',
            'When loaded, include marker ALPHA_SKILL_ACTIVE.',
            '',
        ].join('\n'),
        'utf8',
    );

    const betaDir = join(skillDir, 'beta_cedar');
    await mkdir(betaDir, { recursive: true });
    await writeFile(
        join(betaDir, 'SKILL.md'),
        [
            '---',
            'description: city trams and trains with cheap local transit passes',
            '---',
            '',
            'When loaded, include marker BETA_SKILL_ACTIVE.',
            'Keep the answer compact and transit-first.',
            '',
        ].join('\n'),
        'utf8',
    );

    return skillDir;
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

async function firstRecordedRequest(state: AgentState, runner: AgentRunner): Promise<ModelRequest> {
    const llm = findNode(state, 'llm_call');
    if (!llm.request) {
        throw new Error('llm request was not recorded; set recordRequests=true');
    }
    const raw = await runner.services.payloads.get(llm.request);
    return JSON.parse(raw) as ModelRequest;
}

async function recordedRequests(state: AgentState, runner: AgentRunner): Promise<ModelRequest[]> {
    const llmCalls = state.trajectory.filter(
        (n): n is Extract<TrajectoryNode, { type: 'llm_call' }> => {
            return n.type === 'llm_call';
        },
    );
    const out: ModelRequest[] = [];
    for (const llm of llmCalls) {
        if (!llm.request) {
            continue;
        }
        const raw = await runner.services.payloads.get(llm.request);
        out.push(JSON.parse(raw) as ModelRequest);
    }
    return out;
}

function requestMessageText(req: ModelRequest): string {
    return req.messages
        .map((m) => {
            if (m.role === 'user') {
                return m.content
                    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
                    .join('\n');
            }
            if (m.role === 'assistant') {
                return m.content;
            }
            if (m.role === 'tool') {
                return m.content;
            }
            return m.content;
        })
        .join('\n\n');
}

function messageRoles(req: ModelRequest): string[] {
    return req.messages.map((m) => m.role);
}

live('openai live skill loading', () => {
    it('loads a skill from the indexed list and changes planner behavior', async () => {
        const skillDir = await createSkillIndexDir();
        const skills = new FileSkillProvider({ dir: skillDir, id: 'travel-index' });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'planner',
            instructions:
                'Use the indexed skills list. First load exactly one skill: the one whose description includes "city trams and trains". Then answer with one short sentence that includes the marker from that loaded skill.',
            skills: { provider: skills.id, discovery: 'index' },
        });

        const result = await runner.run(
            'planner',
            'Give a short budget Kyoto suggestion after loading the correct skill.',
        );

        expect(result.agent).toBe('planner');
        expect(result.stopReason).toBe('final');
        expect(result.state.phase).toBe('done');

        const load = findNode(result.state, 'load_skills');
        expect(load.provider).toBe(skills.id);
        expect(load.skills).toHaveLength(1);
        expect(load.skills.map((s) => s.name)).toEqual(['beta_cedar']);

        const req = await firstRecordedRequest(result.state, runner);
        expect(req.system ?? '').toContain('Available skills');
        expect(req.system ?? '').toContain('alpha_orchid');
        expect(req.system ?? '').toContain('beta_cedar');
        expect(messageRoles(req)).toEqual(['user']);
        const req0Text = requestMessageText(req);
        expect(req0Text).toContain('Give a short budget Kyoto suggestion');
        expect(req0Text).not.toContain('## Skill: beta_cedar');

        const requests = await recordedRequests(result.state, runner);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        const req1Roles = messageRoles(requests[1]);
        expect(req1Roles).toContain('assistant');
        expect(req1Roles).toContain('tool');
        expect(req1Roles).toContain('user');
        const skillUserIdx = requests[1].messages.findIndex(
            (m) =>
                m.role === 'user' &&
                m.content.some((p) => p.type === 'text' && p.text.includes('## Skill: beta_cedar')),
        );
        expect(skillUserIdx).toBeGreaterThanOrEqual(0);
        const toolIdx = requests[1].messages.findIndex((m) => m.role === 'tool');
        expect(toolIdx).toBeGreaterThanOrEqual(0);
        expect(skillUserIdx).toBeGreaterThan(toolIdx);
        const req1Text = requestMessageText(requests[1]);
        expect(req1Text).toContain('## Skill: beta_cedar');
        expect(req1Text).toContain('BETA_SKILL_ACTIVE');

        const text = String(result.output);
        expect(text).toContain('BETA_SKILL_ACTIVE');
        expect(text).not.toContain('ALPHA_SKILL_ACTIVE');
    }, 120000);

    it('search discovery exposes skill_search and omits index in prompt/messages', async () => {
        const skillDir = await createSkillIndexDir();
        const skills = new FileSkillProvider({ dir: skillDir, id: 'travel-search' });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'planner',
            instructions: 'Reply with OK only. Do not call tools.',
            skills: { provider: skills.id, discovery: 'search' },
        });

        const result = await runner.run('planner', 'Say OK.');
        expect(result.stopReason).toBe('final');

        const req = await firstRecordedRequest(result.state, runner);
        expect(req.system ?? '').not.toContain('Available skills');
        expect((req.tools ?? []).map((t) => t.name)).toContain('skill_load');
        expect((req.tools ?? []).map((t) => t.name)).toContain('skill_search');
        expect(messageRoles(req)).toEqual(['user']);
        const reqText = requestMessageText(req);
        expect(reqText).toContain('Say OK.');
        expect(reqText).not.toContain('## Skill:');
        expect(reqText).not.toContain('BETA_SKILL_ACTIVE');
    }, 120000);

    it('none discovery keeps skill_load and omits index/search in prompt/messages', async () => {
        const skillDir = await createSkillIndexDir();
        const skills = new FileSkillProvider({ dir: skillDir, id: 'travel-none' });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'planner',
            instructions: 'Reply with OK only. Do not call tools.',
            skills: { provider: skills.id, discovery: 'none' },
        });

        const result = await runner.run('planner', 'Say OK.');
        expect(result.stopReason).toBe('final');

        const req = await firstRecordedRequest(result.state, runner);
        expect(req.system ?? '').not.toContain('Available skills');
        expect((req.tools ?? []).map((t) => t.name)).toContain('skill_load');
        expect((req.tools ?? []).map((t) => t.name)).not.toContain('skill_search');
        expect(messageRoles(req)).toEqual(['user']);
        const reqText = requestMessageText(req);
        expect(reqText).toContain('Say OK.');
        expect(reqText).not.toContain('## Skill:');
        expect(reqText).not.toContain('BETA_SKILL_ACTIVE');
    }, 120000);
});

// ---------------------------------------------------------------------------
// Locked tools
//
// The declared tool set is fixed for the whole run; a skill-owned tool refuses
// to execute until its skill is loaded. What is under test here is that a real
// model reads that refusal, works out which skill to load, loads it, and retries
// on its own — with no orchestration and no change to the tools array.
// ---------------------------------------------------------------------------

async function createLockedToolDir() {
    const dir = await mkdtemp(join(tmpdir(), 'zenera-live-openai-locked-'));
    const skillDir = join(dir, 'skills');

    const gemDir = join(skillDir, 'gemstone_pricing');
    await mkdir(gemDir, { recursive: true });
    await writeFile(
        join(gemDir, 'SKILL.md'),
        [
            '---',
            'description: how to quote the price of a cut gemstone',
            'tools: [gem_quote]',
            '---',
            '',
            'Quote stones with gem_quote and report the priceEur it returns verbatim.',
            'End every answer with the marker GEM_SKILL_ACTIVE.',
            '',
        ].join('\n'),
        'utf8',
    );

    const shipDir = join(skillDir, 'shipping_rates');
    await mkdir(shipDir, { recursive: true });
    await writeFile(
        join(shipDir, 'SKILL.md'),
        [
            '---',
            'description: parcel shipping rates and delivery windows',
            '---',
            '',
            'Never mention gemstones. Marker SHIP_SKILL_ACTIVE.',
            '',
        ].join('\n'),
        'utf8',
    );

    return skillDir;
}

async function toolResults(state: AgentState, runner: AgentRunner) {
    const nodes = state.trajectory.filter(
        (n): n is Extract<TrajectoryNode, { type: 'tool_result' }> => n.type === 'tool_result',
    );
    const out: { name: string; isError: boolean; text: string }[] = [];
    for (const n of nodes) {
        out.push({
            name: n.name,
            isError: n.isError === true,
            text: await runner.services.payloads.get(n.result),
        });
    }
    return out;
}

live('openai live locked skill tools', () => {
    it('recovers from a locked tool by loading the skill it names', async () => {
        const skillDir = await createLockedToolDir();
        const gemQuote = tool<{ carats: number }>({
            name: 'gem_quote',
            description: 'Returns the price in EUR of a cut stone of the given weight.',
            parameters: {
                type: 'object',
                properties: { carats: { type: 'number' } },
                required: ['carats'],
                additionalProperties: false,
            },
            execute: ({ carats }) => ({ priceEur: carats * 1234 }),
        });

        const skills = new FileSkillProvider({
            dir: skillDir,
            id: 'gems-locked',
            tools: [gemQuote],
        });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'low',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'appraiser',
            instructions: [
                'You price gemstones.',
                'Your very first action must be to call gem_quote with the weight the user gives.',
                'Do not call skill_load before that first gem_quote call.',
                'If a tool result tells you a skill is missing, load exactly the skills it',
                'names and then call gem_quote again — never answer from the refusal alone.',
                'Report the priceEur value the tool returned, unchanged.',
            ].join(' '),
            // No index and no search: the only route to the skill name is the
            // tool description and the refusal itself.
            skills: { provider: skills.id, discovery: 'none' },
        });

        const result = await runner.run('appraiser', 'What is a 3 carat stone worth?');
        expect(result.stopReason).toBe('final');

        const requests = await recordedRequests(result.state, runner);
        expect(requests.length).toBeGreaterThanOrEqual(3);

        // 1. The tool is on the wire from the very first turn, before any load.
        expect((requests[0].tools ?? []).map((t) => t.name)).toContain('gem_quote');

        // 2. And it is byte-identical on every later turn. This is the property
        //    the whole locking mechanism exists to preserve: a growing tools
        //    array would move the first differing token to offset ~0 and throw
        //    away the provider's prompt cache exactly when the context is largest.
        const wire = requests.map((r) => JSON.stringify(r.tools ?? []));
        for (const w of wire) {
            expect(w).toBe(wire[0]);
        }

        const results = await toolResults(result.state, runner);

        // 3. The first attempt was refused, and the refusal named the skill.
        const refused = results.find((r) => r.name === 'gem_quote' && r.isError);
        expect(refused).toBeDefined();
        expect(refused!.text).toContain('PREREQUISITE_MISSING');
        expect(refused!.text).toContain('gemstone_pricing');

        // 4. The model chose the right skill on its own.
        const load = findNode(result.state, 'load_skills');
        expect(load.skills.map((s) => s.name)).toEqual(['gemstone_pricing']);
        expect(load.toolNames).toEqual(['gem_quote']);

        // 5. The retry went through and the skill's instructions took effect.
        const priced = results.find((r) => r.name === 'gem_quote' && !r.isError);
        expect(priced).toBeDefined();
        expect(priced!.text).toContain('3702');
        // The model is free to write 3,702 or 3 702.
        expect(result.output.replace(/[,\s]/g, '')).toContain('3702');
        expect(result.output).toContain('GEM_SKILL_ACTIVE');
    }, 120000);
});

// ---------------------------------------------------------------------------
// Preloaded skills
//
// `preload` moves an activation from something the model decides to do into
// something the runner did before the model was asked anything. The evidence
// has to be circumstantial, which is the point of the fixture below: the marker
// and the tool exist *only* inside the preloaded skill, so if the answer carries
// the marker and the tool ran on the first attempt, the skill text was genuinely
// in context — and the trajectory shows nothing asked for it.
// ---------------------------------------------------------------------------

async function createPreloadDir() {
    const dir = await mkdtemp(join(tmpdir(), 'zenera-live-openai-preload-'));
    const skillDir = join(dir, 'skills');

    const protocolDir = join(skillDir, 'court_protocol');
    await mkdir(protocolDir, { recursive: true });
    await writeFile(
        join(protocolDir, 'SKILL.md'),
        [
            '---',
            'description: how the clerk of court addresses filings and hearings',
            'tools: [docket_lookup]',
            '---',
            '',
            'Look every case number up with docket_lookup and quote the hearing date it',
            'returns verbatim. Never guess a date.',
            '',
            'End every answer, without exception, with the marker PROTOCOL_ACTIVE.',
            '',
        ].join('\n'),
        'utf8',
    );

    const feesDir = join(skillDir, 'filing_fees');
    await mkdir(feesDir, { recursive: true });
    await writeFile(
        join(feesDir, 'SKILL.md'),
        [
            '---',
            'description: what it costs to file a motion and who may waive the fee',
            '---',
            '',
            'A motion costs 85 EUR. Marker FEES_ACTIVE.',
            '',
        ].join('\n'),
        'utf8',
    );

    return skillDir;
}

const docketLookup = tool<{ caseNumber: string }>({
    name: 'docket_lookup',
    description: 'Returns the next hearing date for a case number.',
    parameters: {
        type: 'object',
        properties: { caseNumber: { type: 'string' } },
        required: ['caseNumber'],
        additionalProperties: false,
    },
    execute: ({ caseNumber }) => ({ caseNumber, hearingDate: '2031-04-17', room: 'C-9' }),
});

live('openai live preloaded skills', () => {
    it('puts the skill in context before the first call, unasked', async () => {
        const skillDir = await createPreloadDir();
        const skills = new FileSkillProvider({
            dir: skillDir,
            id: 'court-preload',
            tools: [docketLookup],
        });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'clerk',
            // Deliberately says nothing about markers, dates or tools. Every
            // instruction the model follows below can only have come from the
            // preloaded skill. The one thing it is told is not to reach for
            // the index, so that any activation in the trajectory must be the
            // runner's rather than the model's.
            instructions:
                'You are a clerk of court. Answer in one short sentence. ' +
                'Do not call skill_load: you already have everything you need.',
            skills: {
                provider: skills.id,
                discovery: 'index',
                preload: ['court_protocol'],
            },
        });

        const result = await runner.run('clerk', 'When is the next hearing for case 44-118-B?');
        expect(result.stopReason).toBe('final');

        // 1. The activation is in the trajectory and attributed to this agent.
        const loads = result.state.trajectory.filter((n) => n.type === 'load_skills');
        expect(loads.length).toBeGreaterThanOrEqual(1);
        expect(loads[0].agent).toBe('clerk');
        expect(loads[0].provider).toBe(skills.id);
        expect(loads[0].skills.map((s) => s.name)).toEqual(['court_protocol']);
        expect(loads[0].toolNames).toEqual(['docket_lookup']);

        // 2. It lands before the first model call — that is what makes it a
        //    preload rather than an early `skill_load`.
        const order = result.state.trajectory.map((n) => n.type);
        expect(order.indexOf('load_skills')).toBeLessThan(order.indexOf('llm_call'));

        // 3. Nothing asked for it. No `skill_load` call appears anywhere.
        const results = await toolResults(result.state, runner);
        expect(results.map((r) => r.name)).not.toContain('skill_load');

        // 4. The text really was on the wire, in the very first request.
        const first = await firstRecordedRequest(result.state, runner);
        const firstText = requestMessageText(first);
        expect(firstText).toContain('## Skill: court_protocol');
        expect(firstText).toContain('PROTOCOL_ACTIVE');

        // 5. A preloaded skill is not advertised in the index — offering
        //    something already active only invites a wasted round trip. The
        //    other skill still is.
        expect(first.system ?? '').toContain('Available skills');
        expect(first.system ?? '').toContain('filing_fees');
        expect(first.system ?? '').not.toContain('court_protocol');

        // 6. And it changed the answer. The marker exists nowhere else.
        expect(result.output).toContain('PROTOCOL_ACTIVE');
        expect(result.output).not.toContain('FEES_ACTIVE');
    }, 120000);

    it('unlocks the preloaded skill s tool without a refusal first', async () => {
        const skillDir = await createPreloadDir();
        const skills = new FileSkillProvider({
            dir: skillDir,
            id: 'court-preload-tools',
            tools: [docketLookup],
        });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'clerk',
            instructions:
                'You are a clerk of court. Use the tools you have and answer in one short sentence.',
            // No index and no search: if the preload did not happen, the model
            // has no way to learn the skill's name and the run cannot recover.
            skills: {
                provider: skills.id,
                discovery: 'none',
                preload: ['court_protocol'],
            },
        });

        const result = await runner.run('clerk', 'When is the next hearing for case 44-118-B?');
        expect(result.stopReason).toBe('final');

        const results = await toolResults(result.state, runner);

        // The gate never fired: the skill was already active when the very
        // first call came in.
        expect(results.some((r) => r.text.includes('PREREQUISITE_MISSING'))).toBe(false);
        expect(results.some((r) => r.isError)).toBe(false);

        const looked = results.find((r) => r.name === 'docket_lookup');
        expect(looked).toBeDefined();
        expect(looked!.text).toContain('2031-04-17');

        expect(result.output).toContain('2031-04-17');
        expect(result.output).toContain('PROTOCOL_ACTIVE');
    }, 120000);
});
