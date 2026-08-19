import type { PayloadResolver } from './payload.ts';
import { lastOfType, totalUsage, type TrajectoryNode } from './trajectory.ts';
import type { JsonSchema, TokenUsage } from './types.ts';

// ---------------------------------------------------------------------------
// Run state — plain JSON, no prototypes, no functions
// ---------------------------------------------------------------------------

export type RunPhase =
    /** initial context built, nothing executed */
    | 'created'
    /** next step is a model call */
    | 'awaiting_llm'
    /** the model returned tool calls; some results are missing */
    | 'awaiting_tools'
    /** a fork is in flight; some branches are unfinished */
    | 'awaiting_branches'
    | 'done'
    | 'failed';

/**
 * Immutable run configuration: written once by `createState`, never touched by
 * `apply*`. It lives inside the state so a run is a single persistable blob
 * that a generic worker can resume without application code.
 */
export interface RunSpec {
    startAgent: string;
    /** JSON Schema projection of the caller's Zod schema */
    outputSchema?: JsonSchema;
    /** sha256 of `outputSchema`, for cheap mismatch detection on resume */
    outputSchemaHash?: string;
    /** non-object schemas travel in a single `value` property (tool params must be objects) */
    outputWrapped?: boolean;
    /** set on child runs created by a fork */
    parent?: { runId: string; forkId: string; branch: string };
    /** 0 for a root run */
    forkDepth: number;
    /** structural bound on recursive forking (not a turn budget) */
    maxForkDepth: number;
}

export interface AgentState {
    /** schema version for forward migration */
    version: 1;
    runId: string;
    spec: RunSpec;
    /** active agent — changes on handoff */
    agentName: string;
    phase: RunPhase;
    trajectory: TrajectoryNode[];
    /** tool calls from the last llm_call still lacking a tool_result */
    pendingToolCalls: string[];
    /** branches of an in-flight fork still lacking a result */
    pendingBranches: string[];
    /** derived cache; always recomputable from the trajectory */
    usage: TokenUsage;
    /** serialized user context (must be JSON) */
    context?: unknown;
    /** set when phase === 'failed' */
    error?: string;
}

export interface RunResult<T = string> {
    /** `z.infer` of the output schema when one was given */
    output: T;
    agent: string;
    state: AgentState;
    usage: TokenUsage;
    stopReason: 'final' | 'aborted' | 'failed';
}

/**
 * Structural check for a rehydrated state. There is no prototype to restore —
 * `JSON.parse(JSON.stringify(state))` is identity — so this replaces v1's
 * `AgentState.from`.
 */
export function validateState(json: unknown): json is AgentState {
    if (json === null || typeof json !== 'object') {
        return false;
    }
    const s = json as Partial<AgentState>;
    return (
        s.version === 1 &&
        typeof s.runId === 'string' &&
        typeof s.agentName === 'string' &&
        typeof s.phase === 'string' &&
        Array.isArray(s.trajectory) &&
        Array.isArray(s.pendingToolCalls) &&
        Array.isArray(s.pendingBranches) &&
        typeof s.spec === 'object' &&
        s.spec !== null
    );
}

export function assertState(json: unknown): AgentState {
    if (!validateState(json)) {
        throw new TypeError('not a valid AgentState');
    }
    return json;
}

/** Number of model calls made — v1's `state.turns`, derived instead of stored. */
export function turns(state: AgentState): number {
    return state.trajectory.filter((n) => n.type === 'llm_call').length;
}

export function usageOf(state: AgentState): TokenUsage {
    return totalUsage(state.trajectory);
}

/** Most recent assistant text; async because the text lives behind a payload. */
export async function lastText(state: AgentState, payloads: PayloadResolver): Promise<string> {
    const final = lastOfType(state.trajectory, 'final_output');
    if (final) {
        return payloads.get(final.output);
    }
    for (let i = state.trajectory.length - 1; i >= 0; i--) {
        const n = state.trajectory[i];
        if (n.type === 'llm_call' && n.text.size > 0) {
            return payloads.get(n.text);
        }
    }
    return '';
}
