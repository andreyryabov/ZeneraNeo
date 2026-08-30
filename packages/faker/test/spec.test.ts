import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Router } from '../src/router.ts';
import { normalize } from '../src/schema.ts';
import { loadSpec, loadSpecs, SpecError } from '../src/spec.ts';
import { Checks } from '../src/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spec = (name: string): string => join(here, 'specs', name);

describe('schema normalisation', () => {
    it('turns `nullable` into a union type', () => {
        const out = normalize({ type: 'string', nullable: true }, 'openapi-3.0');
        expect(out.type).toEqual(['string', 'null']);
        expect(out.nullable).toBeUndefined();
    });

    it('lifts a boolean exclusive bound onto the bound itself', () => {
        const out = normalize(
            { type: 'number', maximum: 100, exclusiveMaximum: true },
            'openapi-3.0',
        );
        expect(out.exclusiveMaximum).toBe(100);
        expect(out.maximum).toBeUndefined();
    });

    it('drops a boolean exclusive bound that says `false`', () => {
        const out = normalize(
            { type: 'number', minimum: 1, exclusiveMinimum: false },
            'swagger-2.0',
        );
        expect(out.minimum).toBe(1);
        expect(out.exclusiveMinimum).toBeUndefined();
    });

    it('leaves 3.1 alone, where those keywords already mean what they say', () => {
        const out = normalize({ type: 'number', exclusiveMaximum: 100 }, 'openapi-3.1');
        expect(out.exclusiveMaximum).toBe(100);
    });

    it('spells a tuple as prefixItems', () => {
        const out = normalize(
            { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
            'swagger-2.0',
        );
        expect(out.prefixItems).toHaveLength(2);
        expect(out.items).toBeUndefined();
    });

    it('renames `definitions` to `$defs`', () => {
        const out = normalize({ definitions: { A: { type: 'string' } } }, 'swagger-2.0');
        expect(out.$defs).toEqual({ A: { type: 'string' } });
        expect(out.definitions).toBeUndefined();
    });

    // Real documents write a JavaScript regex literal here. With the slashes
    // left on, no string can ever match, so the endpoint becomes impossible
    // rather than merely badly specified.
    it('unwraps a regex literal in `pattern`', () => {
        const out = normalize({ type: 'string', pattern: '/^[_a-z0-9-]+$/' }, 'openapi-3.0');
        expect(out.pattern).toBe('^[_a-z0-9-]+$');
    });

    it('keeps a pattern that was already a bare expression', () => {
        const out = normalize({ type: 'string', pattern: '^[a-z]+$' }, 'openapi-3.0');
        expect(out.pattern).toBe('^[a-z]+$');
    });

    it('drops a pattern that will not compile at all', () => {
        const out = normalize({ type: 'string', pattern: '[unterminated' }, 'openapi-3.0');
        expect(out.pattern).toBeUndefined();
    });

    // The one that matters: `dereference` hands back cyclic objects, and a
    // cyclic schema cannot be compiled or printed.
    it('breaks a self-reference into a $ref, so the result can be stringified', () => {
        const user: Record<string, unknown> = { type: 'object', properties: {} };
        (user.properties as Record<string, unknown>).manager = user;

        const out = normalize(user, 'openapi-3.0');
        expect(() => JSON.stringify(out)).not.toThrow();
        expect(JSON.stringify(out)).toContain('#/$defs/');
    });

    it('hoists a schema used twice, rather than repeating it', () => {
        const shared = { type: 'string', format: 'email' };
        const out = normalize(
            { type: 'object', properties: { a: shared, b: shared } },
            'openapi-3.0',
        );
        expect(Object.keys(out.$defs as object)).toHaveLength(1);
    });
});

describe('loading documents', () => {
    it('flattens an OpenAPI 3 document into operations', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        const ids = ops.map((o) => o.operationId).sort();
        expect(ids).toEqual(['createUser', 'getSelf', 'getUserById', 'stopPing']);
    });

    it('merges path-level parameters into every operation on it', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        const get = ops.find((o) => o.operationId === 'getUserById');
        expect(get?.params.map((p) => `${p.in}:${p.name}`).sort()).toEqual([
            'path:user_id',
            'query:verbose',
        ]);
    });

    it('picks the lowest 2xx that carries a JSON body', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        expect(ops.find((o) => o.operationId === 'createUser')?.success.status).toBe(201);
    });

    it('leaves an operation with no JSON body without a schema', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        const ping = ops.find((o) => o.operationId === 'stopPing');
        expect(ping?.success).toEqual({ status: 204 });
    });

    it('reads Swagger 2.0, basePath and inline parameter types included', async () => {
        const ops = await loadSpec(spec('legacy.yaml'));
        expect(ops).toHaveLength(1);
        expect(ops[0].path).toBe('/api/v1/orders/{order_id}');
        const limit = ops[0].params.find((p) => p.name === 'limit');
        expect(limit?.schema.type).toBe('integer');
        expect(limit?.schema.exclusiveMinimum).toBe(1);
    });

    it('says which file it could not read', async () => {
        await expect(loadSpec(spec('nope.yaml'))).rejects.toBeInstanceOf(SpecError);
    });
});

describe('cache keys', () => {
    it('are a function of shape, so two loads agree', async () => {
        const a = await loadSpec(spec('petstore.yaml'));
        const b = await loadSpec(spec('petstore.yaml'));
        expect(a.map((o) => o.key)).toEqual(b.map((o) => o.key));
    });

    it('differ between operations', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        expect(new Set(ops.map((o) => o.key)).size).toBe(ops.length);
    });
});

describe('routing', () => {
    it('prefers a literal segment over a templated one', async () => {
        const router = new Router(await loadSpec(spec('petstore.yaml')));
        expect(router.match('get', '/users/me')?.operation.operationId).toBe('getSelf');
        expect(router.match('get', '/users/12324')?.operation.operationId).toBe('getUserById');
    });

    it('returns the path parameters it matched', async () => {
        const router = new Router(await loadSpec(spec('petstore.yaml')));
        expect(router.match('get', '/users/12324')?.pathParams).toEqual({ user_id: '12324' });
    });

    it('does not match a different depth', async () => {
        const router = new Router(await loadSpec(spec('petstore.yaml')));
        expect(router.match('get', '/users/12324/orders')).toBeUndefined();
    });

    it('reports the methods a known path does have', async () => {
        const router = new Router(await loadSpec(spec('petstore.yaml')));
        expect(router.match('put', '/users')).toBeUndefined();
        expect(router.allowed('/users')).toEqual(['post']);
    });

    it('refuses two documents that define the same route', async () => {
        const ops = await loadSpecs([spec('petstore.yaml'), spec('petstore.yaml')]);
        expect(() => new Router(ops)).toThrow(/declared twice/);
    });
});

describe('request checking', () => {
    it('coerces a path segment, which is always text on the wire', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        const compiled = new Checks().for(ops.find((o) => o.operationId === 'getUserById')!);
        expect(compiled.path({ user_id: '12324' })).toBe(true);
        expect(compiled.path({ user_id: 'nope' })).toBe(false);
    });

    it('accepts a recursive response schema, which means the $ref survived', async () => {
        const ops = await loadSpec(spec('petstore.yaml'));
        const compiled = new Checks().for(ops.find((o) => o.operationId === 'getUserById')!);
        expect(
            compiled.response?.({
                user_id: 1,
                email: 'a@b.com',
                manager: { user_id: 2, email: 'c@d.com' },
            }),
        ).toBe(true);
        expect(compiled.response?.({ user_id: 1 })).toBe(false);
    });
});
