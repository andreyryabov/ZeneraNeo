import { describe, expect, it } from 'vitest';
import { chunkDocument, MAX_CHUNK_TOKENS } from '../../src/docs/chunk.ts';
import { parseDocument } from '../../src/docs/parse.ts';

// ---------------------------------------------------------------------------
// Structures survive being cut
//
// A chunk stands for a set of lines, and those lines are quoted verbatim with
// everything between them marked as omitted. That is only safe if the set is
// closed: a slice taken from the middle of a fence has to bring both fence
// lines with it, and a table row has to bring its header and its rule. Quote a
// ``` that never closes and the reader — a person or a model — gets a code
// block that swallows the rest of the document.
//
// The document below is deliberately hostile: everything is long enough to be
// split, so the cuts land inside structures rather than politely between them.
// ---------------------------------------------------------------------------

const FENCE = '```';
const TILDE = '~~~';

function hostile(): string {
    const lines: string[] = ['---', 'title: Stress', '---', '', '# Stress', ''];

    lines.push('## A fence far longer than the budget', '', `${FENCE}ts`);
    for (let i = 0; i < 220; i++) {
        lines.push(`export const symbol_${i} = compute${i}(alpha, beta, gamma, delta);`);
        if (i % 9 === 8) {
            lines.push('');
        }
    }
    lines.push(FENCE, '');

    lines.push('## A tilde fence', '', `${TILDE}python`);
    for (let i = 0; i < 120; i++) {
        lines.push(`def handler_${i}(request, response): return dispatch(${i})`);
    }
    lines.push(TILDE, '');

    // Wide enough that one row alone is over the slice budget.
    const columns = Array.from({ length: 14 }, (_, i) => `col_${i}`);
    lines.push('## A wide table', '');
    lines.push(`| key | ${columns.join(' | ')} |`);
    lines.push(`| --- | ${columns.map(() => '---').join(' | ')} |`);
    for (let r = 0; r < 40; r++) {
        const cells = columns.map((c) => `${c}_value_${r}_with_quite_a_lot_of_text_in_it`);
        lines.push(`| key_${r} | ${cells.join(' | ')} |`);
    }
    lines.push('');

    lines.push('## A narrow table', '', 'Counts per region.', '');
    lines.push('| region | count |', '| --- | --- |');
    for (let r = 0; r < 30; r++) {
        lines.push(`| region_${r} | ${r * 7} |`);
    }
    lines.push('');

    lines.push('## A tiny section', '', 'One short line.', '');

    // Not a fence: a real README opened a sentence this way, and a scanner that
    // reads it as one desynchronises every pair after it.
    lines.push('## An inline span at the margin', '');
    lines.push('```var``` declared variables are function scoped, unlike the rest.', '');

    lines.push('## A nested list', '');
    for (let i = 0; i < 12; i++) {
        lines.push(`- item ${i} talks about something`);
        lines.push(`    - sub ${i}a, with more detail than its parent`);
        lines.push(`    - sub ${i}b, with more detail than its parent`);
    }
    lines.push('');

    lines.push('## A fence inside a list', '');
    lines.push('- first, run this:', '', `    ${FENCE}sh`, '    zen run --thing', `    ${FENCE}`);
    lines.push('', '- then check it', '');

    lines.push('## A fence inside a quote', '');
    lines.push('> Note the following:', '>', `> ${FENCE}json`, '> { "a": 1 }', `> ${FENCE}`, '');

    lines.push('## Raw html', '', '<div class="note">', '  <p>Something inline.</p>', '</div>', '');

    // Never closed, which is a thing real documents do.
    lines.push('## A fence that never closes', '', `${FENCE}text`);
    for (let i = 0; i < 30; i++) {
        lines.push(`dangling line ${i}`);
    }

    return lines.join('\n');
}

const SOURCE = hostile();
const LINES = SOURCE.split('\n');
const doc = parseDocument(SOURCE, 'stress.md', 'markdown');
const chunks = chunkDocument(doc);

