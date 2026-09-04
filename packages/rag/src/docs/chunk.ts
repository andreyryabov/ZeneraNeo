import {
    collapse,
    headingLines,
    headingPath,
    type Block,
    type ListItemBlock,
    type ParsedDoc,
    type Section,
    type StructureKind,
    type TableBlock,
    type TableRowBlock,
} from './parse.ts';

// ---------------------------------------------------------------------------
// Cutting a document into the things that get retrieved
//
// A chunk is a SET of lines, not a span of them. It has a contiguous body —
// the part that actually matched — plus the heading lines above it and any
// prelude the body cannot be read without: the header row of a table, the
// opening line of a fence. That set is decided here, at index time, which is
// why a retrieved table row can never come back without its column names and
// why there is no prelude-injection step at the far end.
//
// Cuts land on block boundaries. There is no sentence segmenter, because once
// the structure tree exists the block ends are already known and are already
// safe. A segmenter would earn its keep in exactly one situation — a single
// block over the budget — and that case is handled by splitting on lines and
// accepting it, so the design has one soft spot rather than a stage spread
// across the pipeline for a rare input.
//
// Bodies never overlap; text does, slightly. Fixed-size windows over raw text
// need roughly half of each chunk repeated as damage control, because a blind
// cut lands mid-sentence. Nothing here cuts blindly, so overlapping bodies
// would only double the embedding bill and inflate document frequency. What
// does overlap is a single carried line of text and, for tables, the caption —
// enough that an answer straddling a boundary can still be found from the
// later chunk alone, with no extra row and no extra vector.
// ---------------------------------------------------------------------------

/** Soft target, hard ceiling, and the width at which one table row is too wide. */
export const CHUNK_TOKENS = 384;
export const MAX_CHUNK_TOKENS = 512;
export const TABLE_SLICE_TOKENS = 128;

/** How much of a table its descriptor stands for when no row of it matched. */
export const TABLE_PREVIEW_ROWS = 3;

/**
 * And how many rows may share one. The token budget alone would put a narrow
 * sixteen-row table in a single chunk, so matching one row of it quotes all
 * sixteen — the rows are independent facts, and a reader asking about one is
 * not asking about the other fifteen.
 */
export const TABLE_ROWS_PER_CHUNK = 4;

/**
 * Below this a chunk is merged into its neighbour rather than retrieved alone.
 *
 * BM25 normalises by document length, so a nine-word chunk that happens to
 * contain two query terms outscores a real answer that contains them among a
 * hundred other words. Measured on this repository, a one-line aside about
 * markdown link syntax took full-text rank 0 for "how to create docs index"
 * while the vector leg — correctly — put it 185th. It is not that the chunk is
 * wrong; it is that alone it is not a passage, and a passage is what the
 * lexical index is scoring.
 */
export const MIN_CHUNK_TOKENS = 48;

/**
 * Four characters to a token, which is within about 15% for English prose and
 * wrong for CJK, for dense numeric cells and for long identifiers. It cannot
 * cause a request to fail — 512 estimated tokens sits far below any embedding
 * model's limit, so even a threefold underestimate has headroom. Injectable so
 * a real tokenizer is a one-line swap if the corpus ever needs one.
 */
export const tokenCount = (text: string): number => Math.ceil(text.length / 4);

/** The kinds a chunk can be, which is what `--kind` filters on. */
export const CHUNK_KINDS = [
    'paragraph',
    'list',
    'table',
    'table_row',
    'code',
    'frontmatter',
    'html',
] as const;

export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface ChunkOptions {
    chunkTokens?: number;
    minChunkTokens?: number;
    maxChunkTokens?: number;
    tableSliceTokens?: number;
    tokenCount?: (text: string) => number;
}

export interface Chunk {
    index: number;
    kind: ChunkKind;
    /** the innermost structure node containing the whole body */
    structureId: string;
    structurePath: string;
    /** the breadcrumb, from the document name down to the nearest heading */
    headings: string;
    bodyStart: number;
    bodyEnd: number;
    /** everything that gets rendered: headings, prelude and body, sorted */
    lineNumbers: number[];
    /** the full-text document — wider */
    text: string;
    /** the vector's source — tighter */
    embedText: string;
    tokens: number;
}

