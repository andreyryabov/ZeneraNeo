import OpenAI from 'openai';
import type { StreamDelta } from './events.ts';
import { zeroUsage, type Message, type TokenUsage, type ToolCall, type ToolSchema } from './types.ts';

// ---------------------------------------------------------------------------
// Model abstraction
// ---------------------------------------------------------------------------

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export interface ModelRequest {
    system?: string;
    messages: Message[];
    tools: ToolSchema[];
    toolChoice?: 'auto' | 'required' | 'none';
    signal?: AbortSignal;
}

export interface ModelResponse {
    text: string;
    /** reasoning chain, when the provider returns one */
    thinking?: string;
    toolCalls: ToolCall[];
    usage?: TokenUsage;
    stopReason?: StopReason;
}

export interface Model {
    readonly id: string;
    generate(req: ModelRequest): Promise<ModelResponse>;
    /** optional: non-streaming models simply never produce deltas */
    stream?(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse>;
}

function toStopReason(finish: string | null | undefined): StopReason {
    switch (finish) {
        case 'tool_calls':
        case 'function_call':
            return 'tool_calls';
        case 'length':
            return 'length';
        case 'content_filter':
            return 'content_filter';
        default:
            return 'stop';
    }
}

export class OpenAIModel implements Model {
    readonly id: string;
    readonly #client: OpenAI;

    constructor(id = 'gpt-4o-mini', client = new OpenAI()) {
        this.id = id;
        this.#client = client;
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        const res = await this.#client.chat.completions.create(this.#params(req), {
            signal: req.signal,
        });
        const choice = res.choices[0];
        const message = choice?.message;
        return {
            text: message?.content ?? '',
            thinking: readReasoning(message),
            toolCalls: (message?.tool_calls ?? []).flatMap((c) =>
                c.type === 'function'
                    ? [{ id: c.id, name: c.function.name, args: c.function.arguments }]
                    : [],
            ),
            usage: toUsage(res.usage),
            stopReason: toStopReason(choice?.finish_reason),
        };
    }

    async stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse> {
        const stream = await this.#client.chat.completions.create(
            { ...this.#params(req), stream: true, stream_options: { include_usage: true } },
            { signal: req.signal },
        );

        let text = '';
        let thinking = '';
        let usage: TokenUsage | undefined;
        let stopReason: StopReason | undefined;
        // Tool calls arrive as deltas keyed by index, with the id and name in the
        // first fragment and arguments trickling in afterwards.
        const calls = new Map<number, ToolCall>();

        for await (const chunk of stream) {
            if (chunk.usage) {
                usage = toUsage(chunk.usage);
            }
            const choice = chunk.choices[0];
            if (!choice) {
                continue;
            }
            if (choice.finish_reason) {
                stopReason = toStopReason(choice.finish_reason);
            }
            const delta = choice.delta;
            const reasoning = readReasoning(delta);
            if (reasoning) {
                thinking += reasoning;
                onDelta({ type: 'thinking_delta', delta: reasoning });
            }
            if (delta?.content) {
                text += delta.content;
                onDelta({ type: 'text_delta', delta: delta.content });
            }
            for (const part of delta?.tool_calls ?? []) {
                const known = calls.get(part.index);
                const call: ToolCall = known ?? {
                    id: part.id ?? `call_${part.index}`,
                    name: part.function?.name ?? '',
                    args: '',
                };
                if (!known) {
                    calls.set(part.index, call);
                }
                if (part.id) {
                    call.id = part.id;
                }
                if (part.function?.name) {
                    call.name = part.function.name;
                }
                if (!known || (part.function?.name && !known.name)) {
                    onDelta({ type: 'tool_call_detected', callId: call.id, name: call.name });
                }
                const args = part.function?.arguments;
                if (args) {
                    call.args += args;
                    onDelta({
                        type: 'tool_args_delta',
                        callId: call.id,
                        name: call.name,
                        delta: args,
                        argsSoFar: call.args,
                    });
                }
            }
        }

        return {
            text,
            thinking: thinking || undefined,
            toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
            usage,
            stopReason: stopReason ?? (calls.size ? 'tool_calls' : 'stop'),
        };
    }

    #params(req: ModelRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        if (req.system) {
            messages.push({ role: 'system', content: req.system });
        }
        for (const m of req.messages) {
            messages.push(OpenAIModel.#toOpenAI(m));
        }
        return {
            model: this.id,
            messages,
            tools: req.tools.length
                ? req.tools.map((t) => ({
                      type: 'function' as const,
                      function: {
                          name: t.name,
                          description: t.description,
                          parameters: t.parameters as Record<string, unknown>,
                      },
                  }))
                : undefined,
            tool_choice: req.tools.length ? (req.toolChoice ?? 'auto') : undefined,
        };
    }

    /**
     * Translates one internal message into the provider wire format. Static +
     * private because it is pure and must not be part of the public surface.
     */
    static #toOpenAI(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
        switch (m.role) {
            case 'system':
                return { role: 'system', content: m.content };
            case 'user':
                return {
                    role: 'user',
                    // Only images have a first-class multimodal representation in
                    // chat completions; other media degrade to a text reference
                    // so the thread stays valid instead of throwing.
                    content: m.content.map((p) =>
                        p.type === 'text'
                            ? { type: 'text' as const, text: p.text }
                            : p.type === 'image'
                              ? { type: 'image_url' as const, image_url: { url: p.url } }
                              : { type: 'text' as const, text: `[${p.type}] ${p.url}` },
                    ),
                };
            case 'assistant':
                return {
                    role: 'assistant',
                    // A tool-calling turn usually has no prose; the API wants an
                    // explicit null there rather than an empty string.
                    content: m.content || null,
                    tool_calls: m.toolCalls?.length
                        ? m.toolCalls.map((c) => ({
                              id: c.id,
                              type: 'function' as const,
                              function: { name: c.name, arguments: c.args },
                          }))
                        : undefined,
                };
            case 'tool':
                return { role: 'tool', tool_call_id: m.callId, content: m.content };
        }
    }
}

function toUsage(u: OpenAI.CompletionUsage | undefined): TokenUsage | undefined {
    if (!u) {
        return undefined;
    }
    return {
        ...zeroUsage(),
        inputTokens: u.prompt_tokens,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: u.completion_tokens,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    };
}

/**
 * Reasoning text is not part of the chat-completions type surface, but several
 * providers (and OpenAI-compatible gateways) put it on the message or delta.
 */
function readReasoning(v: unknown): string | undefined {
    if (v === null || typeof v !== 'object') {
        return undefined;
    }
    const r = v as { reasoning?: unknown; reasoning_content?: unknown };
    const value = typeof r.reasoning === 'string' ? r.reasoning : r.reasoning_content;
    return typeof value === 'string' && value ? value : undefined;
}