/** Fence pairs read from the source, so the parser cannot mark its own homework. */
function fences(): [number, number][] {
    const pairs: [number, number][] = [];
    let open: { line: number; delimiter: string } | undefined;

    LINES.forEach((text, index) => {
        const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
        if (!match) {
            return;
        }
        // A backtick fence's info string may not itself contain a backtick, so
        // a sentence opening with ```var``` is a paragraph and not a fence.
        if (match[1]!.startsWith('`') && match[2]!.includes('`')) {
            return;
        }
        if (!open) {
            open = { line: index + 1, delimiter: match[1]! };
        } else if (match[1]!.startsWith(open.delimiter[0]!)) {
            pairs.push([open.line, index + 1]);
            open = undefined;
        }
    });
    return pairs;
}

const tables = doc.blocks
    .filter((block) => block.table)
    .map((block) => block.table!)
    .map((table) => ({
        header: table.headerLine,
        separator: table.separatorLine,
        rows: table.rows.map((row) => row.line),
    }));

describe('cutting a hostile document', () => {
    it('splits it rather than swallowing it whole', () => {
        // If nothing were being split there would be nothing to break.
        expect(chunks.filter((c) => c.kind === 'code').length).toBeGreaterThan(5);
        expect(chunks.filter((c) => c.kind === 'table_row').length).toBeGreaterThan(20);
        // The two at the margin; the indented and quoted ones are left to the
        // scanner's blind spot, and are kept whole by the cutter anyway.
        expect(fences()).toHaveLength(2);
        expect(tables).toHaveLength(2);
    });

    it('never quotes a fence it does not also close', () => {
        for (const chunk of chunks) {
            const shown = new Set(chunk.lineNumbers);
            for (const [open, close] of fences()) {
                const inside = chunk.lineNumbers.some((line) => line > open && line < close);
                if (!inside) {
                    continue;
                }
                expect(shown, `${chunk.index} opens fence ${open}..${close}`).toContain(open);
                expect(shown, `${chunk.index} closes fence ${open}..${close}`).toContain(close);
            }
        }
    });

    it('never quotes a table row without the header that names its columns', () => {
        for (const chunk of chunks) {
            const shown = new Set(chunk.lineNumbers);
            for (const table of tables) {
                if (!table.rows.some((line) => shown.has(line))) {
                    continue;
                }
                expect(shown, `${chunk.index} has the header`).toContain(table.header);
                if (table.separator !== undefined) {
                    expect(shown, `${chunk.index} has the rule`).toContain(table.separator);
                }
            }
        }
    });

    it('gives every chunk lines that exist, and covers its own body', () => {
        for (const chunk of chunks) {
            expect(chunk.lineNumbers.length).toBeGreaterThan(0);
            expect(chunk.lineNumbers).toContain(chunk.bodyStart);
            expect(chunk.lineNumbers).toContain(chunk.bodyEnd);
            for (const line of chunk.lineNumbers) {
                expect(line).toBeGreaterThanOrEqual(1);
                expect(line).toBeLessThanOrEqual(LINES.length);
            }
        }
    });

    it('keeps a row of a wide table to itself, so one match quotes one row', () => {
        const wide = tables[0]!;
        for (const chunk of chunks.filter((c) => c.kind === 'table_row')) {
            const rows = chunk.lineNumbers.filter((line) => wide.rows.includes(line));
            if (rows.length > 0) {
                expect(rows).toHaveLength(1);
            }
        }
    });

    it('keeps a narrow table to a few rows a chunk, not all of them', () => {
        const narrow = tables[1]!;
        const covered = chunks
            .filter((c) => c.kind === 'table_row')
            .map((c) => c.lineNumbers.filter((line) => narrow.rows.includes(line)))
            .filter((rows) => rows.length > 0);

        expect(covered.length).toBeGreaterThan(4);
        for (const rows of covered) {
            expect(rows.length).toBeLessThanOrEqual(4);
        }
        expect(new Set(covered.flat()).size).toBe(narrow.rows.length);
    });
});

// ---------------------------------------------------------------------------
// Documents that are barely documents
//
// The hostile document above is large, so it exercises the cutting. These are
// the other end: empty, truncated, mis-punctuated, or structural in a way that
// resolves to nothing. None of them should be interesting, and that is the
// point — a chunk with no lines, a line number past the end of the file, or a
// body the renderer cannot quote are all crashes at the far end of the
// pipeline, a long way from the input that caused them.
//
// The count is part of each case, so the ones that yield nothing assert that
// they yield nothing rather than passing an empty loop.
// ---------------------------------------------------------------------------

