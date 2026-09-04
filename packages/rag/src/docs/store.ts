import { connect, Index, type Connection, type Table } from '@lancedb/lancedb';
import { CliError, EXIT } from '@zenera/cli/lib';
import { CHUNK_KINDS } from './chunk.ts';
import { lancePath } from './files.ts';

// ---------------------------------------------------------------------------
// The chunk table
//
// One row per chunk, carrying both retrieval texts: `text` is what the
// full-text index reads and `embedText` is what the vector was made from. They
// are different on purpose and are kept side by side so an index can be
// re-embedded without re-reading the documents.
//
// The two legs are run separately rather than through the built-in hybrid
// query, and fused in `search.ts`. Three reasons, none of them cosmetic: the
// built-in fuses on a physical row id, which moves when the table is compacted,
// where a chunk id does not; `mode` already has to offer a vector-only and a
// text-only path, so making hybrid the same shape as those two is one mechanism
// instead of three; and when there is no full-text index, or the query is
// nonsense to it, degrading has to be a decision rather than an exception.
//
// Only closed vocabularies reach the SQL predicate. `kind` is one of seven
// words. A document name is compared against a safe character set first and, if
// it does not pass, is simply not put in the predicate at all — the JavaScript
// filter that runs afterwards is what makes the answer correct, so the clause is
// only ever an optimisation and there is nothing to escape.
// ---------------------------------------------------------------------------

const TABLE = 'chunks';

/** Below this an IVF index has nothing to train on, and a flat scan is faster. */
const VECTOR_INDEX_MIN_ROWS = 2000;

const KINDS = new Set<string>(CHUNK_KINDS);

/** What may go into a string literal in a predicate, and nothing else. */
const SAFE = /^[\w.:/ -]+$/;

export interface ChunkRecord {
    /** `${path}#c${ordinal}` — the fusion key, and stable across compaction */
    id: string;
    /** the document's name in the index: its relative path */
    path: string;
    ordinal: number;
    kind: string;
    /** the full-text document — wider */
    text: string;
    /** what the vector was made from — tighter */
    embedText: string;
    /** the render set, run-length encoded: `1,5,12-40` */
    lineSpec: string;
    bodyStart: number;
    bodyEnd: number;
    structureId: string;
    structurePath: string;
    headings: string;
    tokens: number;
}

export interface StoreFilter {
    kinds?: readonly string[];
    /** document names, exactly as the manifest spells them */
    paths?: readonly string[];
    /** structure path prefixes, as `structurePath LIKE 'x%'` */
    prefixes?: readonly string[];
}

export interface Hit {
    record: ChunkRecord;
    /** 0-based position in this leg's own result list */
    rank: number;
    relevance: number;
}

export interface WriteResult {
    rows: number;
    fts: boolean;
    vector: boolean;
}

export async function writeChunks(
    dir: string,
    rows: readonly ChunkRecord[],
    vectors: readonly Float32Array[],
): Promise<WriteResult> {
    if (rows.length === 0) {
        throw new CliError(
            'the documents hold nothing to index',
            EXIT.invalid,
            'they are empty, or every one of them is blank',
        );
    }
    const db = await connect(lancePath(dir));
    // Every column is always populated — never null — so the Arrow schema is
    // inferred from the first row without a declaration to keep in step.
    const table = await db.createTable(
        TABLE,
        rows.map((row, i) => ({ ...row, vector: vectors[i]! })),
        { mode: 'overwrite' },
    );

    await table.createIndex('text', { config: Index.fts() });
    await table.createIndex('kind', { config: Index.bitmap() });
    for (const column of ['path', 'structurePath'] as const) {
        await table.createIndex(column, { config: Index.btree() });
    }
    const vector = rows.length >= VECTOR_INDEX_MIN_ROWS;
    if (vector) {
        await table.createIndex('vector');
    }
    db.close();
    return { rows: rows.length, fts: true, vector };
}

