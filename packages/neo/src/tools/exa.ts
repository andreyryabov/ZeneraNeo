import { tool, type AnyTool } from '../types.ts';

// ---------------------------------------------------------------------------
// Web tools, backed by Exa
//
// Three things an agent cannot do from a workspace and a shell: find a page it
// does not know the address of, read one, and ask a question of the open web.
// Like every other tool here, none of it is wired in by default — reaching the
// network is a deployment decision, so a host asks for it by calling
// `exaTools` and handing the result to a project.
//
// There is no SDK. The whole surface is three JSON POSTs to one host, and a
// dependency that exists to spell `fetch` differently would be a dependency
// this library has to keep in step with for nothing. What the vendor's client
// would buy — typed requests, retries, a client object — is either provided
// here or deliberately not wanted.
//
// The credential is read at *call* time, not construction. A host registers
// tool groups unconditionally so that config naming `exa:*` resolves, and a
// project on a machine with no key must still load; the failure belongs to the
// call that needed the key, in words the model can act on.
// ---------------------------------------------------------------------------

/** The family name config selects the whole set by: `tools: [exa:*]`. */
export const EXA_GROUP = 'exa';

/** Where the api lives. Exported so a host can probe the same address. */
export const EXA_BASE_URL = 'https://api.exa.ai';

const DEFAULT_BASE_URL = EXA_BASE_URL;
/** The variable the key is read from when the host does not pass one. */
export const EXA_API_KEY_ENV = 'EXA_API_KEY';

const DEFAULT_RESULTS = 8;
/** Exa's own ceiling is 100; a hundred results is a context bill, not an answer. */
const MAX_RESULTS = 25;
/** Per page. Exa refuses anything above 10000. */
const DEFAULT_CHARACTERS = 4000;
const MAX_CHARACTERS = 10_000;
/** What one call may return in total, however many pages it was asked for. */
const MAX_TOTAL_CHARACTERS = 128 * 1024;
/** Pages per `web_read` call. Exa's own limit is 100. */
const MAX_URLS = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ExaOptions {
    /** The key. Falls back to `$EXA_API_KEY`, read when a tool is called. */
    apiKey?: string;
    baseUrl?: string;
    /** How many results `web_search` returns when the model does not say. */
    numResults?: number;
    /** How much of a page `web_read` returns when the model does not say. */
    maxCharacters?: number;
    /** Milliseconds one request may take. */
    timeout?: number;
    /** How requests are made — the seam tests replace. */
    fetch?: FetchLike;
}

/**
 * A failure the model should read rather than one the run should die of.
 * Module-private: it never escapes a tool, which turns it into `{error, hint}`
 * the same way the workspace tools turn a bad patch into one.
 */
class ExaError extends Error {
    readonly hint: string | undefined;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'ExaError';
        this.hint = hint;
    }
}

/**
 * What to say about a refusal, by the vendor's machine-readable tag. The set is
 * open-ended by contract, so an unknown tag falls through to the message Exa
 * sent — which is the one thing that is always about the actual problem.
 */
const HINTS: Record<string, string> = {
    INVALID_API_KEY: `the credential in $${EXA_API_KEY_ENV} was refused`,
    NO_MORE_CREDITS: 'the Exa account is out of credit, so this tool will keep failing',
    API_KEY_BUDGET_EXCEEDED: 'this key has spent its budget, so this tool will keep failing',
    TEAM_BUDGET_EXCEEDED: 'the team has spent its budget, so this tool will keep failing',
    RATE_LIMIT_EXCEEDED: 'wait a moment and try once more',
    INVALID_URLS: 'give whole absolute urls, http:// or https://',
    NO_CONTENT_FOUND: 'try a different page, or search again for another source',
};

interface ErrorEnvelope {
    error?: string;
    tag?: string;
}

class Exa {
    readonly #apiKey: string | undefined;
    readonly #baseUrl: string;
    readonly #timeout: number;
    readonly #fetch: FetchLike;

    constructor(opts: ExaOptions) {
        this.#apiKey = opts.apiKey;
        this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.#timeout = clamp(opts.timeout ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
        this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    }