const DEGENERATE: Record<string, [source: string, chunks: number]> = {
    empty: ['', 0],
    whitespace: ['   \n\t\n  ', 0],
    blankLines: ['\n\n\n', 0],
    frontmatterOnly: ['---\ntitle: x\n---\n', 1],
    frontmatterUnclosed: ['---\ntitle: x\n', 1],
    noTrailingNewline: ['# H\n\nbody text here', 1],
    noHeadingAtAll: ['A paragraph, and not one heading above it.', 1],
    oneCharacter: ['x', 1],
    headingAndNothingElse: ['# H', 0],
    tableWithNoRows: ['| a | b |\n| --- | --- |\n', 1],
    tableWithRaggedRows: ['| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |\n', 2],
    tableWithNoRule: ['| a | b |\n| 1 | 2 |\n', 1],
    emptyFence: ['```\n```\n', 0],
    unclosedEmptyFence: ['```\n', 0],
    sevenHashes: ['####### not a heading\n', 1],
    nulByte: ['# H\n\nbefore\u0000after, and the paragraph continues.\n', 1],
    tabIndented: ['#\tH\n\n\tindented by a tab\n', 1],
    deeplyQuoted: [`${'>'.repeat(40)} deep\n`, 1],
    astralPlane: ['# H\n\n\u{1F600}\u{1F600}\u{1F600} and some prose after the emoji.\n', 1],
};

