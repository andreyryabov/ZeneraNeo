import type { OpenRouter } from '@openrouter/sdk';
import type { ProviderPreferences } from '@openrouter/sdk/models';
import type {
    CreateEmbeddingsData,
    CreateEmbeddingsRequestBody,
} from '@openrouter/sdk/models/operations';
import type { Embedder, EmbeddingRequest, EmbeddingResponse } from '../embedding.ts';
import { embeddingResponse } from '../embedding.ts';
import { RETRY_STATUS_CODES } from '../models/openrouter.ts';
import { zeroUsage } from '../types.ts';

// ---------------------------------------------------------------------------
// OpenRouter embeddings adapter
//
// The same trade as the chat adapter next door: its own SDK rather than the
// OpenAI client aimed at another base url, because provider routing is the
// reason to be here at all and chat completions has nowhere to put it.
// ---------------------------------------------------------------------------

/** OpenRouter's word for the retrieval side, which it takes as a free string. */
const INPUT_TYPES = { query: 'search_query', document: 'search_document' } as const;

/** Provider-specific knobs. */
export interface OpenRouterEmbedderOptions {
    /** default width; a request may override it */
    dimensions?: number;
    /**
     * Which upstream providers may serve this model, and in what order. Named
     * as in `OpenRouterModelOptions`, and for the same reason: a *provider*
     * here is already the connection.
     */
    routing?: ProviderPreferences;
}

export class OpenRouterEmbedder implements Embedder {
    readonly id: string;
    readonly #client: OpenRouter;
    readonly #options: OpenRouterEmbedderOptions;

    constructor(id: string, client: OpenRouter, options: OpenRouterEmbedderOptions = {}) {
        this.id = id;
        this.#client = client;
        this.#options = options;
    }

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        const requestBody: CreateEmbeddingsRequestBody = {
            model: this.id,
            input: req.input,
            dimensions: req.dimensions ?? this.#options.dimensions,
            inputType: req.taskType ? INPUT_TYPES[req.taskType] : undefined,
            provider: this.#options.routing,
            // `encodingFormat` is deliberately not sent. Its type is an open
            // enum, whose values are branded and so unreachable without a value
            // import of the SDK — and float is the default anyway. The string
            // branch of `embedding` below is what catches a gateway that
            // decides otherwise.
        };
        const res = await this.#client.embeddings.generate(
            { requestBody },
            { fetchOptions: { signal: req.signal }, retryCodes: RETRY_STATUS_CODES },
        );
        // The response is declared as the body *or* a bare string, so the
        // parsed shape has to be established before anything is read off it.
        if (typeof res === 'string') {
            throw new Error(`embedder "${this.id}": expected an embeddings response, got text`);
        }
        const vectors = [...res.data].sort(byIndex).map((d) => vectorOf(d, this.id));
        return embeddingResponse(
            vectors,
            req,
            res.usage ? { ...zeroUsage(), inputTokens: res.usage.promptTokens } : undefined,
        );
    }
}

/** `index` is optional here, so its absence has to mean "keep the order given". */
function byIndex(a: CreateEmbeddingsData, b: CreateEmbeddingsData): number {
    return (a.index ?? 0) - (b.index ?? 0);
}

function vectorOf(data: CreateEmbeddingsData, id: string): number[] {
    if (typeof data.embedding === 'string') {
        throw new Error(
            `embedder "${id}": got a base64 embedding, which this adapter does not decode`,
        );
    }
    return data.embedding;
}
