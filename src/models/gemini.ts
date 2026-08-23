import {
    FinishReason,
    FunctionCallingConfigMode,
    ThinkingLevel,
    type Content,
    type GenerateContentConfig,
    type GenerateContentParameters,
    type GenerateContentResponse,
    type GoogleGenAI,
    type Part,
} from '@google/genai';
import type { StreamDelta } from '../events.ts';
import type { Model, ModelRequest, ModelResponse, StopReason } from '../model.ts';
import {
    zeroUsage,
    type ContentPart,
    type Message,
    type TokenUsage,
    type ToolCall,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Google Gemini adapter
// ---------------------------------------------------------------------------

/** The coarse dial Gemini 3 takes in place of a token budget. */
export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Provider-specific knobs.
 *
 * Thinking is configured two different ways depending on the generation, and
 * both are exposed rather than unified: 2.5 takes a token `thinkingBudget`,
 * 3 takes a coarse `thinkingLevel`, and passing the wrong one is an API error
 * rather than something this adapter can paper over.
 */
export interface GeminiModelOptions {
    /** hard cap on output tokens; the model's own default applies when unset */
    maxTokens?: number;
    /** 2.5-era budget, in tokens: `0` disables thinking, `-1` lets the model decide */
    thinkingBudget?: number;
    /** 3-era dial; mutually exclusive with `thinkingBudget` */
    thinkingLevel?: GeminiThinkingLevel;
    /**
     * Ask for thought *summaries* — the only reasoning text the API exposes.
     * On by default: the runtime has a `thinking` channel and the tokens are
     * billed whether or not the summary is returned.
     */
    includeThoughts?: boolean;
}

const THINKING_LEVELS: Record<GeminiThinkingLevel, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
};

/**
 * Ids this adapter invented. The Gemini API returns function calls without one
 * — Vertex does populate `id` — but the runner pairs results to calls by id, so
 * one has to exist. The prefix is how a synthesized id is recognised on the way
 * back out and dropped, leaving the API to pair by function name as it expects.
 */
const SYNTHETIC_ID = 'gemini-call-';

/**
 * How many thought signatures to keep. Signatures are only ever needed for
 * calls still live in the trajectory, so this is a leak guard rather than a
 * tuning knob — see `#signatures`.
 */
const SIGNATURE_LIMIT = 512;

/**
 * The `Model` contract over `generateContent`.
 *
 * Google publishes an OpenAI-compatible endpoint, and reaching Gemini through
 * it costs nothing but a base url. What it costs *afterwards* is everything
 * this file exists for: thinking budgets and thought summaries, thought
 * signatures (without which Gemini 3 function calling degrades), cached-content
 * accounting, and the block reasons that come back when a safety filter fires.
 * None of those have an OpenAI field to be carried in.
 */
export class GeminiModel implements Model {
    readonly id: string;
    readonly #client: GoogleGenAI;
    readonly #options: GeminiModelOptions;

    /**
     * Thought signatures, by call id.
     *
     * Gemini 3 returns an opaque signature alongside each function call and
     * requires it back on the next request; dropping it makes the model
     * re-derive its reasoning and answer worse. The signature is meaningless to
     * every other provider, so it does not belong in the trajectory — which
     * leaves the adapter holding it, keyed by the one identifier that does
     * survive the round trip.
     *
     * The consequence is that a `GeminiModel` should outlive a run. The
     * registry memoizes one per model spec, so it does; a caller who rebuilds
     * the model between turns loses the signatures and gets the 2.5-era
     * behaviour back, which is a quality regression rather than an error.
     */
    readonly #signatures = new Map<string, string>();
    #nextId = 0;

    constructor(id: string, client: GoogleGenAI, options: GeminiModelOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#options = options;
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        const res = await this.#client.models.generateContent(this.#params(req));
        const read = emptyRead();
        for (const part of candidateParts(res)) {
            this.#readPart(part, read);
        }
        return this.#finish(read, res);
    }

    async stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse> {
        const stream = await this.#client.models.generateContentStream(this.#params(req));
        const read = emptyRead();
        let last: GenerateContentResponse | undefined;

        for await (const chunk of stream) {
            last = chunk;
            for (const part of candidateParts(chunk)) {
                this.#readPart(part, read, onDelta);
            }
        }
        return this.#finish(read, last);
    }

