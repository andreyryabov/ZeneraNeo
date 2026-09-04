import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cutLoop, tokenOf, type Paging } from '../src/paging.ts';
import { loadSpec, type Operation } from '../src/spec.ts';

const here = dirname(fileURLToPath(import.meta.url));

const load = async (name: string): Promise<Map<string, Operation>> => {
    const ops = await loadSpec(join(here, 'specs', `${name}.yaml`));
    return new Map(ops.map((o) => [o.operationId, o]));
};

describe('recognising a paged operation', () => {
    it('finds the cursor, the size, the token and the items', async () => {
        const op = (await load('paged')).get('listMachines')!;
        expect(op.paging).toEqual({
            style: 'cursor',
            param: 'cursor',
            size: 'page_size',
            next: 'cursor',
            nextNullable: true,
            nextRequired: false,
            more: 'has_more',
            items: 'results',
        });
    });

    it('reads an offset style, and camelCase, as the same thing', async () => {
        const op = (await load('paged')).get('listEvents')!;
        expect(op.paging?.style).toBe('offset');
        expect(op.paging?.param).toBe('offset');
        expect(op.paging?.size).toBe('limit');
        expect(op.paging?.next).toBe('next_offset');
        expect(op.paging?.more).toBe('hasMore');
        expect(op.paging?.items).toBe('data');
    });

    // A cap on how much comes back is not an invitation to come back.
    it('does not call a bare `limit` pagination', async () => {
        const op = (await load('paged')).get('listTags')!;
        expect(op.paging).toBeUndefined();
    });

    it('leaves an operation with no query controls alone', async () => {
        const op = (await load('petstore')).get('getUserById')!;
        expect(op.paging).toBeUndefined();
    });

    // The identity is what makes a paged operation rebuild once and everything
    // else stay exactly where it is. These two are the keys the released
    // version produces; a change here means somebody's whole cache is cold.
    it('leaves the cache key of an unpaged operation exactly as it was', async () => {
        const ops = await load('petstore');
        expect(ops.get('getUserById')!.key).toBe('b0030957041e70c5');
        expect(ops.get('createUser')!.key).toBe('0345299ea01b3a37');
        expect((await load('paged')).get('listTags')!.key).toBe('16e8fb3f2e92f328');
    });
});

describe('cutting a looping token', () => {
    const paging: Paging = {
        style: 'cursor',
        param: 'cursor',
        next: 'cursor',
        nextNullable: true,
        nextRequired: false,
        more: 'has_more',
        items: 'results',
    };

    it('reads the token out of a nested envelope', () => {
        expect(tokenOf({ page: { cursor: 'abc' } }, paging)).toBe('abc');
        expect(tokenOf({ page: { cursor: null } }, paging)).toBeUndefined();
        expect(tokenOf({ page: {} }, paging)).toBeUndefined();
    });

    it('nulls a token that came straight back, and says the pages ended', () => {
        const body = { results: [], cursor: '8fde793b', has_more: true };
        expect(cutLoop(body, paging, '8fde793b')).toBe(true);
        expect(body).toEqual({ results: [], cursor: null, has_more: false });
    });

    it('leaves a token that advanced alone', () => {
        const body = { results: [], cursor: 'page-2', has_more: true };
        expect(cutLoop(body, paging, 'page-1')).toBe(false);
        expect(body.cursor).toBe('page-2');
    });

    it('drops an optional token that cannot be nulled', () => {
        const optional: Paging = { ...paging, nextNullable: false };
        const body: Record<string, unknown> = { results: [], cursor: 'x' };
        expect(cutLoop(body, optional, 'x')).toBe(true);
        expect('cursor' in body).toBe(false);
    });

    // Nothing re-validates a generator's output on the way out, so a required
    // non-nullable property is left as it is: a hang is better than a lie.
    it('will not break the schema to break the loop', async () => {
        const op = (await load('paged')).get('listEvents')!;
        const body = { data: [], next_offset: 40 };
        expect(cutLoop(body, op.paging!, '40')).toBe(false);
        expect(body.next_offset).toBe(40);
    });
});
