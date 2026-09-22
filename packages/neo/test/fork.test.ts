import { describe, expect, it } from 'vitest';
import { forkParameters } from '../src/fork.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { AgentRunner } from '../src/runner.ts';
import { zeroUsage } from '../src/types.ts';

// ---------------------------------------------------------------------------
// A model that answers immediately and keeps the request it was sent, so the
// prompt the provider would have seen is what the assertions read.
// ---------------------------------------------------------------------------

class CaptureModel implements Model {
    readonly id = 'capture';
    last?: ModelRequest;

    async generate(req: ModelRequest): Promise<ModelResponse> {
        this.last = req;
        return { text: 'ok', toolCalls: [], stopReason: 'stop', usage: zeroUsage() };
    }
}

/** The system prompt an agent is run with, whatever composed it. */
async function systemOf(
    agent: Parameters<AgentRunner['agent']>[0],
    opts: { maxForkDepth?: number } = {},
): Promise<string> {
    const model = new CaptureModel();
    const runner = new AgentRunner({ model });
    runner.agent(agent);
    await runner.run(agent.name, 'go', opts);
    return model.last?.system ?? '';
}

describe('fork parameters', () => {
    it('accepts a single branch, because one branch is delegation', () => {
        const schema = forkParameters(['solo'], 'solo');
        expect(schema.properties?.branches).toMatchObject({ minItems: 1 });
        expect(schema.properties?.branches).not.toHaveProperty('maxItems');
    });

    it('caps the array when the author capped it, delegation-only included', () => {
        expect(forkParameters(['solo'], 'solo', 1).properties?.branches).toMatchObject({
            minItems: 1,
            maxItems: 1,
        });
        expect(forkParameters(['solo'], 'solo', 4).properties?.branches).toMatchObject({
            maxItems: 4,
        });
    });

    it('demands an agent only when the caller is not one of the choices', () => {
        const items = (agents: string[]): Record<string, unknown> =>
            (forkParameters(agents, 'lead').properties?.branches as Record<string, unknown>)
                .items as Record<string, unknown>;
        expect(items(['lead', 'scout']).required).toEqual(['name', 'instructions']);
        expect(items(['scout']).required).toEqual(['name', 'instructions', 'agent']);
    });
});

describe('fork instructions', () => {
    // The prose lives in the project, in `agents/fork-instructions.md` under
    // `requires: [fork]` — see `project.test.ts`. A host that builds agents by
    // hand gets the tool schema and nothing else, exactly as it does for
    // memory, because the runtime does not invent a replacement.
    it('are not composed by the runtime', async () => {
        const system = await systemOf({ name: 'lead', instructions: 'LEAD', fork: {} });
        expect(system).toBe('LEAD');
    });

    it('leave the prompt of an agent that cannot fork alone', async () => {
        const system = await systemOf({ name: 'solo', instructions: 'SOLO' });
        expect(system).toBe('SOLO');
    });
});

describe('flattened fork argument handling', () => {
    it('coerces a single branch passed at the root of the tool arguments', async () => {
        let branchSaw = '';
        const model: Model = {
            id: 'mock',
            generate: async (req: ModelRequest): Promise<ModelResponse> => {
                const last = req.messages.at(-1);
                if (last?.role === 'tool' && last.name === 'fork') {
                    if (last.content.includes('find the number')) {
                        branchSaw = last.content;
                        return {
                            text: 'found 42',
                            toolCalls: [],
                            stopReason: 'stop',
                            usage: zeroUsage(),
                        };
                    }
                    return {
                        text: 'delegation done',
                        toolCalls: [],
                        stopReason: 'stop',
                        usage: zeroUsage(),
                    };
                }
                return {
                    text: '',
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'fork',
                            args: JSON.stringify({
                                agent: 'specialist',
                                name: 'lookup',
                                instructions: 'find the number',
                            }),
                        },
                    ],
                    stopReason: 'tool_calls',
                    usage: zeroUsage(),
                };
            },
        };
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'specialist', instructions: 'SPECIALIST' });
        runner.agent({ name: 'lead', instructions: 'LEAD', fork: {} });

        const res = await runner.run('lead', 'start');
        expect(res.output).toBe('delegation done');
        expect(branchSaw).toContain('find the number');
    });

    it('returns a diagnostic error message when branch fields are passed without instructions', async () => {
        let toolError = '';
        const model: Model = {
            id: 'mock',
            generate: async (req: ModelRequest): Promise<ModelResponse> => {
                const last = req.messages.at(-1);
                if (last?.role === 'tool' && last.name === 'fork') {
                    toolError = last.content;
                    return {
                        text: 'error seen',
                        toolCalls: [],
                        stopReason: 'stop',
                        usage: zeroUsage(),
                    };
                }
                return {
                    text: '',
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'fork',
                            args: JSON.stringify({
                                agent: 'specialist',
                                name: 'lookup',
                            }),
                        },
                    ],
                    stopReason: 'tool_calls',
                    usage: zeroUsage(),
                };
            },
        };
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'specialist', instructions: 'SPECIALIST' });
        runner.agent({ name: 'lead', instructions: 'LEAD', fork: {} });

        const res = await runner.run('lead', 'start');
        expect(res.output).toBe('error seen');
        expect(toolError).toContain(
            'the "branches" argument is missing; "fork" requires an array of branches',
        );
    });
});
