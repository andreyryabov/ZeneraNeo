import type { EmbedContentParameters, EmbedContentResponse, GoogleGenAI } from '@google/genai';
import type { OpenRouter } from '@openrouter/sdk';
import type { CreateEmbeddingsRequest } from '@openrouter/sdk/models/operations';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbedder } from '../src/embeddings/gemini.ts';
import { OpenAIEmbedder } from '../src/embeddings/openai.ts';
import { OpenRouterEmbedder } from '../src/embeddings/openrouter.ts';
import { ModelRegistry } from '../src/models/factory.ts';

// ---------------------------------------------------------------------------
// Embeddings
//
// The same seam as models, one layer down: a provider is a connection, an
// embedder is a request shape, and the interesting assertions are all about
// those two staying separate — that an embedder reaches for the client its
// provider name already owns, and that the one thing the vendors disagree
// about (which side of a retrieval a text is) survives the crossing.
// ---------------------------------------------------------------------------

afterEach(() => {
    vi.unstubAllEnvs();
});

/** An OpenAI client that records what it was asked and answers with fixed widths. */
function stubOpenAI(widths: number[]) {
    const sent: OpenAI.EmbeddingCreateParams[] = [];
    const client = {
        embeddings: {
            create: async (params: OpenAI.EmbeddingCreateParams) => {
                sent.push(params);
                return {
                    // Deliberately out of order: `index` is the only thing
                    // tying a vector back to its text.
                    data: widths
                        .map((w, i) => ({
                            index: i,
                            object: 'embedding' as const,
                            embedding: Array.from({ length: w }, () => i),
                        }))
                        .reverse(),
                    model: 'stub',
                    object: 'list' as const,
                    usage: { prompt_tokens: 11, total_tokens: 11 },
                };
            },
        },
    };
    return { client: client as unknown as OpenAI, sent };
}

/**
 * Answers with one vector per content it was actually sent, cycling `values`.
 * A stub that returned the whole list regardless would hide the thing this
 * adapter gets wrong: how many documents one request describes.
 */
function stubGenAI(values: number[][]) {
    const sent: EmbedContentParameters[] = [];
    let next = 0;
    const client = {
        models: {
            embedContent: async (params: EmbedContentParameters) => {
                sent.push(params);
                const count = (params.contents as unknown[]).length;
                return {
                    embeddings: Array.from({ length: count }, () => ({
                        values: values[next++ % values.length]!,
                    })),
                } as EmbedContentResponse;
            },
        },
    };
    return { client: client as unknown as GoogleGenAI, sent };
}

function stubOpenRouter(values: number[][]) {
    const sent: CreateEmbeddingsRequest[] = [];
    const client = {
        embeddings: {
            generate: async (request: CreateEmbeddingsRequest) => {
                sent.push(request);
                return {
                    data: values.map((v, i) => ({
                        index: i,
                        object: 'embedding' as const,
                        embedding: v,
                    })),
                    usage: { promptTokens: 7, totalTokens: 7 },
                };
            },
        },
    };
    return { client: client as unknown as OpenRouter, sent };
}

// ---------------------------------------------------------------------------

describe('the unit-length guarantee', () => {
    /** Answers with vectors of a known, deliberately non-unit magnitude. */
    function scaled(...vectors: number[][]) {
        const client = {
            embeddings: {
                create: async () => ({
                    data: vectors.map((embedding, index) => ({
                        index,
                        object: 'embedding' as const,
                        embedding,
                    })),
                    model: 'stub',
                    object: 'list' as const,
                    usage: { prompt_tokens: 1, total_tokens: 1 },
                }),
            },
        };
        return new OpenAIEmbedder('m', client as unknown as OpenAI);
    }

    it('scales every vector to unit length by default', async () => {
        const res = await scaled([3, 4], [0, 12]).embed({ input: ['a', 'b'] });

        expect(res.vectors).toEqual([
            [0.6, 0.8],
            [0, 1],
        ]);
        expect(res.dimensions).toBe(2);
    });

    it('hands back what the model said when asked not to', async () => {
        const res = await scaled([3, 4]).embed({ input: ['a'], normalize: false });
        expect(res.vectors).toEqual([[3, 4]]);
    });

    it('leaves a zero vector alone rather than dividing by its length', async () => {
        const res = await scaled([0, 0]).embed({ input: ['a'] });
        expect(res.vectors).toEqual([[0, 0]]);
    });
});

