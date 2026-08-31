import { refsIn, type Schema } from './schema.ts';
import type { Operation } from './spec.ts';
import type { Subgraph, SubgraphNode } from './subgraph.ts';
import { Printer, property } from './typescript.ts';

// ---------------------------------------------------------------------------
// A subgraph, as something you can compile against
//
// The graph says *which* types the answer is about; the schemas say what they
// are. Between the two sits the one rule that decides whether the output is
// usable: a printed interface may name only types that are also printed, so
// the selection is closed over `$ref` before anything is written. Without that
// step the emitted `.d.ts` refers to a `Address` nobody declared, and the
// first thing the compiler says is about the tool rather than the code.
// ---------------------------------------------------------------------------

export interface HydrateOptions {
    docs?: boolean;
    maxDoc?: number;
    /** narrow each interface to the properties the search actually matched */
    onlyHits?: boolean;
}

export function toTypeScript(
    sub: Subgraph,
    schemas: Readonly<Record<string, Schema>>,
    options: HydrateOptions = {},
): string {
    const printer = new Printer(schemas);
    const wanted = closure(typeNames(sub), schemas);
    const only = options.onlyHits ? hitProperties(sub) : undefined;
    const blocks: string[] = [];

    const operations = sub.nodes.filter((n) => n.kind === 'method');
    if (operations.length > 0) {
        blocks.push(operations.map((m) => routeComment(m)).join('\n'));
    }

    const printed = new Set([...wanted].map((name) => printer.identifier(name)));
    for (const method of operations) {
        const block = params(sub, method, printer, printed, options);
        if (block) {
            blocks.push(block);
        }
    }

    for (const name of [...wanted].sort()) {
        blocks.push(
            printer.declaration(name, {
                docs: options.docs,
                maxDoc: options.maxDoc,
                only: only?.get(name),
            }),
        );
    }
    return blocks.filter(Boolean).join('\n');
}

/**
 * The other half of the job: when the task is to *call* the API rather than to
 * type its payloads, a valid document beats a declaration file.
 */
export function toOpenApi(
    sub: Subgraph,
    schemas: Readonly<Record<string, Schema>>,
    operations: readonly Operation[],
    info: { title: string; version: string } = { title: 'Selection', version: '0' },
): Record<string, unknown> {
    const names = new Set(
        sub.nodes.filter((n) => n.kind === 'method').map((n) => n.attributes.name),
    );
    const chosen = operations.filter((op) => names.has(op.operationId));
    const wanted = closure(typeNames(sub), schemas);

    const paths: Record<string, Record<string, unknown>> = {};
    for (const op of chosen) {
        for (const name of [
            ...op.params.flatMap((p) => refsIn(p.schema)),
            ...refsIn(op.requestBody?.schema),
            ...op.responses.flatMap((r) => refsIn(r.schema)),
        ]) {
            wanted.add(name);
        }
        (paths[op.path] ??= {})[op.method] = {
            operationId: op.operationId,
            ...(op.summary ? { summary: op.summary } : {}),
            ...(op.description ? { description: op.description } : {}),
            ...(op.params.length > 0
                ? {
                      parameters: op.params.map((p) => ({
                          name: p.name,
                          in: p.in,
                          required: p.required,
                          ...(p.doc ? { description: p.doc } : {}),
                          schema: p.schema,
                      })),
                  }
                : {}),
            ...(op.requestBody
                ? {
                      requestBody: {
                          required: op.requestBody.required,
                          content: { 'application/json': { schema: op.requestBody.schema } },
                      },
                  }
                : {}),
            responses: Object.fromEntries(
                op.responses.map((r) => [
                    String(r.status),
                    {
                        description: r.doc || 'Success',
                        content: { 'application/json': { schema: r.schema } },
                    },
                ]),
            ),
        };
    }

    // Everything was rewritten to `#/$defs/<id>` at load; a standalone document
    // has to point at where the schemas are about to be written instead.
    const components = Object.fromEntries(
        [...closure(wanted, schemas)].sort().map((name) => [name, rebase(schemas[name])]),
    );
    return {
        openapi: '3.1.0',
        info,
        paths: rebase(paths) as Record<string, unknown>,
        components: { schemas: components },
    };
}

// ---------------------------------------------------------------------------

function typeNames(sub: Subgraph): Set<string> {
    return new Set(sub.nodes.filter((n) => n.kind === 'type').map((n) => n.attributes.name));
}

/** Every name reachable from the selection, so nothing printed dangles. */
function closure(names: Iterable<string>, schemas: Readonly<Record<string, Schema>>): Set<string> {
    const out = new Set<string>();
    const stack = [...names];
    while (stack.length > 0) {
        const name = stack.pop()!;
        if (out.has(name) || !schemas[name]) {
            continue;
        }
        out.add(name);
        stack.push(...refsIn(schemas[name]));
    }
    return out;
}

function hitProperties(sub: Subgraph): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const node of sub.nodes) {
        if (node.kind !== 'property' || !node.hit || !node.attributes.parent) {
            continue;
        }
        const set = out.get(node.attributes.parent) ?? new Set<string>();
        set.add(node.attributes.name);
        out.set(node.attributes.parent, set);
    }
    return out;
}

function routeComment(method: SubgraphNode): string {
    const a = method.attributes;
    return `// ${a.httpMethod} ${a.path}${a.doc ? `  — ${a.doc.replace(/\s+/g, ' ')}` : ''}`;
}

/** The parameters of one operation, as something a caller can hold. */
function params(
    sub: Subgraph,
    method: SubgraphNode,
    printer: Printer,
    printed: ReadonlySet<string>,
    options: HydrateOptions,
): string {
    const owned = sub.edges
        .filter((e) => e.source === method.id && e.relation === 'HAS_PARAM')
        .map((e) => ({ edge: e, node: sub.nodes.find((n) => n.id === e.target) }))
        .filter((p): p is { edge: (typeof sub.edges)[number]; node: SubgraphNode } => !!p.node);

    if (owned.length === 0) {
        return '';
    }
    const lines = [`export interface ${printer.identifier(`${method.attributes.name}Params`)} {`];
    for (const { edge, node } of owned) {
        const a = node.attributes;
        const note = [edge.in, a.doc].filter(Boolean).join(' — ');
        if (options.docs && note) {
            lines.push(`    /** ${note.replace(/\s+/g, ' ')} */`);
        }
        lines.push(
            `    ${property(a.name)}${a.required ? '' : '?'}: ${resolvable(a.signature, printed)};`,
        );
    }
    lines.push('}\n');
    return lines.join('\n');
}

const BUILTIN = new Set([
    'string',
    'number',
    'boolean',
    'null',
    'unknown',
    'never',
    'Record',
    'true',
    'false',
]);

/**
 * Signatures were computed against the whole corpus, so one may name a type
 * this selection does not print. `unknown` is a worse answer than the name and
 * a far better one than a file that will not compile.
 */
function resolvable(signature: string, printed: ReadonlySet<string>): string {
    if (!signature) {
        return 'unknown';
    }
    const names = signature.replace(/'[^']*'/g, '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    return names.every((name) => BUILTIN.has(name) || printed.has(name)) ? signature : 'unknown';
}

/** `#/$defs/X` back to `#/components/schemas/X`. */
function rebase(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(rebase);
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
        out[key] =
            key === '$ref' && typeof inner === 'string'
                ? inner.replace(/^#\/\$defs\//, '#/components/schemas/')
                : rebase(inner);
    }
    return out;
}
