import { basename } from 'node:path';
import type { Building, Completed, Failed, Report } from '../common/progress.ts';
import { INTERVAL_MS } from '../common/progress.ts';
import { duration, fields, grid, message, plural, searched } from '../common/prose.ts';
import type { Counts, Manifest, SourceRecord } from './files.ts';

// ---------------------------------------------------------------------------
// What the directory says about itself, in words
//
// The three states of a schema index's README. The mechanics — when this is
// written, and through what — belong to `common/progress.ts`; all that is here
// is what an API index is and how to ask it something.
// ---------------------------------------------------------------------------

export type Phase = 'reading' | 'graph' | 'embedding' | 'writing';

export const PHASES: Record<Phase, string> = {
    reading: 'reading the documents',
    graph: 'building the graph',
    embedding: 'embedding',
    writing: 'writing the store',
};

export const SCHEMA_REPORT: Report<Counts, Manifest> = { building, complete, failed };

function building(state: Building<Counts>): string {
    const rows: string[][] = [
        ['documents', state.documents.join(', ')],
        ['embedding', state.embedding],
        [
            'started',
            `${new Date(state.started).toISOString()} (${duration(state.now - state.started)} ago)`,
        ],
        ['step', state.step],
    ];
    if (state.summary) {
        rows.push(['found', entities(state.summary)]);
    }
    if (state.total > 0) {
        const percent = Math.round((state.done / state.total) * 100);
        rows.push(['embedded', `${state.done} of ${state.total} · ${percent}%`]);
    }
    rows.push(['updated', new Date(state.now).toISOString()]);

    return [
        '# Schema index — being built',
        '',
        'A searchable index of the API documents named below, written by `zen rag schema index`.',
        '**It is incomplete. Nothing should read it yet.**',
        '',
        ...fields(rows),
        '',
        `These lines are refreshed at most every ${INTERVAL_MS / 1000} seconds while the build runs, and`,
        'the whole file is replaced by a description of the index when it finishes. If it still says',
        '"being built" and `.lock` names no living process, the build died part way.',
        '',
    ].join('\n');
}

function complete(state: Completed<Manifest>): string {
    const { manifest } = state;
    const titles = manifest.sources.map((s) => s.title).filter(Boolean);
    const what = titles.length > 0 ? titles.join(', ') : basename(state.dir);

    return [
        `# Schema index — ${what}`,
        '',
        `A searchable index of ${plural(manifest.sources.length, 'API document')}, built with`,
        `${manifest.embedding.ref} (${manifest.embedding.dimensions}d) in ${duration(state.ms)}.`,
        'Ask it for the operations and types behind a question and it answers with a subgraph:',
        'the endpoints that match, the schemas they carry, and the fields inside those — printed',
        'as text, Mermaid, TypeScript or OpenAPI.',
        '',
        '## What it covers',
        '',
        ...sourceTable(manifest.sources),
        '',
        `${entities(manifest.counts)},`,
        `${searched(manifest.indexes)}.`,
        '',
        '## Files',
        '',
        ...fields([
            ['manifest.json', 'what this index is and what built it — read this first'],
            ['graph.json', 'the nodes and edges: operations, types, fields'],
            ['schemas.json', 'the JSON Schema of every type'],
            ['operations.json', 'every operation, with its parameters and responses'],
            ...(manifest.sources.some((s) => s.path)
                ? [['sources/', 'the documents themselves, bundled, exactly as indexed']]
                : []),
            ['lance/', 'the LanceDB table: the search text, the vectors, the filter columns'],
        ]),
        '',
        '## Asking it something',
        '',
        'From this directory:',
        '',
        '```',
        'zen rag schema search --dir . --all "how do I cancel a subscription"',
        '```',
        '',
        `Built by ${manifest.indexer} on ${manifest.createdAt}.`,
        '',
    ].join('\n');
}

function failed(state: Failed): string {
    return [
        '# Schema index — failed',
        '',
        'This index was not finished and what is here is incomplete. Nothing should read it;',
        'build it again with `zen rag schema index`.',
        '',
        ...fields([
            ['documents', state.documents.join(', ')],
            ['step', state.step],
            ['reason', message(state.reason)],
            ['started', new Date(state.started).toISOString()],
            [
                'failed',
                `${new Date().toISOString()} (after ${duration(Date.now() - state.started)})`,
            ],
        ]),
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------

const HEADERS = ['document', 'dialect', 'paths', 'operations', 'schemas', 'fields'] as const;

const sourceTable = (sources: readonly SourceRecord[]): string[] =>
    grid(
        HEADERS,
        sources.map((s) => [
            s.file,
            s.dialect,
            String(s.paths),
            String(s.methods),
            String(s.types),
            String(s.properties),
        ]),
    );

function entities(counts: Counts): string {
    return (
        `${plural(counts.entities, 'entity', 'entities')}: ` +
        `${counts.methods} operations, ${counts.types} schemas, ${counts.properties} fields`
    );
}