describe('the openai wire', () => {
    it('sends the batch whole and returns the vectors in input order', async () => {
        const { client, sent } = stubOpenAI([3, 3]);
        // Raw, because what is under test is the wire and not the unit-length
        // guarantee, which has its own block above.
        const res = await new OpenAIEmbedder('text-embedding-3-small', client).embed({
            input: ['one', 'two'],
            normalize: false,
        });

        expect(sent[0]?.input).toEqual(['one', 'two']);
        expect(res.vectors).toEqual([
            [0, 0, 0],
            [1, 1, 1],
        ]);
        expect(res.dimensions).toBe(3);
        expect(res.usage?.inputTokens).toBe(11);
    });

    it('lets a request override the declared width', async () => {
        const { client, sent } = stubOpenAI([2]);
        const embedder = new OpenAIEmbedder('m', client, { dimensions: 256 });

        await embedder.embed({ input: ['x'] });
        expect(sent[0]?.dimensions).toBe(256);

        await embedder.embed({ input: ['x'], dimensions: 64 });
        expect(sent[1]?.dimensions).toBe(64);
    });

    it('does not send a task type, because these models are symmetric', async () => {
        const { client, sent } = stubOpenAI([2]);
        await new OpenAIEmbedder('m', client).embed({ input: ['x'], taskType: 'query' });
        expect(sent[0]).not.toHaveProperty('inputType');
        expect(sent[0]).not.toHaveProperty('taskType');
    });
});

describe('the gemini wire', () => {
    it('maps the retrieval side onto Google\u2019s task types', async () => {
        const { client, sent } = stubGenAI([[1, 2]]);
        const embedder = new GeminiEmbedder('gemini-embedding-001', client);

        await embedder.embed({ input: ['x'], taskType: 'query' });
        expect(sent[0]?.config?.taskType).toBe('RETRIEVAL_QUERY');

        await embedder.embed({ input: ['x'], taskType: 'document' });
        expect(sent[1]?.config?.taskType).toBe('RETRIEVAL_DOCUMENT');

        await embedder.embed({ input: ['x'] });
        expect(sent[2]?.config?.taskType).toBeUndefined();
    });

    it('spells the width the way this API does', async () => {
        const { client, sent } = stubGenAI([[1, 2]]);
        const res = await new GeminiEmbedder('m', client, { dimensions: 128 }).embed({
            input: ['x'],
            normalize: false,
        });
        expect(sent[0]?.config?.outputDimensionality).toBe(128);
        expect(res.vectors).toEqual([[1, 2]]);
    });

    it('reports no usage, because this API counts characters rather than tokens', async () => {
        const { client } = stubGenAI([[1, 2]]);
        const res = await new GeminiEmbedder('m', client).embed({ input: ['x'] });
        expect(res.usage).toBeUndefined();
    });

    it('sends one Content per text, not one Content of many parts', async () => {
        const { client, sent } = stubGenAI([[1], [2]]);
        await new GeminiEmbedder('m', client, { maxBatch: 2 }).embed({ input: ['a', 'b'] });

        // `ContentListUnion` also accepts a `string[]` and reads it as the
        // parts of a *single* document: two texts in, one vector back, and no
        // error anywhere. Only the shape distinguishes the two.
        expect(sent[0]?.contents).toEqual([{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }]);
    });

    it('splits a batch this endpoint will not take whole, keeping the order', async () => {
        const { client, sent } = stubGenAI([[1], [2], [3]]);
        // One per request is the default: that is what every gemini-embedding
        // model accepts, and the caller should not have to know it.
        const res = await new GeminiEmbedder('m', client).embed({
            input: ['a', 'b', 'c'],
            normalize: false,
        });

        expect(sent).toHaveLength(3);
        expect(sent.map((s) => (s.contents as unknown[]).length)).toEqual([1, 1, 1]);
        expect(res.vectors).toEqual([[1], [2], [3]]);
    });
});

