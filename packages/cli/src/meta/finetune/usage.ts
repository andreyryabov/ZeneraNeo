import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Tokens per stage and model
//
// A run is summed from its own trajectory, so every agent's model is counted
// apart; an analysis and an apply carry `model` and `tokens` in the envelope
// `zen meta run --json` printed, kept beside them.
// ---------------------------------------------------------------------------

export interface Tokens {
    calls: number;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
}

export type ByModel = Record<string, Tokens>;
export type Stage = 'run' | 'analyze' | 'apply';
export const STAGES: Stage[] = ['run', 'analyze', 'apply'];
export type ByStage = Partial<Record<Stage, ByModel>>;

const zero = (): Tokens => ({ calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

function addTo(into: ByModel, model: string, t: Tokens): void {
    const m = (into[model] ??= zero());
    m.calls += t.calls;
    m.input += t.input;
    m.cached += t.cached;
    m.output += t.output;
    m.reasoning += t.reasoning;
}

export function mergeModels(...all: (ByModel | undefined)[]): ByModel {
    const out: ByModel = {};
    for (const by of all) {
        for (const [model, t] of Object.entries(by ?? {})) {
            addTo(out, model, t);
        }
    }
    return out;
}

export function mergeStages(...all: (ByStage | undefined)[]): ByStage {
    const out: ByStage = {};
    for (const stage of STAGES) {
        const parts = all.map((s) => s?.[stage]).filter((p): p is ByModel => !!p);
        if (parts.length > 0) {
            out[stage] = mergeModels(...parts);
        }
    }
    return out;
}

export function total(by: ByModel | undefined): Tokens {
    const sum: ByModel = {};
    for (const t of Object.values(by ?? {})) {
        addTo(sum, 'all', t);
    }
    return sum.all ?? zero();
}

interface Usage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

const fromUsage = (u: Usage, calls: number): Tokens => ({
    calls,
    input: u.inputTokens ?? 0,
    cached: u.cachedInputTokens ?? 0,
    output: u.outputTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
});

/** `vertex/gemini-3.8-flash` and `gemini-3.8-flash` are one model in a table. */
const modelName = (m: string | undefined): string => (m ? m.replace(/^[^/:]+[/:]/, '') : '?');

const cache = new Map<string, { key: string; by: ByModel }>();

/**
 * Per model, over the distinct llm calls of a run's trajectory, branches
 * included. Nested records repeat a call, so calls are counted by id.
 */
export function runTokens(runDir: string): ByModel | undefined {
    const file = join(runDir, 'state.json');
    if (!existsSync(file)) {
        return undefined;
    }
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) {
        return hit.by;
    }
    let root: unknown;
    try {
        root = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
    const by: ByModel = {};
    const seen = new Set<string>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const v = stack.pop();
        if (Array.isArray(v)) {
            stack.push(...v);
        } else if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            if (o.type === 'llm_call' && o.usage && typeof o.id === 'string' && !seen.has(o.id)) {
                seen.add(o.id);
                addTo(by, modelName(o.model as string), fromUsage(o.usage as Usage, 1));
            }
            stack.push(...Object.values(o));
        }
    }
    cache.set(file, { key, by });
    return by;
}

/** One `zen meta run --json` envelope: `{ model, tokens: { calls, inputTokens, … } }`. */
export function envelopeTokens(file: string): ByModel | undefined {
    if (!existsSync(file)) {
        return undefined;
    }
    let env: { model?: string; tokens?: Usage & { calls?: number } };
    try {
        env = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
    if (!env.tokens) {
        return undefined;
    }
    return { [modelName(env.model)]: fromUsage(env.tokens, env.tokens.calls ?? 0) };
}

/** Every envelope in `dir` named `<stem>.json` or `<stem>-<n>.json` - retries keep their own. */
export function envelopesIn(dir: string, stem: string): ByModel | undefined {
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => new RegExp(`^${stem}(-\\d+)?\\.json$`).test(n));
    } catch {
        return undefined;
    }
    const parts = names.map((n) => envelopeTokens(join(dir, n))).filter((p) => !!p);
    return parts.length > 0 ? mergeModels(...parts) : undefined;
}

/** 1234 → 1.2k, 2184341 → 2.2M. */
export function short(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1000) {
        return `${Math.round(n / 1000)}k`;
    }
    return String(n);
}
