import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '../src/model.ts';
import { AnthropicModel } from '../src/models/anthropic.ts';
import { ModelRegistry } from '../src/models/factory.ts';
import { GeminiModel } from '../src/models/gemini.ts';
import { OpenAIModel } from '../src/models/openai-chat.ts';
import { text } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Gateway mode: every provider reached through Bifrost, each in its own
// protocol. Asserted on what reaches `fetch`, because the point is the wire —
// which endpoint, which model name, which key — not the object that was built.
// ---------------------------------------------------------------------------

const GATEWAY = 'https://gw.example';
const VK = 'sk-bf-test';

interface Sent {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
}

const ASK: ModelRequest = { messages: [{ role: 'user', content: [text('hi')] }], tools: [] };

const GEMINI_REPLY = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
};
const ANTHROPIC_REPLY = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
};
const CHAT_REPLY = {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const OPENAI_VECTORS = {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [1, 0] }],
    model: 'x',
    usage: { prompt_tokens: 1, total_tokens: 1 },
};
const GEMINI_VECTORS = { embeddings: [{ values: [1, 0] }] };

/** Records every request and answers each with `reply`. */
function wire(reply: unknown): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({
                url: input instanceof Request ? input.url : String(input),
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
            });
            return new Response(JSON.stringify(reply), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }),
    );
    return sent;
}

