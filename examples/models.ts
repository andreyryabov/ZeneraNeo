import type { Model } from '../packages/neo/src/model.ts';
import { createModel, type ModelSpec } from '../packages/neo/src/models/factory.ts';

// ---------------------------------------------------------------------------
// One place where the demos pick a model
//
// Nothing here is part of the library. Every example used to spell out its own
// `createModel({ provider: 'vertex', model: ... })`, which meant that trying a
// demo on another vendor was an edit in seven files. Now each example asks for
// a *tier* — how much thinking the step deserves — and the vendor is chosen
// once, from the environment:
//
//   npm run demo:all                        # gemini (default)
//   DEMO_VENDOR=openai     npm run demo:all
//   DEMO_VENDOR=anthropic  npm run demo:all
//   DEMO_VENDOR=openrouter npm run demo:all
//
// The one demo this does not cover is ./project.ts: its models are declared in
// assets/project/agents.yaml, because that is the point of that example.
// ---------------------------------------------------------------------------

export type Vendor = 'gemini' | 'openai' | 'anthropic' | 'openrouter';

/**
 * What a step is worth, not what it costs. The demos care about the shape of
 * the run (a router turn is cheap, a synthesis turn is not), and each vendor
 * spells that dial differently — a coarse level, a reasoning effort, a token
 * budget — so the mapping lives here rather than at the call sites.
 */
export type Tier = 'fast' | 'thinking' | 'deep';

/**
 * The model ids are the ones the live test suites exercise, so a demo failing
 * on a vendor is a demo problem rather than a stale id.
 */
export const PRESETS: Record<Vendor, Record<Tier, ModelSpec>> = {
    gemini: {
        fast: {
            provider: 'vertex',
            model: 'gemini-3.5-flash-lite',
            thinkingLevel: 'minimal',
            includeThoughts: true,
        },
        thinking: {
            provider: 'vertex',
            model: 'gemini-3.5-flash-lite',
            thinkingLevel: 'low',
            includeThoughts: true,
        },
        deep: {
            provider: 'vertex',
            model: 'gemini-3.5-flash-lite',
            thinkingLevel: 'medium',
            includeThoughts: true,
        },
    },
    openai: {
        fast: {
            provider: 'openai',
            api: 'responses',
            model: 'gpt-5.4-nano',
            reasoningEffort: 'minimal',
        },
        thinking: {
            provider: 'openai',
            api: 'responses',
            model: 'gpt-5.4-nano',
            reasoningEffort: 'low',
            reasoningSummary: 'auto',
        },
        deep: {
            provider: 'openai',
            api: 'responses',
            model: 'gpt-5.4-nano',
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
        },
    },
    anthropic: {
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
        thinking: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 4096 },
        deep: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 8192 },
    },
    openrouter: {
        fast: {
            provider: 'openrouter',
            api: 'chat',
            model: 'inclusionai/ling-3.0-flash-fin:free',
            reasoningEffort: 'low',
        },
        thinking: {
            provider: 'openrouter',
            api: 'chat',
            model: 'inclusionai/ling-3.0-flash-fin:free',
            reasoningEffort: 'medium',
        },
        deep: {
            provider: 'openrouter',
            api: 'chat',
            model: 'inclusionai/ling-3.0-flash-fin:free',
            reasoningEffort: 'high',
        },
    },
};

/** The vendor every demo in this process talks to. `DEMO_VENDOR`, or gemini. */
export function vendor(): Vendor {
    const name = (process.env.DEMO_VENDOR ?? 'gemini').trim().toLowerCase();
    if (!(name in PRESETS)) {
        throw new Error(
            `unknown DEMO_VENDOR "${name}" — expected one of ${Object.keys(PRESETS).join(', ')}`,
        );
    }
    return name as Vendor;
}

/** Built once per vendor/tier, so demos that use two tiers still share a client. */
const built = new Map<string, Model>();

/** The model a demo should use for work of this weight. */
export function model(tier: Tier = 'thinking'): Model {
    const key = `${vendor()}:${tier}`;
    let m = built.get(key);
    if (!m) {
        m = createModel(PRESETS[vendor()][tier]);
        built.set(key, m);
    }
    return m;
}
