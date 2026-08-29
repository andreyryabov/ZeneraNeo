import { beforeEach, describe, expect, it } from 'vitest';
import { exaTools, type ExaOptions, type FetchLike } from '../src/tools/exa.ts';
import type { AnyTool, ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// The web tools
//
// Every test here replaces `fetch`, so nothing reaches the network and no key
// is needed. What is being checked is the two halves the vendor cannot: the
// request this library decides to send, and what it keeps of what comes back.
// The live half is `test/live-exa.test.ts`.
// ---------------------------------------------------------------------------

interface Call {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

/** A fetch that records what it was asked and answers with what it was given. */
function stub(reply: unknown, init: { status?: number } = {}): { calls: Call[]; fetch: FetchLike } {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, opts) => {
        calls.push({
            url,
            headers: (opts.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(opts.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(reply), {
            status: init.status ?? 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    return { calls, fetch };
}

const context = { signal: undefined } as unknown as ToolContext;

function toolset(opts: ExaOptions): Record<string, AnyTool> {
    return Object.fromEntries(exaTools(opts).map((t) => [t.name, t]));
}

const run = (t: AnyTool, args: unknown): Promise<Record<string, unknown>> =>
    Promise.resolve(t.execute(args, context)) as Promise<Record<string, unknown>>;

describe('the web tools', () => {
    beforeEach(() => {
        delete process.env.EXA_API_KEY;
    });

    it('offers three tools, all in one group', () => {
        const tools = exaTools({ apiKey: 'k' });
        expect(tools.map((t) => t.name)).toEqual(['web_search', 'web_read', 'web_answer']);
        expect(tools.every((t) => t.group === 'exa')).toBe(true);
    });

    describe('web_search', () => {
        it('sends the key, the query and the excerpt request', async () => {
            const { calls, fetch } = stub({ results: [] });
            await run(toolset({ apiKey: 'secret', fetch }).web_search, { query: 'llm scaling' });

            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe('https://api.exa.ai/search');
            expect(calls[0].headers['x-api-key']).toBe('secret');
            expect(calls[0].body).toMatchObject({
                query: 'llm scaling',
                numResults: 8,
                contents: { highlights: true },
            });
        });

        /** Absent arguments must not become nulls the api then validates. */
        it('omits what the model did not say', async () => {
            const { calls, fetch } = stub({ results: [] });
            await run(toolset({ apiKey: 'k', fetch }).web_search, { query: 'q' });
            expect(Object.keys(calls[0].body)).not.toContain('category');
            expect(Object.keys(calls[0].body)).not.toContain('includeDomains');
        });

        it('caps the result count at the ceiling, whatever was asked for', async () => {
            const { calls, fetch } = stub({ results: [] });
            await run(toolset({ apiKey: 'k', fetch }).web_search, { query: 'q', num_results: 500 });
            expect(calls[0].body.numResults).toBe(25);
        });

        it('keeps the source fields and drops the rest', async () => {
            const { fetch } = stub({
                results: [
                    {
                        title: 'A paper',
                        url: 'https://arxiv.org/abs/1',
                        publishedDate: '2024-01-01',
                        author: null,
                        highlights: ['one', 'two'],
                        favicon: 'https://arxiv.org/favicon.ico',
                        entities: [{ type: 'publication' }],
                    },
                ],
                costDollars: { total: 0.007 },
            });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_search, { query: 'q' });

            expect(out.found).toBe(1);
            expect(out.cost_usd).toBe(0.007);
            const [first] = out.results as Record<string, unknown>[];
            expect(first).toEqual({
                title: 'A paper',
                url: 'https://arxiv.org/abs/1',
                published_date: '2024-01-01',
                author: undefined,
                excerpt: 'one … two',
            });
            expect(first).not.toHaveProperty('favicon');
            expect(first).not.toHaveProperty('entities');
        });

        it('refuses an empty query without asking the api', async () => {
            const { calls, fetch } = stub({ results: [] });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_search, { query: '   ' });
            expect(out.error).toBe('query is required');
            expect(calls).toHaveLength(0);
        });
    });

    describe('web_read', () => {
        it('asks for text at the requested size', async () => {
            const { calls, fetch } = stub({ results: [] });
            await run(toolset({ apiKey: 'k', fetch }).web_read, {
                urls: ['https://a.example', 'https://b.example'],
                max_characters: 500,
            });
            expect(calls[0].url).toBe('https://api.exa.ai/contents');
            expect(calls[0].body).toMatchObject({
                urls: ['https://a.example', 'https://b.example'],
                text: { maxCharacters: 500 },
            });
        });

        it('cuts a page at the cap and says that it did', async () => {
            const { fetch } = stub({
                results: [{ url: 'https://a.example', title: 'A', text: 'x'.repeat(100) }],
            });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_read, {
                urls: ['https://a.example'],
                max_characters: 10,
            });
            const [page] = out.pages as Record<string, unknown>[];
            expect(page.text).toBe('x'.repeat(10));
            expect(page.truncated).toBe(true);
        });

        /** One bad url must not lose the pages that did load. */
        it('reports failures alongside the pages that worked', async () => {
            const { fetch } = stub({
                results: [{ url: 'https://a.example', text: 'ok' }],
                statuses: [
                    { id: 'https://a.example', status: 'success' },
                    {
                        id: 'https://b.example',
                        status: 'error',
                        error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
                    },
                ],
            });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_read, {
                urls: ['https://a.example', 'https://b.example'],
            });
            expect(out.pages).toHaveLength(1);
            expect(out.failed).toEqual([
                { url: 'https://b.example', error: 'CRAWL_NOT_FOUND', status: 404 },
            ]);
        });

        it('refuses an empty list without asking the api', async () => {
            const { calls, fetch } = stub({ results: [] });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_read, { urls: [] });
            expect(out.error).toBe('urls is required');
            expect(calls).toHaveLength(0);
        });
    });

    describe('web_answer', () => {
        it('returns the answer and its sources', async () => {
            const { fetch } = stub({
                answer: '$350 billion.',
                citations: [{ title: 'The Guardian', url: 'https://g.example', author: 'D' }],
                costDollars: { total: 0.005 },
            });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_answer, {
                query: 'how much',
            });
            expect(out.answer).toBe('$350 billion.');
            expect(out.sources).toEqual([
                {
                    title: 'The Guardian',
                    url: 'https://g.example',
                    published_date: undefined,
                    author: 'D',
                },
            ]);
            expect(out.cost_usd).toBe(0.005);
        });
    });

    // -----------------------------------------------------------------------
    // Credentials and refusals
    // -----------------------------------------------------------------------

    describe('the credential', () => {
        /**
         * The key is read when a tool runs, not when it is built. A host
         * registers these before it knows whether the machine has a key, and
         * materialises the keyring after.
         */
        it('is read at call time, so a later export still works', async () => {
            const { calls, fetch } = stub({ results: [] });
            const tools = toolset({ fetch });
            process.env.EXA_API_KEY = 'exported-after';
            await run(tools.web_search, { query: 'q' });
            expect(calls[0].headers['x-api-key']).toBe('exported-after');
        });

        it('does not throw when there is none', async () => {
            const { calls, fetch } = stub({ results: [] });
            const out = await run(toolset({ fetch }).web_search, { query: 'q' });
            expect(out.error).toBe('no Exa credential');
            expect(out.hint).toContain('EXA_API_KEY');
            expect(calls).toHaveLength(0);
        });
    });

    describe('a refusal', () => {
        it('carries the vendor words and our advice', async () => {
            const { fetch } = stub(
                { error: 'Invalid API key', tag: 'INVALID_API_KEY' },
                { status: 401 },
            );
            const out = await run(toolset({ apiKey: 'bad', fetch }).web_search, { query: 'q' });
            expect(out.error).toBe('Exa 401: Invalid API key');
            expect(out.hint).toContain('refused');
        });

        it('says plainly when the account is out of credit', async () => {
            const { fetch } = stub(
                { error: 'You have exceeded your credits limit', tag: 'NO_MORE_CREDITS' },
                { status: 402 },
            );
            const out = await run(toolset({ apiKey: 'k', fetch }).web_read, {
                urls: ['https://a.example'],
            });
            expect(out.hint).toContain('out of credit');
        });

        /** A gateway can answer with html; the status is then all there is. */
        it('survives a body that is not json', async () => {
            const fetch: FetchLike = async () =>
                new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' });
            const out = await run(toolset({ apiKey: 'k', fetch }).web_search, { query: 'q' });
            expect(out.error).toContain('502');
            expect(out.hint).toBeUndefined();
        });
    });
});