    /**
     * The environment is read here rather than in the constructor, so a key
     * exported after the tools were built still works — which is exactly what
     * a host materialising a keyring before a run does.
     */
    #key(): string {
        const key = this.#apiKey ?? process.env[EXA_API_KEY_ENV];
        if (!key) {
            throw new ExaError(
                'no Exa credential',
                `set $${EXA_API_KEY_ENV} to a key from https://dashboard.exa.ai/api-keys`,
            );
        }
        return key;
    }

    async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
        const key = this.#key();
        const deadline = AbortSignal.timeout(this.#timeout);
        let res: Response;
        try {
            res = await this.#fetch(`${this.#baseUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key },
                body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            });
        } catch (err) {
            // An abort that came from the caller is the run being cancelled and
            // is not this tool's to describe; one that came from the deadline is.
            if (signal?.aborted) {
                throw err;
            }
            if (deadline.aborted) {
                throw new ExaError(
                    `Exa did not answer within ${Math.round(this.#timeout / 1000)}s`,
                    'try once more, or ask for fewer results',
                );
            }
            throw new ExaError(
                `could not reach Exa: ${err instanceof Error ? err.message : String(err)}`,
                'the network is the problem, not the request',
            );
        }
        if (!res.ok) {
            throw await refusal(res);
        }
        return (await res.json()) as T;
    }
}

/** The vendor's own words about a rejection, with ours about what to do next. */
async function refusal(res: Response): Promise<ExaError> {
    let envelope: ErrorEnvelope = {};
    try {
        envelope = (await res.json()) as ErrorEnvelope;
    } catch {
        // A non-JSON body from a gateway or a proxy; the status is all there is.
    }
    const said = envelope.error ?? res.statusText ?? 'refused';
    const tag = envelope.tag;
    return new ExaError(`Exa ${res.status}: ${said}`, tag ? HINTS[tag] : undefined);
}

// ---------------------------------------------------------------------------
// Shaping what comes back
//
// A raw Exa result carries entity records, favicons, subpages and similarity
// scores. A model asked to pick a source needs a title, an address, a date and
// enough text to judge relevance, and every field beyond that is paid for twice
// — once in tokens and once in the attention spent skipping it.
// ---------------------------------------------------------------------------

interface ExaResult {
    title?: string;
    url: string;
    id?: string;
    publishedDate?: string;
    author?: string | null;
    text?: string;
    highlights?: string[];
    summary?: string;
}

interface CostDollars {
    total?: number;
}

interface SearchResponse {
    results?: ExaResult[];
    costDollars?: CostDollars;
}

interface ContentsStatus {
    id: string;
    status: 'success' | 'error';
    error?: { tag?: string; httpStatusCode?: number | null };
}

interface ContentsResponse {
    results?: ExaResult[];
    statuses?: ContentsStatus[];
    costDollars?: CostDollars;
}

interface AnswerResponse {
    answer?: string | Record<string, unknown>;
    citations?: ExaResult[];
    costDollars?: CostDollars;
}

/**
 * A running character allowance. Text arrives per result, and a cap applied per
 * result alone still lets twenty long pages add up to a context nobody asked
 * for — so the budget is spent across the whole call and says when it ran out.
 */
class Budget {
    #left: number;

    constructor(total: number) {
        this.#left = total;
    }

