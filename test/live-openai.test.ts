import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModel } from '../src/models/factory.ts';
import { AgentRunner } from '../src/runner.ts';
import { FileSkillProvider } from '../src/skill-providers/file.ts';
import { assertState, turns, type AgentState } from '../src/state.ts';
import type { TrajectoryNode } from '../src/trajectory.ts';

const live = process.env.OPENAI_API_KEY ? describe : describe.skip;

const Plan = z.object({
    title: z.string().min(1),
    budget_summary: z.string().min(1),
    notes: z.string().min(1),
    steps: z.array(z.string()).min(1),
});

async function createSkillDir() {
    const dir = await mkdtemp(join(tmpdir(), 'zenera-live-openai-'));
    const skillDir = join(dir, 'skills');
    const budgetDir = join(skillDir, 'budget_travel');
    await mkdir(budgetDir, { recursive: true });
    await writeFile(
        join(budgetDir, 'SKILL.md'),
        [
            '---',
            'description: budget travel guidance',
            '---',
            '',
            'Prefer trains. Book lodging outside the city centre.',
            'Keep transport cheap and use local transit passes.',
            'Plan short walking days and low-cost food.',
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

function findLastNode<T extends TrajectoryNode['type']>(
    state: AgentState,
    type: T,
): Extract<TrajectoryNode, { type: T }> {
    const node = state.trajectory.findLast((n) => n.type === type);
    if (!node) {
        throw new Error(`no ${type} node in the trajectory`);
    }
    return node as Extract<TrajectoryNode, { type: T }>;
}

live('openai live run', () => {
    it('runs, resumes, sends, hands off, loads a skill, and returns structured output', async () => {
        const skillDir = await createSkillDir();
        const skills = new FileSkillProvider({ dir: skillDir, id: 'travel' });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            skills: [skills],
            stream: false,
        });

        runner.agent({
            name: 'planner',
            instructions:
                'First load the budget_travel skill. Then answer only with JSON matching the schema. Keep the plan short and use the skill guidance.',
            skills: { provider: skills.id, discovery: 'index' },
        });
        runner.agent({
            name: 'router',
            instructions: 'Always hand off trip-planning requests to planner.',
            handoffs: ['planner'],
        });

        let snapshot: AgentState | undefined;
        const stream = runner.run('router', 'Plan a cheap 2-day Kyoto trip.', { output: Plan });
        for await (const event of stream) {
            if (event.type === 'before_tool_call' && event.call.name === 'transfer_to_planner') {
                snapshot = assertState(JSON.parse(JSON.stringify(event.state)));
                break;
            }
        }

        if (!snapshot) {
            throw new Error('did not capture a handoff checkpoint');
        }

        expect(snapshot.agentName).toBe('router');
        expect(snapshot.phase).toBe('awaiting_tools');
        expect(snapshot.pendingToolCalls).toHaveLength(1);

        const resumed = await runner.resume(snapshot).final();
        expect(resumed.agent).toBe('planner');
        expect(resumed.stopReason).toBe('final');
        expect(resumed.state.phase).toBe('done');
        expect(resumed.output).toMatchObject({
            title: expect.any(String),
            steps: expect.arrayContaining([expect.any(String)]),
        });
        expect(turns(resumed.state)).toBeGreaterThanOrEqual(2);

        const handoff = findNode(resumed.state, 'handoff');
        expect(handoff.from).toBe('router');
        expect(handoff.to).toBe('planner');

        const load = findNode(resumed.state, 'load_skills');
        expect(load.provider).toBe(skills.id);
        expect(load.skills.map((s) => s.name)).toEqual(['budget_travel']);

        const finalOutput = findLastNode(resumed.state, 'final_output');
        expect(Plan.parse(finalOutput.parsed)).toEqual(Plan.parse(resumed.output));

        const followUp = await runner
            .send(resumed.state, 'Now make it even shorter while keeping the same schema.')
            .final();
        expect(followUp.agent).toBe('planner');
        expect(followUp.stopReason).toBe('final');
        expect(followUp.state.phase).toBe('done');
        const followUpParsed = Plan.parse(followUp.output);
        expect(followUp.output).toMatchObject(followUpParsed);
        expect(turns(followUp.state)).toBeGreaterThan(turns(resumed.state));
        expect(Plan.parse(findLastNode(followUp.state, 'final_output').parsed)).toEqual(
            followUpParsed,
        );
    }, 120000);
});