beforeEach(() => {
    vi.stubEnv('BIFROST_BASE_URL', `${GATEWAY}/`);
    vi.stubEnv('BIFROST_API_KEY', VK);
    // Vendor credentials are deliberately absent: the gateway key is the only one.
    for (const name of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'VERTEX_API_KEY',
    ]) {
        vi.stubEnv(name, '');
    }
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('gateway mode', () => {
    it('sends a vertex gemini model to /genai, in gemini protocol, as vertex/<id>', async () => {
        const sent = wire(GEMINI_REPLY);
        const model = new ModelRegistry().model('vertex:gemini-3.5-flash');

        expect(model).toBeInstanceOf(GeminiModel);
        expect((await model.generate(ASK)).text).toBe('ok');
        expect(sent[0]!.url).toMatch(
            /^https:\/\/gw\.example\/genai\/v1beta\/models\/vertex\/gemini-3\.5-flash:generateContent/,
        );
        expect(sent[0]!.headers.get('x-goog-api-key')).toBe(VK);
        expect(sent[0]!.headers.get('x-bf-vk')).toBe(VK);
        // The id a config, a trajectory and a memory record stays the vendor's own.
        expect(model.id).toBe('gemini-3.5-flash');
    });

    it('names a google model by bifrost\u2019s word for it', async () => {
        const sent = wire(GEMINI_REPLY);
        await new ModelRegistry().model('google:gemini-3.5-flash').generate(ASK);
        expect(sent[0]!.url).toContain('/genai/v1beta/models/gemini/gemini-3.5-flash:');
    });

    it('sends claude to /anthropic in messages format', async () => {
        const sent = wire(ANTHROPIC_REPLY);
        const model = new ModelRegistry().model('anthropic:claude-haiku-4-5');

        expect(model).toBeInstanceOf(AnthropicModel);
        await model.generate(ASK);
        expect(sent[0]!.url).toBe(`${GATEWAY}/anthropic/v1/messages`);
        expect(sent[0]!.body.model).toBe('anthropic/claude-haiku-4-5');
        expect(sent[0]!.headers.get('x-api-key')).toBe(VK);
    });

    it('sends claude on vertex to /anthropic as vertex/<id>', async () => {
        const sent = wire(ANTHROPIC_REPLY);
        await new ModelRegistry().model('vertex:anthropic/claude-sonnet-4-5').generate(ASK);
        expect(sent[0]!.url).toBe(`${GATEWAY}/anthropic/v1/messages`);
        expect(sent[0]!.body.model).toBe('vertex/claude-sonnet-4-5');
    });

    it('sends openai to /openai with the virtual key as bearer', async () => {
        const sent = wire(CHAT_REPLY);
        const model = new ModelRegistry().model('openai:gpt-5.4-nano');

        expect(model).toBeInstanceOf(OpenAIModel);
        await model.generate(ASK);
        expect(sent[0]!.url).toBe(`${GATEWAY}/openai/chat/completions`);
        expect(sent[0]!.body.model).toBe('openai/gpt-5.4-nano');
        expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${VK}`);
    });

    it('speaks openai for openrouter, so openrouter-only knobs are refused', async () => {
        const sent = wire(CHAT_REPLY);
        const models = new ModelRegistry();

        await models.model('openrouter:anthropic/claude-sonnet-4.5').generate(ASK);
        expect(sent[0]!.body.model).toBe('openrouter/anthropic/claude-sonnet-4.5');
        expect(() =>
            models.model({
                provider: 'openrouter',
                model: 'x/y',
                routing: { order: ['a'] },
            }),
        ).toThrow(/does not read "routing"/);
    });

    it('reroutes a declared provider too, keeping its headers', async () => {
        const sent = wire(CHAT_REPLY);
        const models = new ModelRegistry().provider('vllm', {
            kind: 'openai-compatible',
            baseURL: 'https://vllm.internal/v1',
            apiKey: 'sk-vllm',
            headers: { 'x-team': 'acme' },
        });

        await models.model('vllm:llama-4').generate(ASK);
        expect(sent[0]!.url).toBe(`${GATEWAY}/openai/chat/completions`);
        expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${VK}`);
        expect(sent[0]!.headers.get('x-team')).toBe('acme');
    });

    it('leaves a pre-built client where it is', () => {
        const client = { stub: true } as never;
        const models = new ModelRegistry().provider('stubbed', { kind: 'openai', client });
        expect(models.requirement('stubbed:gpt-4o').gateway).toBeUndefined();
    });

    it('qualifies the embedding model on the wire and nowhere else', async () => {
        const sent = wire(OPENAI_VECTORS);
        const embedder = new ModelRegistry().embedder('openai:text-embedding-3-small');

        await embedder.embed({ input: ['a'], normalize: false });
        expect(sent[0]!.url).toBe(`${GATEWAY}/openai/embeddings`);
        expect(sent[0]!.body.model).toBe('openai/text-embedding-3-small');
        // A memory records this id and refuses another one.
        expect(embedder.id).toBe('text-embedding-3-small');
    });

    it('qualifies a gemini embedding in the url and in each batched request', async () => {
        const sent = wire(GEMINI_VECTORS);
        const embedder = new ModelRegistry().embedder('vertex:gemini-embedding-001');

        await embedder.embed({ input: ['a'], normalize: false });
        expect(sent[0]!.url).toContain('/genai/v1beta/models/vertex/gemini-embedding-001:');
        expect(sent[0]!.body.requests).toEqual([
            expect.objectContaining({ model: 'models/vertex/gemini-embedding-001' }),
        ]);
        expect(embedder.id).toBe('gemini-embedding-001');
    });

    it('asks for the gateway key, not the vendor one', () => {
        const models = new ModelRegistry();
        expect(models.requirement('vertex:gemini-3.5-flash')).toMatchObject({
            apiKeyEnv: 'BIFROST_API_KEY',
            satisfied: true,
            gateway: 'bifrost',
        });

        vi.stubEnv('BIFROST_API_KEY', '');
        expect(models.requirement('openai:gpt-4o').satisfied).toBe(false);
    });

    it('sends no virtual-key header to a gateway that wants none', async () => {
        vi.stubEnv('BIFROST_API_KEY', '');
        const sent = wire(CHAT_REPLY);
        await new ModelRegistry().model('openai:gpt-4o').generate(ASK);
        expect(sent[0]!.headers.get('x-bf-vk')).toBeNull();
    });

    it('changes nothing when no gateway is set', () => {
        vi.stubEnv('BIFROST_BASE_URL', '');
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'zn-project');
        const models = new ModelRegistry();

        expect(models.requirement('vertex:gemini-3.5-flash').gateway).toBeUndefined();
        expect((models.client('vertex') as unknown as { vertexai?: boolean }).vertexai).toBe(true);
    });
});
