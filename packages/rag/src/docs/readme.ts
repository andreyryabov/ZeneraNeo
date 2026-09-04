import { basename } from 'node:path';
import {
    INTERVAL_MS,
    type Building,
    type Completed,
    type Failed,
    type Report,
} from '../common/progress.ts';
import { duration, fields, grid, message, plural, searched } from '../common/prose.ts';
import type { Counts, DocRecord, Manifest } from './files.ts';

// ---------------------------------------------------------------------------
// What the directory says about itself, in words
//
// The three states of a document index's README. The mechanics — when this is
// written, and through what — belong to `common/progress.ts`; all that is here
// is what a document index is and how to ask it something.
// ---------------------------------------------------------------------------

export type Phase = 'reading' | 'embedding' | 'writing';

export const PHASES: Record<Phase, string> = {
    reading: 'reading the documents and cutting them into chunks',
    embedding: 'embedding',
    writing: 'writing the store',
};

export const DOCS_REPORT: Report<Counts, Manifest> = { building, complete, failed };

function building(state: Building<Counts>): string {
    const rows: string[][] = [
        ['documents', summary(state.documents)],
        ['embedding', state.embedding],
        [
            'started',
            `${new Date(state.started).toISOString()} (${duration(state.now - state.started)} ago)`,
        ],
        ['step', state.step],
    ];
    if (state.summary) {
        rows.push(['found', counted(state.summary)]);
    }
    if (state.total > 0) {
        const percent = Math.round((state.done / state.total) * 100);
        rows.push(['embedded', `${state.done} of ${state.total} · ${percent}%`]);
    }
    rows.push(['updated', new Date(state.now).toISOString()]);

    return [
        '# Document index — being built',
        '',
        'A searchable index of the documents named below, written by `zen rag docs index`.',
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

    return [
        `# Document index — ${basename(state.dir)}`,
        '',
        `A searchable index of ${plural(manifest.sources.length, 'document')}, built with`,
        `${manifest.embedding.ref} (${manifest.embedding.dimensions}d) in ${duration(state.ms)}.`,
        'Ask it a question and it answers with the passages that matched, quoted verbatim from',
        'the copies kept in `sources/` — line numbers included, and with a marker wherever',
        'something between two of them was left out.',
        '',
        '## What it covers',
        '',
        ...documentTable(manifest.sources),
        '',
        `${counted(manifest.counts)},`,
        `${searched(manifest.indexes)}.`,
        '',
        '## Files',
        '',
        ...fields([
            ['manifest.json', 'what this index is and what built it — read this first'],
            ['outline.json', 'every heading and table, with the lines they cover'],
            ['sources/', 'the documents themselves, verbatim: where the quotes come from'],
            ['lance/', 'the chunks: the search text, the vectors, the filter columns'],
        ]),
        '',
        '## Asking it something',
        '',
        'From this directory:',
        '',
        '```',
        'zen rag docs search --dir . "what you are after"',
        'zen rag docs search --dir . --file "guides/**" --kind table "pressure rating"',
        'zen rag docs list files --dir .',
        '```',
        '',
        `Built by ${manifest.indexer} on ${manifest.createdAt}.`,
        '',
    ].join('\n');
}

function failed(state: Failed): string {
    return [
        '# Document index — failed',
        '',
        'This index was not finished and what is here is incomplete. Nothing should read it;',
        'build it again with `zen rag docs index`.',
        '',
        ...fields([
            ['documents', summary(state.documents)],
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

const HEADERS = ['document', 'format', 'lines', 'sections', 'tables', 'chunks'] as const;

const documentTable = (sources: readonly DocRecord[]): string[] =>
    grid(
        HEADERS,
        sources.map((s) => [
            s.name,
            s.format,
            String(s.lines),
            String(s.sections),
            String(s.tables),
            String(s.chunks),
        ]),
    );

function counted(counts: Counts): string {
    return (
        `${plural(counts.chunks, 'chunk')} over ${plural(counts.documents, 'document')}: ` +
        `${counts.lines} lines, ${counts.sections} sections, ${counts.tables} tables`
    );
}

/** A corpus can be thousands of files; a README listing them all is a wall. */
function summary(documents: readonly string[]): string {
    const shown = documents.slice(0, 12).join(', ');
    return documents.length > 12 ? `${shown}, and ${documents.length - 12} more` : shown;
}
