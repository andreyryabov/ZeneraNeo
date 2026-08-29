import type OpenAI from 'openai';
import {
    embeddingResponse,
    type Embedder,
    type EmbeddingRequest,
    type EmbeddingResponse,
} from '../embedding.ts';
import { zeroUsage } from '../types.ts';

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
export interface OpenAIEmbedderOptions {
    /** default width; a request may override it */
    dimensions?: number;
}

export class OpenAIEmbedder implements Embedder {
    readonly id: string;
    readonly #client: OpenAI;
    readonly #dimensions: number | undefined;

    constructor(id: string, client: OpenAI, options: OpenAIEmbedderOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#dimensions = options.dimensions;
    }

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        const res = await this.#client.embeddings.create(
            {
                model: this.id,
                input: req.input,
                dimensions: req.dimensions ?? this.#dimensions,
            },
            { signal: req.signal },
        );
        // The API documents the order but does not promise it, and `index` is
        // the only thing that ties a vector back to its text.
        const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        return embeddingResponse(vectors, req, {
            ...zeroUsage(),
            inputTokens: res.usage.prompt_tokens,
        });
    }
}
