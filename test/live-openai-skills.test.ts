import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createModel } from '../src/models/factory.ts';
import type { ModelRequest } from '../src/model.ts';
import { AgentRunner } from '../src/runner.ts';
import { FileSkillProvider } from '../src/skill-providers/file.ts';
import type { AgentState } from '../src/state.ts';
import type { TrajectoryNode } from '../src/trajectory.ts';

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
