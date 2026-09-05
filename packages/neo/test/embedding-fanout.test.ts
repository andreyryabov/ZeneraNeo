import type { EmbedContentParameters, GoogleGenAI } from '@google/genai';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { estimateTokens, sliceBatch } from '../src/embeddings/fanout.ts';
import { GeminiEmbedder } from '../src/embeddings/gemini.ts';
import { RateLimiter } from '../src/embeddings/limiter.ts';
import { OpenAIEmbedder } from '../src/embeddings/openai.ts';
import { classify, retryAfterMs, statusOf } from '../src/embeddings/rate-limit.ts';

// ---------------------------------------------------------------------------
// Adaptive fan-out
//
// Two things are being tested here and they fail differently. The limiter fails
// loudly — too slow, or a 429 storm — and its tests are about arithmetic that
// only shows up under simultaneity, which is why the epoch test bothers to get
// eight tasks refused at literally the same moment.
//
// The fan-out fails silently. Sub-requests finish out of order by design, and a
// fan-out that puts a vector back in the wrong slot returns a perfectly
// well-formed index in which every passage answers a different question. So the
// stubs here always finish out of order, and always answer with something that
// identifies which text it was for.
// ---------------------------------------------------------------------------

/** An error shaped the way a vendor SDK shapes one. */
function refused(status: number, headers?: Record<string, string>): Error {
    return Object.assign(new Error(`stub ${status}`), { status, headers });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('classify', () => {
    it('reads the status wherever the SDK keeps it', () => {
        expect(statusOf(refused(429))).toBe(429);
        // The OpenRouter client's spelling, which reading only `status` misses.
        expect(statusOf(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(401);
        expect(statusOf(new Error('x'))).toBeUndefined();
    });

    it('separates being refused from being broken', () => {
        expect(classify(refused(429))).toBe('rate-limit');
        expect(classify(refused(503))).toBe('rate-limit');
        expect(classify(refused(500))).toBe('transient');
        expect(classify(refused(401))).toBe('fatal');
        expect(classify(refused(400))).toBe('fatal');
        // A miscount is our own bug, so it must not be retried.
        expect(classify(new Error('answered 1 vector for 8 texts'))).toBe('fatal');
    });

    it('finds a dropped connection down the cause chain', () => {
        const err = new Error('fetch failed', {
            cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        });
        expect(classify(err)).toBe('transient');
    });

    it('survives a cause that points at itself', () => {
        const err: Error & { cause?: unknown } = new Error('loop');
        err.cause = err;
        expect(classify(err)).toBe('fatal');
    });

    it('never retries an abort', () => {
        expect(classify(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('fatal');
    });

    it('prefers the millisecond header, and reads seconds from the other', () => {
        expect(retryAfterMs(refused(429, { 'retry-after-ms': '250', 'retry-after': '30' }))).toBe(
            250,
        );
        expect(retryAfterMs(refused(429, { 'Retry-After': '2' }))).toBe(2000);
        expect(retryAfterMs(refused(429))).toBeUndefined();
    });

    it('reads a `Headers` instance as readily as an object', () => {
        const headers = new Headers({ 'retry-after': '3' });
        expect(retryAfterMs(Object.assign(new Error('x'), { status: 429, headers }))).toBe(3000);
    });
});

describe('RateLimiter', () => {
    it('halves once for one overload, however many refusals it produced', async () => {
        // Eight in flight, all refused at the same instant. Halving per refusal
        // would take the limit to 1 in a single round trip and then spend
        // minutes climbing back; the epoch is what makes it one event.
        const limiter = new RateLimiter({
            start: 8,
            max: 8,
            stride: 100,
            initialBackoffMs: 0,
        });
        const attempts = new Array<number>(8).fill(0);
        let arrived = 0;
        let open = (): void => {};
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });

        const done = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                limiter.run(async () => {
                    attempts[i]!++;
                    if (attempts[i] === 1) {
                        if (++arrived === 8) {
                            open();
                        }
                        await gate;
                        throw refused(429);
                    }
                    return i;
                }),
            ),
        );

        expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(limiter.limit).toBe(4);
    });

    it('holds every worker for the pause the provider asked for', async () => {
        const limiter = new RateLimiter({ start: 1, max: 1, maxRetries: 0 });
        const started: number[] = [];
        const at = Date.now();

        const first = limiter.run(async () => {
            started.push(Date.now() - at);
            throw refused(429, { 'retry-after-ms': '80' });
        });
        const second = limiter.run(async () => {
            started.push(Date.now() - at);
            return 'ok';
        });

        await expect(first).rejects.toThrow('stub 429');
        await second;
        // The pause is shared, so the queued task waits for it too rather than
        // starting the moment the refused one let go of its slot.
        expect(started[1]!).toBeGreaterThanOrEqual(60);
    });

    it('climbs back up while calls succeed and the queue is not empty', async () => {
        const limiter = new RateLimiter({ start: 1, max: 4, stride: 1 });
        await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => 'ok')));
        expect(limiter.limit).toBe(4);
    });

    it('does not grow on a workload that never fills it', async () => {
        const limiter = new RateLimiter({ start: 2, max: 8, stride: 1 });
        await limiter.run(async () => 'ok');
        await limiter.run(async () => 'ok');
        expect(limiter.limit).toBe(2);
    });

    it('gives up on a fatal failure without spending a retry', async () => {
        const limiter = new RateLimiter({ initialBackoffMs: 0 });
        let calls = 0;
        await expect(
            limiter.run(async () => {
                calls++;
                throw refused(401);
            }),
        ).rejects.toThrow('stub 401');
        expect(calls).toBe(1);
    });

    it('stops after the last retry rather than looping', async () => {
        const limiter = new RateLimiter({ maxRetries: 2, initialBackoffMs: 0 });
        let calls = 0;
        await expect(
            limiter.run(async () => {
                calls++;
                throw refused(500);
            }),
        ).rejects.toThrow('stub 500');
        expect(calls).toBe(3);
    });

    it('rejects what is still queued when the signal aborts', async () => {
        const limiter = new RateLimiter({ start: 1, max: 1 });
        const control = new AbortController();
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        const running = limiter.run(async () => {
            await held;
            return 'first';
        }, control.signal);
        const queued = limiter.run(async () => 'second', control.signal);

        await sleep(0);
        control.abort();
        await expect(queued).rejects.toThrow();
        release();
        await expect(running).resolves.toBe('first');
        // A rejected waiter must still free its place, or the queue never drains.
        expect(limiter.inFlight).toBe(0);
    });
});