    take(text: string | undefined, limit: number): { text: string; truncated: boolean } {
        if (!text) {
            return { text: '', truncated: false };
        }
        const allowed = Math.min(limit, this.#left);
        if (allowed <= 0) {
            return { text: '', truncated: true };
        }
        this.#left -= Math.min(text.length, allowed);
        return { text: text.slice(0, allowed), truncated: text.length > allowed };
    }
}

const clamp = (n: number, low: number, high: number): number =>
    Math.min(high, Math.max(low, Math.trunc(n)));

/** `null` and `''` both mean the field was not found; neither is worth a token. */
function pick<T>(value: T | null | undefined): T | undefined {
    return value === null || value === '' ? undefined : (value ?? undefined);
}

function source(r: ExaResult): Record<string, unknown> {
    return {
        title: pick(r.title),
        url: r.url,
        published_date: pick(r.publishedDate),
        author: pick(r.author),
    };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function exaTools<TCtx = unknown>(opts: ExaOptions = {}): AnyTool<TCtx>[] {
    const exa = new Exa(opts);
    const defaultResults = clamp(opts.numResults ?? DEFAULT_RESULTS, 1, MAX_RESULTS);
    const defaultCharacters = clamp(opts.maxCharacters ?? DEFAULT_CHARACTERS, 1, MAX_CHARACTERS);

    /**
     * Every tool here reports a refusal instead of raising one. A search that
     * found nothing, a page that would not load and a key that was rejected are
     * all things the model can respond to — by asking differently, by choosing
     * another source, or by saying plainly that it cannot look. A thrown error
     * ends the run and tells the user what the model should have told them.
     */
    const attempt = async <T>(run: () => Promise<T>): Promise<T | Record<string, unknown>> => {
        try {
            return await run();
        } catch (err) {
            if (err instanceof ExaError) {
                return { error: err.message, hint: err.hint };
            }
            throw err;
        }
    };

    const webSearch = tool<
        {
            query: string;
            num_results?: number;
            include_domains?: string[];
            exclude_domains?: string[];
            start_published_date?: string;
            end_published_date?: string;
            category?: string;
            type?: string;
        },
        TCtx
    >({
        name: 'web_search',
        group: EXA_GROUP,
        description:
            'Searches the live web and returns ranked pages with a short relevant excerpt ' +
            'from each. Written as a description of what is wanted rather than as keywords: ' +
            'the query is read by a model, so "papers arguing that scaling laws break down" ' +
            'works better than "scaling laws paper". Excerpts are for judging which source ' +
            'to trust — read the page with web_read before quoting it.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'What is wanted, in a sentence. Do not use site: or other ' +
                        'search operators; use include_domains instead.',
                },
                num_results: {
                    type: 'integer',
                    description: `How many pages to return. Default ${defaultResults}, at most ${MAX_RESULTS}.`,
                },
                include_domains: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Only return pages from these hosts, e.g. ["arxiv.org", "*.gov.uk"].',
                },
                exclude_domains: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Never return pages from these hosts.',
                },
                start_published_date: {
                    type: 'string',
                    description: 'Only pages published on or after this ISO 8601 date.',
                },
                end_published_date: {
                    type: 'string',
                    description: 'Only pages published on or before this ISO 8601 date.',
                },
                category: {
                    type: 'string',
                    enum: [
                        'company',
                        'publication',
                        'news',
                        'personal site',
                        'financial report',
                        'people',
                    ],
                    description: 'Narrow the search to one kind of page.',
                },
                type: {
                    type: 'string',
                    enum: ['auto', 'fast', 'instant'],
                    description:
                        'Search depth. "auto" is the default and right for most questions; ' +
                        '"fast" and "instant" trade recall for latency.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        execute: ({ query, ...rest }, tc) =>
            attempt(async () => {
                const text = query?.trim();
                if (!text) {
                    return { error: 'query is required' };
                }
                const body = await exa.post<SearchResponse>(
                    '/search',
                    {
                        query: text,
                        numResults: clamp(rest.num_results ?? defaultResults, 1, MAX_RESULTS),
                        includeDomains: pick(rest.include_domains),
                        excludeDomains: pick(rest.exclude_domains),
                        startPublishedDate: pick(rest.start_published_date),
                        endPublishedDate: pick(rest.end_published_date),
                        category: pick(rest.category),
                        type: pick(rest.type),
                        // Highlights are the model-selected sentences that made
                        // the page match, which is what a search result excerpt
                        // is for. Full text is what web_read exists to fetch.
                        contents: { highlights: true },
                    },
                    tc.signal,
                );
                const budget = new Budget(MAX_TOTAL_CHARACTERS);
                const results = (body.results ?? []).map((r) => {
                    const joined = (r.highlights ?? []).join(' … ') || r.summary;
                    const { text: excerpt } = budget.take(joined, defaultCharacters);
                    return { ...source(r), excerpt: pick(excerpt) };
                });
                return {
                    query: text,
                    results,
                    found: results.length,
                    cost_usd: body.costDollars?.total,
                };
            }),
    });

