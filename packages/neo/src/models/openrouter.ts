import type { OpenRouter } from '@openrouter/sdk';
import type {
    ChatContentItems,
    ChatFunctionTool,
    ChatMessages,
    ChatRequest,
    ChatRequestPlugin,
    ChatUsage,
    ProviderPreferences,
} from '@openrouter/sdk/models';
import type { StreamDelta } from '../events.ts';
import type { Model, ModelRequest, ModelResponse, StopReason } from '../model.ts';
import { zeroUsage, type Message, type TokenUsage, type ToolCall } from '../types.ts';

// ---------------------------------------------------------------------------
// OpenRouter adapter
//
// Not the chat-completions adapter pointed at another base url. OpenRouter's
// own SDK is a different wire contract in TypeScript terms — camelCase fields
// remapped to snake_case on the way out, a response union that covers both
// streaming and not, assistant content that may arrive as an array — so it
// gets its own adapter rather than a widened `OpenAIModel`.
//
// What that buys is the part of OpenRouter the OpenAI client cannot express:
// provider routing, a model fallback chain, and per-call cost. What it costs
// is that responses are zod-parsed on the way in, so a provider returning a
// shape the schema does not know raises `ResponseValidationError` where the
// OpenAI client would have shrugged. `kind: openai-compatible` against the
// same base url remains the way back if that ever bites.
// ---------------------------------------------------------------------------

/**
 * Effort levels, spelled out rather than imported: the SDK's is an *open* enum
 * (its literals plus any string), which would let a typo through, and naming
 * its type here would tie this interface to a generated alias. The set is the
 * same one the OpenAI adapters accept, which is what lets `ModelSpec` extend
 * both without the two declarations disagreeing.
 */
export type OpenRouterEffort =
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;

/** Provider-specific knobs. */
export interface OpenRouterModelOptions {
    reasoningEffort?: OpenRouterEffort;
    /** ask for a reasoning summary from models that expose one */
    reasoningSummary?: 'auto' | 'concise' | 'detailed';
    /** hard cap on output tokens; the model's own default applies when unset */
    maxTokens?: number;
    /**
     * Which upstream providers may serve this model, and in what order. Named
     * `routing` rather than the SDK's `provider` because in this runtime a
     * provider is already the *connection* — OpenRouter itself — and reusing
     * the word for "who OpenRouter hands the request to" would collide.
     */
    routing?: ProviderPreferences;
    /**
     * Models to try, in order, when the primary one is unavailable. The SDK
     * calls this `models`; `fallbacks` says which of the two lists it is.
     */
    fallbacks?: string[];
    /** OpenRouter-side plugins: web search, file parsing, moderation */
    plugins?: ChatRequestPlugin[];
    /** provider-dependent latency/price tier, ignored where unsupported */
    serviceTier?: 'auto' | 'default' | 'fast' | 'flex' | 'priority' | 'scale';
}

function toStopReason(finish: string | null | undefined): StopReason {
    switch (finish) {
        case 'tool_calls':
            return 'tool_calls';
        case 'length':
            return 'length';
        case 'content_filter':
            return 'content_filter';
        default:
            return 'stop';
    }
}

/**
 * Assistant content is `string | ContentItems[] | null` here, unlike chat
 * completions where it is a string. The array form appears when a provider
 * returns text alongside images, so the text parts are what this runtime's
 * `text` channel means; anything else is carried by other fields.
 */
function toText(content: string | ChatContentItems[] | null | undefined): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!content) {
        return '';
    }
    return content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

function toUsage(u: ChatUsage | undefined): TokenUsage | undefined {
    if (!u) {
        return undefined;
    }
    return {
        ...zeroUsage(),
        inputTokens: u.promptTokens,
        cachedInputTokens: u.promptTokensDetails?.cachedTokens ?? 0,
        outputTokens: u.completionTokens,
        reasoningTokens: u.completionTokensDetails?.reasoningTokens ?? 0,
    };
}

export class OpenRouterModel implements Model {
    readonly id: string;
    readonly #client: OpenRouter;
    readonly #options: OpenRouterModelOptions;

    constructor(id: string, client: OpenRouter, options: OpenRouterModelOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#options = options;
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        const res = await this.#send(req, false);
        // Both overloads are declared to return the same union, so the narrowing
        // the `stream` flag implies has to be done here.
        if (Symbol.asyncIterator in res) {
            throw new Error(`model "${this.id}": asked for one completion, got a stream`);
        }
        const choice = res.choices[0];
        const message = choice?.message;
        return {
            text: toText(message?.content),
            thinking: message?.reasoning ?? undefined,
            toolCalls: (message?.toolCalls ?? []).map((c) => ({
                id: c.id,
                name: c.function.name,
                args: c.function.arguments,
            })),
            usage: toUsage(res.usage),
            stopReason: toStopReason(choice?.finishReason),
        };
    }

