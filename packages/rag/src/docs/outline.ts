import type { FileOutline, HeadingRecord, TableRecord } from './files.ts';
import type { ParsedDoc } from './parse.ts';

// ---------------------------------------------------------------------------
// What a document holds, without the document
//
// This lives apart from `load.ts` for one reason: a parse worker needs it, and
// `load.ts` imports the CLI. A worker that reached for it there would load the
// whole command layer into every thread to call one pure function. Nothing here
// may import anything that is not pure.
// ---------------------------------------------------------------------------

/**
 * Headings and tables, with the line each ends on. That end is what makes the
 * outline enough on its own: a section runs from its heading to the line before
 * the next heading at the same depth or shallower, so scoping a search to a
 * section, listing what is in one, or naming the sections a skipped range
 * covered are all answerable without reading the document.
 */
export function outlineOf(doc: ParsedDoc, chunks: number): FileOutline {
    const sections = doc.sections.filter((s) => s.line !== undefined);
    const headings = sections.map((section, at): HeadingRecord => {
        const next = sections.findIndex((other, i) => i > at && other.level <= section.level);
        const end = next === -1 ? doc.lines.length : sections[next]!.line! - 1;
        return {
            line: section.line!,
            end,
            level: section.level,
            title: section.title,
            id: section.id,
            path: section.path,
        };
    });

    const tables = doc.blocks
        .filter((block) => block.table)
        .map((block): TableRecord => {
            const table = block.table!;
            return {
                id: block.id,
                path: block.path,
                section: block.section.path,
                line: block.start,
                end: block.end,
                columns: table.columns,
                rows: table.rows.length,
                caption: table.caption,
            };
        });

    return {
        name: doc.name,
        title: doc.title,
        format: doc.format,
        lines: doc.lines.length,
        chunks,
        headings,
        tables,
    };
}
