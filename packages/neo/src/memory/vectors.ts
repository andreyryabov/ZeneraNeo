// ---------------------------------------------------------------------------
// Vectors — a dense block and a linear scan
//
// No vector database. At the scale agent memory actually reaches — tens of
// thousands of nodes at the very outside — an exact scan over one contiguous
// Float32Array beats an approximate index that costs a native dependency, and
// it is exact, which an ANN index is not. `@zenera/neo` has two runtime
// dependencies for a reason, and none of them ship a `.node` binary.
//
// `Embedder` guarantees unit vectors (`embeddingResponse` normalizes before it
// returns), so cosine similarity here is a bare dot product. If that guarantee
// ever moves, this is the file that silently starts lying.
//
// Deletion is a swap-remove: the last row moves into the hole. That keeps the
// block dense — no tombstones, no compaction pass — at the cost of row indices
// not being stable, which is why nothing outside this file ever holds one.
// ---------------------------------------------------------------------------

const GROWTH = 2;
const INITIAL_ROWS = 64;

export interface Scored {
    id: string;
    score: number;
}

export class VectorBlock {
    readonly #dims: number;
    #ids: string[] = [];
    readonly #index = new Map<string, number>();
    #data: Float32Array;
    #rows = 0;

    constructor(dims: number, capacity = INITIAL_ROWS) {
        this.#dims = dims;
        this.#data = new Float32Array(Math.max(capacity, 1) * dims);
    }

    get dims(): number {
        return this.#dims;
    }

    get rows(): number {
        return this.#rows;
    }

    get ids(): readonly string[] {
        return this.#ids;
    }

    has(id: string): boolean {
        return this.#index.has(id);
    }

    set(id: string, vector: ArrayLike<number>): void {
        if (vector.length !== this.#dims) {
            throw new Error(`expected a ${this.#dims}-dimension vector, got ${vector.length}`);
        }
        let row = this.#index.get(id);
        if (row === undefined) {
            this.#grow(this.#rows + 1);
            row = this.#rows++;
            this.#ids[row] = id;
            this.#index.set(id, row);
        }
        this.#data.set(vector as unknown as number[], row * this.#dims);
    }

    remove(id: string): boolean {
        const row = this.#index.get(id);
        if (row === undefined) {
            return false;
        }
        const last = this.#rows - 1;
        if (row !== last) {
            const moved = this.#ids[last];
            this.#data.copyWithin(row * this.#dims, last * this.#dims, (last + 1) * this.#dims);
            this.#ids[row] = moved;
            this.#index.set(moved, row);
        }
        this.#ids.length = last;
        this.#index.delete(id);
        this.#rows = last;
        return true;
    }

    /** Exact kNN over the rows `allow` accepts. Ties break toward the earlier row. */
    topK(query: ArrayLike<number>, k: number, allow?: (id: string) => boolean): Scored[] {
        if (query.length !== this.#dims) {
            throw new Error(`expected a ${this.#dims}-dimension query, got ${query.length}`);
        }
        const out: Scored[] = [];
        for (let row = 0; row < this.#rows; row++) {
            const id = this.#ids[row];
            if (allow && !allow(id)) {
                continue;
            }
            out.push({ id, score: this.#dot(query, row) });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, k);
    }

    /** The raw block, trimmed to the rows in use — what goes to disk. */
    bytes(): Float32Array {
        return this.#data.subarray(0, this.#rows * this.#dims);
    }

    static load(dims: number, ids: readonly string[], data: Float32Array): VectorBlock {
        const block = new VectorBlock(dims, Math.max(ids.length, 1));
        block.#ids = [...ids];
        block.#rows = ids.length;
        for (let row = 0; row < ids.length; row++) {
            block.#index.set(ids[row], row);
        }
        block.#data.set(data.subarray(0, ids.length * dims), 0);
        return block;
    }

    #dot(query: ArrayLike<number>, row: number): number {
        const base = row * this.#dims;
        let sum = 0;
        for (let i = 0; i < this.#dims; i++) {
            sum += (query[i] as number) * this.#data[base + i];
        }
        return sum;
    }

    #grow(needed: number): void {
        const capacity = this.#data.length / this.#dims;
        if (needed <= capacity) {
            return;
        }
        const next = new Float32Array(Math.max(needed, capacity * GROWTH) * this.#dims);
        next.set(this.#data, 0);
        this.#data = next;
    }
}

// ---------------------------------------------------------------------------
// Lexical fallback
//
// Used when a project configures no embedder. It is worse than embeddings and
// is meant to be: the alternative is memory that silently does nothing, and a
// term-overlap hit on a remembered task is still a hit.
// ---------------------------------------------------------------------------

export function tokenize(v: string): string[] {
    return v
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
}

export function overlap(a: readonly string[], b: readonly string[]): number {
    const set = new Set(b);
    const shared = a.filter((t) => set.has(t)).length;
    return a.length ? shared / a.length : 0;
}

/** Half-life in days: how fast a memory nobody reads falls behind one that is read. */
export const DECAY_HALF_LIFE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Multiplied into similarity, never added: a stale exact match should still beat
 * a fresh irrelevant one, so decay narrows the field rather than reordering it.
 */
export function recencyDecay(lastUsedAt: string, now: number): number {
    const age = now - Date.parse(lastUsedAt);
    if (!Number.isFinite(age) || age <= 0) {
        return 1;
    }
    return 2 ** (-age / DAY_MS / DECAY_HALF_LIFE_DAYS);
}
