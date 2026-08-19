import OpenAI from 'openai';
import type { StreamDelta } from '../events.ts';
import type { Model, ModelRequest, ModelResponse, StopReason } from '../model.ts';
import { zeroUsage, type Message, type TokenUsage, type ToolCall } from '../types.ts';

// ---------------------------------------------------------------------------
// OpenAI responses adapter
// ---------------------------------------------------------------------------

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;

/**
 * Provider-specific knobs, mirroring `OpenAIModelOptions` but expressed the way
 * the responses API spells them.
 */
export interface OpenAIResponsesModelOptions {
    reasoningEffort?: OpenAI.ReasoningEffort;
    /** ask the model for a reasoning summary — the only reasoning text this API exposes */
    reasoningSummary?: 'auto' | 'concise' | 'detailed';
    /**
     * Server-side conversation state. Off by default: the runner already owns
     * the trajectory and replays the full thread on every call, so storing it
     * again would duplicate state rather than help.
     */
    store?: boolean;
}

/**
 * Same `Model` contract as `OpenAIModel`, over `/v1/responses` instead of
 * `/v1/chat/completions`. Reasoning models are the reason to prefer it: effort
 * and summaries are first-class there.
 */
export class OpenAIResponsesModel implements Model {
    readonly id: string;
    readonly #client: OpenAI;
    readonly #reasoningEffort: OpenAI.ReasoningEffort | undefined;
    readonly #reasoningSummary: 'auto' | 'concise' | 'detailed' | undefined;
    readonly #store: boolean;

    constructor(id: string, client = new OpenAI(), options: OpenAIResponsesModelOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#reasoningEffort = options.reasoningEffort;
        this.#reasoningSummary = options.reasoningSummary;
        this.#store = options.store ?? false;
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        const res = await this.#client.responses.create(this.#params(req), {
            signal: req.signal,
        });
        const toolCalls = readToolCalls(res.output);
        return {
            text: readText(res.output),
            thinking: readThinking(res.output),
            toolCalls,
            usage: toUsage(res.usage),
            stopReason: toStopReason(res, toolCalls.length > 0),
        };
    }

    async stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse> {
        const stream = await this.#client.responses.create(
            { ...this.#params(req), stream: true },
            { signal: req.signal },
        );

        let text = '';
        let thinking = '';
        let final: OpenAI.Responses.Response | undefined;
        // Output items are addressed by their index in `response.output`, which
        // every delta event carries — that is the only stable key while the
        // items are still being assembled.
        const calls = new Map<number, ToolCall>();

        for await (const event of stream) {
            switch (event.type) {
                case 'response.output_text.delta': {
                    text += event.delta;
                    onDelta({ type: 'text_delta', delta: event.delta });
                    break;
                }
                case 'response.reasoning_summary_part.added': {
                    // A response carries several summary parts, each its own
                    // paragraph. Nothing separates them in the deltas, so a
                    // blank line is inserted between them here.
                    if (thinking) {
                        thinking += '\n\n';
                        onDelta({ type: 'thinking_delta', delta: '\n\n' });
                    }
                    break;
                }
                case 'response.reasoning_summary_text.delta': {
                    thinking += event.delta;
                    onDelta({ type: 'thinking_delta', delta: event.delta });
                    break;
                }
                case 'response.reasoning.delta': {
                    const delta = readReasoningDelta(event.delta);
                    if (delta) {
                        thinking += delta;
                        onDelta({ type: 'thinking_delta', delta });
                    }
                    break;
                }
                case 'response.output_item.added': {
                    if (event.item.type === 'function_call') {
                        const call: ToolCall = {
                            id: event.item.call_id,
                            name: event.item.name,
                            args: '',
                        };
                        calls.set(event.output_index, call);
                        onDelta({
                            type: 'tool_call_detected',
                            callId: call.id,
                            name: call.name,
                        });
                    }
                    break;
                }
                case 'response.function_call_arguments.delta': {
                    const call = calls.get(event.output_index);
                    if (call) {
                        call.args += event.delta;
                        onDelta({
                            type: 'tool_args_delta',
                            callId: call.id,
                            name: call.name,
                            delta: event.delta,
                            argsSoFar: call.args,
                        });
                    }
                    break;
                }
                case 'response.completed':
                case 'response.incomplete':
                case 'response.failed': {
                    final = event.response;
                    break;
                }
                default:
                    break;
            }
        }

        const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
        return {
            text,
            thinking: thinking || undefined,
            toolCalls,
            usage: toUsage(final?.usage),
            stopReason: final
                ? toStopReason(final, toolCalls.length > 0)
                : toolCalls.length
                  ? 'tool_calls'
                  : 'stop',
        };
    }

    #params(req: ModelRequest): OpenAI.Responses.ResponseCreateParamsNonStreaming {
        return {
            model: this.id,
            // The responses API has a dedicated slot for the system prompt
            // instead of a leading message.
            instructions: req.system,
            input: req.messages.flatMap(OpenAIResponsesModel.#toResponses),
            store: this.#store,
            reasoning: this.#reasoningEffort
                ? { effort: this.#reasoningEffort, summary: this.#reasoningSummary }
                : undefined,
            tools: req.tools.length
                ? req.tools.map((t) => ({
                      // Tools are flat here — no nested `function` object.
                      type: 'function' as const,
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters as Record<string, unknown>,
                      strict: false,
                  }))
                : undefined,
            tool_choice: req.tools.length ? (req.toolChoice ?? 'auto') : undefined,
        };
    }

    /**
     * Translates one internal message into responses-API input items. Returns a
     * list because an assistant turn with tool calls becomes several items: the
     * prose message plus one `function_call` per call.
     */
    static #toResponses(m: Message): ResponseInputItem[] {
        switch (m.role) {
            case 'system':
                return [{ role: 'system', content: m.content }];
            case 'user':
                return [
                    {
                        role: 'user',
                        // Only images have a first-class multimodal representation
                        // by url; other media degrade to a text reference so the
                        // thread stays valid instead of throwing.
                        content: m.content.map((p) =>
                            p.type === 'text'
                                ? { type: 'input_text' as const, text: p.text }
                                : p.type === 'image'
                                  ? {
                                        type: 'input_image' as const,
                                        image_url: p.url,
                                        detail: 'auto' as const,
                                    }
                                  : { type: 'input_text' as const, text: `[${p.type}] ${p.url}` },
                        ),
                    },
                ];
            case 'assistant': {
                const items: ResponseInputItem[] = [];
                if (m.content) {
                    items.push({ role: 'assistant', content: m.content });
                }
                for (const c of m.toolCalls ?? []) {
                    items.push({
                        type: 'function_call',
                        call_id: c.id,
                        name: c.name,
                        arguments: c.args,
                    });
                }
                return items;
            }
            case 'tool':
                return [{ type: 'function_call_output', call_id: m.callId, output: m.content }];
        }
    }
}

