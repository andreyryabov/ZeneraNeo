import { describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embedding.ts';
import { createEmbedder, type EmbeddingRef } from '../src/models/factory.ts';

// ---------------------------------------------------------------------------
// One conformance suite, run once per vendor
// ---------------------------------------------------------------------------

/**
 * These tests exercise an `Embedder` directly — no store, no retrieval, no
 * kernel. The point is the adapter: does a batch survive the trip out and back
 * with its order intact, and do the numbers that come back mean anything?
 *
 * The second question is the one an offline stub cannot answer. A transposed
 * batch, a task type sent under the wrong name, a truncation applied to the
 * wrong axis — each of those returns vectors of the right shape and the wrong
 * content, and the only thing that catches it is asking a real model whether
 * the passage that answers a question is the one nearest to it.
 */

const TIMEOUT_MS = 120_000;

/**
 * Sentences with nothing in common but the language they are written in, so a
 * ranking that puts the right one first cannot be luck. The first three are
 * also the corpus the questions below are answered from.
 */
const PASSAGES = [
    'A sourdough loaf is made from flour, water and salt, left to ferment overnight.',
    'Apollo 11 landed the first humans on the Moon in July 1969.',
    'TypeScript adds static types to JavaScript and compiles away to plain JavaScript.',
    'The Danube flows through ten countries before it reaches the Black Sea.',
    'A dovetail joint holds two boards together without glue or nails.',
    'Penicillin was discovered when a mould contaminated a bacterial culture.',
];

/** Each question is answered by exactly one of the first three passages. */
const QUESTIONS: [question: string, answer: number][] = [
    ['How do I bake bread at home?', 0],
    ['Which mission first put people on the Moon?', 1],
    ['What does adding types to JavaScript get me?', 2],
];

/** Two vectors of the same text are never bit-identical, but they are this close. */
const SAME = 0.999;

/** float32 round-tripping moves a unit vector by about this much, and no more. */
const UNIT_TOLERANCE = 0.001;

/** `toBeCloseTo` counts decimal places rather than taking a delta. */
const PLACES = Math.round(-Math.log10(UNIT_TOLERANCE));

export interface LiveEmbeddingSuite {
    /** shown in the test name */
    label: string;
    /** what to hand `createEmbedder` */
    ref: EmbeddingRef;
    /** false when the vendor's credentials are absent — the suite then skips */
    enabled: boolean;
    /** the vendor reports token usage; Google counts billable characters instead */
    reportsUsage?: boolean;
    /** a narrower width this model accepts, when it supports truncation at all */
    truncatedWidth?: number;
    /**
     * Request sizes to exercise. Vendors cap this differently and change the
     * cap between models, so it is stated per vendor rather than assumed — and
     * the largest is what the tests below send in one call.
     */
    batchSizes?: number[];
}

export function liveEmbeddingSuite({
    label,
    ref,
    enabled,
    reportsUsage = true,
    truncatedWidth,
    batchSizes = [1, 2, PASSAGES.length],
}: LiveEmbeddingSuite): void {
    const live = enabled ? describe : describe.skip;
    const widest = Math.max(...batchSizes);

    live(`${label} live embeddings`, () => {
        // One instance for the whole suite, only to avoid rebuilding a client
        // per test. Nothing about a call may live on an `Embedder`.
        let embedder: Embedder;

        function get(): Embedder {
            embedder ??= createEmbedder(ref);
            return embedder;
        }

        /** Splits the corpus into requests this vendor will accept. */
        async function embed(input: string[], taskType: 'query' | 'document'): Promise<number[][]> {
            const out: number[][] = [];
            for (let i = 0; i < input.length; i += widest) {
                const res = await get().embed({ input: input.slice(i, i + widest), taskType });
                out.push(...res.vectors);
            }
            return out;
        }

        it.each(batchSizes)(
            'returns %i vector(s), all of one width',
            async (size) => {
                const res = await get().embed({ input: sample(size) });

                expect(res.vectors).toHaveLength(size);
                expect(res.dimensions).toBeGreaterThan(0);
                for (const vector of res.vectors) {
                    expect(vector).toHaveLength(res.dimensions);
                    // A vector of zeros has the right shape and no meaning.
                    expect(vector.some((v) => v !== 0)).toBe(true);
                }

                if (reportsUsage) {
                    expect(res.usage?.inputTokens).toBeGreaterThan(0);
                } else {
                    expect(res.usage).toBeUndefined();
                }
            },
            TIMEOUT_MS,
        );

        it.runIf(widest > 1)(
            'gives a text the same vector alone as it does in a batch',
            async () => {
                const input = sample(widest);
                const batched = (await get().embed({ input })).vectors;

                // Position by position, against the same text asked for on its
                // own. A reversed or transposed batch has the right shape and
                // the right widths, and fails here at every index but the
                // middle one.
                for (const [i, text] of input.entries()) {
                    const alone = (await get().embed({ input: [text] })).vectors[0]!;
                    expect(cosine(alone, batched[i]!), `input ${i}`).toBeGreaterThan(SAME);
                }
            },
            TIMEOUT_MS,
        );

        it(
            'puts the answering passage nearest each question',
            async () => {
                const corpus = PASSAGES.slice(0, QUESTIONS.length);
                const docs = await embed(corpus, 'document');
                const asked = await embed(
                    QUESTIONS.map(([q]) => q),
                    'query',
                );

                for (const [i, [question, answer]] of QUESTIONS.entries()) {
                    const scores = docs.map((d) => cosine(asked[i]!, d));
                    const nearest = scores.indexOf(Math.max(...scores));
                    expect(nearest, `${question} → ${corpus[nearest]}`).toBe(answer);
                }
            },
            TIMEOUT_MS,
        );

        it.runIf(truncatedWidth !== undefined)(
            'truncates to a requested width',
            async () => {
                const res = await get().embed({
                    input: [PASSAGES[0]!],
                    dimensions: truncatedWidth,
                });
                expect(res.dimensions).toBe(truncatedWidth);
            },
            TIMEOUT_MS,
        );

        it(
            'returns unit vectors, at full width and truncated alike',
            async () => {
                const widths = [undefined, ...(truncatedWidth ? [truncatedWidth] : [])];
                for (const dimensions of widths) {
                    const res = await get().embed({ input: sample(1), dimensions });
                    expect(norm(res.vectors[0]!), `at ${res.dimensions} dimensions`).toBeCloseTo(
                        1,
                        PLACES,
                    );
                }
            },
            TIMEOUT_MS,
        );

        it(
            'leaves the vendor’s own magnitude alone when asked not to normalise',
            async () => {
                // Truncation is where the vendors differ: it is a raw slice of
                // a longer vector, and only some models rescale afterwards. The
                // assertion is not which one this model is — that changes
                // between generations — but that turning the guarantee off
                // reaches whatever it said, and turning it on moves only the
                // magnitude, never the direction.
                const input = sample(1);
                const dimensions = truncatedWidth;
                const raw = await get().embed({ input, dimensions, normalize: false });
                const unit = await get().embed({ input, dimensions });

                expect(cosine(raw.vectors[0]!, unit.vectors[0]!)).toBeGreaterThan(SAME);
                expect(norm(unit.vectors[0]!)).toBeCloseTo(1, PLACES);
            },
            TIMEOUT_MS,
        );
    });
}

/** A size beyond the corpus should fail loudly, not quietly embed duplicates. */
function sample(n: number): string[] {
    if (n > PASSAGES.length) {
        throw new Error(`the corpus holds ${PASSAGES.length} passages, not ${n}`);
    }
    return PASSAGES.slice(0, n);
}

/** Similarity, not distance: vendors normalise differently, direction does not. */
function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function norm(v: number[]): number {
    return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}
