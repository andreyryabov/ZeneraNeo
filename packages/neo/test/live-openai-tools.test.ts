import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../src/model.ts';
import { createModel } from '../src/models/factory.ts';
import { AgentRunner } from '../src/runner.ts';
import { turns, type AgentState } from '../src/state.ts';
import type { TrajectoryNode } from '../src/trajectory.ts';
import { tool } from '../src/types.ts';

const live = process.env.OPENAI_API_KEY ? describe : describe.skip;

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

live('openai live agent tools', () => {
    it('registers agent tools, executes one, and uses its result in the final answer', async () => {
        const marker = 'LIVE_TOOL_MARKER_8675309';
        const echoMarker = tool<Record<string, never>>({
            name: 'echo_marker',
            description: `Returns the fixed verification marker ${marker}. Call this tool before answering any verification request.`,
            parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
            },
            execute: () => marker,
        });

        const runner = new AgentRunner({
            model: createModel({
                model: 'gpt-5-nano',
                api: 'responses',
                reasoningEffort: 'minimal',
            }),
            stream: false,
            recordRequests: true,
        });

        runner.agent({
            name: 'verifier',
            instructions:
                'Before answering, call the echo_marker tool exactly once. After the tool returns, reply with the marker only and no other text.',
            tools: [echoMarker],
        });

        const result = await runner.run(
            'verifier',
            'Verify that the registered tool works end to end by calling it and then repeating its exact output.',
        );

        expect(result.agent).toBe('verifier');
        expect(result.stopReason).toBe('final');
        expect(result.state.phase).toBe('done');
        expect(turns(result.state)).toBeGreaterThanOrEqual(2);

        const req = await firstRecordedRequest(result.state, runner);
        expect((req.tools ?? []).map((t) => t.name)).toContain('echo_marker');

        const toolCalls = result.state.trajectory.filter(
            (node): node is Extract<TrajectoryNode, { type: 'tool_call' }> =>
                node.type === 'tool_call',
        );
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);
        expect(toolCalls.some((node) => node.name === 'echo_marker')).toBe(true);

        const toolResults = result.state.trajectory.filter(
            (node): node is Extract<TrajectoryNode, { type: 'tool_result' }> =>
                node.type === 'tool_result',
        );
        expect(toolResults.length).toBeGreaterThanOrEqual(1);
        expect(toolResults.every((node) => node.name === 'echo_marker')).toBe(true);
        expect(toolResults.every((node) => node.isError === false)).toBe(true);
        expect(await runner.services.payloads.get(toolResults.at(-1)!.result)).toBe(marker);

        expect(String(result.output)).toContain(marker);
    }, 120000);
});
