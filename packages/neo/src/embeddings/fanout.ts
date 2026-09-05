import { embeddingResponse, type EmbeddingRequest, type EmbeddingResponse } from '../embedding.ts';
import { zeroUsage, type TokenUsage } from '../types.ts';
import { RateLimiter } from './limiter.ts';

// ---------------------------------------------------------------------------
// One batch in, as many requests as it takes
//
// The contract is batch-first, and every vendor caps how big a batch may be —
// at 2048 texts, or at one, or at some number a gateway never wrote down. That
// cap is a property of the model, so splitting for it belongs here rather than
// in each caller, where it was previously a constant with no relationship to
// the model it was sent to.
//
// There are two caps, not one, because the count is the cap people quote and
// the token total is the cap that actually fires. OpenAI accepts 2048 inputs
// per request and roughly 300k tokens across them, so 2048 paragraphs is fine
// and 2048 pages is a 400 — and a caller cannot avoid that by choosing a
// smaller number, because it does not know how long its texts are either.
//
// Order is the whole correctness story. Sub-requests finish out of order by
// design, so results are placed by index and never appended; a fan-out that
// transposes two vectors returns a plausible answer to a different question and
// nothing downstream can tell. The count check is here for the same reason: a
// vendor that reads a batch as one document answers with one vector and no
// error at all.
// ---------------------------------------------------------------------------

/** What one request came back with, before it is joined to the others. */
export interface EmbeddingSlice {
    vectors: number[][];
    /** absent where the vendor reports characters, or nothing */
    inputTokens?: number;
}

/** The per-model knobs every adapter shares, and the connection they share it with. */
export interface BatchOptions {
    /** texts per request; the model's own cap applies when unset */
    maxBatch?: number;
    /** estimated tokens per request; the model's own cap applies when unset */
    maxBatchTokens?: number;
    /**
     * Paces every embedding request on one connection. Supplied by the registry
     * so two embedders on one account cannot each ramp up to the full limit;
     * an adapter built by hand gets one of its own.
     */
    limiter?: RateLimiter;
}

export interface FanoutPlan {
    /** the embedder's id, for the one error message that needs it */
    id: string;
    limiter: RateLimiter;
    maxBatch: number;
    maxBatchTokens: number;
    send(input: string[]): Promise<EmbeddingSlice>;
}

/**
 * Four characters to a token: within about 15% for English prose, wrong for CJK
 * and for long identifiers. It only has to be right enough to stay under a cap
 * that is already generous, and being wrong costs an extra request, not a
 * failed one.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export async function fanout(req: EmbeddingRequest, plan: FanoutPlan): Promise<EmbeddingResponse> {
    if (req.input.length === 0) {
        return embeddingResponse([], req);
    }
    const parts = sliceBatch(req.input, plan.maxBatch, plan.maxBatchTokens);
    let done = 0;

    const slices = await Promise.all(
        parts.map((part) =>
            plan.limiter.run(async () => {
                const slice = await plan.send(part.texts);
                if (slice.vectors.length !== part.texts.length) {
                    throw new Error(
                        `embedder "${plan.id}": answered ${slice.vectors.length} vectors ` +
                            `for ${part.texts.length} texts`,
                    );
                }
                done += part.texts.length;
                req.onProgress?.(done, req.input.length);
                return slice;
            }, req.signal),
        ),
    );

    const vectors = new Array<number[]>(req.input.length);
    for (const [at, part] of parts.entries()) {
        for (const [i, vector] of slices[at]!.vectors.entries()) {
            vectors[part.at + i] = vector;
        }
    }
    return embeddingResponse(vectors, req, usageOf(slices));
}

interface Part {
    /** where these texts started in the caller's array */
    at: number;
    texts: string[];
}

/**
 * Greedy, on both caps at once. A single text over the token budget goes alone
 * and is sent as it is: truncating it would answer with a vector for something
 * the caller did not ask about, which is worse than the error it will get.
 */
export function sliceBatch(
    input: readonly string[],
    maxBatch: number,
    maxBatchTokens: number,
): Part[] {
    const parts: Part[] = [];
    let texts: string[] = [];
    let at = 0;
    let tokens = 0;

    for (const [i, text] of input.entries()) {
        const cost = estimateTokens(text);
        if (texts.length > 0 && (texts.length >= maxBatch || tokens + cost > maxBatchTokens)) {
            parts.push({ at, texts });
            texts = [];
            at = i;
            tokens = 0;
        }
        texts.push(text);
        tokens += cost;
    }
    if (texts.length > 0) {
        parts.push({ at, texts });
    }
    return parts;
}

/** Undefined unless something reported a number: a zero would read as free. */
function usageOf(slices: readonly EmbeddingSlice[]): TokenUsage | undefined {
    let total: number | undefined;
    for (const slice of slices) {
        if (slice.inputTokens !== undefined) {
            total = (total ?? 0) + slice.inputTokens;
        }
    }
    return total === undefined ? undefined : { ...zeroUsage(), inputTokens: total };
}
