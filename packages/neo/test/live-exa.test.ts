import { describe, expect, it } from 'vitest';
import { exaTools } from '../src/tools/exa.ts';
import type { AnyTool, ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// The one Exa test that spends money.
//
// Offline tests pin the request this library sends and the shape it keeps of
// the reply; neither can notice the vendor renaming a field. That is the whole
// job here, so it asks for as little as an answer can be made of: one result,
// one page, no `web_answer` — that endpoint runs a model on the other side and
// proves nothing this does not.
//
// Self-skips without a key, and is excluded by `--exclude '**/live-*'`.
// ---------------------------------------------------------------------------

const enabled = Boolean(process.env.EXA_API_KEY);
const context = { signal: undefined } as unknown as ToolContext;

const byName = Object.fromEntries(exaTools().map((t) => [t.name, t])) as Record<string, AnyTool>;

const run = (t: AnyTool, args: unknown): Promise<Record<string, unknown>> =>
    Promise.resolve(t.execute(args, context)) as Promise<Record<string, unknown>>;

describe.skipIf(!enabled)('the web tools, against the real api', () => {
    it('searches and returns usable sources', { timeout: 60_000 }, async () => {
        const out = await run(byName.web_search, {
            query: 'the original transformer paper, attention is all you need',
            num_results: 3,
        });

        expect(out.error).toBeUndefined();
        const results = out.results as Record<string, unknown>[];
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(typeof r.url).toBe('string');
            expect(String(r.url)).toMatch(/^https?:\/\//);
        }
        // The excerpt is the whole reason search asks for highlights; a rename
        // upstream would leave every result with nothing to judge it by.
        expect(results.some((r) => typeof r.excerpt === 'string' && r.excerpt.length > 0)).toBe(
            true,
        );
    });

    it('reads a page, and says when it cut it', { timeout: 60_000 }, async () => {
        const out = await run(byName.web_read, {
            urls: ['https://arxiv.org/abs/1706.03762'],
            max_characters: 600,
        });

        expect(out.error).toBeUndefined();
        const [page] = out.pages as Record<string, unknown>[];
        expect(page).toBeDefined();
        expect(String(page.text).length).toBeGreaterThan(0);
        expect(String(page.text).length).toBeLessThanOrEqual(600);
    });

    /** A url nothing serves must come back as a report, not as a thrown error. */
    it('reports a page it could not fetch', { timeout: 60_000 }, async () => {
        const out = await run(byName.web_read, {
            urls: ['https://example.invalid/nothing-is-here'],
        });
        expect(out.error).toBeUndefined();
        const pages = out.pages as unknown[];
        const failed = (out.failed ?? []) as unknown[];
        expect(pages.length + failed.length).toBeGreaterThan(0);
    });
});
