import { describe, expect, it } from 'vitest';
import { compareModels, parseModel, rankModels } from '../src/rank.ts';

describe('reading a model id', () => {
    it.each([
        ['claude-opus-5', 'anthropic', [5], 'top'],
        ['claude-opus-4-5-20251101', 'anthropic', [4, 5], 'top'],
        ['claude-opus-4-5@20251101', 'anthropic', [4, 5], 'top'],
        ['claude-sonnet-4.5', 'anthropic', [4, 5], 'mid'],
        ['claude-3-5-sonnet-20241022', 'anthropic', [3, 5], 'mid'],
        ['claude-haiku-5', 'anthropic', [5], 'small'],
        ['gpt-6-sol', 'openai', [6], 'top'],
        ['gpt-5.6-terra', 'openai', [5, 6], 'mid'],
        ['gpt-5.6-luna', 'openai', [5, 6], 'small'],
        ['gpt-4o-mini', 'openai', [4], 'small'],
        ['gpt-4.1-mini', 'openai', [4, 1], 'small'],
        ['chatgpt-4o-latest', 'openai', [4], 'mid'],
        ['o3-pro', 'openai', [4, 3], 'top'],
        ['o4-mini', 'openai', [4, 4], 'small'],
        ['gemini-4-argon', 'google', [4], 'top'],
        ['gemini-3.8-flash', 'google', [3, 8], 'mid'],
        ['gemini-3.5-flash-lite', 'google', [3, 5], 'small'],
        ['gpt-oss-120b-maas', 'other', [], 'mid'],
        ['qwen3-235b-a22b-instruct-2507-maas', 'other', [3], 'mid'],
        ['deepseek-v3.1', 'other', [3, 1], 'mid'],
    ] as const)('%s', (id, maker, version, tier) => {
        expect(parseModel(id)).toMatchObject({ maker, version, tier });
    });

    it('reads past the route and the variant', () => {
        expect(parseModel('anthropic/claude-opus-5')).toMatchObject({
            maker: 'anthropic',
            version: [5],
        });
        expect(parseModel('openai/gpt-6-sol:free')).toMatchObject({
            maker: 'openai',
            version: [6],
        });
    });

    // Numbers after the tier are dates and builds, not a finer version.
    it('stops the version where the name moves on', () => {
        expect(parseModel('gemini-2.5-pro-preview-05-06')).toMatchObject({
            version: [2, 5],
            tier: 'top',
            preview: true,
        });
        expect(parseModel('gemini-2.0-flash-001').version).toEqual([2, 0]);
        expect(parseModel('gpt-4-0613')).toMatchObject({ version: [4], date: '0613' });
        expect(parseModel('gpt-4-turbo-2024-04-09')).toMatchObject({
            version: [4],
            date: '20240409',
        });
    });

    it('marks models built for one job', () => {
        expect(parseModel('gpt-5-codex').special).toBe(true);
        expect(parseModel('gemini-3.8-live').special).toBe(true);
        expect(parseModel('gpt-4o-search-preview').special).toBe(true);
        expect(parseModel('gpt-5.6-sol').special).toBe(false);
    });
});

describe('ranking models', () => {
    const at = (ref: string) => {
        const [provider, ...rest] = ref.split('/');
        return { provider: provider!, id: rest.join('/') };
    };
    const ranked = (refs: string[]) => rankModels(refs.map(at)).map((r) => `${r.provider}/${r.id}`);

    it('puts Anthropic, then OpenAI, then Google, then the rest; small tiers last', () => {
        expect(
            ranked([
                'google/gemini-3.5-flash-lite',
                'openai/gpt-5.6-luna',
                'vertex/qwen3-235b-a22b-instruct-2507-maas',
                'google/gemini-3.8-flash',
                'openai/gpt-5-codex',
                'google/gemini-4-argon',
                'anthropic/claude-haiku-5',
                'openai/gpt-5.6-terra',
                'openai/gpt-6-sol',
                'anthropic/claude-sonnet-4-5',
                'openai/gpt-5.6-sol',
                'anthropic/claude-opus-5',
                'anthropic/claude-sonnet-5',
                'anthropic/claude-opus-4-5',
            ]),
        ).toEqual([
            'anthropic/claude-opus-5',
            'anthropic/claude-sonnet-5',
            'anthropic/claude-opus-4-5',
            'anthropic/claude-sonnet-4-5',
            'openai/gpt-6-sol',
            'openai/gpt-5.6-sol',
            'openai/gpt-5.6-terra',
            'google/gemini-4-argon',
            'google/gemini-3.8-flash',
            'vertex/qwen3-235b-a22b-instruct-2507-maas',
            'openai/gpt-5-codex',
            'anthropic/claude-haiku-5',
            'openai/gpt-5.6-luna',
            'google/gemini-3.5-flash-lite',
        ]);
    });

    // A new generation outranks the old flagship; within one, the tier decides.
    it('weighs the generation before the tier, and the tier before the point release', () => {
        expect(ranked(['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-5'])[0]).toBe(
            'anthropic/claude-sonnet-5',
        );
        expect(ranked(['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5'])[0]).toBe(
            'anthropic/claude-opus-5',
        );
        expect(ranked(['openai/gpt-5.6-sol', 'openai/gpt-5.4-sol'])[0]).toBe('openai/gpt-5.6-sol');
    });

    it('prefers a release to a preview, an alias to a snapshot, and the newest snapshot', () => {
        expect(ranked(['google/gemini-3.8-pro-preview', 'google/gemini-3.8-pro'])[0]).toBe(
            'google/gemini-3.8-pro',
        );
        expect(
            ranked([
                'anthropic/claude-opus-4-5-20250901',
                'anthropic/claude-opus-4-5-20251101',
                'anthropic/claude-opus-4-5',
            ]),
        ).toEqual([
            'anthropic/claude-opus-4-5',
            'anthropic/claude-opus-4-5-20251101',
            'anthropic/claude-opus-4-5-20250901',
        ]);
    });

    it("takes the vendor's own endpoint before a reseller", () => {
        expect(
            ranked([
                'openrouter/anthropic/claude-opus-5',
                'vertex/claude-opus-5',
                'anthropic/claude-opus-5',
            ]),
        ).toEqual([
            'anthropic/claude-opus-5',
            'vertex/claude-opus-5',
            'openrouter/anthropic/claude-opus-5',
        ]);
    });

    it('is a plain comparator', () => {
        expect(compareModels(at('openai/gpt-6-sol'), at('openai/gpt-6-sol'))).toBe(0);
        expect(compareModels(at('openai/gpt-6-sol'), at('google/gemini-4-argon'))).toBeLessThan(0);
    });
});
