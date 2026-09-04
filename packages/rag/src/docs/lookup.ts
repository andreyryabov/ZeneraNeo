import { CliError, EXIT } from '@zenera/cli/lib';
import { loose, type MatchOptions } from '../common/match.ts';
import type { HeadingRecord } from './files.ts';
import type { DocsIndex } from './search.ts';
import { under } from './search.ts';

// ---------------------------------------------------------------------------
// The exact half
//
// Not every question about a corpus is a question about meaning. What files are
// in here, what sections does this one have, which lines say `X-Rate-Limit`,
// show me lines 40 to 80 — these have one right answer, and answering them with
// a ranked list of approximately-relevant passages would be answering worse.
//
// So they are here, and none of them touch the store, the embedder, or the
// network. They read `manifest.json`, `outline.json` and the copies in
// `sources/`, which is why they work in an index built with a model whose key
// this process does not have.
//
// Every result reports `found` as the true total and `rows` as what fitted
// under the limit. An agent that is told "50 of 812" asks a narrower question;
// one handed 50 rows and no count believes it has them all.
// ---------------------------------------------------------------------------

export interface Listing<T> {
    found: number;
    rows: T[];
    truncated: boolean;
}

export interface ListOptions {
    /** patterns over the document name */
    files?: readonly string[];
    exclude_files?: readonly string[];
    limit?: number;
}

export const DEFAULT_ROWS = 50;
export const MAX_ROWS = 500;

export interface FileRow {
    name: string;
    title: string;
    format: string;
    lines: number;
    sections: number;
    tables: number;
    chunks: number;
}

export function listFiles(index: DocsIndex, options: ListOptions = {}): Listing<FileRow> {
    const names = new Set(index.resolveFiles(options.files, options.exclude_files));
    const rows = index.manifest.sources
        .filter((source) => names.has(source.name))
        .map((source): FileRow => ({
            name: source.name,
            title: source.title,
            format: source.format,
            lines: source.lines,
            sections: source.sections,
            tables: source.tables,
            chunks: source.chunks,
        }));
    return cut(rows, options.limit);
}

export interface SectionRow {
    file: string;
    id: string;
    path: string;
    level: number;
    title: string;
    line: number;
    end: number;
}

export interface SectionOptions extends ListOptions {
    /** a heading title, a structure id, or a structure path */
    section?: readonly string[];
    /** deepest heading level to report; the default is everything */
    depth?: number;
}

export function listSections(index: DocsIndex, options: SectionOptions = {}): Listing<SectionRow> {
    const files = index.resolveFiles(options.files, options.exclude_files);
    const within = new Set(files);
    const wanted = options.section?.length
        ? index.resolveSections(options.section, files).map((h) => h.path)
        : [];

    const rows: SectionRow[] = [];
    for (const file of index.outline.files) {
        if (!within.has(file.name)) {
            continue;
        }
        for (const heading of file.headings) {
            if (under(heading.path, wanted) && heading.level <= (options.depth ?? Infinity)) {
                rows.push({ file: file.name, ...record(heading) });
            }
        }
    }
    return cut(rows, options.limit);
}

export interface TableRow {
    file: string;
    id: string;
    section: string;
    caption: string;
    columns: string;
    rows: number;
    line: number;
    end: number;
}

export function listTables(index: DocsIndex, options: SectionOptions = {}): Listing<TableRow> {
    const files = index.resolveFiles(options.files, options.exclude_files);
    const within = new Set(files);
    const wanted = options.section?.length
        ? index.resolveSections(options.section, files).map((h) => h.path)
        : [];

    const rows: TableRow[] = [];
    for (const file of index.outline.files) {
        if (!within.has(file.name)) {
            continue;
        }
        for (const table of file.tables) {
            if (!under(table.path, wanted)) {
                continue;
            }
            rows.push({
                file: file.name,
                id: table.id,
                section: table.section,
                caption: table.caption,
                columns: table.columns.join(', '),
                rows: table.rows,
                line: table.line,
                end: table.end,
            });
        }
    }
    return cut(rows, options.limit);
}

export interface LineRow {
    file: string;
    line: number;
    text: string;
    /** the innermost heading the line sits under, so a hit has a place */
    section: string;
}

export interface GrepOptions extends SectionOptions, MatchOptions {}

/**
 * Lines matching a pattern. Substring by default, glob when it has wildcards,
 * a regular expression when asked — the same rule every other pattern in this
 * package follows, so nobody has to remember which flavour a flag takes.
 */
export async function grepLines(
    index: DocsIndex,
    pattern: string,
    options: GrepOptions = {},
): Promise<Listing<LineRow>> {
    const files = index.resolveFiles(options.files, options.exclude_files);
    const wanted = options.section?.length
        ? index.resolveSections(options.section, files)
        : undefined;
    const match = loose(pattern, { regex: options.regex, caseSensitive: options.caseSensitive });

    const rows: LineRow[] = [];
    for (const name of files) {
        const spans = wanted?.filter((h) => index.file(name)?.headings.includes(h));
        if (wanted && (!spans || spans.length === 0)) {
            continue;
        }
        const lines = await index.lines(name);
        const headings = index.file(name)?.headings ?? [];

        for (const [at, text] of lines.entries()) {
            const line = at + 1;
            if (spans && !spans.some((span) => line >= span.line && line <= span.end)) {
                continue;
            }
            if (match(text)) {
                rows.push({ file: name, line, text, section: enclosing(headings, line) });
            }
        }
    }
    return cut(rows, options.limit);
}

export interface Verbatim {
    file: string;
    title: string;
    start: number;
    end: number;
    lines: string[];
    /** the document's length, so a caller can tell what it did not get */
    total: number;
}

/** A named section, verbatim: heading line to the line before the next peer. */
export async function readSection(
    index: DocsIndex,
    file: string,
    section: string,
): Promise<Verbatim> {
    const found = index.resolveSections([section], [file]);
    const heading = found[0];
    if (!heading) {
        throw new CliError(
            `${file} has no section called ${section}`,
            EXIT.failed,
            'list them with `zen rag docs list sections --file <name>`',
        );
    }
    return await readRange(index, file, heading.line, heading.end);
}

export async function readRange(
    index: DocsIndex,
    file: string,
    from: number,
    to: number,
): Promise<Verbatim> {
    const lines = await index.lines(file);
    const outline = index.file(file);
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);

    return {
        file,
        title: outline?.title ?? file,
        start,
        end,
        lines: lines.slice(start - 1, end),
        total: lines.length,
    };
}

// ---------------------------------------------------------------------------

function cut<T>(rows: T[], limit: number | undefined): Listing<T> {
    const take = Math.min(Math.max(1, limit ?? DEFAULT_ROWS), MAX_ROWS);
    return { found: rows.length, rows: rows.slice(0, take), truncated: rows.length > take };
}

const record = (heading: HeadingRecord): Omit<SectionRow, 'file'> => ({
    id: heading.id,
    path: heading.path,
    level: heading.level,
    title: heading.title,
    line: heading.line,
    end: heading.end,
});

/** The last heading at or above this line, which is the section it is in. */
function enclosing(headings: readonly HeadingRecord[], line: number): string {
    let title = '';
    for (const heading of headings) {
        if (heading.line > line) {
            break;
        }
        title = heading.title;
    }
    return title;
}
