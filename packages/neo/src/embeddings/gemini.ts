import type { Content, EmbedContentConfig, GoogleGenAI } from '@google/genai';
import type {
    Embedder,
    EmbeddingRequest,
    EmbeddingResponse,
    EmbeddingTaskType,
} from '../embedding.ts';
import { fanout, type BatchOptions } from './fanout.ts';
import { RateLimiter } from './limiter.ts';

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

/**
 * One, because `embedContent` is a single-document endpoint for every
 * `gemini-embedding-*` model — it answers more than one content with *"The
 * embedContent API for this model only supports one content at a time"* — and
 * the batch path is a separate, job-based API. The older `text-embedding-*`
 * models take far more.
 *
 * This is why the fan-out matters most here: a corpus is one request per chunk,
 * so how many may be in flight is the entire runtime of a build.
 */
const MAX_BATCH = 1;
const LEGACY_MAX_BATCH = 250;
const MAX_BATCH_TOKENS = 20_000;

const LEGACY_MODEL = /^text-embedding-/;

/** Provider-specific knobs. */
export interface GeminiEmbedderOptions extends BatchOptions {
    /** default width; a request may override it */
    dimensions?: number;
    /** a document's title, which the retrieval task type takes into account */
    title?: string;
}

export class GeminiEmbedder implements Embedder {
    readonly id: string;
    readonly #client: GoogleGenAI;
    readonly #options: GeminiEmbedderOptions;
    readonly #limiter: RateLimiter;
    readonly #maxBatch: number;
    readonly #maxBatchTokens: number;

    constructor(id: string, client: GoogleGenAI, options: GeminiEmbedderOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#options = options;
        this.#limiter = options.limiter ?? new RateLimiter();
        this.#maxBatch = options.maxBatch ?? (LEGACY_MODEL.test(id) ? LEGACY_MAX_BATCH : MAX_BATCH);
        this.#maxBatchTokens = options.maxBatchTokens ?? MAX_BATCH_TOKENS;
    }

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        const config: EmbedContentConfig = {
            taskType: req.taskType ? TASK_TYPES[req.taskType] : undefined,
            // Only meaningful alongside RETRIEVAL_DOCUMENT; the API ignores it
            // otherwise rather than rejecting the request.
            title: this.#options.title,
            outputDimensionality: req.dimensions ?? this.#options.dimensions,
            abortSignal: req.signal,
            // The SDK retries nothing unless `retryOptions` is present, and the
            // client was built with some; one attempt hands a refusal back out
            // to the limiter, which is the only thing that can slow the run down.
            httpOptions: { retryOptions: { attempts: 1 } },
        };

        // Usage stays undefined on purpose: this API reports billable
        // *characters*, on Vertex only, which is not a token count and would be
        // a lie in `TokenUsage`.
        return await fanout(req, {
            id: this.id,
            limiter: this.#limiter,
            maxBatch: this.#maxBatch,
            maxBatchTokens: this.#maxBatchTokens,
            send: async (input) => {
                const res = await this.#client.models.embedContent({
                    model: this.id,
                    // Spelled out as one `Content` per text. `ContentListUnion`
                    // also accepts a `string[]`, and reads it as the *parts of a
                    // single document* — six sentences in, one vector back, and
                    // no error.
                    contents: input.map((text): Content => ({ parts: [{ text }] })),
                    config,
                });
                return { vectors: (res.embeddings ?? []).map((e) => e.values ?? []) };
            },
        });
    }
}