export class ChunkStore {
    readonly #db: Connection;
    readonly #table: Table;

    constructor(db: Connection, table: Table) {
        this.#db = db;
        this.#table = table;
    }

    static async open(dir: string): Promise<ChunkStore> {
        const db = await connect(lancePath(dir));
        try {
            return new ChunkStore(db, await db.openTable(TABLE));
        } catch {
            db.close();
            throw new CliError(
                `${dir} holds no searchable table`,
                EXIT.invalid,
                'rebuild it with `zen rag docs index`',
            );
        }
    }

    /** Nearest neighbours. Every row has a vector, so nothing has to be excluded. */
    async nearest(vector: Float32Array, filter: StoreFilter, limit: number): Promise<Hit[]> {
        let query = this.#table.query().nearestTo(vector).limit(limit);
        const predicate = where(filter);
        if (predicate) {
            query = query.where(predicate);
        }
        return hits(await query.toArray());
    }

    /**
     * The lexical leg. A missing full-text index, or a query the tokenizer
     * makes nothing of, answers with nothing rather than throwing: a hybrid
     * search that loses one leg is a worse search, not a failed one.
     */
    async matching(text: string, filter: StoreFilter, limit: number): Promise<Hit[]> {
        try {
            let query = this.#table
                .query()
                .fullTextSearch(text, { columns: ['text'] })
                .limit(limit);
            const predicate = where(filter);
            if (predicate) {
                query = query.where(predicate);
            }
            return hits(await query.toArray());
        } catch {
            return [];
        }
    }

    close(): void {
        this.#db.close();
    }
}

// ---------------------------------------------------------------------------

function where(filter: StoreFilter): string {
    return [clause('kind', filter.kinds), clause('path', filter.paths), prefixes(filter.prefixes)]
        .filter(Boolean)
        .join(' AND ');
}

function clause(column: string, values: readonly string[] | undefined): string {
    if (!values || values.length === 0) {
        return '';
    }
    if (column === 'kind') {
        for (const value of values) {
            if (!KINDS.has(value)) {
                throw new Error(`kind cannot be ${JSON.stringify(value)}`);
            }
        }
    } else if (!values.every((value) => SAFE.test(value))) {
        // Left to the JavaScript filter, which is what makes it correct anyway.
        return '';
    }
    return `${column} IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

/**
 * One prefix covers a section and everything nested inside it. `LIKE` alone is
 * too generous — `doc/sec:1` prefixes `doc/sec:10` as well — so this narrows
 * the scan and the caller settles the boundary in JavaScript.
 */
function prefixes(values: readonly string[] | undefined): string {
    if (!values || values.length === 0 || !values.every((value) => SAFE.test(value))) {
        return '';
    }
    return `(${values.map((v) => `structurePath LIKE '${v}%'`).join(' OR ')})`;
}

function hits(rows: readonly unknown[]): Hit[] {
    return rows.map((row, rank) => ({
        record: strip(row as ChunkRecord & Record<string, unknown>),
        rank,
        relevance: score(row as Record<string, unknown>),
    }));
}

/** A lexical query reports a score; a vector one reports a distance. */
function score(row: Record<string, unknown>): number {
    const relevance = row._relevance_score ?? row._score;
    if (typeof relevance === 'number') {
        return relevance;
    }
    const distance = row._distance;
    return typeof distance === 'number' ? 1 / (1 + distance) : 0;
}

function strip(row: ChunkRecord & Record<string, unknown>): ChunkRecord {
    return {
        id: row.id,
        path: row.path,
        ordinal: row.ordinal,
        kind: row.kind,
        text: row.text,
        embedText: row.embedText,
        lineSpec: row.lineSpec,
        bodyStart: row.bodyStart,
        bodyEnd: row.bodyEnd,
        structureId: row.structureId,
        structurePath: row.structurePath,
        headings: row.headings,
        tokens: row.tokens,
    };
}