interface Body {
    kind: ChunkKind;
    id: string;
    path: string;
    section: Section;
    start: number;
    end: number;
    /** lines the body cannot be read without, outside its own span */
    prelude: number[];
    preludeText: string;
    text: string;
    /** table caption: full-text only, never in the vector */
    caption?: string;
    /** the previous body's last line, text only */
    carry?: string;
}

const PROSE = new Set<StructureKind>(['paragraph', 'blockquote']);

/**
 * What the floor may join. A paragraph and the snippet under it are one
 * thought and read as one; a table or a list has an identity of its own, and a
 * `--kind table` that quietly returned prose would be a worse bargain than a
 * short chunk.
 */
const MERGEABLE = new Set<ChunkKind>(['paragraph', 'code']);

export function chunkDocument(doc: ParsedDoc, options: ChunkOptions = {}): Chunk[] {
    const cut = new Cutter(doc, options);
    return cut.run();
}

class Cutter {
    readonly #doc: ParsedDoc;
    readonly #soft: number;
    readonly #floor: number;
    readonly #hard: number;
    readonly #slice: number;
    readonly #tok: (text: string) => number;
    readonly #bodies: Body[] = [];

    constructor(doc: ParsedDoc, options: ChunkOptions) {
        this.#doc = doc;
        this.#soft = options.chunkTokens ?? CHUNK_TOKENS;
        this.#floor = options.minChunkTokens ?? MIN_CHUNK_TOKENS;
        this.#hard = options.maxChunkTokens ?? MAX_CHUNK_TOKENS;
        this.#slice = options.tableSliceTokens ?? TABLE_SLICE_TOKENS;
        this.#tok = options.tokenCount ?? tokenCount;
    }

    run(): Chunk[] {
        let run: Block[] = [];
        const flush = (): void => {
            if (run.length > 0) {
                this.#prose(run);
                run = [];
            }
        };

        for (const block of this.#doc.blocks) {
            // A run is prose of one kind under one heading. Anything else ends
            // it, which is what keeps a body from crossing a section boundary.
            if (PROSE.has(block.kind) && block.text) {
                if (run.length > 0 && run[0]!.section !== block.section) {
                    flush();
                }
                run.push(block);
                continue;
            }
            flush();
            this.#other(block);
        }
        flush();

        return this.#compact().map((body, index) => this.#finish(body, index));
    }

