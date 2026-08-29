import type { Content, EmbedContentConfig, GoogleGenAI } from '@google/genai';
import {
    embeddingResponse,
    type Embedder,
    type EmbeddingRequest,
    type EmbeddingResponse,
    type EmbeddingTaskType,
} from '../embedding.ts';

// ---------------------------------------------------------------------------
// Google Gemini embeddings adapter
//
// Serves `google` and `vertex` alike: the two differ in how the client
// authenticates, which is the provider's business, not this file's.
// ---------------------------------------------------------------------------

/**
 * Google's task types are plain strings in `EmbedContentConfig` — unlike
 * `ThinkingLevel` next door, there is no enum to inline. Only the retrieval
 * pair is mapped: the others (clustering, similarity, classification) are jobs
 * this runtime does not have a word for.
 */
const TASK_TYPES: Record<EmbeddingTaskType, string> = {
    query: 'RETRIEVAL_QUERY',
    document: 'RETRIEVAL_DOCUMENT',
};

/** Requests in flight at once when a batch has to be split across several. */
const CONCURRENCY = 8;

/** Provider-specific knobs. */
export interface GeminiEmbedderOptions {
    /** default width; a request may override it */
    dimensions?: number;
    /** a document's title, which the retrieval task type takes into account */
    title?: string;
    /**
     * Texts this model accepts per request. One is the default because that is
     * what every `gemini-embedding-*` model takes — `embedContent` is a
     * single-document endpoint there, and the batch path is a separate,
     * job-based API. The older `text-embedding-*` models accept far more and
     * can say so.
     */
    maxBatch?: number;
}

export class GeminiEmbedder implements Embedder {
    readonly id: string;
    readonly #client: GoogleGenAI;
    readonly #options: GeminiEmbedderOptions;

    constructor(id: string, client: GoogleGenAI, options: GeminiEmbedderOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#options = options;
    }

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        const config: EmbedContentConfig = {
            taskType: req.taskType ? TASK_TYPES[req.taskType] : undefined,
            // Only meaningful alongside RETRIEVAL_DOCUMENT; the API ignores it
            // otherwise rather than rejecting the request.
            title: this.#options.title,
            outputDimensionality: req.dimensions ?? this.#options.dimensions,
            abortSignal: req.signal,
        };

        // The contract is batch-first and this endpoint usually is not, so the
        // splitting happens here rather than in every caller. Chunks are issued
        // in waves and their results concatenated in order, so a caller cannot
        // tell how many requests it took.
        const size = Math.max(1, this.#options.maxBatch ?? 1);
        const chunks: string[][] = [];
        for (let i = 0; i < req.input.length; i += size) {
            chunks.push(req.input.slice(i, i + size));
        }

        const vectors: number[][] = [];
        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const wave = await Promise.all(
                chunks.slice(i, i + CONCURRENCY).map((chunk) => this.#send(chunk, config)),
            );
            for (const part of wave) {
                vectors.push(...part);
            }
        }

        // Usage stays undefined on purpose: this API reports billable
        // *characters*, on Vertex only, which is not a token count and would be
        // a lie in `TokenUsage`.
        return embeddingResponse(vectors, req);
    }

    async #send(input: string[], config: EmbedContentConfig): Promise<number[][]> {
        const res = await this.#client.models.embedContent({
            model: this.id,
            // Spelled out as one `Content` per text. `ContentListUnion` also
            // accepts a `string[]`, and reads it as the *parts of a single
            // document* — six sentences in, one vector back, and no error.
            contents: input.map((text): Content => ({ parts: [{ text }] })),
            config,
        });
        return (res.embeddings ?? []).map((e) => e.values ?? []);
    }
}