describe('the openrouter wire', () => {
    it('maps the retrieval side onto an input type, and reads the usage', async () => {
        const { client, sent } = stubOpenRouter([[1, 2, 3]]);
        const res = await new OpenRouterEmbedder('qwen/qwen3-embedding-8b', client).embed({
            input: ['x'],
            taskType: 'document',
            normalize: false,
        });

        expect(sent[0]?.requestBody.inputType).toBe('search_document');
        // Never sent: its type is an open enum whose values would need a value
        // import of the SDK, and float is the default.
        expect(sent[0]?.requestBody).not.toHaveProperty('encodingFormat');
        expect(res.vectors).toEqual([[1, 2, 3]]);
        expect(res.usage?.inputTokens).toBe(7);
    });

    it('carries provider routing, which is the reason for this adapter', async () => {
        const { client, sent } = stubOpenRouter([[1]]);
        await new OpenRouterEmbedder('m', client, { routing: { order: ['deepinfra'] } }).embed({
            input: ['x'],
        });
        expect(sent[0]?.requestBody.provider).toEqual({ order: ['deepinfra'] });
    });
});

// ---------------------------------------------------------------------------

describe('the registry', () => {
    it('picks an adapter by the provider\u2019s protocol', () => {
        const models = new ModelRegistry()
            .provider('oa', { kind: 'openai', apiKey: 'sk-x' })
            .provider('goo', { kind: 'google', apiKey: 'sk-x' })
            .provider('or', { kind: 'openrouter', apiKey: 'sk-x' });

        expect(models.embedder('oa:text-embedding-3-small')).toBeInstanceOf(OpenAIEmbedder);
        expect(models.embedder('goo:gemini-embedding-001')).toBeInstanceOf(GeminiEmbedder);
        expect(models.embedder('or:qwen/qwen3-embedding-8b')).toBeInstanceOf(OpenRouterEmbedder);
    });

    it('shares one client with the models on the same provider name', () => {
        const models = new ModelRegistry().provider('house', { apiKey: 'sk-house' });
        models.model('house:gpt-4o');
        const client = models.client('house');

        models.embedder('house:text-embedding-3-small');
        expect(models.client('house')).toBe(client);
    });

    it('says so when a vendor publishes no embeddings api at all', () => {
        const models = new ModelRegistry().provider('claude', {
            kind: 'anthropic',
            apiKey: 'sk-x',
        });
        expect(() => models.embedder('claude:whatever')).toThrow(/has no embeddings api/);
    });

    it('refuses an api segment, which means nothing on this endpoint', () => {
        const models = new ModelRegistry().provider('oa', { kind: 'openai', apiKey: 'sk-x' });
        expect(() => models.embedder('oa/responses:text-embedding-3-small')).toThrow(
            /embeddings have one api/,
        );
    });

    it('lets inline credentials opt out of the shared client', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-shared');
        const models = new ModelRegistry();
        const shared = models.client('openai');

        models.embedder({ model: 'text-embedding-3-small', apiKey: 'sk-inline' });
        expect(models.client('openai')).toBe(shared);
    });

    it('reports what a ref would need without contacting anything', () => {
        const models = new ModelRegistry();
        const need = models.requirement({ provider: 'google', model: 'gemini-embedding-001' });
        expect(need.kind).toBe('google');
        expect(need.apiKeyEnv).toBe('GEMINI_API_KEY');
    });
});