    async stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse> {
        const res = await this.#send(req, true);
        if (!(Symbol.asyncIterator in res)) {
            throw new Error(`model "${this.id}": asked for a stream, got one completion`);
        }

        let text = '';
        let thinking = '';
        let usage: TokenUsage | undefined;
        let stopReason: StopReason | undefined;
        // Tool calls arrive as deltas keyed by index, with the id and name in the
        // first fragment and arguments trickling in afterwards.
        const calls = new Map<number, ToolCall>();

        for await (const chunk of res) {
            // An upstream failure mid-stream arrives as a chunk on a 200, so it
            // has to be raised here or the turn ends early and looks complete.
            if (chunk.error) {
                throw new Error(`model "${this.id}": ${chunk.error.message} (${chunk.error.code})`);
            }
            if (chunk.usage) {
                usage = toUsage(chunk.usage);
            }
            const choice = chunk.choices[0];
            if (!choice) {
                continue;
            }
            if (choice.finishReason) {
                stopReason = toStopReason(choice.finishReason);
            }
            const delta = choice.delta;
            if (delta.reasoning) {
                thinking += delta.reasoning;
                onDelta({ type: 'thinking_delta', delta: delta.reasoning });
            }
            if (delta.content) {
                text += delta.content;
                onDelta({ type: 'text_delta', delta: delta.content });
            }
            for (const part of delta.toolCalls ?? []) {
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

    /**
     * The abort signal rides in `fetchOptions` rather than on the request: this
     * SDK keeps transport concerns out of the body it validates.
     */
    #send(req: ModelRequest, stream: boolean) {
        return this.#client.chat.send(
            { chatRequest: this.#request(req, stream) },
            { fetchOptions: { signal: req.signal } },
        );
    }

    #request(req: ModelRequest, stream: boolean): ChatRequest {
        const o = this.#options;
        const messages: ChatMessages[] = [];
        if (req.system) {
            messages.push({ role: 'system', content: req.system });
        }
        for (const m of req.messages) {
            messages.push(OpenRouterModel.#toOpenRouter(m));
        }
        return {
            model: this.id,
            messages,
            stream,
            maxCompletionTokens: o.maxTokens,
            reasoning:
                o.reasoningEffort || o.reasoningSummary
                    ? { effort: o.reasoningEffort, summary: o.reasoningSummary }
                    : undefined,
            provider: o.routing,
            models: o.fallbacks,
            plugins: o.plugins,
            serviceTier: o.serviceTier,
            tools: req.tools.length
                ? req.tools.map((t): ChatFunctionTool => ({
                      type: 'function',
                      function: {
                          name: t.name,
                          description: t.description,
                          parameters: t.parameters as Record<string, unknown>,
                      },
                  }))
                : undefined,
            toolChoice: req.tools.length ? (req.toolChoice ?? 'auto') : undefined,
        };
    }

    /** Translates one internal message into the provider wire format. */
    static #toOpenRouter(m: Message): ChatMessages {
        switch (m.role) {
            case 'system':
                return { role: 'system', content: m.content };
            case 'user':
                return {
                    role: 'user',
                    // Only images have a first-class multimodal representation
                    // here; other media degrade to a text reference so the
                    // thread stays valid instead of throwing.
                    content: m.content.map((p) =>
                        p.type === 'text'
                            ? { type: 'text' as const, text: p.text }
                            : p.type === 'image'
                              ? { type: 'image_url' as const, imageUrl: { url: p.url } }
                              : { type: 'text' as const, text: `[${p.type}] ${p.url}` },
                    ),
                };
            case 'assistant':
                return {
                    role: 'assistant',
                    // A tool-calling turn usually has no prose; the API wants an
                    // explicit null there rather than an empty string.
                    content: m.content || null,
                    toolCalls: m.toolCalls?.length
                        ? m.toolCalls.map((c) => ({
                              id: c.id,
                              type: 'function' as const,
                              function: { name: c.name, arguments: c.args },
                          }))
                        : undefined,
                };
            case 'tool':
                return { role: 'tool', toolCallId: m.callId, content: m.content };
        }
    }
}
