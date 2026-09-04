import { connect, Index, type Connection, type Table } from '@lancedb/lancedb';
import { CliError, EXIT } from '@zenera/cli/lib';
import type { EntityRecord } from './entities.ts';
import { lancePath } from './files.ts';

// ---------------------------------------------------------------------------
// The hybrid index
//
// LanceDB holds one table: a row per graph node, a materialized `text` column
// carrying both the embedding and the full-text index, and the handful of
// enum columns a query filters on.
//
// Those closed vocabularies are the *only* thing that reaches the SQL
// predicate. `source` is one of them: its values are the document names the
// index itself wrote, so the store is opened with that list and checks against
// it. Exclusion lists — which arrive from a model, or from a shell — are
// applied afterwards in JavaScript. Escaping those into `where()` would work
// right up until it did not, and there is nothing here that a filter string
// buys.
// ---------------------------------------------------------------------------

const TABLE = 'entities';

/** Below this an IVF index has nothing to train on, and a flat scan is faster. */
const VECTOR_INDEX_MIN_ROWS = 2000;

const KINDS = new Set(['method', 'type', 'property']);
const DIRECTIONS = new Set(['input', 'output', 'both', 'none']);
const METHOD_TYPES = new Set(['read_only', 'read_write', 'n/a']);

export interface StoreFilter {
    kinds?: readonly string[];
    directions?: readonly string[];
    methodTypes?: readonly string[];
    sources?: readonly string[];
}

export interface Hit {
    record: EntityRecord;
    /** 0-based position in this query's own result list */
    rank: number;
    /** what the store thought, where it says; 0 when it does not */
    relevance: number;
}

export interface WriteResult {
    rows: number;
    fts: boolean;
    vector: boolean;
}

export async function writeStore(
    dir: string,
    rows: readonly EntityRecord[],
    vectors: readonly Float32Array[],
): Promise<WriteResult> {
    if (rows.length === 0) {
        throw new CliError(
            'the documents describe nothing to index',
            EXIT.invalid,
            'they have no operations and no component schemas',
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
    for (const column of ['kind', 'direction', 'methodType'] as const) {
        await table.createIndex(column, { config: Index.bitmap() });
    }
    const vector = rows.length >= VECTOR_INDEX_MIN_ROWS;
    if (vector) {
        await table.createIndex('vector');
    }
    db.close();
    return { rows: rows.length, fts: true, vector };
}

export class EntityStore {
    readonly #db: Connection;
    readonly #table: Table;
    readonly #sources: ReadonlySet<string>;

    constructor(db: Connection, table: Table, sources: readonly string[] = []) {
        this.#db = db;
        this.#table = table;
        this.#sources = new Set(sources);
    }

    /** `sources` is the document vocabulary a `sources` filter is checked against. */
    static async open(dir: string, sources: readonly string[] = []): Promise<EntityStore> {
        const db = await connect(lancePath(dir));
        try {
            return new EntityStore(db, await db.openTable(TABLE), sources);
        } catch {
            db.close();
            throw new CliError(
                `${dir} holds no searchable table`,
                EXIT.invalid,
                'rebuild it with `zen rag schema index`',
            );
        }
    }

    /**
     * One hybrid query: the same string goes to the full-text side and, as a
     * vector, to the nearest-neighbour side, and LanceDB fuses the two.
     */
    async search(
        text: string,
        vector: Float32Array,
        filter: StoreFilter,
        limit: number,
    ): Promise<Hit[]> {
        const predicate = where(filter, this.#sources);
        let query = this.#table.query().nearestToText(text).nearestTo(vector).limit(limit);
        if (predicate) {
            query = query.where(predicate);
        }
        const rows = (await query.toArray()) as (EntityRecord & Record<string, unknown>)[];
        return rows.map((row, rank) => ({
            record: strip(row),
            rank,
            relevance: score(row),
        }));
    }

    close(): void {
        this.#db.close();
    }
}

// ---------------------------------------------------------------------------

/** Closed vocabularies only. Anything else is a bug, and is treated as one. */
function where(filter: StoreFilter, sources: ReadonlySet<string>): string {
    const clauses = [
        clause('kind', filter.kinds, KINDS),
        clause('direction', filter.directions, DIRECTIONS),
        clause('methodType', filter.methodTypes, METHOD_TYPES),
        clause('source', filter.sources, sources),
    ].filter(Boolean);
    return clauses.join(' AND ');
}

function clause(
    column: string,
    values: readonly string[] | undefined,
    allowed: ReadonlySet<string>,
): string {
    if (!values || values.length === 0) {
        return '';
    }
    for (const value of values) {
        if (!allowed.has(value)) {
            throw new Error(`${column} cannot be ${JSON.stringify(value)}`);
        }
    }
    return `${column} IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

/** A hybrid query reports relevance; a one-sided one reports a distance. */
function score(row: Record<string, unknown>): number {
    const relevance = row._relevance_score ?? row._score;
    if (typeof relevance === 'number') {
        return relevance;
    }
    const distance = row._distance;
    return typeof distance === 'number' ? 1 / (1 + distance) : 0;
}

function strip(row: EntityRecord & Record<string, unknown>): EntityRecord {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        parent: row.parent,
        doc: row.doc,
        direction: row.direction,
        methodType: row.methodType,
        httpMethod: row.httpMethod,
        path: row.path,
        source: row.source,
        signature: row.signature,
        required: row.required,
        text: row.text,
    };
}
