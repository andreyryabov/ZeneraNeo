import type { Payload, PayloadResolver } from './payload.ts';
import type { MemoryQuery } from './memory.ts';
import {
    addUsage,
    zeroUsage,
    type MediaKind,
    type Message,
    type TokenUsage,
    type ToolCall,
    type AssistantMessage,
} from './types.ts';

// ---------------------------------------------------------------------------
// Trajectory — the append-only source of truth
// ---------------------------------------------------------------------------

export interface NodeBase {
    /** ulid — unique, sortable */
    id: string;
    /** dense index in the trajectory (0..n-1) */
    seq: number;
    /** ISO timestamp (informational, not used for logic) */
    ts: string;
    /** active agent when the node was created */
    agent: string;
}

/** A content part whose text lives behind a payload reference. */
export type PayloadPart =
    | { type: 'text'; text: Payload }
    | { type: MediaKind; url: string; mimeType?: string };

export interface UserInputNode extends NodeBase {
    type: 'user_input';
    content: PayloadPart[];
    /** produced by the runtime (e.g. a "call final_output" nudge), not the user */
    synthetic?: boolean;
}

export interface SystemPromptNode extends NodeBase {
    type: 'system_prompt';
    prompt: Payload;
}

export interface LoadSkillsNode extends NodeBase {
    type: 'load_skills';
    provider: string;
    skills: { name: string; version?: string; contentHash: string }[];
    /** concatenated instructions the model saw */
    content: Payload;
    /** tools this activation unlocked */
    toolNames: string[];
}

export interface MemoryRecallNode extends NodeBase {
    type: 'memory_recall';
    store: string;
    scope: string;
    query: MemoryQuery;
    /** ids, not bodies — the rendered block is the payload */
    hits: { id: string; score: number; revision: number }[];
    content: Payload;
}

export interface MemoryOpNode extends NodeBase {
    type: 'memory_op';
    op: 'write' | 'update' | 'delete';
    store: string;
    scope: string;
    /** sha256(runId, callId) — deterministic, so a replay is deduplicated */
    opId: string;
    recordId: string;
    revision: number;
    before?: Payload;
    after?: Payload;
}

