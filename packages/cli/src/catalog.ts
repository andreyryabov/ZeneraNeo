// ---------------------------------------------------------------------------
// The catalog
//
// What each provider will actually serve this machine, asked of the provider
// itself and remembered on disk.
//
// Note what is *not* here: any judgement about which model is good. The lists
// below are ordered by how likely a call is to succeed and how little it costs
// to find out, not by quality — a recovery path, not a recommender. The moment
// a file like this starts ranking intelligence it becomes a thing that has to
// be argued about every quarter, and the argument is not what anyone came for.
//
// Nor is there a single hard-coded table of every model. Vendors ship models
// faster than a release cycle, so the shipped table is a *fallback* and the
// answer is whatever the vendor said this morning. Every row carries its own
// `source` for exactly that reason: a curated guess must never be mistaken for
// the vendor's own word.
// ---------------------------------------------------------------------------

import { join } from 'node:path';

import { ModelRegistry } from '@zenera/neo';

import { paths, readJson, writeJson } from './home.ts';
import { PROVIDERS, type KeyCheck, type Provider } from './keys.ts';
import { classify } from './liveness.ts';

/**
 * What a model is *for*. A model can hold more than one — Gemini's embedding
 * endpoint and its chat endpoint are the same catalog row on some providers —
 * so this is a set rather than a field.
 */
export type Role = 'chat' | 'embedding' | 'image' | 'audio';

export interface CatalogEntry {
    /** `provider:id` — paste-able straight into `agents.yaml` */
    ref: string;
    /** the id that goes on the wire, with any resource prefix already stripped */
    id: string;
    provider: Provider;
    roles: Role[];
    name?: string;
    description?: string;
    /** total tokens the model will accept in one request */
    contextLength?: number;
    maxOutputTokens?: number;
    /** embeddings only, when the vendor publishes it */
    dimensions?: number;
    modalities?: { input?: string[]; output?: string[] };
    supports?: { tools?: boolean; reasoning?: boolean; vision?: boolean };
    /** USD per token, as the vendor writes it — strings, because they are tiny */
    pricing?: { prompt?: string; completion?: string; free?: boolean };
    /** ISO date the model was published, when known */
    created?: string;
    source: 'live' | 'curated';
}

/** A provider's listing, and an honest account of where it came from. */
export interface Catalog {
    provider: Provider;
    entries: CatalogEntry[];
    /** `live` asked just now; `cache` a fresh file; `stale` an expired one; `curated` the fallback */
    origin: 'live' | 'cache' | 'stale' | 'curated';
    /** when the entries were actually fetched, not when they were read */
    fetchedAt: string;
    /** why the live call was not used, when it was tried and failed */
    problem?: KeyCheck;
}

/** A day. Model lists change on the scale of weeks; a stale row costs a retry. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const CACHE_VERSION = 1;

interface CacheFile {
    version: number;
    provider: Provider;
    fetchedAt: string;
    entries: CatalogEntry[];
}

// ---------------------------------------------------------------------------
// The fallback table
// ---------------------------------------------------------------------------

/**
 * Enough to work with when the provider cannot be asked — offline, no
 * credential, or a listing endpoint that is down. Deliberately short: this is
 * the set worth typing, not the set that exists.
 *
 * Anthropic publishes no embeddings API at all, which is why it has no
 * embedding row here and why the registry throws rather than guessing.
 */
export const CURATED: Record<
    Provider,
    readonly Omit<CatalogEntry, 'ref' | 'provider' | 'source'>[]
