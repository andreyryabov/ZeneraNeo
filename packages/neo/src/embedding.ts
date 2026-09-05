import type { TokenUsage } from './types.ts';

// ---------------------------------------------------------------------------
// Embedding abstraction
//
// The same shape as `Model`, one layer down: a vendor-neutral request, a
// vendor-neutral response, and one method. There is no streaming counterpart
// because there are no deltas to emit — an embedding arrives whole or not at
// all.
// ---------------------------------------------------------------------------

/**
 * Which side of a retrieval this text is.
 *
 * The only asymmetry worth a place in the contract: the current generation of
 * embedding models is trained so that a question and the passage answering it
 * are encoded *differently*, and mixing the two up costs recall silently rather
 * than loudly. Google spells it `taskType`, OpenRouter `inputType`, and OpenAI
 * has no such knob at all — which is exactly why it belongs on the request
 * rather than on any one adapter.
 */
export type EmbeddingTaskType = 'query' | 'document';

export interface EmbeddingRequest {
    /**
     * The texts to encode, in the order the vectors come back. Any length: the
     * adapter splits it to whatever the model accepts per request and issues
     * those in parallel, so a caller never has to know the cap or invent one.
     */
    input: string[];
    taskType?: EmbeddingTaskType;
    /** truncate to this width, where the model supports it */
    dimensions?: number;
    /**
     * Scale each vector to unit length. On by default — see `vectors` below.
     * Turn it off to see what the model actually returned.
     */
    normalize?: boolean;
    /**
     * Texts finished so far, out of the whole input. A large batch is minutes
     * of one `await`, and a caller with nothing to say for that long is
     * indistinguishable from a hung one.
     */
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
}

export interface EmbeddingResponse {
    /**
     * One vector per input, in the same order, and of unit length unless the
     * request asked otherwise.
     *
     * Normalising here rather than leaving it to the caller is the one place
     * this contract does more than translate. Whether a model returns unit
     * vectors is a property of the *model*, not the vendor, and it changes
     * between generations: `gemini-embedding-2` is unit at every width,
     * `gemini-embedding-001` comes back at |v| ≈ 0.58 when truncated to 768 of
     * its 3072, and `text-embedding-005` at ≈ 0.67 for 256 of its 768 — because
     * truncation is a raw slice and only some models rescale afterwards.
     *
     * Cosine similarity divides the magnitude out and so cannot see any of
     * that; a dot-product index, which is what pgvector and most vector stores
     * default to, can see nothing else. So a caller that did not normalise
     * would not get an error, it would get quietly worse results — and it
     * cannot know which model it was handed.
     */
    vectors: number[][];
    /** the width actually returned, which a truncating request may have chosen */
    dimensions: number;
    /** input tokens only; some providers report nothing at all */
    usage?: TokenUsage;
}

export interface Embedder {
    readonly id: string;
    embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/**
 * The one way an adapter finishes, so the unit-length guarantee holds for every
 * provider without three copies of the same loop.
 */
export function embeddingResponse(
    vectors: number[][],
    req: EmbeddingRequest,
    usage?: TokenUsage,
): EmbeddingResponse {
    return {
        vectors: req.normalize === false ? vectors : vectors.map(unit),
        dimensions: vectors[0]?.length ?? 0,
        usage,
    };
}

function unit(vector: number[]): number[] {
    let sum = 0;
    for (const x of vector) {
        sum += x * x;
    }
    const length = Math.sqrt(sum);
    // A zero vector has no direction to preserve, and dividing would make it NaN.
    return length === 0 ? vector : vector.map((x) => x / length);
}
