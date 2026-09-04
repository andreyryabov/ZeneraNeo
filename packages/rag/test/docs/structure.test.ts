import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/docs/chunk.ts';
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
        const match = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
        if (!match) {
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