export interface LlmCallNode extends NodeBase {
    type: 'llm_call';
    /** exact model id used */
    model: string;
    /** sha256 of the projected request, for replay checks */
    requestDigest: string;
    text: Payload;
    thinking?: Payload;
    toolCalls: { callId: string; name: string; args: Payload }[];
    usage: TokenUsage;
    stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface ToolCallNode extends NodeBase {
    type: 'tool_call';
    callId: string;
    name: string;
    args: Payload;
}

export interface ToolResultNode extends NodeBase {
    type: 'tool_result';
    callId: string;
    name: string;
    result: Payload;
    isError: boolean;
    durationMs?: number;
}

export interface HandoffNode extends NodeBase {
    type: 'handoff';
    from: string;
    to: string;
    reason?: string;
}

export interface ForkNode extends NodeBase {
    type: 'fork';
    forkId: string;
    /** the fork tool call that caused it */
    callId: string;
    contextMode: 'inherit' | 'compact' | 'none';
    branches: {
        name: string;
        agent: string;
        instructions: Payload;
        childRunId: string;
    }[];
}

export interface JoinNode extends NodeBase {
    type: 'join';
    forkId: string;
    /** always in declared branch order, never completion order */
    results: {
        name: string;
        status: 'ok' | 'error' | 'aborted';
        output: Payload;
        error?: string;
        usage: TokenUsage;
        childRunId: string;
        /** the full child state, offloaded */
        childStateRef: Payload;
    }[];
    /** sum over branches */
    usage: TokenUsage;
}

export interface InheritedContextNode extends NodeBase {
    type: 'inherited_context';
    parent: { runId: string; seq: number };
    /** frozen projection of the parent, as JSON `Message[]` */
    messages: Payload;
}

export interface CompactionNode extends NodeBase {
    type: 'compaction';
    /** seq range (inclusive) whose nodes are hidden from projection */
    maskFrom: number;
    maskTo: number;
    /** what the model sees instead of the masked range; may be empty */
    summary: Payload;
    reason: 'handoff_noise' | 'token_budget' | 'branch_summary' | 'manual' | string;
}

export interface FinalOutputNode extends NodeBase {
    type: 'final_output';
    output: Payload;
    /** present when an output schema was set */
    parsed?: unknown;
}

export type TrajectoryNode =
    | UserInputNode
    | SystemPromptNode
    | LoadSkillsNode
    | MemoryRecallNode
    | MemoryOpNode
    | LlmCallNode
    | ToolCallNode
    | ToolResultNode
    | HandoffNode
    | ForkNode
    | JoinNode
    | InheritedContextNode
    | CompactionNode
    | FinalOutputNode;

export type NodeBody<T extends TrajectoryNode> = Omit<T, keyof NodeBase>;

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Compaction hides nodes, it never deletes them: audit and replay always see
 * the full history. A later compaction may cover an earlier one, so masks are
 * applied from the end — a compaction that is itself masked has no effect.
 */
export function maskedSeqs(trajectory: TrajectoryNode[]): Set<number> {
    const masked = new Set<number>();
    for (let i = trajectory.length - 1; i >= 0; i--) {
        const n = trajectory[i];
        if (n.type !== 'compaction' || masked.has(n.seq)) {
            continue;
        }
        for (let s = n.maskFrom; s <= n.maskTo; s++) {
            masked.add(s);
        }
    }
    return masked;
}

export function visibleNodes(trajectory: TrajectoryNode[]): TrajectoryNode[] {
    const masked = maskedSeqs(trajectory);
    return trajectory.filter((n) => !masked.has(n.seq));
}

/** Total consumption, including tokens spent inside parallel branches. */
export function totalUsage(trajectory: TrajectoryNode[]): TokenUsage {
    return trajectory.reduce(
        (acc, n) =>
            n.type === 'llm_call' || n.type === 'join' ? addUsage(acc, n.usage) : acc,
        zeroUsage(),
    );
}

export function lastOfType<T extends TrajectoryNode['type']>(
    trajectory: TrajectoryNode[],
    type: T,
): Extract<TrajectoryNode, { type: T }> | undefined {
    for (let i = trajectory.length - 1; i >= 0; i--) {
        if (trajectory[i].type === type) {
            return trajectory[i] as Extract<TrajectoryNode, { type: T }>;
        }
    }
    return undefined;
}

export function nodePayloads(n: TrajectoryNode): Payload[] {
    switch (n.type) {
        case 'user_input':
            return n.content.flatMap((p) => (p.type === 'text' ? [p.text] : []));
        case 'system_prompt':
            return [n.prompt];
        case 'load_skills':
            return [n.content];
        case 'memory_recall':
            return [n.content];
        case 'llm_call':
            return [n.text, ...n.toolCalls.map((c) => c.args)];
        case 'tool_call':
            return [n.args];
        case 'tool_result':
            return [n.result];
        case 'join':
            return n.results.map((r) => r.output);
        case 'inherited_context':
            return [n.messages];
        case 'compaction':
            return [n.summary];
        case 'final_output':
            return [n.output];
        default:
            // memory_op / handoff / fork carry only provenance in the projection
            return [];
    }
}

// ---------------------------------------------------------------------------
// Projection: trajectory → messages
// ---------------------------------------------------------------------------

export interface Projection {
    system?: string;
    messages: Message[];
}

export async function projectMessages(
    trajectory: TrajectoryNode[],
    payloads: PayloadResolver,
): Promise<Projection> {
    const visible = visibleNodes(trajectory);
    const blobs = await payloads.getMany(visible.flatMap(nodePayloads));
    const get = (p: Payload): string => blobs.get(p.sha256) ?? '';
    // Fork nodes may be masked while their join survives, so index the whole
    // trajectory rather than the visible slice.
    const forks = new Map(
        trajectory.flatMap((n) => (n.type === 'fork' ? [[n.forkId, n] as const] : [])),
    );

    let system: string | undefined;
    const messages: Message[] = [];

    for (const n of visible) {
        switch (n.type) {
            case 'system_prompt':
                // Last one wins; earlier prompts are superseded, not emitted.
                system = get(n.prompt);
                break;
            case 'user_input':
                messages.push({
                    role: 'user',
                    content: n.content.map((p) =>
                        p.type === 'text'
                            ? { type: 'text' as const, text: get(p.text) }
                            : { type: p.type, url: p.url, mimeType: p.mimeType },
                    ),
                });
                break;
            case 'load_skills':
            case 'memory_recall': {
                const content = get(n.content);
                if (content) {
                    messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
                }
                break;
            }
            case 'llm_call': {
                const toolCalls: ToolCall[] = n.toolCalls.map((c) => ({
                    id: c.callId,
                    name: c.name,
                    args: get(c.args),
                }));
                messages.push({
                    role: 'assistant',
                    content: get(n.text),
                    toolCalls: toolCalls.length ? toolCalls : undefined,
                    agent: n.agent,
                });
                break;
            }
            case 'tool_call':
                // Already folded into the owning llm_call; the standalone node
                // exists only so a checkpoint can be cut before execution.
                break;
            case 'tool_result':
                messages.push({
                    role: 'tool',
                    callId: n.callId,
                    name: n.name,
                    content: get(n.result),
                    isError: n.isError || undefined,
                });
                break;
            case 'join': {
                const fork = forks.get(n.forkId);
                const rendered = n.results
                    .map(
                        (r) =>
                            `### ${r.name} (${r.status})\n` +
                            (r.status === 'ok' ? get(r.output) : (r.error ?? get(r.output))),
                    )
                    .join('\n\n');
                messages.push({
                    role: 'tool',
                    callId: fork?.callId ?? n.forkId,
                    name: 'fork',
                    content: rendered,
                    isError: n.results.some((r) => r.status !== 'ok') || undefined,
                });
                break;
            }
            case 'inherited_context': {
                const parsed: unknown = JSON.parse(get(n.messages) || '[]');
                if (Array.isArray(parsed)) {
                    messages.push(...(parsed as Message[]));
                }
                break;
            }
            case 'compaction': {
                const summary = get(n.summary);
                if (summary) {
                    messages.push({
                        role: 'user',
                        content: [{ type: 'text', text: `[earlier context, summarized]\n${summary}` }],
                    });
                }
                break;
            }
            case 'final_output':
                messages.push({ role: 'assistant', content: get(n.output), agent: n.agent });
                break;
            default:
                // handoff / memory_op / fork project through other nodes
                break;
        }
    }

    return { system, messages: repairToolCalls(messages) };
}

/**
 * Providers reject a thread whose assistant tool call has no matching tool
 * message — and vice versa. Compaction can mask either side of a pair, so the
 * projection drops the orphaned half instead of producing an invalid request.
 */
function repairToolCalls(messages: Message[]): Message[] {
    const called = new Set(
        messages.flatMap((m) =>
            m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [],
        ),
    );
    const kept = messages.filter((m) => m.role !== 'tool' || called.has(m.callId));
    const answered = new Set(kept.flatMap((m) => (m.role === 'tool' ? [m.callId] : [])));
    const out: Message[] = [];
    for (const m of kept) {
        if (m.role !== 'assistant' || !m.toolCalls?.length) {
            out.push(m);
            continue;
        }
        const calls = m.toolCalls.filter((c) => answered.has(c.id));
        if (!calls.length && !m.content) {
            continue;
        }
        const fixed: AssistantMessage = { ...m, toolCalls: calls.length ? calls : undefined };
        out.push(fixed);
    }
    return out;
}
