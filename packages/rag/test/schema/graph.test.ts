import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraph, methodId, paramId, propertyId, typeId } from '../../src/schema/graph.ts';
import { loadSpecs } from '../../src/schema/spec.ts';
import { stitch } from '../../src/schema/subgraph.ts';
import { Printer } from '../../src/schema/typescript.ts';

// ---------------------------------------------------------------------------
// Specs, and the graph they become
//
// The assertions worth having here are the ones a shape check cannot make:
// that a component keeps its *name* (the faker's dereferencing loses it and
// that is why this package has its own loader), that a type used both ways is
// marked `both` rather than whichever side was read last, and that a document
// which refers to itself terminates.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`../specs/${name}`, import.meta.url));

const PETSTORE = spec('petstore.yaml');
const BILLING = spec('billing.json');

const corpus = await loadSpecs([PETSTORE]);
const built = buildGraph(corpus);

describe('loading a document', () => {
    it('keeps component names instead of inlining them', () => {
        expect(Object.keys(corpus.types)).toContain('ResetPasswordPayload');
        expect(corpus.types.PublicUserProfile).toBeDefined();
    });

    it('leaves an internal $ref standing, pointed at the settled id', () => {
        const body = corpus.operations.find((o) => o.operationId === 'resetPassword')?.requestBody;
        expect(body?.schema).toEqual({ $ref: '#/$defs/ResetPasswordPayload' });
    });

    it('reads path and query parameters, and marks a path one required', () => {
        const list = corpus.operations.find((o) => o.operationId === 'listPets');
        expect(list?.params.map((p) => `${p.in}:${p.name}`)).toEqual([
            'query:page_size',
            'query:species',
        ]);
        const user = corpus.operations.find((o) => o.operationId === 'getUser');
        expect(user?.params[0]).toMatchObject({ name: 'userId', in: 'path', required: true });
    });

    it('takes only the responses that carry a body', () => {
        const reset = corpus.operations.find((o) => o.operationId === 'resetPassword');
        expect(reset?.responses.map((r) => r.status)).toEqual([200]);
    });

    it('unwraps a JavaScript regex literal written as a pattern', () => {
        const address = corpus.types.Address as { properties: { postcode: { pattern: string } } };
        expect(address.properties.postcode.pattern).toBe('^[0-9]{4}$');
    });
});

describe('swagger 2.0', () => {
    it('prefixes basePath, lifts the body parameter and converts Draft-4 bounds', async () => {
        const old = await loadSpecs([BILLING]);
        const create = old.operations.find((o) => o.operationId === 'createInvoice');

        expect(create?.path).toBe('/v1/invoices');
        expect(create?.requestBody?.schema).toEqual({ $ref: '#/$defs/Invoice' });
        // The body parameter became the request body; the path-level header stays.
        expect(create?.params.map((p) => p.name)).toEqual(['X-Tenant']);
        expect(old.types.Invoice).toMatchObject({
            properties: { total: { exclusiveMinimum: 0 } },
        });
    });

    it('merges the path-level parameter into every method on that path', async () => {
        const old = await loadSpecs([BILLING]);
        const list = old.operations.find((o) => o.operationId === 'listInvoices');
        expect(list?.params.map((p) => p.name)).toEqual(['X-Tenant', 'cursor']);
    });
});

describe('two documents at once', () => {
    it('qualifies only the names that actually collide', async () => {
        const both = await loadSpecs([PETSTORE, BILLING]);

        expect(both.types['petstore.Address']).toBeDefined();
        expect(both.types['billing.Address']).toBeDefined();
        expect(both.types.Address).toBeUndefined();
        // `Invoice` is claimed by one document only, so it keeps its name.
        expect(both.types.Invoice).toBeDefined();
    });

    it('rewrites the refs of a renamed type on both sides', async () => {
        const both = await loadSpecs([PETSTORE, BILLING]);
        const profile = JSON.stringify(both.types.PublicUserProfile);
        expect(profile).toContain('#/$defs/petstore.Address');
    });
});

