import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assemble } from '../../src/docs/assemble.ts';
import { buildIndex } from '../../src/docs/build.ts';
import { readManifest } from '../../src/docs/files.ts';
import {
    grepLines,
    listFiles,
    listSections,
    listTables,
    readSection,
} from '../../src/docs/lookup.ts';
import { renderAssembly } from '../../src/docs/render.ts';
import { DocsIndex } from '../../src/docs/search.ts';
import { docsTools } from '../../src/docs/tools.ts';
import { StubEmbedder } from '../stub.ts';

// ---------------------------------------------------------------------------
// A corpus, indexed and then asked things
//
// Two releases of the same document, on purpose: it is the case the whole
// design turns on. Both say almost the same words, so a ranking alone cannot
// tell them apart, and the only honest answer to "what is the limit in 4.2" is
// the one narrowed by path. If `--file` does not separate these, nothing does.
// ---------------------------------------------------------------------------

const CORPUS: Record<string, string> = {
    'nsx_4.1.0/api/routing.md': [
        '# Routing',
        '',
        'Traffic is matched against the table below.',
        '',
        '## Rate limits',
        '',
        'Requests are counted per tenant and rejected past the limit.',
        '',
        '| route | limit | window |',
        '| --- | --- | --- |',
        '| /api/users | 100 | 1m |',
        '',
        '## Retries',
        '',
        'A 429 response carries a Retry-After header.',
        '',
    ].join('\n'),

    'nsx_4.2.0/api/routing.md': [
        '# Routing',
        '',
        'Traffic is matched against the table below.',
        '',
        '## Rate limits',
        '',
        'Requests are counted per tenant and rejected past the limit.',
        '',
        '| route | limit | window |',
        '| --- | --- | --- |',
        '| /api/users | 250 | 1m |',
        '',
        '## Retries',
        '',
        'A 429 response carries a Retry-After header.',
        '',
    ].join('\n'),

    'notes/onboarding.txt': [
        'Ask for a keyring entry before the first deploy.',
        '',
        'The staging cluster is rebuilt every Sunday.',
        '',
    ].join('\n'),

    // One document that really is the whole answer to one question, in enough
    // sections that the per-document cap has something to hold back.
    'manual/telemetry.md': [
        '# Telemetry',
        '',
        ...Array.from({ length: 9 }, (_, i) => [
            `## Telemetry counter ${i}`,
            '',
            `Telemetry counter ${i} is exported by every telemetry collector on the`,
            'telemetry bus, and telemetry operators read it whenever a telemetry',
            'sample looks wrong. Telemetry counters reset when the telemetry daemon',
            'restarts, which telemetry dashboards render as a telemetry gap.',
            '',
        ]).flat(),
    ].join('\n'),
};

const source = await mkdtemp(join(tmpdir(), 'zenera-docs-src-'));
const out = await mkdtemp(join(tmpdir(), 'zenera-docs-'));
const embedder = new StubEmbedder();

for (const [name, text] of Object.entries(CORPUS)) {
    const path = join(source, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
}

await buildIndex({
    files: [source],
    cwd: process.cwd(),
    out,
    embedder,
    indexer: 'test',
});

const index = await DocsIndex.open(out, embedder);

afterAll(async () => {
    index.close();
    await rm(source, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
});

describe('building', () => {
    it('names each document by its path below the common root', async () => {
        const manifest = await readManifest(out);
        expect(manifest.sources.map((s) => s.name).sort()).toEqual(Object.keys(CORPUS).sort());
    });

    it('keeps a copy of every document, byte for byte', async () => {
        for (const [name, text] of Object.entries(CORPUS)) {
            expect((await index.lines(name)).join('\n')).toBe(text);
        }
    });

    it('counts what it read', async () => {
        const manifest = await readManifest(out);
        expect(manifest.counts.documents).toBe(4);
        expect(manifest.counts.chunks).toBeGreaterThan(3);
        expect(manifest.counts.tables).toBe(2);
    });

    it('refuses an index built by another embedder', async () => {
        await expect(DocsIndex.open(out, new StubEmbedder('stub:other'))).rejects.toThrow(
            /built with stub:bag-of-words/,
        );
    });
});

describe('searching', () => {
    it('answers a question with passages from the documents', async () => {
        const result = await index.search({ query: 'requests counted per tenant' });
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.files).toHaveLength(4);
    });

    it('narrows to one release by path pattern', async () => {
        const result = await index.search({
            query: 'rate limit for the users route',
            files: ['nsx_4.2*/**'],
        });
        expect(result.files).toEqual(['nsx_4.2.0/api/routing.md']);
        expect(result.matches.every((m) => m.path === 'nsx_4.2.0/api/routing.md')).toBe(true);
    });

    it('narrows to a section by its heading', async () => {
        const result = await index.search({
            query: 'header',
            files: ['nsx_4.1*/**'],
            section: ['Retries'],
        });
        expect(result.sections).toHaveLength(1);
        for (const found of result.matches) {
            expect(found.headings).toContain('Retries');
        }
    });

    it('narrows to tables alone', async () => {
        const result = await index.search({
            query: 'route limit window',
            kinds: ['table', 'table_row'],
        });
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.matches.every((m) => m.kind.startsWith('table'))).toBe(true);
    });

    it('says nothing rather than everything when no document matches', async () => {
        const result = await index.search({ query: 'anything', files: ['nsx_9*'] });
        expect(result.files).toEqual([]);
        expect(result.matches).toEqual([]);
    });

    it('moves on when what was seen is excluded', async () => {
        const first = await index.search({ query: 'retry after header', limit: 2 });
        const again = await index.search({
            query: 'retry after header',
            limit: 2,
            exclude_ids: first.matches.map((m) => m.id),
        });
        for (const found of again.matches) {
            expect(first.matches.map((m) => m.id)).not.toContain(found.id);
        }
    });
});

