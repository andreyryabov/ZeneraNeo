import type { Agent } from './agent.ts';
import type { MemoryOpSpec } from './memory.ts';
import type { Services } from './services.ts';
import type { SkillLoadSpec } from './skills.ts';
import type { AgentState } from './state.ts';

// ---------------------------------------------------------------------------
// Content / Input
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'audio' | 'video' | 'file';

export interface TextPart {
    type: 'text';
    text: string;
}

export interface MediaPart {
    type: MediaKind;
    /** http(s) url or data: uri */
    url: string;
    mimeType?: string;
}

export type ContentPart = TextPart | MediaPart;

/**
 * Sugar accepted on input boundaries. A bare string inside an array is text,
 * `{ image: url }` & co. are media shorthands.
 */
export type InputPart =
    | string
    | ContentPart
    | { image: string; mimeType?: string }
    | { audio: string; mimeType?: string }
    | { video: string; mimeType?: string }
    | { file: string; mimeType?: string };

/** Either plain text, or an array of content parts. */
export type Input = string | InputPart[];

const MEDIA_KEYS: MediaKind[] = ['image', 'audio', 'video', 'file'];

export function text(value: string): TextPart {
    return { type: 'text', text: value };
}

export function media(kind: MediaKind, url: string, mimeType?: string): MediaPart {
    return { type: kind, url, mimeType };
}

/** Normalizes any accepted input shape into a flat `ContentPart[]`. */
export function toContent(input: Input): ContentPart[] {
    if (typeof input === 'string') {
        return [text(input)];
    }
    return input.map((part): ContentPart => {
        if (typeof part === 'string') {
            return text(part);
        }
        // `'type' in part` is a TS narrowing guard: it splits the union into the
        // canonical `ContentPart` branch and the `{ image: url }` shorthands.
        if ('type' in part) {
            return part;
        }
        // Shorthand: exactly one of image/audio/video/file carries the url.
        for (const kind of MEDIA_KEYS) {
            const url = (part as Record<string, unknown>)[kind];
            if (typeof url === 'string') {
                return media(kind, url, part.mimeType);
            }
        }
        throw new TypeError(`unsupported input part: ${JSON.stringify(part)}`);
    });
}

export function contentToText(content: ContentPart[]): string {
    return content.map((p) => (p.type === 'text' ? p.text : `[${p.type}: ${p.url}]`)).join('\n');
}

// ---------------------------------------------------------------------------
// Messages — a *projection* of the trajectory, never the source of truth
// ---------------------------------------------------------------------------

export interface ToolCall {
    id: string;
    name: string;
    /** raw JSON string as produced by the model */
    args: string;
}

export interface SystemMessage {
    role: 'system';
    content: string;
}

export interface UserMessage {
    role: 'user';
    content: ContentPart[];
}

export interface AssistantMessage {
    role: 'assistant';
    content: string;
    toolCalls?: ToolCall[];
    /** which agent produced it — useful after hand-offs */
    agent?: string;
}

export interface ToolMessage {
    role: 'tool';
    callId: string;
    name: string;
    content: string;
    isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

export interface TokenUsage {
    inputTokens: number;
    /** subset of inputTokens served from cache */
    cachedInputTokens: number;
    outputTokens: number;
    /** subset of outputTokens spent on thinking */
    reasoningTokens: number;
}

export function zeroUsage(): TokenUsage {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface JsonSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

export interface ToolContext<TCtx = unknown> {
    ctx: TCtx;
    state: AgentState;
    agent: Agent<TCtx>;
    /** id of the call being executed — memory ops derive their opId from it */
    callId: string;
    services: Services;
    signal?: AbortSignal;
}

/** What the model needs to know about a tool — no execution details. */
export interface ToolSchema {
    name: string;
    description?: string;
    parameters: JsonSchema;
}

/**
 * What a tool produced. `effects` are structured side-effect records the kernel
 * must fold into the trajectory (memory writes, skill activations); the tool
 * itself performed the I/O, because the kernel stays free of it.
 */
export interface ToolOutcome {
    output: string;
    isError: boolean;
    durationMs?: number;
    effects?: ToolEffect[];
}

export type ToolEffect =
    | { kind: 'memory_op'; spec: MemoryOpSpec }
    | { kind: 'skill_load'; spec: SkillLoadSpec };

const TOOL_RETURN = Symbol('agent.toolReturn');

/**
 * What a tool returns when it needs the kernel to record something beyond the
 * tool message itself. Tagged with a symbol so an ordinary object result can
 * never be mistaken for one.
 */
export interface ToolReturn {
    [TOOL_RETURN]: true;
    output: unknown;
    effects: ToolEffect[];
}

export function withEffects(output: unknown, ...effects: ToolEffect[]): ToolReturn {
    return { [TOOL_RETURN]: true, output, effects };
}

export function isToolReturn(v: unknown): v is ToolReturn {
    return v !== null && typeof v === 'object' && TOOL_RETURN in v;
}

export interface Tool<TArgs = unknown, TCtx = unknown> extends ToolSchema {
    execute(args: TArgs, tc: ToolContext<TCtx>): unknown | Promise<unknown>;
}

/**
 * Heterogeneous tool lists: every tool has a different `TArgs`, so there is no
 * single type parameter that fits an array of them. `any` here is deliberate --
 * `unknown` would make `execute` contravariant and reject concrete tools, and
 * `never` propagates into `ToolContext<TCtx>` and breaks assignability. Arg
 * safety is preserved at the definition site by `tool()` below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<TCtx = unknown> = Tool<any, TCtx>;

/**
 * Identity helper. Its only job is inference: written inline, `execute`'s
 * `args` would be `unknown`; going through `tool<{city: string}>()` types it.
 */
export function tool<TArgs, TCtx = unknown>(def: Tool<TArgs, TCtx>): Tool<TArgs, TCtx> {
    return def;
}

// Built-in tool names. Hand-offs, memory, skills and forks are all ordinary
// tools, so the model drives everything with one mechanism; the kernel
// recognises them by these names alone.
export const HANDOFF_PREFIX = 'transfer_to_';
export const FORK_TOOL = 'fork';
export const FINAL_OUTPUT_TOOL = 'final_output';
export const MEMORY_SEARCH_TOOL = 'memory_search';
export const MEMORY_WRITE_TOOL = 'memory_write';
export const MEMORY_UPDATE_TOOL = 'memory_update';
export const MEMORY_DELETE_TOOL = 'memory_delete';
export const SKILL_SEARCH_TOOL = 'skill_search';
export const SKILL_LOAD_TOOL = 'skill_load';

export function parseArgs(raw: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(raw || '{}');
        return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function asString(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

export function stringify(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}