describe('cutting a degenerate document', () => {
    for (const [name, [source, expected]] of Object.entries(DEGENERATE)) {
        it(`survives ${name}`, () => {
            const doc = parseDocument(source, 'odd.md', 'markdown');
            const cut = chunkDocument(doc);

            expect(cut).toHaveLength(expected);

            for (const chunk of cut) {
                const lines = chunk.lineNumbers;
                const where = `${name} #${chunk.index}`;

                expect(lines.length, `${where} cites lines`).toBeGreaterThan(0);
                expect(
                    Math.min(...lines),
                    `${where} starts inside the file`,
                ).toBeGreaterThanOrEqual(1);
                expect(Math.max(...lines), `${where} ends inside the file`).toBeLessThanOrEqual(
                    doc.lines.length,
                );
                expect(lines, `${where} is sorted and has no repeats`).toEqual(
                    [...new Set(lines)].sort((a, b) => a - b),
                );
                expect(lines, `${where} covers its body start`).toContain(chunk.bodyStart);
                expect(lines, `${where} covers its body end`).toContain(chunk.bodyEnd);
                expect(chunk.bodyEnd, `${where} runs forwards`).toBeGreaterThanOrEqual(
                    chunk.bodyStart,
                );
                expect(chunk.text.trim(), `${where} has something to show`).not.toBe('');
                expect(chunk.embedText.trim(), `${where} has something to embed`).not.toBe('');
                expect(chunk.headings, `${where} has a breadcrumb`).toBeTruthy();
                expect(chunk.tokens, `${where} costs something`).toBeGreaterThan(0);
            }
        });
    }

    it('never hands the embedder half a character', () => {
        // Both the carry and the table slice cut by UTF-16 unit, which is one
        // unit short of an astral character.
        const sources = [SOURCE, ...Object.values(DEGENERATE).map(([source]) => source)];
        for (const source of sources) {
            for (const chunk of chunkDocument(parseDocument(source, 'odd.md', 'markdown'))) {
                expect(chunk.text.isWellFormed()).toBe(true);
                expect(chunk.embedText.isWellFormed()).toBe(true);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Things that only look like structure
// ---------------------------------------------------------------------------

const chunkOf = (source: string) => chunkDocument(parseDocument(source, 'looks.md', 'markdown'));

describe('reading what is there rather than what it resembles', () => {
    it('does not parse the contents of a fence', () => {
        const source = [
            '# Real',
            '',
            '```md',
            '# Not a heading',
            '',
            '| a | b |',
            '| --- | --- |',
            '| 1 | 2 |',
            '',
            '---',
            '```',
            '',
            'After the fence.',
        ].join('\n');
        const doc = parseDocument(source, 'looks.md', 'markdown');

        expect(doc.blocks.filter((block) => block.table)).toHaveLength(0);
        expect(doc.blocks.map((block) => block.kind)).toEqual(['code', 'paragraph']);
        for (const chunk of chunkDocument(doc)) {
            expect(chunk.headings).not.toContain('Not a heading');
        }
    });

    it('treats a table without a delimiter row as the prose it is', () => {
        const cut = chunkOf('| a | b |\n| 1 | 2 |\n');
        expect(cut.map((chunk) => chunk.kind)).toEqual(['paragraph']);
    });

    it('reads a setext heading, including the one underlined like a rule', () => {
        const cut = chunkOf('Title\n=====\n\nbody here\n\nSub\n---\n\nmore body\n');
        expect(cut.map((chunk) => chunk.headings)).toEqual([
            'looks > Title',
            'looks > Title > Sub',
        ]);
    });

    it('keeps two sections of the same name apart', () => {
        // The breadcrumb is not identifying: `--section` and the per-section
        // cap both key on the path, so a collision here silently merges two
        // unrelated parts of a document.
        const cut = chunkOf(
            '# A\n\n## Options\n\nAlpha options paragraph.\n\n# B\n\n## Options\n\nBeta options paragraph.\n',
        );
        expect(cut).toHaveLength(2);
        expect(cut[0]!.structurePath).not.toBe(cut[1]!.structurePath);
        expect(cut[0]!.structureId).not.toBe(cut[1]!.structureId);
    });

    it('reads a document the same however its lines end', () => {
        const source = `# H\n\n${'Ordinary prose giving the document a body. '.repeat(4)}\n`;
        const lf = chunkOf(source);

        for (const variant of [
            source.replace(/\n/g, '\r\n'),
            source.replace(/\n/g, '\r'),
            `\uFEFF${source}`,
        ]) {
            const doc = parseDocument(variant, 'looks.md', 'markdown');
            const cut = chunkDocument(doc);
            expect(cut).toEqual(lf);
            // Equal chunks are not enough: a lone CR that never became a line
            // break leaves the same chunks citing a document of one line.
            for (const chunk of cut) {
                expect(Math.max(...chunk.lineNumbers)).toBeLessThanOrEqual(doc.lines.length);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// One line that is bigger than the budget
//
// Cuts land between lines, so a single line over the ceiling has nowhere to be
// divided and comes back whole. That is the design's one soft spot, and it is
// load-bearing rather than theoretical: type-challenges keeps a whole README
// table on one line, and the heaviest single-line body in the 983-README
// corpus is 794 tokens against a 512 ceiling.
//
// These pin the shape of the overrun. What matters is not that the chunk is
// big — nothing can make it small — but that it stays honest while it is: one
// line in, one line cited, nothing borrowed from its neighbours.
// ---------------------------------------------------------------------------

const fill = (n: number): string => 'x'.repeat(n);
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const OVERLONG: Record<string, [source: string, bodyLine: number]> = {
    paragraph: [`# H\n\n${fill(40000)}\n`, 3],
    prose: [`# H\n\n${words(8000)}\n`, 3],
    code: [`# H\n\n\`\`\`js\n${fill(40000)}\n\`\`\`\n`, 4],
    listItem: [`# H\n\n- ${words(8000)}\n`, 3],
    blockquote: [`# H\n\n> ${fill(40000)}\n`, 3],
};

describe('a single line over the ceiling', () => {
    for (const [name, [source, bodyLine]] of Object.entries(OVERLONG)) {
        it(`returns an oversized ${name} whole rather than mangling it`, () => {
            const doc = parseDocument(source, 'big.md', 'markdown');
            const cut = chunkDocument(doc);
            const heavy = cut.filter((chunk) => chunk.tokens > MAX_CHUNK_TOKENS);

            expect(heavy).toHaveLength(1);
            expect(heavy[0]!.bodyStart).toBe(bodyLine);
            expect(heavy[0]!.bodyEnd).toBe(bodyLine);
            for (const chunk of cut) {
                expect(Math.max(...chunk.lineNumbers)).toBeLessThanOrEqual(doc.lines.length);
                expect(chunk.text.isWellFormed()).toBe(true);
            }
        });
    }

    it('does not let the line next door into the chunk', () => {
        // The carry is one line of the block before, and before the bound it
        // was that line entire — 92kB of table markup landing in the vector of
        // a seven-line paragraph that cited none of it.
        const wall = `# H\n\n${words(60)}\n\n${fill(40000)}\n\n${words(60)}\n`;
        for (const chunk of chunkDocument(parseDocument(wall, 'big.md', 'markdown'))) {
            if (chunk.bodyStart === 5) {
                continue;
            }
            expect(chunk.tokens).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
        }
    });

    it('carries a gigantic heading into every chunk beneath it', () => {
        // The breadcrumb is copied per chunk, so a heading pays its length
        // once for each. The longest in the corpus is 248 characters, which is
        // why this is recorded rather than bounded.
        const heading = words(2000);
        const source = `# ${heading}\n\n${['a', 'b', 'c']
            .map((s) => `## ${s}\n\n${words(120)}\n`)
            .join('\n')}`;
        const cut = chunkDocument(parseDocument(source, 'big.md', 'markdown'));

        expect(cut.length).toBeGreaterThan(1);
        for (const chunk of cut) {
            expect(chunk.headings).toContain(heading);
        }
    });
});

// ---------------------------------------------------------------------------
// Tables that are not quite tables
//
// A row is only safe to quote alone because its header comes with it. When the
// grid is malformed there may be no header to bring, so the question for each
// of these is which side of the line the parser puts it on — a table whose
// rows travel with their names, or prose, which is quoted as it stands.
// ---------------------------------------------------------------------------

const BROKEN: Record<string, [source: string, gridded: boolean]> = {
    fewerCellsThanHeader: ['| a | b | c |\n| --- | --- | --- |\n| 1 |\n', true],
    moreCellsThanHeader: ['| a | b |\n| --- | --- |\n| 1 | 2 | 3 | 4 |\n', true],
    noOuterPipes: ['a | b\n--- | ---\n1 | 2\n', true],
    escapedPipe: ['| a | b |\n| --- | --- |\n| x \\| y | 2 |\n', true],
    pipeInACodeSpan: ['| a | b |\n| --- | --- |\n| `x | y` | 2 |\n', true],
    emptyHeaderCells: ['|  |  |\n| --- | --- |\n| 1 | 2 |\n', true],
    alignmentColons: ['| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n', true],
    noNewlineAtEnd: ['| a | b |\n| --- | --- |\n| 1 | 2 |', true],
    // The rule has to have one cell per column, or there is no table.
    ruleTooShort: ['| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |\n', false],
    ruleTooLong: ['| a | b |\n| --- | --- | --- |\n| 1 | 2 |\n', false],
    ruleWithNoHeader: ['| --- | --- |\n', false],
    ruleOfWrongCharacters: ['| a | b |\n| -x- | --- |\n| 1 | 2 |\n', false],
};

describe('cutting a table that is not quite a table', () => {
    for (const [name, [source, gridded]] of Object.entries(BROKEN)) {
        it(`reads ${name} as ${gridded ? 'a table' : 'prose'}`, () => {
            const doc = parseDocument(source, 'broken.md', 'markdown');
            const grids = doc.blocks.filter((block) => block.table);

            expect(grids).toHaveLength(gridded ? 1 : 0);

            for (const chunk of chunkDocument(doc)) {
                expect(Math.max(...chunk.lineNumbers)).toBeLessThanOrEqual(doc.lines.length);
                if (!gridded) {
                    expect(chunk.kind).not.toBe('table_row');
                    continue;
                }
                const table = grids[0]!.table!;
                const rows = table.rows.map((row) => row.line);
                if (chunk.lineNumbers.some((line) => rows.includes(line))) {
                    expect(chunk.lineNumbers).toContain(table.headerLine);
                    expect(chunk.lineNumbers).toContain(table.separatorLine);
                }
            }
        });
    }

    it('drops a row out of the table once a blank line has ended it', () => {
        const doc = parseDocument(
            '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n',
            'broken.md',
            'markdown',
        );
        const stray = chunkDocument(doc).find((chunk) => chunk.bodyStart === 5);

        expect(stray?.kind).toBe('paragraph');
        expect(stray?.lineNumbers).not.toContain(1);
    });
});