> = {
    openai: [
        { id: 'gpt-4o-mini', roles: ['chat'], contextLength: 128_000 },
        { id: 'gpt-4o', roles: ['chat'], contextLength: 128_000 },
        { id: 'text-embedding-3-small', roles: ['embedding'], dimensions: 1536 },
        { id: 'text-embedding-3-large', roles: ['embedding'], dimensions: 3072 },
    ],
    anthropic: [
        { id: 'claude-haiku-4-5', roles: ['chat'], contextLength: 200_000 },
        { id: 'claude-sonnet-4-5', roles: ['chat'], contextLength: 200_000 },
    ],
    google: [
        { id: 'gemini-2.5-flash', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-2.5-pro', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-embedding-001', roles: ['embedding'], dimensions: 3072 },
    ],
    vertex: [
        { id: 'gemini-2.5-flash', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-2.5-pro', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-embedding-001', roles: ['embedding'], dimensions: 3072 },
        { id: 'text-embedding-005', roles: ['embedding'], dimensions: 768 },
    ],
    openrouter: [
        { id: 'openai/gpt-4o-mini', roles: ['chat'] },
        { id: 'anthropic/claude-haiku-4.5', roles: ['chat'] },
        { id: 'openai/text-embedding-3-small', roles: ['embedding'], dimensions: 1536 },
    ],
};

/**
 * The order `zen models pick` walks, per provider and per role.
 *
 * Cheap and fast first. `pick` exists to answer "give me something that works"
 * in one round trip where it can, and the small models answer soonest and cost
 * least when the answer is thrown away — which it always is.
 */
export const PREFERRED: Record<
    Provider,
    { chat: readonly string[]; embedding: readonly string[] }
> = {
    openai: {
        chat: ['gpt-4o-mini', 'gpt-4o'],
        embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    },
    anthropic: {
        chat: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
        embedding: [],
    },
    google: {
        chat: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        embedding: ['gemini-embedding-001'],
    },
    vertex: {
        chat: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        embedding: ['text-embedding-005', 'gemini-embedding-001'],
    },
    openrouter: {
        chat: ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5'],
        embedding: ['openai/text-embedding-3-small'],
    },
};

function curated(provider: Provider): CatalogEntry[] {
    return CURATED[provider].map((entry) => ({
        ...entry,
        ref: `${provider}:${entry.id}`,
        provider,
        source: 'curated' as const,
    }));
}

// ---------------------------------------------------------------------------
// Vendor adapters
//
// Each takes the client `ModelRegistry` already built — never a direct SDK
// import — so a missing optional dependency surfaces as the library's own
// "run: npm i openai" rather than a stack trace from this file.
//
// The SDK types are described structurally and locally. Four vendors' generated
// types would drag half of `zod` into a module whose whole job is to produce
// one flat row shape, and every field here is one the wire format has carried
// unchanged for years.
// ---------------------------------------------------------------------------

const iso = (value: number | string | undefined | null): string | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }
    // OpenAI and OpenRouter both say unix seconds; Anthropic says a timestamp.
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

/** Drops empty optionals so a cached row does not carry a dozen `undefined`s. */
function entry(
    provider: Provider,
    row: Omit<CatalogEntry, 'ref' | 'provider' | 'source'>,
): CatalogEntry {
    const clean = Object.fromEntries(
        Object.entries(row).filter(([, v]) => v !== undefined && v !== null),
    ) as Omit<CatalogEntry, 'ref' | 'provider' | 'source'>;
    return { ...clean, ref: `${provider}:${row.id}`, provider, source: 'live' };
}

interface OpenAIClient {
    models: { list(): Promise<AsyncIterable<{ id: string; created?: number }>> };
}

/**
 * OpenAI's listing is three fields — id, created, owner — so the role has to be
 * read off the id. Wrong on an id nobody has seen before, which is why the
 * curated table is merged over the top and why `test` asks the model itself.
 */
function openaiRole(id: string): Role | undefined {
    if (/moderation/.test(id)) {
        return undefined; // not reachable through any interface this CLI has
    }
    if (/embedding/.test(id)) {
        return 'embedding';
    }
    // `dall-e-3`, `gpt-image-1` and `chatgpt-image-latest` share only the word.
    if (/^dall-e|image/.test(id)) {
        return 'image';
    }
    if (/(whisper|tts|transcribe|realtime|audio)/.test(id)) {
        return 'audio';
    }
    return 'chat';
}

