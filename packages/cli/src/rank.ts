// ---------------------------------------------------------------------------
// Ranking models
//
// A heuristic read off the id alone, not a benchmark. Vendors name models by
// generation and tier, so both can be parsed and compared without a table
// that goes stale with every release: `gpt-6-sol` outranks `gpt-5.6-sol` the
// day it is listed.
//
// Best first: general models before specialised ones and small tiers last;
// then Anthropic, OpenAI, Google, everyone else; then the newer generation;
// then the higher tier; then the rest of the version.
// ---------------------------------------------------------------------------

export type Maker = 'anthropic' | 'openai' | 'google' | 'other';
export type Tier = 'top' | 'mid' | 'small';

export interface ModelTraits {
    maker: Maker;
    /** `[5, 6]` for `gpt-5.6-sol`; empty when the id carries none */
    version: number[];
    tier: Tier;
    /** built for one job: codex, search, audio, image… */
    special: boolean;
    preview: boolean;
    /** a dated snapshot, as `YYYYMMDD` or the vendor's shorter `MMDD` */
    date?: string;
}

/** What a listing row needs to be ranked: the provider routing it and its id. */
export interface Ranked {
    provider: string;
    id: string;
}

const MAKERS: readonly Maker[] = ['anthropic', 'openai', 'google', 'other'];
const TIERS: readonly Tier[] = ['top', 'mid', 'small'];

const SMALL = new Set(['haiku', 'luna', 'mini', 'nano', 'lite', 'small', 'tiny']);
const TOP = new Set(['opus', 'sol', 'pro', 'ultra', 'argon', 'max']);
const PREVIEW = new Set(['preview', 'exp', 'experimental', 'beta', 'alpha']);
// Not `instruct`: open-weight chat models carry it (`qwen3-…-instruct`) as their general release.
const SPECIAL =
    /codex|search|audio|realtime|image|tts|transcribe|computer-use|embedding|research|(^|-)live(-|$)/;

function makerOf(name: string): Maker {
    if (name.startsWith('claude')) {
        return 'anthropic';
    }
    // Open weights under OpenAI's name, served by others.
    if (name.startsWith('gpt-oss')) {
        return 'other';
    }
    if (/^(gpt|chatgpt|o\d)/.test(name)) {
        return 'openai';
    }
    return name.startsWith('gemini') ? 'google' : 'other';
}

const parts = (text: string): number[] => text.split('.').map(Number);

export function parseModel(id: string): ModelTraits {
    // Routed ids carry their maker (`anthropic/claude-opus-5`) and OpenRouter a variant (`:free`).
    const routed = (id.toLowerCase().split('/').pop() ?? '').replace(/:.*$/, '');
    // Vertex dates Claude with an at sign: `claude-opus-4-5@20251101`.
    const [name = '', at] = routed.split('@');
    const maker = makerOf(name);
    const words = name.split('-');
    const traits: ModelTraits = {
        maker,
        version: [],
        tier: 'mid',
        special: SPECIAL.test(name),
        preview: false,
        ...(at && /^\d{8}$/.test(at) ? { date: at } : {}),
    };

    let ended = false;
    for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        if (/^\d{8}$/.test(word)) {
            traits.date = word;
            continue;
        }
        if (
            /^20\d\d$/.test(word) &&
            /^\d\d$/.test(words[i + 1] ?? '') &&
            /^\d\d$/.test(words[i + 2] ?? '')
        ) {
            traits.date = word + words[i + 1] + words[i + 2];
            i += 2;
            continue;
        }
        // `gpt-4-0613`, `gpt-3.5-turbo-0125`
        if (/^\d{4}$/.test(word) && traits.version.length > 0) {
            traits.date = word;
            continue;
        }
        if (PREVIEW.has(word)) {
            traits.preview = true;
        }
        if (SMALL.has(word)) {
            traits.tier = 'small';
        } else if (TOP.has(word) && traits.tier !== 'small') {
            traits.tier = 'top';
        }

        if (ended) {
            continue;
        }
        // OpenAI's o-series came between GPT-4 and GPT-5.
        const series = i === 0 && maker === 'openai' ? /^o(\d+)$/.exec(word) : null;
        if (series) {
            traits.version = [4, Number(series[1])];
            ended = true;
            continue;
        }
        // `qwen3`, `llama4`: the generation glued to the family name.
        const glued = i === 0 ? /^[a-z]+(\d+(?:\.\d+)*)$/.exec(word) : null;
        if (glued) {
            traits.version = parts(glued[1]!);
            ended = true;
            continue;
        }
        // `5.6`, `4o`, `v3`, or the `4`, `5` of `opus-4-5`; sizes like `120b` are not versions.
        const number = /^v?(\d{1,2}(?:\.\d+)*)o?$/.exec(word);
        if (number) {
            const next = parts(number[1]!);
            traits.version = traits.version.length > 0 ? [...traits.version, next[0]!] : next;
            if (word.endsWith('o')) {
                ended = true;
            }
            continue;
        }
        if (traits.version.length > 0) {
            ended = true;
        }
    }
    return traits;
}

/** The vendor's own endpoint first, then the resellers. */
function routeRank(provider: string, maker: Maker): number {
    if (provider === maker) {
        return 0;
    }
    return provider === 'vertex' ? 1 : provider === 'openrouter' ? 2 : 3;
}

const bucket = (t: ModelTraits): number => (t.tier === 'small' ? 2 : t.special ? 1 : 0);

function compareTraits(a: ModelTraits, b: ModelTraits): number {
    const majorA = a.version[0] ?? -1;
    const majorB = b.version[0] ?? -1;
    return (
        bucket(a) - bucket(b) ||
        MAKERS.indexOf(a.maker) - MAKERS.indexOf(b.maker) ||
        majorB - majorA ||
        TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
        compareRest(b.version, a.version) ||
        Number(a.preview) - Number(b.preview) ||
        // The alias that follows the newest snapshot, then the newest snapshot.
        Number(a.date !== undefined) - Number(b.date !== undefined) ||
        (b.date ?? '').localeCompare(a.date ?? '')
    );
}

function compareRest(a: number[], b: number[]): number {
    for (let i = 1; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/** Best first. Usable as a sort comparator on any listing row. */
export function compareModels(a: Ranked, b: Ranked): number {
    const ta = parseModel(a.id);
    const tb = parseModel(b.id);
    return (
        compareTraits(ta, tb) ||
        routeRank(a.provider, ta.maker) - routeRank(b.provider, tb.maker) ||
        a.id.localeCompare(b.id) ||
        a.provider.localeCompare(b.provider)
    );
}

/** A sorted copy, best first. */
export function rankModels<T extends Ranked>(rows: readonly T[]): T[] {
    return [...rows].sort(compareModels);
}
