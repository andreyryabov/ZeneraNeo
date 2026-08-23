import type Anthropic from '@anthropic-ai/sdk';
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
// Anthropic messages adapter
// ---------------------------------------------------------------------------

// A type alias cannot stand in for the namespace, so these spell it out once
// and the rest of the file works in short names.
type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type MessageCreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type ContentBlock = Anthropic.Messages.ContentBlock;
type Usage = Anthropic.Messages.Usage;
type ToolChoice = Anthropic.Messages.ToolChoice;
type AnthropicStopReason = Anthropic.Messages.StopReason;
type Base64Media = Anthropic.Messages.Base64ImageSource['media_type'];

/**
 * Provider-specific knobs.
 *
 * `maxTokens` has no counterpart in the OpenAI adapters because there it is
 * optional; Anthropic *requires* an output cap on every request, so one has to
 * exist. 8192 is the largest value every current Claude model accepts, which
 * makes it the only safe default — raise it per model when you know better.
 */
export interface AnthropicModelOptions {
    /** hard cap on output tokens; required by the API, so it always has a value */
    maxTokens?: number;
    /**
     * Extended thinking budget, in tokens (≥1024 enables it). Off by default,
     * and deliberately so — see the note on `#params` about tool use.
     */
    thinkingBudgetTokens?: number;
}

/** Every current Claude model accepts at least this many output tokens. */
const DEFAULT_MAX_TOKENS = 8192;

/** The API's floor for a thinking budget; below it the request is rejected. */
const MIN_THINKING_BUDGET = 1024;

/**
 * The `Model` contract over `/v1/messages`.
 *
 * Unlike Google, Anthropic is not worth reaching through an OpenAI-compatible
 * shim: the compatibility layer they publish is explicitly a porting aid, and
 * it drops the two things this runtime cares most about — accurate cache
 * accounting and extended thinking. A real adapter is ~200 lines and gets both.
 */
export class AnthropicModel implements Model {
    readonly id: string;
    readonly #client: Anthropic;
    readonly #maxTokens: number;
    readonly #thinkingBudget: number | undefined;

    constructor(id: string, client: Anthropic, options: AnthropicModelOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#thinkingBudget =
            options.thinkingBudgetTokens && options.thinkingBudgetTokens >= MIN_THINKING_BUDGET
                ? options.thinkingBudgetTokens
                : undefined;
        // The budget is spent *out of* the output cap, so a cap at or below it
        // leaves no room to answer in.
        this.#maxTokens = Math.max(
            options.maxTokens ?? DEFAULT_MAX_TOKENS,
            (this.#thinkingBudget ?? 0) + MIN_THINKING_BUDGET,
        );
    }

    async generate(req: ModelRequest): Promise<ModelResponse> {
        const res = await this.#client.messages.create(this.#params(req), { signal: req.signal });
        return {
            ...readBlocks(res.content),
            usage: toUsage(res.usage),
            stopReason: toStopReason(res.stop_reason),
        };
    }

    async stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse> {
        const stream = this.#client.messages.stream(this.#params(req), { signal: req.signal });

        // Blocks are addressed by index, and a tool call's id and name arrive in
        // its `content_block_start` while the arguments trickle in afterwards.
        const calls = new Map<number, ToolCall>();

        for await (const event of stream) {
            if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block.type === 'tool_use') {
                    calls.set(event.index, { id: block.id, name: block.name, args: '' });
                    onDelta({ type: 'tool_call_detected', callId: block.id, name: block.name });
                }
                continue;
            }
            if (event.type !== 'content_block_delta') {
                continue;
            }
            const delta = event.delta;
            switch (delta.type) {
                case 'text_delta':
                    onDelta({ type: 'text_delta', delta: delta.text });
                    break;
                case 'thinking_delta':
                    onDelta({ type: 'thinking_delta', delta: delta.thinking });
                    break;
                case 'input_json_delta': {
                    const call = calls.get(event.index);
                    if (call && delta.partial_json) {
                        call.args += delta.partial_json;
                        onDelta({
                            type: 'tool_args_delta',
                            callId: call.id,
                            name: call.name,
                            delta: delta.partial_json,
                            argsSoFar: call.args,
                        });
                    }
                    break;
                }
            }
        }

        // The accumulated message is authoritative: it has the parsed tool
        // inputs and the final usage, so the deltas above are for the UI only
        // and nothing here depends on having reassembled them correctly.
        const final = await stream.finalMessage();
        return {
            ...readBlocks(final.content),
            usage: toUsage(final.usage),
            stopReason: toStopReason(final.stop_reason),
        };
    }

    /**
     * Note what is *not* here: prior thinking blocks are never replayed. The
     * API requires the original block, signature included, when extended
     * thinking is on and the turn being replayed made tool calls — and a
     * signature is not something the trajectory carries, since it is meaningless
     * to every other provider. So `thinkingBudgetTokens` is safe for plain
     * conversation and will be rejected by the API on a tool-using multi-turn
     * run. Preserving signatures would mean a provider-specific field on
     * `AssistantMessage`, which is a trajectory change, not an adapter change.
     */
    #params(req: ModelRequest): MessageCreateParams {
        return {
            model: this.id,
            max_tokens: this.#maxTokens,
            system: req.system,
            messages: toMessages(req.messages),
            thinking: this.#thinkingBudget
                ? { type: 'enabled', budget_tokens: this.#thinkingBudget }
                : undefined,
            tools: req.tools.length
                ? req.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
                  }))
                : undefined,
            tool_choice: req.tools.length ? toToolChoice(req.toolChoice) : undefined,
        };
    }
}

