import RandExp from 'randexp';
import type { Collection, WorldStore } from './store.ts';

// ---------------------------------------------------------------------------
// What a handler is given
//
// A handler is one TypeScript module per operation, written by a model and run
// in a worker thread. It owns the API's *mechanics* — which collection an
// operation reads, how a query filters it, what a POST writes — and none of its
// *content*. Content lives in the world, and when the world has nothing to say
// yet, the handler asks for it: `ctx.lookup` and `ctx.ensure` read through to an
// agent that makes the missing entities up, consistent with the story and with
// everything already there, and stores them before answering.
//
// That split is why one cached handler serves every story: change the story and
// the world changes, the code does not.
//
// Loaded inside the worker, so: `node:` built-ins, `randexp` and erasable
// TypeScript only.
// ---------------------------------------------------------------------------

export interface HandlerRequest {
    operationId: string;
    method: string;
    /** the template, `/users/{userId}/messages/{id}` */
    path: string;
    pathParams: Record<string, string>;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
    seed: number;
}

/** What a handler may ask the world agent to make up. */
export interface SynthesisRequest {
    collection: string;
    /** the component schema every record must satisfy, e.g. `"Message"` */
    type?: string;
    /** how many to make when no ids are named. Default 5 */
    count?: number;
    /** nothing is made if this many records already match `where` */
    min?: number;
    /** ids that must exist afterwards */
    ids?: (string | number)[];
    /** the property that holds the id. Default `id` */
    idField?: string;
    /** values every new record must carry, e.g. `{ calendarId: 'primary' }` */
    where?: Record<string, unknown>;
    /** what the records are for, in a sentence: the query, the filter, the context */
    hint?: string;
    /** the first read of this collection (and `where`): fill it as the story has it */
    populate?: boolean;
}

export type Synthesize = (request: SynthesisRequest) => Promise<Record<string, unknown>[]>;

/** Where accounts live, and the id of the one the API is called as. */
export const ACCOUNTS = 'accounts';

/**
 * Whether a collection — or the part of it `where` selects — has ever been
 * filled by the world agent. Counting records cannot tell: a mailbox whose
 * only message is the one the client just sent is not an inbox yet.
 */
export function populatedKey(collection: string, where?: Record<string, unknown>): string {
    const pins = Object.keys(where ?? {})
        .sort()
        .map((k) => [k, String(where![k])]);
    return `populated:${collection}:${JSON.stringify(pins)}`;
}
export const OWNER = '@me';

export interface Account {
    id: string;
    email: string;
    displayName?: string;
    [key: string]: unknown;
}

export interface Page<T> {
    items: T[];
    /** the token for the next page, null on the last */
    nextToken: string | null;
    /** the offset of the next page, null on the last */
    nextOffset: number | null;
    hasMore: boolean;
    total: number;
}

export interface PageOptions {
    /** the token a previous page handed out, as the client sent it back */
    token?: unknown;
    /** for offset-style APIs, the offset the client asked for */
    offset?: unknown;
    /** page size the client asked for */
    size?: unknown;
    /** page size when the client did not say. Default 10 */
    defaultSize?: number;
}

export interface HandlerContext {
    /** the shared world: `ctx.db.collection('messages').get(id)` */
    db: { collection<T = Record<string, unknown>>(name: string): Collection<T> };
    /** a record by id, made up by the world agent if the world does not have it */
    lookup<T = Record<string, unknown>>(
        collection: string,
        id: string | number,
        options?: Omit<SynthesisRequest, 'collection' | 'ids' | 'count'>,
    ): Promise<T>;
    /**
     * Every record in a collection, after making sure there are at least
     * `min` (default 1) matching `where`. The way a list endpoint starts.
     */
    ensure<T = Record<string, unknown>>(
        collection: string,
        options?: Omit<SynthesisRequest, 'collection' | 'ids'>,
    ): Promise<T[]>;
    /** asks the world agent for new records directly; they are stored before this returns */
    synthesize: Synthesize;
    /**
     * The account this API is called as — the person `me`, `primary` and
     * `self` stand for. Made once, from the story, and shared by every API.
     */
    owner(): Promise<Account>;
    /** a page of `items` with a token or offset that always advances and always ends */
    page<T>(items: readonly T[], options?: PageOptions): Page<T>;
    /** answers with an HTTP error instead of the success body */
    fail(status: number, body?: unknown): never;
    /** a string matching a regular expression, e.g. a schema `pattern` */
    fromPattern(pattern: string): string;
    /** a fresh id: hex by default, or matching `pattern` when given */
    newId(pattern?: string): string;
    /** seeded randomness, so one request answers the same way twice under `--seed` */
    random(): number;
    int(min: number, max: number): number;
    pick<T>(items: readonly T[]): T;
    /** the current time as RFC 3339 */
    now(): string;
}

