import { CliError, EXIT } from '@zenera/cli/lib';
import { loose, type MatchOptions } from '@zenera/neo';
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
// Several reads at once
//
// An agent that cites five passages otherwise spends five turns on five reads,
// each resending the whole conversation, because no model we run will issue
// them in parallel however it is asked. One call naming all five leaves
// nothing to batch.
//
// The reads share one line budget, divided so the first cannot spend it all:
// each gets an even share, and what a short one leaves goes to the rest. A read
// that was cut says which read continues it, so the budget costs a call and
// never a passage.
// ---------------------------------------------------------------------------

export interface Read {
    /** what the caller wrote, so a failure can be put back next to it */
    target: string;
    file: string;
    /** a heading title, id or path; wins over from/to */
    section?: string;
    from?: number;
    to?: number;
}

export interface ReadBlock {
    /** what was printed, as a read that would print it again */
    target: string;
    file: string;
    /** first line printed */
    from: number;
    /** last line printed; `from - 1` when the budget left none */
    to: number;
    /** last line that was asked for, after clamping to the document */
    end: number;
    total: number;
    /** the heading, when the block is exactly one section */
    section?: string;
    /** the range asked for, when it ran past the end of the document */
    asked?: string;
    lines: string[];
    truncated: boolean;
    /** the read that prints the rest of a cut block */
    continue?: string;
}

export interface ReadFailure {
    target: string;
    file: string;
    error: string;
    hint: string;
}

export type ReadResult = ReadBlock | ReadFailure;

export interface ReadMany {
    results: ReadResult[];
    printed: number;
    failed: number;
}

export interface ReadHints {
    document: (file: string) => string;
    section: (file: string) => string;
    range: (file: string, total: number) => string;
}

export interface ReadManyOptions {
    maxLines?: number;
    hints?: Partial<ReadHints>;
}

const CLI_HINTS: ReadHints = {
    document: (file) =>
        `\`zen rag docs list files --file "*${file.split('/').at(-1)}*"\` lists close names`,
    section: (file) => `\`zen rag docs list sections --file "${file}"\` lists its headings`,
    range: (file, total) => `read ${spanOf(file, 1, total)}`,
};

export const isFailure = <T extends object>(result: T | ReadFailure): result is ReadFailure =>
    'error' in result;

export const spanOf = (file: string, from: number, to: number): string =>
    from === to ? `${file}:${from}` : `${file}:${from}-${to}`;

interface Span {
    target: string;
    file: string;
    from: number;
    end: number;
    total: number;
    section?: string;
    asked?: string;
}

export async function readMany(
    index: DocsIndex,
    reads: readonly Read[],
    options: ReadManyOptions = {},
): Promise<ReadMany> {
    const hints = { ...CLI_HINTS, ...options.hints };
    const slots: (Span | ReadFailure)[] = [];

    for (const read of reads) {
        const span = await spanFor(index, read, hints);
        if (isFailure(span)) {
            slots.push(span);
            continue;
        }
        // Everything it overlaps or touches folds into the first of them, so a
        // line is printed once however many reads named it.
        const touching = slots.filter(
            (slot): slot is Span =>
                !isFailure(slot) &&
                slot.file === span.file &&
                span.from <= slot.end + 1 &&
                span.end >= slot.from - 1,
        );
        if (touching.length === 0) {
            slots.push(span);
            continue;
        }
        const [first, ...rest] = touching;
        const all = [first!, ...rest, span];
        const from = Math.min(...all.map((s) => s.from));
        const end = Math.max(...all.map((s) => s.end));
        const same = all.every((s) => s.from === from && s.end === end);
        Object.assign(first!, {
            from,
            end,
            section:
                same && all.every((s) => s.section === first!.section) ? first!.section : undefined,
            asked: same ? first!.asked : undefined,
        });
        for (const gone of rest) {
            slots.splice(slots.indexOf(gone), 1);
        }
    }

    const spans = slots.filter((slot): slot is Span => !isFailure(slot));
    const grants = share(
        spans.map((s) => s.end - s.from + 1),
        options.maxLines ?? Infinity,
    );

    const results: ReadResult[] = [];
    for (const slot of slots) {
        if (isFailure(slot)) {
            results.push(slot);
            continue;
        }
        const granted = grants[spans.indexOf(slot)]!;
        const to = slot.from + granted - 1;
        const lines = (await index.lines(slot.file)).slice(slot.from - 1, to);
        const truncated = to < slot.end;
        results.push({
            target: spanOf(slot.file, slot.from, granted > 0 ? to : slot.end),
            file: slot.file,
            from: slot.from,
            to,
            end: slot.end,
            total: slot.total,
            ...(slot.section ? { section: slot.section } : {}),
            ...(slot.asked ? { asked: slot.asked } : {}),
            lines,
            truncated,
            ...(truncated ? { continue: spanOf(slot.file, to + 1, slot.end) } : {}),
        });
    }
    const failed = results.filter(isFailure).length;
    return { results, printed: results.length - failed, failed };
}

async function spanFor(
    index: DocsIndex,
    read: Read,
    hints: ReadHints,
): Promise<Span | ReadFailure> {
    const fail = (error: string, hint: string): ReadFailure => ({
        target: read.target,
        file: read.file,
        error,
        hint,
    });
    const outline = index.file(read.file);
    if (!outline) {
        return fail('no document by that name', hints.document(read.file));
    }
    const total = (await index.lines(read.file)).length;
    const base = { target: read.target, file: read.file, total };

    if (read.section !== undefined) {
        const found = index.resolveSections([read.section], [read.file]);
        const wanted = read.section.toLowerCase();
        const heading = found.find((h) => h.title.toLowerCase() === wanted) ?? found[0];
        if (!heading) {
            return fail(`no section called ${read.section}`, hints.section(read.file));
        }
        return { ...base, from: heading.line, end: heading.end, section: heading.title };
    }

    const from = read.from ?? 1;
    const to = read.to ?? total;
    if (from > total) {
        return fail(
            `line ${from} is past the end; the document has ${total} lines`,
            hints.range(read.file, total),
        );
    }
    return {
        ...base,
        from,
        end: Math.min(to, total),
        ...(to > total && read.to !== undefined ? { asked: `${from}-${to}` } : {}),
    };
}

/**
 * Divides a budget so no request can starve the rest: an even share each, and
 * what a short one does not use is shared again among those still wanting.
 */
function share(sizes: readonly number[], budget: number): number[] {
    const grants = sizes.map(() => 0);
    const order = sizes.map((_, at) => at).sort((a, b) => sizes[a]! - sizes[b]!);
    let left = budget;
    for (const [rank, at] of order.entries()) {
        const fair = Math.floor(left / (order.length - rank));
        grants[at] = Math.min(sizes[at]!, fair === Infinity ? sizes[at]! : fair);
        left -= grants[at]!;
    }
    return grants;
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