describe('assembling an answer', () => {
    it('quotes the lines it matched, verbatim and numbered', async () => {
        const result = await index.search({
            query: 'requests counted per tenant',
            files: ['nsx_4.1*/**'],
        });
        const excerpt = await assemble(index, result.matches);
        const file = excerpt.files[0]!;
        const original = await index.lines(file.path);

        for (const piece of file.pieces) {
            if (piece.type === 'segment') {
                expect(piece.lines).toEqual(original.slice(piece.start - 1, piece.end));
            }
        }
    });

    it('marks what it skipped, and names the sections in the gap', async () => {
        const result = await index.search({
            query: 'retry after header',
            files: ['nsx_4.1*/**'],
            limit: 1,
        });
        const excerpt = await assemble(index, result.matches, { mergeGap: 0 });
        const omissions = excerpt.files
            .flatMap((f) => f.pieces)
            .filter((p) => p.type === 'omission');

        expect(omissions.length).toBeGreaterThan(0);
        expect(omissions.some((o) => o.count > 0)).toBe(true);
    });

    it('stops at the line budget and says so', async () => {
        const result = await index.search({ query: 'routing traffic table' });
        const excerpt = await assemble(index, result.matches, { maxLines: 3 });
        expect(excerpt.shown).toBeLessThanOrEqual(3);
        expect(excerpt.truncated).toBe(true);
    });

    it('lets one document own more of the answer when more is asked for', async () => {
        // The cap is a nudge at the default limit and a straitjacket above it
        // unless it scales: asking for sixteen results on a question one
        // document answers should not spend eleven of them elsewhere.
        const mine = async (limit: number) =>
            (await index.search({ query: 'telemetry counter bus daemon', limit })).matches.filter(
                (m) => m.path === 'manual/telemetry.md',
            ).length;

        expect(await mine(8)).toBeLessThanOrEqual(5);
        expect(await mine(16)).toBeGreaterThan(5);
    });

    it('renders with a line-number gutter a follow-up can quote', async () => {
        const result = await index.search({
            query: 'requests counted per tenant',
            files: ['nsx_4.1*/**'],
            limit: 1,
        });
        const text = renderAssembly(await assemble(index, result.matches), { colour: false });
        expect(text).toContain('nsx_4.1.0/api/routing.md');
        expect(text).toMatch(/\d+ \| /);
    });
});

describe('the exact half', () => {
    it('lists every document with what it holds', () => {
        const listed = listFiles(index);
        expect(listed.found).toBe(4);
        expect(listed.rows.map((r) => r.name)).toContain('notes/onboarding.txt');
    });

    it('lists headings, scoped to a document', () => {
        const listed = listSections(index, { files: ['nsx_4.2*/**'] });
        expect(listed.rows.map((r) => r.title)).toEqual(['Routing', 'Rate limits', 'Retries']);
    });

    it('gives a section the lines it actually ends on', () => {
        const [limits] = listSections(index, {
            files: ['nsx_4.2*/**'],
            section: ['Rate limits'],
        }).rows;
        expect(limits!.line).toBe(5);
        expect(limits!.end).toBe(12);
    });

    it('lists tables with their columns', () => {
        const listed = listTables(index);
        expect(listed.found).toBe(2);
        expect(listed.rows[0]!.columns).toBe('route, limit, window');
    });

    it('greps every match and reports the true total', async () => {
        const found = await grepLines(index, 'Retry-After');
        expect(found.found).toBe(2);
        expect(found.rows[0]!.section).toBe('Retries');
    });

    it('greps within one section only', async () => {
        const found = await grepLines(index, 'limit', { section: ['Retries'] });
        expect(found.found).toBe(0);
    });

    it('reads a named section verbatim', async () => {
        const read = await readSection(index, 'nsx_4.2.0/api/routing.md', 'Rate limits');
        expect(read.lines[0]).toBe('## Rate limits');
        expect(read.lines.join('\n')).toContain('| /api/users | 250 | 1m |');
    });

    it('works without an embedder at all', async () => {
        const plain = await DocsIndex.open(out);
        try {
            expect(listFiles(plain).found).toBe(4);
        } finally {
            plain.close();
        }
    });
});

describe('the tools an agent is given', () => {
    const tools = docsTools(index);
    const call = async (name: string, args: unknown) => {
        const found = tools.find((t) => t.name === name)!;
        return (await found.execute(args as never, undefined as never)) as Record<string, unknown>;
    };

    it('offers exactly the four an agent needs', () => {
        expect(tools.map((t) => t.name)).toEqual([
            'search_docs',
            'list_docs',
            'grep_docs',
            'read_docs',
        ]);
    });

    it('answers a search with quoted passages and their ids', async () => {
        const result = await call('search_docs', { query: 'requests counted per tenant' });
        expect(result.found).toBeGreaterThan(0);
        expect(String(result.passages)).toContain('per tenant');
    });

    it('hints rather than throwing when a file pattern matches nothing', async () => {
        const result = await call('search_docs', { query: 'anything', files: ['nsx_9*'] });
        expect(result.found).toBe(0);
        expect(String(result.hint)).toContain('list_docs');
    });

    it('reads a line range so a passage can be quoted in full', async () => {
        const result = await call('read_docs', {
            file: 'nsx_4.1.0/api/routing.md',
            from: 9,
            to: 11,
        });
        expect(result.text).toContain('| /api/users | 100 | 1m |');
        expect(result.end).toBe(11);
    });

    it('reports a missing document rather than failing', async () => {
        const result = await call('read_docs', { file: 'nowhere.md' });
        expect(String(result.error)).toContain('no document called');
    });
});