function readText(output: ResponseOutputItem[]): string {
    return output
        .flatMap((item) =>
            item.type === 'message'
                ? item.content.flatMap((p) => (p.type === 'output_text' ? [p.text] : []))
                : [],
        )
        .join('');
}

function readThinking(output: ResponseOutputItem[]): string | undefined {
    const parts = output.flatMap((item) =>
        item.type === 'reasoning' ? item.summary.map((s) => s.text) : [],
    );
    return parts.join('\n\n') || undefined;
}

function readToolCalls(output: ResponseOutputItem[]): ToolCall[] {
    // `call_id` — not `id` — is what a later `function_call_output` must
    // reference, so it is the identity we carry through the trajectory.
    return output.flatMap((item) =>
        item.type === 'function_call'
            ? [{ id: item.call_id, name: item.name, args: item.arguments }]
            : [],
    );
}

function toStopReason(res: OpenAI.Responses.Response, hasToolCalls: boolean): StopReason {
    if (hasToolCalls) {
        return 'tool_calls';
    }
    switch (res.incomplete_details?.reason) {
        case 'max_output_tokens':
            return 'length';
        case 'content_filter':
            return 'content_filter';
        default:
            return 'stop';
    }
}

function toUsage(u: OpenAI.Responses.ResponseUsage | undefined): TokenUsage | undefined {
    if (!u) {
        return undefined;
    }
    return {
        ...zeroUsage(),
        inputTokens: u.input_tokens,
        cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: u.output_tokens,
        reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    };
}

/**
 * `response.reasoning.delta` carries an untyped payload: providers send either a
 * bare string or `{ text }`.
 */
function readReasoningDelta(delta: unknown): string | undefined {
    if (typeof delta === 'string') {
        return delta || undefined;
    }
    if (delta === null || typeof delta !== 'object') {
        return undefined;
    }
    const text = (delta as { text?: unknown }).text;
    return typeof text === 'string' && text ? text : undefined;
}