// ---------------------------------------------------------------------------
// Wire translation
// ---------------------------------------------------------------------------

/**
 * Internal messages → Anthropic turns.
 *
 * Two things differ from the OpenAI shape and both are handled by merging
 * adjacent same-role turns: a tool result is a *user* turn rather than a role
 * of its own, and parallel tool results have to arrive together in one turn
 * rather than as one message each.
 */
function toMessages(messages: Message[]): MessageParam[] {
    const out: MessageParam[] = [];

    const push = (role: 'user' | 'assistant', blocks: ContentBlockParam[]): void => {
        if (!blocks.length) {
            return;
        }
        const last = out.at(-1);
        if (last?.role === role) {
            (last.content as ContentBlockParam[]).push(...blocks);
            return;
        }
        out.push({ role, content: blocks });
    };

    for (const m of messages) {
        switch (m.role) {
            case 'system':
                // There is no mid-conversation system turn in this API, and
                // hoisting it to the top-level `system` would move it away from
                // the point it was injected at — which is the whole value of a
                // memory recall. A user turn keeps the position.
                push('user', [{ type: 'text', text: m.content }]);
                break;
            case 'user':
                push('user', m.content.map(toBlock));
                break;
            case 'assistant': {
                const blocks: ContentBlockParam[] = [];
                if (m.content) {
                    blocks.push({ type: 'text', text: m.content });
                }
                for (const c of m.toolCalls ?? []) {
                    blocks.push({
                        type: 'tool_use',
                        id: c.id,
                        name: c.name,
                        input: parseArgs(c.args),
                    });
                }
                push('assistant', blocks);
                break;
            }
            case 'tool':
                push('user', [
                    {
                        type: 'tool_result',
                        tool_use_id: m.callId,
                        content: m.content,
                        is_error: m.isError,
                    },
                ]);
                break;
        }
    }
    return out;
}

/** Only images have a first-class representation; other media degrade to text. */
function toBlock(part: ContentPart): ContentBlockParam {
    if (part.type === 'text') {
        return { type: 'text', text: part.text };
    }
    if (part.type !== 'image') {
        return { type: 'text', text: `[${part.type}] ${part.url}` };
    }
    const inline = readDataUri(part.url);
    return inline
        ? { type: 'image', source: { type: 'base64', ...inline } }
        : { type: 'image', source: { type: 'url', url: part.url } };
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function readDataUri(url: string): { media_type: Base64Media; data: string } | undefined {
    const match = DATA_URI.exec(url);
    if (!match) {
        return undefined;
    }
    return {
        media_type: match[1] as Base64Media,
        data: match[2],
    };
}

/**
 * Tool arguments travel as the raw JSON string the model produced, because that
 * is what every other provider wants back verbatim. Anthropic wants the parsed
 * object, and a malformed one is the model's error to see, not a crash here.
 */
function parseArgs(args: string): unknown {
    if (!args.trim()) {
        return {};
    }
    try {
        return JSON.parse(args);
    } catch {
        return { _raw: args };
    }
}

function toToolChoice(choice: ModelRequest['toolChoice']): ToolChoice {
    switch (choice) {
        case 'required':
            return { type: 'any' };
        case 'none':
            return { type: 'none' };
        default:
            return { type: 'auto' };
    }
}

function readBlocks(content: ContentBlock[]): {
    text: string;
    thinking?: string;
    toolCalls: ToolCall[];
} {
    let text = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                text += block.text;
                break;
            case 'thinking':
                thinking += block.thinking;
                break;
            case 'tool_use':
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    args: JSON.stringify(block.input ?? {}),
                });
                break;
        }
    }
    return { text, thinking: thinking || undefined, toolCalls };
}

/**
 * Anthropic reports `input_tokens` *excluding* what the cache served, while
 * `TokenUsage.cachedInputTokens` is defined as a subset of `inputTokens`. So
 * the cache figures are added back in rather than passed through, and a run
 * that mixes providers still sums to a comparable number.
 */
function toUsage(u: Usage | undefined): TokenUsage | undefined {
    if (!u) {
        return undefined;
    }
    const read = u.cache_read_input_tokens ?? 0;
    const written = u.cache_creation_input_tokens ?? 0;
    return {
        ...zeroUsage(),
        inputTokens: u.input_tokens + read + written,
        cachedInputTokens: read,
        outputTokens: u.output_tokens,
        // Thinking is billed as ordinary output and is not broken out, so
        // claiming a number here would be inventing one.
        reasoningTokens: 0,
    };
}

function toStopReason(reason: AnthropicStopReason | null): StopReason {
    switch (reason) {
        case 'tool_use':
            return 'tool_calls';
        case 'max_tokens':
        case 'model_context_window_exceeded':
            return 'length';
        case 'refusal':
            return 'content_filter';
        default:
            return 'stop';
    }
}