async function fromOpenAI(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const page = await (client as OpenAIClient).models.list();
    const rows: CatalogEntry[] = [];
    for await (const model of page) {
        const role = openaiRole(model.id);
        if (role) {
            rows.push(
                entry(provider, { id: model.id, roles: [role], created: iso(model.created) }),
            );
        }
    }
    return rows;
}

interface AnthropicClient {
    models: {
        list(params: {
            limit: number;
        }): Promise<AsyncIterable<{ id: string; display_name?: string; created_at?: string }>>;
    };
}

async function fromAnthropic(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const page = await (client as AnthropicClient).models.list({ limit: 1000 });
    const rows: CatalogEntry[] = [];
    for await (const model of page) {
        // Every model Anthropic lists is a chat model. Emitting an embedding
        // row would be inventing an endpoint that does not exist.
        rows.push(
            entry(provider, {
                id: model.id,
                roles: ['chat'],
                name: model.display_name,
                created: iso(model.created_at),
            }),
        );
    }
    return rows;
}

interface GenAIClient {
    models: {
        list(params: { config: { queryBase: boolean; pageSize: number } }): Promise<
            AsyncIterable<{
                name?: string;
                displayName?: string;
                description?: string;
                inputTokenLimit?: number;
                outputTokenLimit?: number;
                supportedActions?: string[];
            }>
        >;
    };
}

/**
 * Google returns resource names — `models/gemini-2.5-flash`, or under Vertex
 * `publishers/google/models/…`. The native API takes the bare tail, and the
 * bare tail is what a ref has to hold, so the prefix comes off here.
 */
const bareId = (name: string): string => name.split('/').pop() ?? name;

/**
 * Vertex lists the whole Model Garden — `alphafold3-request`, `bart-large-cnn`,
 * `automl-e2e` — alongside the models the GenAI API will actually serve. The
 * garden rows are deployment recipes, not model ids: they carry no
 * `supportedActions` and no token limits, and asking one of them a question
 * fails in a way no error message explains.
 *
 * So a row with no declared actions has to earn its place on the id. Generous
 * on purpose — a new `gemini-4` must not need a release here — and it only
 * applies where the backend told us nothing.
 */
const GENERATIVE =
    /^(gemini|gemma|imagen|veo|text-embedding|text-multilingual|multimodalembedding|embedding)/;

async function fromGenAI(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    // `queryBase: true` is not optional: without it the SDK lists *tuned*
    // models, and an account with none looks like an account with no models —
    // which is precisely the confusion this command exists to end.
    const pager = await (client as GenAIClient).models.list({
        config: { queryBase: true, pageSize: 200 },
    });
    const rows: CatalogEntry[] = [];
    for await (const model of pager) {
        if (!model.name) {
            continue;
        }
        const id = bareId(model.name);
        const actions = model.supportedActions ?? [];
        const roles: Role[] = [];
        if (actions.includes('embedContent')) {
            roles.push('embedding');
        }
        if (actions.includes('generateContent') || actions.includes('streamGenerateContent')) {
            roles.push('chat');
        }
        if (actions.includes('predict') && /image|imagen/.test(id)) {
            roles.push('image');
        }
        if (roles.length === 0) {
            if (!GENERATIVE.test(id)) {
                continue;
            }
            roles.push(/embedding/.test(id) ? 'embedding' : 'chat');
        }
        rows.push(
            entry(provider, {
                id,
                roles,
                name: model.displayName,
                description: model.description,
                contextLength: model.inputTokenLimit,
                maxOutputTokens: model.outputTokenLimit,
            }),
        );
    }
    return rows;
}

interface RouterModel {
    id: string;
    name?: string;
    description?: string;
    contextLength?: number | null;
    created?: number;
    architecture?: {
        inputModalities?: string[];
        outputModalities?: string[];
    };
    pricing?: { prompt?: string; completion?: string };
    supportedParameters?: string[];
    topProvider?: { maxCompletionTokens?: number | null };
}