export class HttpError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body?: unknown) {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.body = body ?? { error: `HTTP ${status}` };
    }
}

export function createContext(
    input: HandlerRequest,
    store: WorldStore,
    synthesize: Synthesize,
): HandlerContext {
    const random = mulberry32(input.seed || 1);
    const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
    const fromPattern = (pattern: string): string => {
        const gen = new RandExp(stripSlashes(pattern));
        gen.max = 8;
        gen.randInt = int;
        return gen.gen();
    };

    const ctx: HandlerContext = {
        db: { collection: (name) => store.collection(name) },
        async lookup(collection, id, options = {}) {
            const col = store.collection(collection);
            const found = col.get(id);
            if (found !== undefined) {
                return found as never;
            }
            await synthesize({ ...options, collection, ids: [id] });
            const made = col.get(id);
            if (made === undefined) {
                throw new Error(`the world agent did not create ${collection}/${String(id)}`);
            }
            return made as never;
        },
        async ensure(collection, options = {}) {
            const min = options.min ?? 1;
            const col = store.collection(collection);
            const matching = (): Record<string, unknown>[] =>
                col.all().filter((r) => matches(r, options.where));
            const have = matching().length;
            const populate = !store.getMeta(populatedKey(collection, options.where));
            if (populate || have < min) {
                await synthesize({
                    ...options,
                    collection,
                    min,
                    populate,
                    count: options.count ?? (populate ? Math.max(min, 8) : Math.max(min - have, 5)),
                });
            }
            return matching() as never;
        },
        synthesize,
        owner: () =>
            ctx.lookup<Account>(ACCOUNTS, OWNER, {
                hint: 'the person whose mailbox, calendar and data this API serves',
            }),
        page: (items, options = {}) => page(items, options),
        fail(status, body) {
            throw new HttpError(status, body);
        },
        fromPattern,
        newId: (pattern) =>
            pattern
                ? fromPattern(pattern)
                : Array.from({ length: 16 }, () => int(0, 15).toString(16)).join(''),
        random,
        int,
        pick: (items) => items[int(0, items.length - 1)]!,
        now: () => new Date().toISOString(),
    };
    return ctx;
}

/** Every key in `where` present on the record with an equal value, compared as text. */
export function matches(record: Record<string, unknown>, where?: Record<string, unknown>): boolean {
    if (!where) {
        return true;
    }
    return Object.entries(where).every(([k, v]) => String(record[k]) === String(v));
}

/**
 * The one paging rule, written once rather than by every handler: the token is
 * the next offset, it strictly advances, and it is absent on the last page. A
 * token that cannot be read is the end of the list, never the start of it.
 */
export function page<T>(items: readonly T[], options: PageOptions): Page<T> {
    const size = clampSize(options.size, options.defaultSize ?? 10);
    let start = 0;
    if (options.token !== undefined && options.token !== null && options.token !== '') {
        const decoded = decodeToken(String(options.token));
        start = decoded === undefined ? items.length : decoded;
    } else if (options.offset !== undefined && options.offset !== null && options.offset !== '') {
        const n = Number(options.offset);
        start = Number.isFinite(n) && n >= 0 ? Math.floor(n) : items.length;
    }
    start = Math.min(start, items.length);
    const end = Math.min(start + size, items.length);
    const hasMore = end < items.length;
    return {
        items: items.slice(start, end),
        nextToken: hasMore ? encodeToken(end) : null,
        nextOffset: hasMore ? end : null,
        hasMore,
        total: items.length,
    };
}

function clampSize(asked: unknown, fallback: number): number {
    const n = Number(asked);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 500) : fallback;
}

const encodeToken = (offset: number): string =>
    Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeToken(token: string): number | undefined {
    try {
        const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
            o?: unknown;
        };
        return typeof parsed.o === 'number' && parsed.o >= 0 ? parsed.o : undefined;
    } catch {
        return undefined;
    }
}

/** Some documents write a pattern as a JavaScript literal, slashes and all. */
const stripSlashes = (pattern: string): string => {
    const m = /^\/(.*)\/[a-z]*$/.exec(pattern);
    return m ? m[1]! : pattern;
};

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
