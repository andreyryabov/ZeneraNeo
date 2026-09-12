import { describe, expect, it } from 'vitest';
import { forkInstructions, forkParameters } from '../src/fork.ts';
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
    it('reaches the prompt of an agent that can fork', async () => {
        const system = await systemOf({ name: 'lead', instructions: 'LEAD', fork: {} });
        expect(system).toContain('LEAD');
        expect(system).toContain(forkInstructions());
    });

    it('stays out of the prompt of an agent that cannot', async () => {
        const system = await systemOf({ name: 'solo', instructions: 'SOLO' });
        expect(system).toBe('SOLO');
    });

    it('stops once the depth cap has taken the tool away', async () => {
        const system = await systemOf(
            { name: 'lead', instructions: 'LEAD', fork: {} },
            { maxForkDepth: 0 },
        );
        expect(system).toBe('LEAD');
    });
});