interface RouterPage {
    result?: { data?: RouterModel[] };
}

interface RouterClient {
    models: { list(): Promise<AsyncIterable<RouterPage>> };
    embeddings: { listModels(): Promise<AsyncIterable<RouterPage>> };
}

function routerRow(provider: Provider, model: RouterModel, roles: Role[]): CatalogEntry {
    const input = model.architecture?.inputModalities ?? [];
    const params = model.supportedParameters ?? [];
    const prompt = model.pricing?.prompt;
    return entry(provider, {
        id: model.id,
        roles,
        name: model.name,
        description: model.description,
        contextLength: model.contextLength ?? undefined,
        maxOutputTokens: model.topProvider?.maxCompletionTokens ?? undefined,
        modalities: {
            input,
            output: model.architecture?.outputModalities ?? [],
        },
        supports: {
            tools: params.includes('tools'),
            reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
            vision: input.includes('image'),
        },
        pricing: {
            prompt,
            completion: model.pricing?.completion,
            // OpenRouter writes a free model's price as the string "0".
            free: prompt !== undefined && Number(prompt) === 0,
        },
        created: iso(model.created),
    });
}

async function walk(pages: AsyncIterable<RouterPage>): Promise<RouterModel[]> {
    const all: RouterModel[] = [];
    for await (const page of pages) {
        all.push(...(page.result?.data ?? []));
    }
    return all;
}

async function fromRouter(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const router = client as RouterClient;
    // Two endpoints, because OpenRouter routes embeddings separately and the
    // chat listing does not mention them. Asked together: one slow provider
    // should not cost twice the wall clock.
    //
    // Only the chat listing is allowed to fail the whole call. The embeddings
    // endpoint is the newer of the two and the one a gateway is most likely not
    // to proxy, and losing every chat model over it would be a poor trade.
    const [chat, embedding] = await Promise.all([
        walk(await router.models.list()),
        (async () => {
            try {
                return await walk(await router.embeddings.listModels());
            } catch {
                return [] as RouterModel[];
            }
        })(),
    ]);
    const rows = chat.map((m) => routerRow(provider, m, ['chat']));
    const seen = new Set(rows.map((r) => r.id));
    for (const m of embedding) {
        if (!seen.has(m.id)) {
            rows.push(routerRow(provider, m, ['embedding']));
        }
    }
    return rows;
}

/**
 * Asks one provider what it serves. Throws whatever the SDK throws.
 *
 * `client` is a seam, not a feature: the four adapters are the part most likely
 * to break when a vendor reshapes a payload, and they are untestable if the
 * only way to reach them is a credential and a network. It mirrors
 * `ProviderSpec.client`, which exists in the library for the same reason.
 */
export async function fetchCatalog(
    provider: Provider,
    client: unknown = new ModelRegistry().client(provider),
): Promise<CatalogEntry[]> {
    switch (provider) {
        case 'openai':
            return enrich(provider, await fromOpenAI(client, provider));
        case 'anthropic':
            return enrich(provider, await fromAnthropic(client, provider));
        case 'google':
        case 'vertex':
            return enrich(provider, await fromGenAI(client, provider));
        case 'openrouter':
            return enrich(provider, await fromRouter(client, provider));
    }
}

// ---------------------------------------------------------------------------
// Enrichment and cache
// ---------------------------------------------------------------------------

/**
 * A live row wins on every field it filled in, and the curated table supplies
 * the rest. That is how `text-embedding-3-small` gets its width from here while
 * still being reported as the vendor's own row: OpenAI's listing carries no
 * dimensions field at all, and a blank there would send someone to the docs.
 */
function enrich(provider: Provider, live: CatalogEntry[]): CatalogEntry[] {
    const known = new Map(CURATED[provider].map((c) => [c.id, c]));
    return live.map((row) => {
        const extra = known.get(row.id);
        if (!extra) {
            return row;
        }
        return {
            ...row,
            roles: row.roles.length > 0 ? row.roles : [...extra.roles],
            contextLength: row.contextLength ?? extra.contextLength,
            dimensions: row.dimensions ?? extra.dimensions,
        };
    });
}