    /**
     * Folds one part into the accumulator, emitting deltas when streaming.
     * Shared by both paths so a streamed run and a plain one cannot disagree
     * about what a part meant.
     */
    #readPart(part: Part, into: Read, onDelta?: (d: StreamDelta) => void): void {
        if (part.text !== undefined) {
            // Thought summaries arrive as ordinary text parts flagged
            // `thought`; the flag is the only thing separating reasoning from
            // the answer.
            if (part.thought) {
                into.thinking += part.text;
                onDelta?.({ type: 'thinking_delta', delta: part.text });
            } else {
                into.text += part.text;
                onDelta?.({ type: 'text_delta', delta: part.text });
            }
            return;
        }
        const call = part.functionCall;
        if (!call) {
            return;
        }
        const id = this.#callId(call.id);
        const name = call.name ?? '';
        const args = JSON.stringify(call.args ?? {});
        into.toolCalls.push({ id, name, args });
        if (part.thoughtSignature) {
            into.signatures.set(id, part.thoughtSignature);
        }
        // Arguments are not streamed incrementally by this API: a call arrives
        // whole, so detection and the arguments are one event apart and
        // `argsSoFar` is complete the moment it is first seen.
        onDelta?.({ type: 'tool_call_detected', callId: id, name });
        onDelta?.({ type: 'tool_args_delta', callId: id, name, delta: args, argsSoFar: args });
    }

    #finish(read: Read, res: GenerateContentResponse | undefined): ModelResponse {
        this.#remember(read.signatures);
        return {
            text: read.text,
            thinking: read.thinking || undefined,
            toolCalls: read.toolCalls,
            usage: toUsage(res?.usageMetadata),
            stopReason: toStopReason(res?.candidates?.[0]?.finishReason, read.toolCalls.length > 0),
        };
    }

    #params(req: ModelRequest): GenerateContentParameters {
        return {
            model: this.id,
            contents: toContents(req.messages, this.#signatures),
            config: this.#config(req),
        };
    }

    #config(req: ModelRequest): GenerateContentConfig {
        const o = this.#options;
        const thinking =
            o.thinkingBudget !== undefined || o.thinkingLevel !== undefined
                ? {
                      thinkingBudget: o.thinkingBudget,
                      thinkingLevel: o.thinkingLevel && THINKING_LEVELS[o.thinkingLevel],
                      includeThoughts: o.includeThoughts ?? true,
                  }
                : { includeThoughts: o.includeThoughts ?? true };

        return {
            // Unlike the other two vendors this is a *config* field rather than
            // a turn, so a system prompt never occupies a position in the
            // conversation and cannot be reordered by history trimming.
            systemInstruction: req.system,
            maxOutputTokens: o.maxTokens,
            thinkingConfig: thinking,
            abortSignal: req.signal,
            tools: req.tools.length
                ? [
                      {
                          functionDeclarations: req.tools.map((t) => ({
                              name: t.name,
                              description: t.description,
                              // The `parameters` field takes Google's own
                              // trimmed-down Schema; this one takes the JSON
                              // Schema the rest of the runtime already speaks.
                              parametersJsonSchema: t.parameters,
                          })),
                      },
                  ]
                : undefined,
            toolConfig: req.tools.length
                ? { functionCallingConfig: { mode: toCallingMode(req.toolChoice) } }
                : undefined,
        };
    }

    /** Mints an id for a call the API left unidentified. */
    #callId(id: string | undefined): string {
        return id ?? `${SYNTHETIC_ID}${this.#nextId++}`;
    }

    #remember(signatures: SignatureMap): void {
        for (const [id, signature] of signatures) {
            this.#signatures.set(id, signature);
        }
        // Insertion order is oldest-first, so the excess is at the front.
        const excess = this.#signatures.size - SIGNATURE_LIMIT;
        if (excess > 0) {
            for (const id of [...this.#signatures.keys()].slice(0, excess)) {
                this.#signatures.delete(id);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Wire translation
// ---------------------------------------------------------------------------

type SignatureMap = Map<string, string>;

/** What a response amounts to, once its parts have been sorted by channel. */
interface Read {
    text: string;
    thinking: string;
    toolCalls: ToolCall[];
    signatures: SignatureMap;
}

function emptyRead(): Read {
    return { text: '', thinking: '', toolCalls: [], signatures: new Map() };
}

function candidateParts(res: GenerateContentResponse): Part[] {
    return res.candidates?.[0]?.content?.parts ?? [];
}

/**
 * Internal messages → Gemini contents.
 *
 * The role vocabulary is `user` and `model`, with tool results carried as
 * `functionResponse` parts inside a *user* turn — so, as with Anthropic,
 * adjacent turns of the same role are merged rather than emitted one per
 * message.
 */
function toContents(messages: Message[], signatures: SignatureMap): Content[] {
    const out: Content[] = [];

    const push = (role: 'user' | 'model', parts: Part[]): void => {
        if (!parts.length) {
            return;
        }
        const last = out.at(-1);
        if (last?.role === role) {
            last.parts?.push(...parts);
            return;
        }
        out.push({ role, parts });
    };

    for (const m of messages) {
        switch (m.role) {
            case 'system':
                // A mid-conversation system message is a memory recall, and
                // hoisting it into `systemInstruction` would move it away from
                // the point it was injected at. A user turn keeps the position.
                push('user', [{ text: m.content }]);
                break;
            case 'user':
                push('user', m.content.map(toPart));
                break;
            case 'assistant': {
                const parts: Part[] = [];
                if (m.content) {
                    parts.push({ text: m.content });
                }
                for (const c of m.toolCalls ?? []) {
                    parts.push({
                        functionCall: {
                            id: wireId(c.id),
                            name: c.name,
                            args: parseArgs(c.args),
                        },
                        thoughtSignature: signatures.get(c.id),
                    });
                }
                push('model', parts);
                break;
            }
            case 'tool':
                push('user', [
                    {
                        functionResponse: {
                            id: wireId(m.callId),
                            name: m.name,
                            // The API wants an object, not a string. `output`
                            // and `error` are the conventional keys, and the
                            // distinction is otherwise lost.
                            response: m.isError ? { error: m.content } : { output: m.content },
                        },
                    },
                ]);
                break;
        }
    }
    return out;
}

/** Drops ids this adapter invented, so the API pairs by function name instead. */
function wireId(id: string): string | undefined {
    return id.startsWith(SYNTHETIC_ID) ? undefined : id;
}

/** Only text and inline media have first-class parts; the rest degrade to text. */
function toPart(part: ContentPart): Part {
    if (part.type === 'text') {
        return { text: part.text };
    }
    const inline = readDataUri(part.url);
    if (inline) {
        return { inlineData: inline };
    }
    // A remote uri has to be one the service can fetch — a Files API or GCS
    // reference — and needs its mime type declared, which a bare url does not
    // carry. Without one there is nothing to send but the url itself.
    return part.mimeType
        ? { fileData: { fileUri: part.url, mimeType: part.mimeType } }
        : { text: `[${part.type}] ${part.url}` };
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function readDataUri(url: string): { mimeType: string; data: string } | undefined {
    const match = DATA_URI.exec(url);
    return match ? { mimeType: match[1], data: match[2] } : undefined;
}

/**
 * Tool arguments travel as the raw JSON string the model produced, because that
 * is what the trajectory stores and what other providers want back verbatim.
 * Gemini wants the parsed object, and a malformed one is the model's error to
 * see rather than a crash here.
 */
function parseArgs(args: string): Record<string, unknown> {
    if (!args.trim()) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(args);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return { _raw: args };
    }
}

function toCallingMode(choice: ModelRequest['toolChoice']): FunctionCallingConfigMode {
    switch (choice) {
        case 'required':
            return FunctionCallingConfigMode.ANY;
        case 'none':
            return FunctionCallingConfigMode.NONE;
        default:
            return FunctionCallingConfigMode.AUTO;
    }
}

/**
 * `promptTokenCount` already includes whatever the cache served, matching this
 * runtime's definition of `cachedInputTokens` as a subset. Thinking is the
 * opposite: `thoughtsTokenCount` is reported *beside* `candidatesTokenCount`
 * rather than inside it, so it is added in to keep `reasoningTokens` a subset
 * of `outputTokens`.
 */
function toUsage(u: GenerateContentResponse['usageMetadata']): TokenUsage | undefined {
    if (!u) {
        return undefined;
    }
    const thoughts = u.thoughtsTokenCount ?? 0;
    return {
        ...zeroUsage(),
        inputTokens: u.promptTokenCount ?? 0,
        cachedInputTokens: u.cachedContentTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
        reasoningTokens: thoughts,
    };
}

/**
 * Gemini has no finish reason for "stopped to call a tool" — a turn ending in
 * function calls still reports `STOP`. The presence of calls is therefore the
 * only signal, and it has to be applied here rather than left to the kernel's
 * fallback, which only fires when a stop reason is missing entirely.
 */
function toStopReason(reason: FinishReason | undefined, toolCalls: boolean): StopReason {
    switch (reason) {
        case FinishReason.MAX_TOKENS:
            return 'length';
        case FinishReason.SAFETY:
        case FinishReason.RECITATION:
        case FinishReason.BLOCKLIST:
        case FinishReason.PROHIBITED_CONTENT:
        case FinishReason.SPII:
            return 'content_filter';
        default:
            return toolCalls ? 'tool_calls' : 'stop';
    }
}