    const webRead = tool<{ urls: string[]; max_characters?: number; max_age_hours?: number }, TCtx>(
        {
            name: 'web_read',
            group: EXA_GROUP,
            description:
                'Fetches the text of web pages, several at once. Returns the readable content ' +
                'with navigation and boilerplate stripped, served from a cache when it is fresh ' +
                'enough and crawled live when it is not. Pages that could not be fetched are ' +
                'reported alongside the ones that were, so a single bad url does not lose the rest.',
            parameters: {
                type: 'object',
                properties: {
                    urls: {
                        type: 'array',
                        items: { type: 'string' },
                        description: `Absolute page urls, at most ${MAX_URLS} of them.`,
                    },
                    max_characters: {
                        type: 'integer',
                        description:
                            `How much of each page to return. Default ${defaultCharacters}, ` +
                            `at most ${MAX_CHARACTERS}. Text is cut at the cap and \`truncated\` ` +
                            'says so.',
                    },
                    max_age_hours: {
                        type: 'integer',
                        description:
                            'How stale a cached copy may be. 0 forces a live fetch, which is ' +
                            'slower; omit it unless the page changes by the hour.',
                    },
                },
                required: ['urls'],
                additionalProperties: false,
            },
            execute: ({ urls, max_characters, max_age_hours }, tc) =>
                attempt(async () => {
                    const wanted = (urls ?? []).map((u) => u?.trim()).filter(Boolean);
                    if (wanted.length === 0) {
                        return {
                            error: 'urls is required',
                            hint: 'give at least one absolute url',
                        };
                    }
                    const limit = clamp(max_characters ?? defaultCharacters, 1, MAX_CHARACTERS);
                    const body = await exa.post<ContentsResponse>(
                        '/contents',
                        {
                            urls: wanted.slice(0, MAX_URLS),
                            text: { maxCharacters: limit },
                            maxAgeHours: pick(max_age_hours),
                        },
                        tc.signal,
                    );

                    const budget = new Budget(MAX_TOTAL_CHARACTERS);
                    const pages = (body.results ?? []).map((r) => {
                        const { text, truncated } = budget.take(r.text, limit);
                        return { ...source(r), text, truncated: truncated || undefined };
                    });
                    const failed = (body.statuses ?? [])
                        .filter((s) => s.status === 'error')
                        .map((s) => ({
                            url: s.id,
                            error: s.error?.tag ?? 'could not be fetched',
                            status: pick(s.error?.httpStatusCode),
                        }));
                    return {
                        pages,
                        failed: failed.length ? failed : undefined,
                        skipped: wanted.length > MAX_URLS ? wanted.slice(MAX_URLS) : undefined,
                        cost_usd: body.costDollars?.total,
                    };
                }),
        },
    );

    const webAnswer = tool<{ query: string; model?: string }, TCtx>({
        name: 'web_answer',
        group: EXA_GROUP,
        description:
            'Asks a question of the open web and returns a written answer with the sources ' +
            'it was drawn from. This runs a search and a model on the other side, so it is ' +
            'slower and more expensive than web_search — reach for it when the question is ' +
            'settled by a fact spread over several pages, not when a specific document is ' +
            'wanted. Cite from the returned sources, never from the answer alone.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The question, in full. Specific questions get direct answers.',
                },
                model: {
                    type: 'string',
                    enum: ['exa', 'exa-fast'],
                    description: '"exa" by default; "exa-fast" answers sooner from fewer sources.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        execute: ({ query, model }, tc) =>
            attempt(async () => {
                const text = query?.trim();
                if (!text) {
                    return { error: 'query is required' };
                }
                const body = await exa.post<AnswerResponse>(
                    '/answer',
                    { query: text, model: pick(model), text: false },
                    tc.signal,
                );
                return {
                    answer: body.answer,
                    sources: (body.citations ?? []).map(source),
                    cost_usd: body.costDollars?.total,
                };
            }),
    });

    return [webSearch, webRead, webAnswer];
}