const cachePath = (provider: Provider): string => join(paths.catalog(), `${provider}.json`);

async function readCache(provider: Provider): Promise<CacheFile | undefined> {
    const file = await readJson<CacheFile | undefined>(cachePath(provider), undefined);
    return file?.version === CACHE_VERSION && Array.isArray(file.entries) ? file : undefined;
}

export interface CatalogOptions {
    /** ignore a fresh cache and ask the provider again */
    refresh?: boolean;
    /** do not make a network call at all — cache, however old, then curated */
    offline?: boolean;
}

/**
 * The listing for one provider, from the cheapest source that can answer.
 *
 * Fresh cache, else the provider, else a *stale* cache, else the curated table.
 * Stale-before-curated is the important ordering: yesterday's real answer from
 * this account beats today's guess about accounts in general, and a listing
 * that failed because the wifi dropped should not silently shrink someone's
 * model list to four rows.
 */
export async function loadCatalog(provider: Provider, opts: CatalogOptions = {}): Promise<Catalog> {
    const cached = await readCache(provider);
    const fresh =
        cached && Date.now() - new Date(cached.fetchedAt).getTime() < CATALOG_TTL_MS
            ? cached
            : undefined;

    if (fresh && !opts.refresh) {
        return { provider, entries: fresh.entries, origin: 'cache', fetchedAt: fresh.fetchedAt };
    }
    if (!opts.offline) {
        try {
            const entries = await fetchCatalog(provider);
            const fetchedAt = new Date().toISOString();
            writeJson(
                cachePath(provider),
                { version: CACHE_VERSION, provider, fetchedAt, entries } satisfies CacheFile,
                // Public data, and readable so a human can look at what was cached.
                0o644,
            );
            return { provider, entries, origin: 'live', fetchedAt };
        } catch (err) {
            const problem = classify(err);
            if (cached) {
                return {
                    provider,
                    entries: cached.entries,
                    origin: 'stale',
                    fetchedAt: cached.fetchedAt,
                    problem,
                };
            }
            return {
                provider,
                entries: curated(provider),
                origin: 'curated',
                fetchedAt: new Date(0).toISOString(),
                problem,
            };
        }
    }
    if (cached) {
        return { provider, entries: cached.entries, origin: 'stale', fetchedAt: cached.fetchedAt };
    }
    return {
        provider,
        entries: curated(provider),
        origin: 'curated',
        fetchedAt: new Date(0).toISOString(),
    };
}

/** Every provider asked at once — they are independent and mostly latency. */
export async function loadCatalogs(
    providers: readonly Provider[],
    opts: CatalogOptions = {},
): Promise<Catalog[]> {
    return Promise.all(providers.map((p) => loadCatalog(p, opts)));
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

export interface Filters {
    roles?: readonly Role[];
    tools?: boolean;
    vision?: boolean;
    free?: boolean;
    minContext?: number;
}

export function matches(row: CatalogEntry, query: string, filters: Filters = {}): boolean {
    if (filters.roles?.length && !filters.roles.some((r) => row.roles.includes(r))) {
        return false;
    }
    if (filters.tools && !row.supports?.tools) {
        return false;
    }
    if (filters.vision && !row.supports?.vision) {
        return false;
    }
    if (filters.free && !row.pricing?.free) {
        return false;
    }
    if (filters.minContext !== undefined && (row.contextLength ?? 0) < filters.minContext) {
        return false;
    }
    if (!query) {
        return true;
    }
    // Every whitespace-separated word must appear somewhere, so `claude haiku`
    // narrows rather than widening the way an OR would.
    const haystack = `${row.ref} ${row.name ?? ''} ${row.description ?? ''}`.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => haystack.includes(word));
}

/** The providers a search covers when none was named. */
export const catalogProviders = (): readonly Provider[] => PROVIDERS;
