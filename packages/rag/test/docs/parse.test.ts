import { describe, expect, it } from 'vitest';
import { chunkDocument, formatLines, parseLines } from '../../src/docs/chunk.ts';
import { headingPath, parseDocument } from '../../src/docs/parse.ts';

// ---------------------------------------------------------------------------
// Reading a document, and cutting it up
//
// Every assertion here is about the same promise: a chunk knows exactly which
// lines of the original it stands for. Everything downstream — the quoted
// segments, the omission markers, an agent asking to read lines 40 to 80 —
// is that promise or nothing.
// ---------------------------------------------------------------------------

const SAMPLE = [
    '---',
    'title: Routing',
    '---',
    '',
    '# Routing',
    '',
    'Traffic is matched against the table below.',
    '',
    '## Rate limits',
    '',
    'Requests are counted per tenant.',
    '',
    '| route | limit | window |',
    '| --- | --- | --- |',
    '| /api/users | 100 | 1m |',
    '| /api/teams | 20 | 1m |',
    '',
    '### Retries',
    '',
    'A 429 carries `Retry-After`.',
    '',
    '```bash',
    'curl -i https://example.test/api/users',
    '```',
    '',
].join('\n');

const doc = parseDocument(SAMPLE, 'guides/routing.md', 'markdown');
const chunks = chunkDocument(doc);

const kind = (name: string) => chunks.filter((c) => c.kind === name);
const at = (line: number) => SAMPLE.split('\n')[line - 1];

describe('parsing', () => {
    it('numbers the lines the way the file does', () => {
        expect(doc.lines).toHaveLength(SAMPLE.split('\n').length);
        expect(at(5)).toBe('# Routing');
    });

    it('nests the sections by heading depth', () => {
        const titles = doc.sections.map((s) => s.title);
        expect(titles).toEqual(['guides/routing', 'Routing', 'Rate limits', 'Retries']);

        const retries = doc.sections.at(-1)!;
        expect(retries.level).toBe(3);
        expect(headingPath(retries)).toBe('guides/routing > Routing > Rate limits > Retries');
        expect(retries.path.startsWith(doc.sections[2]!.path)).toBe(true);
    });

    it('keeps the frontmatter as a block rather than as prose', () => {
        expect(doc.blocks[0]!.kind).toBe('frontmatter');
        expect(doc.blocks[0]!.start).toBe(1);
    });

    it('reads a table as columns and rows, with the lines each sits on', () => {
        const table = doc.blocks.find((b) => b.table)!.table!;
        expect(table.columns).toEqual(['route', 'limit', 'window']);
        expect(table.headerLine).toBe(13);
        expect(table.separatorLine).toBe(14);
        expect(table.rows).toHaveLength(2);
        expect(table.rows[1]!.line).toBe(16);
        expect(at(table.rows[1]!.line)).toContain('/api/teams');
    });

    it('takes the paragraph above a table as its caption', () => {
        const table = doc.blocks.find((b) => b.table)!.table!;
        expect(table.caption).toBe('Requests are counted per tenant.');
    });
});

describe('chunking', () => {
    it('gives every chunk lines that exist in the document', () => {
        for (const chunk of chunks) {
            expect(chunk.lineNumbers.length).toBeGreaterThan(0);
            for (const line of chunk.lineNumbers) {
                expect(line).toBeGreaterThanOrEqual(1);
                expect(line).toBeLessThanOrEqual(doc.lines.length);
            }
            expect(chunk.lineNumbers).toContain(chunk.bodyStart);
        }
    });

    it('carries the heading trail into what gets embedded', () => {
        const rows = kind('table_row');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.embedText).toContain('Rate limits');
        expect(rows[0]!.embedText).toContain('/api/users');
    });

    it('covers every row of the table between the row chunks', () => {
        const covered = new Set(kind('table_row').flatMap((c) => c.lineNumbers));
        expect(covered).toContain(15);
        expect(covered).toContain(16);
    });

    it('shows a table row with its header, so the columns have names', () => {
        const row = kind('table_row')[0]!;
        expect(row.lineNumbers).toContain(13);
        expect(row.lineNumbers).toContain(14);
    });

    it('describes the table once, apart from its rows', () => {
        const table = kind('table');
        expect(table).toHaveLength(1);
        expect(table[0]!.text).toContain('2 rows');
    });

    it('keeps a fenced block whole', () => {
        const code = kind('code');
        expect(code).toHaveLength(1);
        expect(code[0]!.text).toContain('curl -i');
    });

    it('numbers chunks in document order', () => {
        expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    });
});

describe('plain text', () => {
    it('splits on blank lines and invents no headings', () => {
        const text = parseDocument('one\ntwo\n\nthree\n', 'notes.txt', 'text');
        expect(text.sections).toHaveLength(1);
        expect(text.blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
        expect(text.blocks[1]!.start).toBe(4);
    });
});

describe('line specs', () => {
    it('round-trips a run of lines through the store', () => {
        const numbers = [1, 5, 12, 13, 14, 15, 40];
        expect(formatLines(numbers)).toBe('1,5,12-15,40');
        expect(parseLines(formatLines(numbers))).toEqual(numbers);
    });

    it('reads an empty spec as no lines', () => {
        expect(parseLines('')).toEqual([]);
    });
});
