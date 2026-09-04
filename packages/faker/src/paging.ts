import { properties, type Declared, type Schema } from './schema.ts';
import type { ParamSpec } from './spec.ts';

// ---------------------------------------------------------------------------
// Pages
//
// A mock that answers `?cursor=X` with `cursor: X` validates against its schema,
// echoes nothing it should not, and still hangs every client that walks it —
// the same class of wrong as the echo rule, and invisible for the same reason.
// Termination is not a property of one response, so no check on one response can
// see it.
//
// What lives here is only the *recognition*: which query parameter turns the
// page and which property carries the token for the next one. The generator
// still mints its own tokens — the host neither signs nor reads them — because
// the alternative is the host guessing the shape of somebody's response body
// and overwriting it, and then the generator is no longer the whole answer.
//
// Names, not conventions: there is no `x-pagination` in any of the three
// dialects, so this is a list of the words the world actually uses, matched
// with the punctuation and case squashed out (`next_cursor`, `nextCursor` and
// `next-cursor` are one word).
// ---------------------------------------------------------------------------

export type PagingStyle = 'cursor' | 'offset';

export interface Paging {
    style: PagingStyle;
    /** the query parameter that turns the page */
    param: string;
    /** the page-size parameter, when the operation takes one */
    size?: string;
    /** the response property carrying the token for the page after this one */
    next?: string;
    /** whether `next` may be set to null */
    nextNullable?: boolean;
    /** whether the object declaring `next` lists it as required */
    nextRequired?: boolean;
    /** a boolean response property — `has_more` and friends */
    more?: string;
    /** the array of things being paged over */
    items?: string;
}

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const CURSOR_PARAMS = new Set([
    'cursor',
    'nextcursor',
    'pagetoken',
    'nextpagetoken',
    'continuationtoken',
    'nexttoken',
    'pagecursor',
    'after',
    'marker',
    'startkey',
]);

const OFFSET_PARAMS = new Set([
    'offset',
    'page',
    'pagenumber',
    'pageindex',
    'start',
    'startindex',
    'skip',
]);

const SIZE_PARAMS = new Set([
    'pagesize',
    'perpage',
    'limit',
    'maxresults',
    'maxitems',
    'count',
    'size',
]);

const NEXT_PROPS = new Set([
    'nextcursor',
    'nextpagetoken',
    'nexttoken',
    'nextoffset',
    'nextpage',
    'nextlink',
    'nexturl',
    'next',
    'cursor',
    'pagetoken',
    'continuationtoken',
    'marker',
]);

const MORE_PROPS = new Set([
    'hasmore',
    'hasnext',
    'hasnextpage',
    'more',
    'islast',
    'islastpage',
    'istruncated',
    'truncated',
]);

const ITEMS_PROPS = new Set([
    'items',
    'results',
    'data',
    'values',
    'records',
    'entries',
    'objects',
    'content',
    'list',
    'edges',
]);

/**
 * The paging shape of an operation, or nothing when it does not page.
 *
 * A page-size parameter on its own is not pagination — plenty of endpoints cap
 * a one-shot list — so a control that turns the page *and* a property that says
 * where the next one is are both required.
 */
export function pagingOf(
    params: readonly ParamSpec[],
    schema: Schema | undefined,
): Paging | undefined {
    if (!schema) {
        return undefined;
    }
    const query = params.filter((p) => p.in === 'query');
    const cursor = query.find((p) => CURSOR_PARAMS.has(squash(p.name)));
    const offset = query.find((p) => OFFSET_PARAMS.has(squash(p.name)) && numeric(p.schema));
    const param = cursor ?? offset;
    if (!param) {
        return undefined;
    }

    const declared = properties(schema);
    const next = declared.find((d) => NEXT_PROPS.has(squash(d.name)));
    const more = declared.find((d) => MORE_PROPS.has(squash(d.name)) && boolish(d.schema));
    if (!next && !more) {
        return undefined;
    }

    return {
        style: cursor ? 'cursor' : 'offset',
        param: param.name,
        size: query.find((p) => SIZE_PARAMS.has(squash(p.name)))?.name,
        next: next?.name,
        nextNullable: next ? nullable(next.schema) : undefined,
        nextRequired: next?.required,
        more: more?.name,
        items: itemsOf(declared),
    };
}

/** The token a body offers for the next page, or nothing when it offers none. */
export function tokenOf(value: unknown, paging: Paging): string | undefined {
    if (!paging.next) {
        return undefined;
    }
    const holder = holderOf(value, paging.next);
    const token = holder?.[paging.next];
    if (token === null || token === undefined || token === '') {
        return undefined;
    }
    return typeof token === 'object' ? JSON.stringify(token) : String(token);
}

/**
 * A last line of defence, for the generator that is already on disk: a body
 * offering the very token it was given is cut back to "no more pages".
 *
 * Deliberately timid. Nothing re-validates a generator's output on the way to
 * the client, so writing `null` into a required, non-nullable property would
 * trade a client that hangs for a mock that lies — and a hang is at least
 * obvious. Where the schema leaves no room, this changes nothing and says so.
 */
export function cutLoop(value: unknown, paging: Paging, sent: string): boolean {
    if (!paging.next || tokenOf(value, paging) !== sent) {
        return false;
    }
    const holder = holderOf(value, paging.next);
    if (!holder) {
        return false;
    }
    if (paging.nextNullable) {
        holder[paging.next] = null;
    } else if (!paging.nextRequired) {
        delete holder[paging.next];
    } else {
        return false;
    }
    const more = paging.more ? holderOf(value, paging.more) : undefined;
    if (more && paging.more) {
        more[paging.more] = false;
    }
    return true;
}

/** The nearest object carrying `name`; a real body nests its envelope. */
function holderOf(value: unknown, name: string): Record<string, unknown> | undefined {
    const seen = new Set<object>();
    let level: unknown[] = [value];

    while (level.length > 0) {
        const next: unknown[] = [];
        for (const node of level) {
            if (typeof node !== 'object' || node === null || seen.has(node)) {
                continue;
            }
            seen.add(node);
            if (Array.isArray(node)) {
                next.push(...node);
                continue;
            }
            const record = node as Record<string, unknown>;
            if (name in record) {
                return record;
            }
            next.push(...Object.values(record));
        }
        level = next;
    }
    return undefined;
}

function itemsOf(declared: readonly Declared[]): string | undefined {
    const named = declared.find((d) => ITEMS_PROPS.has(squash(d.name)) && listish(d.schema));
    return (named ?? declared.find((d) => listish(d.schema)))?.name;
}

const types = (schema: Schema): string[] => {
    const type = schema.type;
    return typeof type === 'string' ? [type] : Array.isArray(type) ? (type as string[]) : [];
};

const numeric = (schema: Schema): boolean =>
    types(schema).some((t) => t === 'integer' || t === 'number');

const boolish = (schema: Schema): boolean => types(schema).includes('boolean');

const listish = (schema: Schema): boolean =>
    types(schema).includes('array') || schema.items !== undefined;

const nullable = (schema: Schema): boolean => types(schema).includes('null');
