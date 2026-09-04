import { toOpenApi, toTypeScript, type HydrateOptions } from './schema/hydrate.ts';
import { render, type RenderFormat, type RenderOptions } from './schema/render.ts';
import type { Schema } from './schema/schema.ts';
import type { Operation } from './schema/spec.ts';
import type { Subgraph } from './schema/subgraph.ts';

// ---------------------------------------------------------------------------
// One subgraph, in whichever of the four shapes was asked for
//
// The command, the prompt loop and the agent tool all print through here, so
// `--format ts` from a shell and `format: "ts"` from a model are the same
// bytes. Two of the four need the schemas off disk and two do not, which is
// the only reason this is async.
// ---------------------------------------------------------------------------

export const FORMATS = ['text', 'mermaid', 'mermaid-flowchart', 'ts', 'openapi'] as const;

export type Format = (typeof FORMATS)[number];

export function isFormat(value: string): value is Format {
    return (FORMATS as readonly string[]).includes(value);
}

export interface OutputOptions extends RenderOptions, HydrateOptions {}

/** Two of the four formats need what is on disk; an open index is enough. */
export interface SchemaSource {
    schemas(): Promise<Record<string, Schema>>;
    operations(): Promise<Operation[]>;
}

export async function present(
    index: SchemaSource,
    subgraphs: readonly Subgraph[],
    format: Format,
    options: OutputOptions = {},
): Promise<string> {
    if (subgraphs.length === 0) {
        return format === 'openapi' ? '{}' : '';
    }
    if (format === 'ts') {
        const schemas = await index.schemas();
        return subgraphs.map((s) => toTypeScript(s, schemas, options)).join('\n');
    }
    if (format === 'openapi') {
        const [schemas, operations] = await Promise.all([index.schemas(), index.operations()]);
        // One document for the whole answer: several would each have to repeat
        // the components the others also touched.
        const merged = subgraphs.reduce<Subgraph>(
            (all, one) => ({
                nodes: [...all.nodes, ...one.nodes],
                edges: [...all.edges, ...one.edges],
                hits: [...all.hits, ...one.hits],
                score: all.score + one.score,
                truncated: all.truncated || one.truncated,
            }),
            { nodes: [], edges: [], hits: [], score: 0, truncated: false },
        );
        return JSON.stringify(toOpenApi(merged, schemas, operations), null, 2);
    }
    return subgraphs
        .map(
            (s, at) =>
                `${subgraphs.length > 1 ? `# result ${at + 1}\n` : ''}${render(s, format as RenderFormat, options)}`,
        )
        .join('\n\n');
}