describe('the graph', () => {
    const { graph } = built;

    it('names a method, a type and a property the way a caller would', () => {
        expect(graph.hasNode(methodId('resetPassword'))).toBe(true);
        expect(graph.hasNode(typeId('ResetPasswordPayload'))).toBe(true);
        expect(graph.hasNode(propertyId('ResetPasswordPayload', 'password'))).toBe(true);
        expect(graph.hasNode(paramId('listPets', 'page_size'))).toBe(true);
    });

    it('treats a query parameter as a property, so a field search finds it', () => {
        expect(graph.getNodeAttributes(paramId('listPets', 'page_size'))).toMatchObject({
            kind: 'property',
            name: 'page_size',
            parent: 'listPets',
            direction: 'input',
        });
    });

    it('unwraps an array response to the type it is an array of', () => {
        const targets = graph
            .outEdges(methodId('listPets'))
            .filter((e) => graph.getEdgeAttribute(e, 'relation') === 'RETURNS_OUTPUT')
            .map((e) => graph.target(e));
        expect(targets).toEqual([typeId('Pet')]);
    });

    it('lifts an inline response body into a type of its own', () => {
        expect(built.types.resetPasswordResponse).toBeDefined();
        expect(graph.hasNode(propertyId('resetPasswordResponse', 'acceptedAt'))).toBe(true);
    });

    it('flattens an inline allOf member onto the type that declares it', () => {
        // `id` and `email` are inside the anonymous allOf branch; `createdAt`
        // belongs to the named base and stays there, reached by COMPOSES.
        expect(graph.hasNode(propertyId('PublicUserProfile', 'email'))).toBe(true);
        expect(graph.hasNode(propertyId('PublicUserProfile', 'createdAt'))).toBe(false);
        expect(graph.hasNode(propertyId('Timestamps', 'createdAt'))).toBe(true);
    });

    it('survives a type that contains itself', () => {
        const manager = propertyId('PublicUserProfile', 'manager');
        const targets = graph.outNeighbors(manager);
        expect(targets).toEqual([typeId('PublicUserProfile')]);
    });

    it('marks a type used on both sides of a call `both`', () => {
        expect(graph.getNodeAttribute(typeId('Pet'), 'direction')).toBe('both');
        expect(graph.getNodeAttribute(typeId('ResetPasswordPayload'), 'direction')).toBe('input');
        expect(graph.getNodeAttribute(typeId('PublicUserProfile'), 'direction')).toBe('output');
    });

    it('pushes direction down into properties and through composition', () => {
        expect(graph.getNodeAttribute(propertyId('Cat', 'meowVolume'), 'direction')).toBe('both');
        expect(graph.getNodeAttribute(typeId('Timestamps'), 'direction')).toBe('output');
        expect(graph.getNodeAttribute(propertyId('Address', 'city'), 'direction')).toBe('output');
    });

    it('reads a method as read-only or read-write from its verb', () => {
        expect(graph.getNodeAttribute(methodId('listPets'), 'methodType')).toBe('read_only');
        expect(graph.getNodeAttribute(methodId('createPet'), 'methodType')).toBe('read_write');
    });

    it('carries a TypeScript signature on every property', () => {
        expect(graph.getNodeAttribute(propertyId('Cat', 'meowVolume'), 'signature')).toBe('number');
        expect(graph.getNodeAttribute(paramId('listPets', 'species'), 'signature')).toBe('Species');
        expect(
            graph.getNodeAttribute(propertyId('PublicUserProfile', 'address'), 'signature'),
        ).toBe('Address');
    });
});

describe('stitching a subgraph', () => {
    const { graph } = built;
    const one = (id: string, maxNodes?: number) =>
        stitch(graph, [{ id, term: id, field: 'test', score: 1 }], { maxNodes })[0]!;
    const ids = (sub: { nodes: { id: string }[] }) => sub.nodes.map((n) => n.id);

    it('walks containment backwards until it finds the call that carries the hit', () => {
        // `postcode` is on `Address`, which no operation mentions: it is reached
        // through `PublicUserProfile.address`, and that is the whole point.
        const sub = one(propertyId('Address', 'postcode'));
        expect(ids(sub)).toEqual(
            expect.arrayContaining([
                typeId('Address'),
                propertyId('PublicUserProfile', 'address'),
                typeId('PublicUserProfile'),
                methodId('getUser'),
            ]),
        );
    });

    it('keeps only the field that links, not the rest of the type it passes through', () => {
        const sub = one(propertyId('Address', 'postcode'));
        expect(ids(sub)).not.toContain(propertyId('PublicUserProfile', 'email'));
        expect(ids(sub)).not.toContain(propertyId('PublicUserProfile', 'settings'));
        // The type the hit actually sits on does come with its siblings.
        expect(ids(sub)).toContain(propertyId('Address', 'city'));
    });

    it('climbs a COMPOSES edge the same way', () => {
        const sub = one(typeId('Timestamps'));
        expect(ids(sub)).toEqual(
            expect.arrayContaining([typeId('PublicUserProfile'), methodId('getUser')]),
        );
    });

    it('terminates on a type that contains itself', () => {
        expect(ids(one(propertyId('PublicUserProfile', 'manager')))).toContain(methodId('getUser'));
    });

    it('spends a tight budget on the route to the call, not on sibling fields', () => {
        const sub = one(propertyId('Address', 'postcode'), 5);
        expect(sub.truncated).toBe(true);
        expect(ids(sub)).toContain(methodId('getUser'));
        expect(ids(sub)).not.toContain(propertyId('Address', 'city'));
    });
});

describe('printing TypeScript', () => {
    const printer = new Printer(built.types);

    it('turns a discriminated oneOf into a tagged union', () => {
        expect(printer.declaration('Pet')).toContain('export type Pet = Cat | Dog;');
        expect(printer.declaration('Cat')).toContain("petType: 'cat';");
        expect(printer.declaration('Dog')).toContain("petType: 'dog';");
    });

    it('marks optional properties and keeps required ones bare', () => {
        const cat = printer.declaration('Cat');
        expect(cat).toContain('name: string;');
        expect(cat).toContain('meowVolume?: number;');
    });

    it('attaches documentation only when asked', () => {
        expect(printer.declaration('ResetPasswordPayload')).not.toContain('/**');
        expect(printer.declaration('ResetPasswordPayload', { docs: true })).toContain(
            '/** New plain-text user password complying with complexity rules. */',
        );
    });

    it('prints a recursive reference by name rather than expanding it', () => {
        expect(printer.declaration('PublicUserProfile')).toContain('manager?: PublicUserProfile;');
    });

    it('narrows to the properties asked for', () => {
        const only = printer.declaration('ResetPasswordPayload', {
            only: new Set(['password']),
        });
        expect(only).toContain('password: string;');
        expect(only).not.toContain('resetToken');
    });
});
