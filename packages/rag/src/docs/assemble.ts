import type { HeadingRecord } from './files.ts';
import type { DocsIndex, Match } from './search.ts';

// ---------------------------------------------------------------------------
// From matches to something worth reading
//
// A ranked list of chunks is not an answer. What is wanted is the document,
// with the parts that matched still in it and the parts that did not clearly
// gone — so the lines are quoted verbatim out of `sources/`, numbered as they
// are in the file, and everything skipped between them is marked and named.
//
// The marker matters more than it looks. A reader — a person or a model — that
// is handed four passages with no sign of a gap will read them as consecutive
// and reason about the document it did not get. `... 42 lines omitted (Rate
// limits, Retries) ...` says both that something is missing and what it was,
// which is exactly enough to ask the next question, and asking the next
// question is the whole point of the tool.
// ---------------------------------------------------------------------------

export interface AssembleOptions {
    /** extra lines quoted before each matching body */
    before?: number;
    after?: number;
    /** a ceiling on the whole answer, so one long section cannot eat it */
    maxLines?: number;
    /** two ranges closer than this are joined rather than marked */
    mergeGap?: number;
}

export interface Segment {
    start: number;
    end: number;
    /** the lines themselves, verbatim */
    lines: string[];
}

export interface Omission {
    start: number;
    end: number;
    count: number;
    /** the headings the skipped lines covered, so the gap has a name */
    sections: string[];
}

export type Piece = ({ type: 'segment' } & Segment) | ({ type: 'omission' } & Omission);

export interface Excerpt {
    path: string;
    title: string;
    score: number;
    /** what landed in this document, best first */
    matches: Match[];
    pieces: Piece[];
    /** lines actually quoted */
    shown: number;
    /** the document's length, so a reader knows what fraction this is */
    lines: number;
}

export interface Assembly {
    files: Excerpt[];
    shown: number;
    /** true when the line budget cut something that had matched */
    truncated: boolean;
}

export const DEFAULT_BEFORE = 0;
export const DEFAULT_AFTER = 0;
export const DEFAULT_MAX_LINES = 400;
export const DEFAULT_MERGE_GAP = 3;

interface Range {
    start: number;
    end: number;
}

export async function assemble(
    index: DocsIndex,
    matches: readonly Match[],
    options: AssembleOptions = {},
): Promise<Assembly> {
    const before = options.before ?? DEFAULT_BEFORE;
    const after = options.after ?? DEFAULT_AFTER;
    const gap = options.mergeGap ?? DEFAULT_MERGE_GAP;
    let budget = options.maxLines ?? DEFAULT_MAX_LINES;

    const files: Excerpt[] = [];
    let truncated = false;
    let shown = 0;

    for (const [path, group] of byFile(matches)) {
        const outline = index.file(path);
        const source = await index.lines(path);
        const total = outline?.lines ?? source.length;
        const wanted = ranges(lineSet(group, before, after, total), gap);

        const pieces: Piece[] = [];
        let quoted = 0;
        let last: Range | undefined;

        for (const range of wanted) {
            if (budget <= 0) {
                truncated = true;
                break;
            }
            const end = Math.min(range.end, range.start + budget - 1);
            if (last) {
                pieces.push(omission(last.end + 1, range.start - 1, outline?.headings ?? []));
            }
            pieces.push({
                type: 'segment',
                start: range.start,
                end,
                lines: source.slice(range.start - 1, end),
            });
            const count = end - range.start + 1;
            quoted += count;
            budget -= count;
            if (end < range.end) {
                truncated = true;
            }
            last = { start: range.start, end };
        }
        if (last && last.end < total) {
            pieces.push(omission(last.end + 1, total, outline?.headings ?? []));
        }
        if (pieces.length === 0) {
            continue;
        }
        shown += quoted;
        files.push({
            path,
            title: outline?.title ?? path,
            score: group[0]!.score,
            matches: group,
            pieces,
            shown: quoted,
            lines: total,
        });
    }
    return { files, shown, truncated };
}

// ---------------------------------------------------------------------------

/** Documents in the order their best match placed, matches within them likewise. */
function byFile(matches: readonly Match[]): [string, Match[]][] {
    const groups = new Map<string, Match[]>();
    for (const item of matches) {
        const group = groups.get(item.path);
        if (group) {
            group.push(item);
        } else {
            groups.set(item.path, [item]);
        }
    }
    return [...groups.entries()];
}

/**
 * Every line the answer wants. A chunk carries its own render set — its
 * headings, a table's header row, the line its body started on — and `before`
 * and `after` widen the body only, so context is padding around the match and
 * never around a heading quoted from elsewhere in the file.
 */
function lineSet(
    matches: readonly Match[],
    before: number,
    after: number,
    total: number,
): Set<number> {
    const wanted = new Set<number>();
    const add = (line: number): void => {
        if (line >= 1 && line <= total) {
            wanted.add(line);
        }
    };

    for (const item of matches) {
        for (const line of item.lineNumbers) {
            add(line);
        }
        for (let line = item.bodyStart - before; line <= item.bodyEnd + after; line++) {
            add(line);
        }
    }
    return wanted;
}

/** Contiguous runs, with runs closer together than `gap` joined into one. */
function ranges(wanted: Set<number>, gap: number): Range[] {
    const sorted = [...wanted].sort((a, b) => a - b);
    const out: Range[] = [];

    for (const line of sorted) {
        const last = out.at(-1);
        if (last && line - last.end <= gap + 1) {
            last.end = line;
        } else {
            out.push({ start: line, end: line });
        }
    }
    return out;
}

function omission(start: number, end: number, headings: readonly HeadingRecord[]): Piece {
    const named = headings.filter((h) => h.line >= start && h.line <= end).map((h) => h.title);
    return {
        type: 'omission',
        start,
        end,
        count: end - start + 1,
        // A gap covering thirty headings is a gap; naming all of them is noise.
        sections: named.slice(0, 6),
    };
}
