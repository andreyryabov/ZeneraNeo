import type OpenAI from 'openai';
import type { Embedder, EmbeddingRequest, EmbeddingResponse } from '../embedding.ts';
import { fanout, type BatchOptions } from './fanout.ts';
import { RateLimiter } from './limiter.ts';

// ---------------------------------------------------------------------------
// OpenAI embeddings adapter
//
// Also the adapter for `openai-compatible`: `/v1/embeddings` is the one
// endpoint every gateway implements the same way, and nothing here reaches for
// a field that only OpenAI itself returns.
// ---------------------------------------------------------------------------

/**
 * Provider-specific knobs. `taskType` has no counterpart here: OpenAI's models
 * are symmetric, so a query and a document are encoded identically and the
 * request's hint is simply not sent.
 */
export interface OpenAIEmbedderOptions extends BatchOptions {
    /** default width; a request may override it */
    dimensions?: number;
}

/**
 * What OpenAI documents for `text-embedding-*`: 2048 inputs, and 300k tokens
 * across them. The token figure is the one that fires in practice, and it is
 * held under the real cap because the estimate feeding it counts characters.
 */
const MAX_BATCH = 2048;
const MAX_BATCH_TOKENS = 250_000;

/**
 * A gateway is not OpenAI. `openai-compatible` reaches vLLM, Ollama and
 * whatever else speaks the shape, none of which promise those numbers, so an
 * unrecognised id gets something any implementation can be expected to hold.
 */
const GATEWAY_BATCH = 96;
const GATEWAY_BATCH_TOKENS = 100_000;

const OPENAI_MODEL = /^text-embedding-/;

export class OpenAIEmbedder implements Embedder {
    readonly id: string;
    readonly #client: OpenAI;
    readonly #dimensions: number | undefined;
    readonly #limiter: RateLimiter;
    readonly #maxBatch: number;
    readonly #maxBatchTokens: number;

    constructor(id: string, client: OpenAI, options: OpenAIEmbedderOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#dimensions = options.dimensions;
        this.#limiter = options.limiter ?? new RateLimiter();
        const known = OPENAI_MODEL.test(id);
        this.#maxBatch = options.maxBatch ?? (known ? MAX_BATCH : GATEWAY_BATCH);
        this.#maxBatchTokens =
            options.maxBatchTokens ?? (known ? MAX_BATCH_TOKENS : GATEWAY_BATCH_TOKENS);
    }

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        return await fanout(req, {
            id: this.id,
            limiter: this.#limiter,
            maxBatch: this.#maxBatch,
            maxBatchTokens: this.#maxBatchTokens,
            send: async (input) => {
                const res = await this.#client.embeddings.create(
                    {
                        model: this.id,
                        input,
                        dimensions: req.dimensions ?? this.#dimensions,
                    },
                    // The client's own retrying is off because a retry it serves
                    // is one the limiter never sees: the call succeeds, nothing
                    // learns the provider is refusing, and the run quietly takes
                    // as long as the backoff it did not report.
                    { signal: req.signal, maxRetries: 0 },
                );
                // The API documents the order but does not promise it, and
                // `index` is the only thing tying a vector back to its text.
                return {
                    vectors: [...res.data]
                        .sort((a, b) => a.index - b.index)
                        .map((d) => d.embedding),
                    inputTokens: res.usage.prompt_tokens,
                };
            },
        });
    }
}