    /**
     * The floor, applied once at the end rather than inside each cutter: only
     * here is a body's true neighbour known, since prose, code and lists are
     * emitted by three different paths but land in document order.
     */
    #compact(): Body[] {
        const kept: Body[] = [];
        for (const body of this.#bodies) {
            const last = kept[kept.length - 1];
            if (last && this.#joinable(last, body)) {
                kept[kept.length - 1] = this.#join(last, body);
                continue;
            }
            kept.push(body);
        }
        return kept;
    }

    /** Neighbours under one heading, at least one of them too small to stand alone. */
    #joinable(left: Body, right: Body): boolean {
        return (
            left.section === right.section &&
            MERGEABLE.has(left.kind) &&
            MERGEABLE.has(right.kind) &&
            (this.#tok(left.text) < this.#floor || this.#tok(right.text) < this.#floor) &&
            this.#tok(`${left.text}\n${right.text}`) <= this.#soft
        );
    }

    #join(left: Body, right: Body): Body {
        const same = left.kind === right.kind;
        return {
            // Prose wins a mixed pair: the words are what the lexical index reads.
            kind: same ? left.kind : 'paragraph',
            id: same && left.id === right.id ? left.id : left.section.id,
            path: same && left.path === right.path ? left.path : left.section.path,
            section: left.section,
            start: Math.min(left.start, right.start),
            end: Math.max(left.end, right.end),
            prelude: [...new Set([...left.prelude, ...right.prelude])].sort((a, b) => a - b),
            preludeText: [left.preludeText, right.preludeText].filter(Boolean).join('\n'),
            text: `${left.text}\n${right.text}`,
            carry: left.carry,
        };
    }

    #other(block: Block): void {
        switch (block.kind) {
            case 'list':
                return this.#list(block);
            case 'table':
                return this.#table(block);
            case 'code':
                return this.#code(block);
            case 'frontmatter':
                this.#emit(this.#whole(block, 'frontmatter'));
                return;
            case 'html':
                this.#emit(this.#whole(block, 'html'));
                return;
            // A heading is never a body of its own: alone it embeds to almost
            // nothing and would compete with the content under it. It reaches
            // results through the breadcrumb and through the line set of every
            // chunk beneath it, so an empty section loses nothing.
            default:
                return;
        }
    }

    // -----------------------------------------------------------------------
    // prose
    // -----------------------------------------------------------------------

    /**
     * The packer, over a whole run rather than one block. A section of ten
     * hundred-token paragraphs becomes about three well-sized chunks instead of
     * ten weak ones, and it takes no extra pass and no extra constant.
     */
    #prose(run: readonly Block[]): void {
        let acc: Block[] = [];
        let previous: Body | undefined;

        const emit = (): void => {
            if (acc.length === 0) {
                return;
            }
            previous = this.#body(acc, previous);
            this.#emit(previous);
            acc = [];
        };

        for (const block of run) {
            if (acc.length === 0 && this.#tok(block.text) > this.#soft) {
                this.#oversized(block, 'paragraph');
                // Its tail is not the end of a block, so nothing carries forward.
                previous = undefined;
                continue;
            }
            if (this.#tok(proseText(acc) + block.text) > this.#soft) {
                emit();
            }
            acc.push(block);
        }
        emit();
    }

    #body(acc: readonly Block[], previous: Body | undefined): Body {
        const first = acc[0]!;
        const last = acc[acc.length - 1]!;
        // One block addresses itself; several address what contains them all.
        const single = acc.length === 1;
        return {
            kind: 'paragraph',
            id: single ? first.id : first.section.id,
            path: single ? first.path : first.section.path,
            section: first.section,
            start: first.start,
            end: last.end,
            prelude: [],
            preludeText: '',
            text: proseText(acc),
            carry: previous ? this.#lastLine(previous) : undefined,
        };
    }

    /** Text-level overlap only: never a line number, never a body line. */
    #lastLine(body: Body): string | undefined {
        return collapse(this.#doc.lines[body.end - 1] ?? '') || undefined;
    }

    // -----------------------------------------------------------------------
    // lists, code, tables
    // -----------------------------------------------------------------------

    /**
     * An item and its sub-items are one thought, so they are never split from
     * each other; siblings pack together up to the budget.
     */
    #list(block: Block): void {
        const items = block.items ?? [];
        let acc: ListItemBlock[] = [];

        const emit = (): void => {
            if (acc.length === 0) {
                return;
            }
            const first = acc[0]!;
            const last = acc[acc.length - 1]!;
            const single = acc.length === 1;
            this.#emit({
                kind: 'list',
                id: single ? first.id : block.id,
                path: single ? first.path : block.path,
                section: block.section,
                start: first.start,
                end: last.end,
                prelude: [],
                preludeText: '',
                text: acc.map((i) => i.text).join('\n'),
            });
            acc = [];
        };

        for (const item of items) {
            if (
                acc.length > 0 &&
                this.#tok(acc.map((i) => i.text).join('\n') + item.text) > this.#soft
            ) {
                emit();
            }
            acc.push(item);
        }
        emit();
    }

    #code(block: Block): void {
        const opener = collapse(this.#doc.lines[block.start - 1] ?? '');
        if (this.#tok(block.text) <= this.#soft) {
            this.#emit({
                kind: 'code',
                id: block.id,
                path: block.path,
                section: block.section,
                start: block.start,
                end: block.end,
                prelude: [block.start],
                preludeText: opener,
                text: block.text,
            });
            return;
        }
        // Split inside the fence at blank lines: the closest thing a program
        // has to a paragraph break. Both fence lines ride along, or a slice
        // taken from the middle quotes an opening delimiter that never closes.
        for (const span of this.#packLines(block.start + 1, Math.max(block.start, block.end - 1))) {
            this.#emit({
                kind: 'code',
                id: block.id,
                path: block.path,
                section: block.section,
                start: span.start,
                end: span.end,
                prelude: [block.start, block.end],
                preludeText: opener,
                text: this.#slabOf(span.start, span.end),
            });
        }
    }

    #table(block: Block): void {
        const table = block.table;
        if (!table) {
            return;
        }
        const prelude = [table.headerLine, table.separatorLine].filter(
            (line): line is number => line !== undefined,
        );
        const columns = table.columns.filter(Boolean).join(', ');
        const preludeText = columns ? `Columns: ${columns}.` : '';

        // One descriptor per table, however wide. It absorbs the lead-in
        // paragraph — the only sentence in the document that says what the
        // table is about, and otherwise the caption of nothing.
        //
        // Its body is the header and the first few rows. Two rules around
        // nothing say only that a table was here; the rows that answer a
        // question arrive as their own chunks, and what neither reached is
        // left to the omission marker to count.
        const preview = table.rows[Math.min(TABLE_PREVIEW_ROWS, table.rows.length) - 1];
        this.#emit({
            kind: 'table',
            id: block.id,
            path: block.path,
            section: block.section,
            start: table.headerLine,
            end: preview?.line ?? table.separatorLine ?? table.headerLine,
            prelude: [],
            preludeText,
            text: [table.caption, `A table of ${table.rows.length} rows.`]
                .filter(Boolean)
                .join(' '),
        });

        let acc: TableRowBlock[] = [];
        const emit = (): void => {
            if (acc.length === 0) {
                return;
            }
            const first = acc[0]!;
            const last = acc[acc.length - 1]!;
            this.#emit({
                kind: 'table_row',
                id: acc.length === 1 ? first.id : block.id,
                path: acc.length === 1 ? first.path : block.path,
                section: block.section,
                start: first.line,
                end: last.line,
                prelude,
                preludeText,
                text: acc.map((r) => r.text).join(' '),
                caption: table.caption || undefined,
            });
            acc = [];
        };

        for (const row of table.rows) {
            const wide = this.#tok(row.text) > this.#slice;
            if (wide) {
                emit();
                this.#slices(block, table, row, prelude, preludeText);
                continue;
            }
            if (
                acc.length > 0 &&
                (acc.length >= TABLE_ROWS_PER_CHUNK ||
                    this.#tok(acc.map((r) => r.text).join(' ') + row.text) > this.#soft)
            ) {
                emit();
            }
            acc.push(row);
        }
        emit();
    }

    /**
     * One wide row, cut into column groups. Two problems, one cut: a query
     * about one field otherwise competes with a vector averaged over thirty-nine
     * others, and a 400-token row makes every chunk a single row and none of
     * them sharp. The key column rides along in every slice, for the same
     * reason the header does — columns 12 to 18 name nothing on their own.
     *
     * Every slice keeps the row's line numbers and body span, so however many
     * of them match, the row is rendered once.
     */
    #slices(
        block: Block,
        table: TableBlock,
        row: TableRowBlock,
        prelude: number[],
        preludeText: string,
    ): void {
        const key = cellOf(table, row, table.keyColumn);
        const parts: string[] = [];
        let acc: string[] = [];

        for (let at = 0; at < row.cells.length; at++) {
            if (at === table.keyColumn) {
                continue;
            }
            const text = cellOf(table, row, at);
            if (!text) {
                continue;
            }
            if (acc.length > 0 && this.#tok([key, ...acc, text].join(' ')) > this.#slice) {
                parts.push([key, ...acc].join(' '));
                acc = [];
            }
            acc.push(text);
        }
        if (acc.length > 0) {
            parts.push([key, ...acc].join(' '));
        }

        for (const text of parts.length > 0 ? parts : [row.text]) {
            this.#emit({
                kind: 'table_row',
                id: row.id,
                path: row.path,
                section: block.section,
                start: row.line,
                end: row.line,
                prelude,
                preludeText,
                text,
                caption: table.caption || undefined,
            });
        }
    }

    // -----------------------------------------------------------------------

    #whole(block: Block, kind: ChunkKind): Body {
        return {
            kind,
            id: block.id,
            path: block.path,
            section: block.section,
            start: block.start,
            end: block.end,
            prelude: [],
            preludeText: '',
            text: block.text,
        };
    }

    /** A block over the hard ceiling, cut at line boundaries and nowhere better. */
    #oversized(block: Block, kind: ChunkKind): void {
        if (this.#tok(block.text) <= this.#hard) {
            this.#emit(this.#whole(block, kind));
            return;
        }
        for (const span of this.#packLines(block.start, block.end)) {
            this.#emit({
                kind,
                id: block.id,
                path: block.path,
                section: block.section,
                start: span.start,
                end: span.end,
                prelude: [],
                preludeText: '',
                text: this.#slabOf(span.start, span.end),
            });
        }
    }

    /** Line ranges, each the longest that still fits under the hard ceiling. */
    #packLines(from: number, to: number): { start: number; end: number }[] {
        const spans: { start: number; end: number }[] = [];
        let start = from;
        let text = '';

        for (let line = from; line <= to; line++) {
            const next = this.#doc.lines[line - 1] ?? '';
            const merged = text ? `${text}\n${next}` : next;
            if (line > start && this.#tok(merged) > this.#hard) {
                spans.push({ start, end: line - 1 });
                start = line;
                text = next;
            } else {
                text = merged;
            }
        }
        if (start <= to) {
            spans.push({ start, end: to });
        }
        return spans;
    }

    #slabOf(start: number, end: number): string {
        return this.#doc.lines
            .slice(start - 1, end)
            .join('\n')
            .trim();
    }

    #emit(body: Body): void {
        if (body.text.trim()) {
            this.#bodies.push(body);
        }
    }

    /**
     * The two texts diverge in content, not in granularity: same row, same id,
     * one vector and one full-text document. The lexical one is wider because
     * BM25 scores a multi-term query well only when the terms land in the same
     * document; the vector one is tighter because every extra topic pulls the
     * mean-pooled vector toward the middle of the chunk instead of toward
     * anything in it.
     */
    #finish(body: Body, index: number): Chunk {
        const lines = new Set<number>([...headingLines(body.section), ...body.prelude]);
        for (let line = body.start; line <= body.end; line++) {
            lines.add(line);
        }
        const headings = headingPath(body.section);
        const common = [headings, body.preludeText, body.carry, body.text]
            .filter(Boolean)
            .join('\n');

        return {
            index,
            kind: body.kind,
            structureId: body.id,
            structurePath: body.path,
            headings,
            bodyStart: body.start,
            bodyEnd: body.end,
            lineNumbers: [...lines].sort((a, b) => a - b),
            text: body.caption ? `${common}\n${body.caption}` : common,
            embedText: common,
            tokens: this.#tok(common),
        };
    }
}