describe('sliceBatch', () => {
    it('splits on the count', () => {
        const parts = sliceBatch(['a', 'b', 'c', 'd', 'e'], 2, 1_000);
        expect(parts.map((p) => p.texts)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
        expect(parts.map((p) => p.at)).toEqual([0, 2, 4]);
    });

    it('splits on the token estimate too', () => {
        // The cap people quote is the count; the cap that actually fires is the
        // token total, which no caller can see from a text length either.
        const long = 'x'.repeat(4_000);
        const parts = sliceBatch([long, long, long], 100, 1_500);
        expect(parts.map((p) => p.texts.length)).toEqual([1, 1, 1]);
        expect(estimateTokens(long)).toBe(1_000);
    });

    it('sends an oversized text alone rather than dropping or truncating it', () => {
        const huge = 'x'.repeat(40_000);
        const parts = sliceBatch(['a', huge, 'b'], 100, 1_000);
        expect(parts.map((p) => p.texts)).toEqual([['a'], [huge], ['b']]);
    });

    it('has nothing to say about nothing', () => {
        expect(sliceBatch([], 10, 10)).toEqual([]);
    });
});

/**
 * An OpenAI client that answers with a one-element vector holding the number
 * each text is, and finishes later the earlier it was called — so a fan-out
 * that appends instead of placing by index gets caught.
 */
function stubOpenAI(options: { fail?: number } = {}) {
    const sent: string[][] = [];
    let call = 0;
    const client = {
        embeddings: {
            create: async (params: OpenAI.EmbeddingCreateParams) => {
                const input = params.input as string[];
                const mine = call++;
                if (mine < (options.fail ?? 0)) {
                    throw refused(429, { 'retry-after-ms': '1' });
                }
                sent.push(input);
                await sleep(10 - Math.min(9, mine));
                return {
                    data: input
                        .map((text, i) => ({
                            index: i,
                            object: 'embedding' as const,
                            embedding: [Number(text)],
                        }))
                        .reverse(),
                    model: 'stub',
                    object: 'list' as const,
                    usage: { prompt_tokens: input.length, total_tokens: input.length },
                };
            },
        },
    };
    return { client: client as unknown as OpenAI, sent };
}

describe('fan-out', () => {
    const texts = Array.from({ length: 20 }, (_, i) => String(i));

    it('keeps the caller\u2019s order however the requests interleave', async () => {
        const { client, sent } = stubOpenAI();
        const embedder = new OpenAIEmbedder('text-embedding-3-small', client, { maxBatch: 3 });

        const res = await embedder.embed({ input: texts, normalize: false });

        expect(sent.length).toBe(7);
        expect(res.vectors.map((v) => v[0])).toEqual(texts.map(Number));
    });

    it('reports progress in texts, monotonically, ending at the total', async () => {
        const { client } = stubOpenAI();
        const embedder = new OpenAIEmbedder('text-embedding-3-small', client, { maxBatch: 3 });
        const seen: number[] = [];

        await embedder.embed({
            input: texts,
            normalize: false,
            onProgress: (done, total) => {
                expect(total).toBe(20);
                seen.push(done);
            },
        });

        expect(seen.at(-1)).toBe(20);
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    });

    it('adds up the usage the requests reported', async () => {
        const { client } = stubOpenAI();
        const embedder = new OpenAIEmbedder('text-embedding-3-small', client, { maxBatch: 3 });
        const res = await embedder.embed({ input: texts, normalize: false });
        expect(res.usage?.inputTokens).toBe(20);
    });

    it('retries a refusal and still lands every vector in its own slot', async () => {
        const { client } = stubOpenAI({ fail: 3 });
        const embedder = new OpenAIEmbedder('text-embedding-3-small', client, { maxBatch: 3 });
        const res = await embedder.embed({ input: texts, normalize: false });
        expect(res.vectors.map((v) => v[0])).toEqual(texts.map(Number));
    });

    it('asks for nothing when there is nothing to embed', async () => {
        const { client, sent } = stubOpenAI();
        const embedder = new OpenAIEmbedder('text-embedding-3-small', client);
        const res = await embedder.embed({ input: [] });
        expect(res.vectors).toEqual([]);
        expect(sent).toEqual([]);
    });

    it('turns the SDK\u2019s own retrying off, so the limiter is the one that sees a 429', async () => {
        const seen: unknown[] = [];
        const client = {
            embeddings: {
                create: async (params: OpenAI.EmbeddingCreateParams, options: unknown) => {
                    seen.push(options);
                    const input = params.input as string[];
                    return {
                        data: input.map((_, i) => ({
                            index: i,
                            object: 'embedding' as const,
                            embedding: [1],
                        })),
                        model: 'stub',
                        object: 'list' as const,
                        usage: { prompt_tokens: 1, total_tokens: 1 },
                    };
                },
            },
        } as unknown as OpenAI;

        await new OpenAIEmbedder('text-embedding-3-small', client).embed({ input: ['a'] });
        expect(seen[0]).toMatchObject({ maxRetries: 0 });
    });

    it('splits a gemini batch to one document per request and keeps the order', async () => {
        const sent: EmbedContentParameters[] = [];
        const client = {
            models: {
                embedContent: async (params: EmbedContentParameters) => {
                    sent.push(params);
                    const contents = params.contents as { parts: { text: string }[] }[];
                    await sleep(10 - Math.min(9, sent.length));
                    return {
                        embeddings: contents.map((c) => ({
                            values: [Number(c.parts[0]!.text)],
                        })),
                    };
                },
            },
        } as unknown as GoogleGenAI;

        const embedder = new GeminiEmbedder('gemini-embedding-001', client);
        const res = await embedder.embed({ input: texts, normalize: false });

        expect(sent.length).toBe(20);
        // Google bills characters, not tokens, so a number here would be a lie.
        expect(res.usage).toBeUndefined();
        expect(res.vectors.map((v) => v[0])).toEqual(texts.map(Number));
        expect(sent[0]?.config?.httpOptions?.retryOptions?.attempts).toBe(1);
    });

    it('refuses an answer with the wrong number of vectors', async () => {
        // The failure this catches has no error attached to it: a vendor that
        // reads a batch as one document answers with one vector and a 200.
        const client = {
            models: {
                embedContent: async () => ({ embeddings: [{ values: [1] }] }),
            },
        } as unknown as GoogleGenAI;

        const embedder = new GeminiEmbedder('text-embedding-004', client, { maxBatch: 4 });
        await expect(embedder.embed({ input: ['a', 'b', 'c', 'd'] })).rejects.toThrow(
            /answered 1 vectors for 4 texts/,
        );
    });
});