// ---------------------------------------------------------------------------

const proseText = (blocks: readonly Block[]): string => blocks.map((b) => b.text).join('\n');

const cellOf = (table: TableBlock, row: TableRowBlock, at: number): string => {
    const value = (row.cells[at] ?? '').trim();
    if (!value) {
        return '';
    }
    const column = table.columns[at];
    return column ? `${column}: ${value}.` : `${value}.`;
};

// ---------------------------------------------------------------------------
// The render set, on the wire
//
// A list column would be inferred as list<float64> by LanceDB, which has no
// declared Arrow schema here to correct it. A run-length string costs nothing,
// round-trips exactly, and is the one column in the table a person can read
// with their own eyes when they dump it.
// ---------------------------------------------------------------------------

export function formatLines(numbers: readonly number[]): string {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const spans: string[] = [];
    let at = 0;

    while (at < sorted.length) {
        const start = sorted[at]!;
        let end = start;
        while (at + 1 < sorted.length && sorted[at + 1] === end + 1) {
            end = sorted[++at]!;
        }
        spans.push(start === end ? `${start}` : `${start}-${end}`);
        at++;
    }
    return spans.join(',');
}

export function parseLines(spec: string): number[] {
    const out: number[] = [];
    for (const span of spec.split(',')) {
        const [from, to] = span.split('-');
        // `Number('')` is 0, which would be a line no document has.
        if (!from) {
            continue;
        }
        const start = Number(from);
        if (!Number.isInteger(start)) {
            continue;
        }
        const end = to === undefined ? start : Number(to);
        for (let line = start; line <= (Number.isInteger(end) ? end : start); line++) {
            out.push(line);
        }
    }
    return out;
}
