import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph } from './graph.ts';
import { MemoryError } from './types.ts';
import { VectorBlock } from './vectors.ts';

// ---------------------------------------------------------------------------
// What a memory is, on disk
//
// A directory, and the order it is written in is the whole crash story: the
// manifest goes last, so a half-written memory has no manifest and reads as
// empty rather than as a graph that quietly lost its vectors. Every file lands
// through a temporary name and a rename, which on a local filesystem is atomic,
// so a reader never sees half a graph.
//
// The lock is advisory and per directory. Memory is project-scoped, and two
// runs of the same project writing the same graph would interleave commits and
// lose edges — but a lock whose process is gone is stale by definition and gets
// taken, because a crashed run must not make a project permanently unusable.
//
// Vectors live beside the graph rather than inside it. `graph.json` is parsed
// whole on open and a few thousand embeddings inflate to megabytes of JSON
// numbers; the same data as raw little-endian float32 is a quarter the size and
// needs no parsing at all.
// ---------------------------------------------------------------------------

export const MEMORY_VERSION = 1;

export const GRAPH_FILE = 'graph.json';
export const VECTORS_FILE = 'vectors.f32';
export const VECTOR_IDS_FILE = 'vectors.json';
export const MANIFEST_FILE = 'manifest.json';
export const FILES_DIR = 'files';
export const LOCK_FILE = '.lock';

export interface MemoryEmbedding {
    model: string;
    dimensions: number;
}

export interface MemoryManifest {
    version: number;
    /** absent when the project configured no embedder and ranks lexically */
    embedding?: MemoryEmbedding;
    nodes: number;
    edges: number;
    updatedAt: string;
}

interface Lock {
    pid: number;
    host: string;
    startedAt: string;
}

export interface OpenOptions {
    /** the embedder the caller intends to use; a mismatch with the manifest is fatal */
    embedding?: MemoryEmbedding;
    /** take the directory lock; off for read-only inspection (`zen memory ls`) */
    lock?: boolean;
}

export class MemoryStore {
    readonly dir: string;
    readonly graph: MemoryGraph;
    #embedding?: MemoryEmbedding;
    #vectors?: VectorBlock;
    #locked = false;

    private constructor(
        dir: string,
        graph: MemoryGraph,
        vectors: VectorBlock | undefined,
        embedding: MemoryEmbedding | undefined,
    ) {
        this.dir = dir;
        this.graph = graph;
        this.#vectors = vectors;
        this.#embedding = embedding;
    }

    static async open(dir: string, opts: OpenOptions = {}): Promise<MemoryStore> {
        await mkdir(join(dir, FILES_DIR), { recursive: true });
        const manifest = await readManifest(dir);

        if (manifest?.embedding && opts.embedding) {
            const a = manifest.embedding;
            const b = opts.embedding;
            if (a.model !== b.model || a.dimensions !== b.dimensions) {
                throw new MemoryError(
                    `this memory was embedded with ${a.model} (${a.dimensions}d), ` +
                        `but ${b.model} (${b.dimensions}d) is configured`,
                    're-embed it with `zen memory reembed`, or restore the original model',
                );
            }
        }

        const graph = manifest
            ? MemoryGraph.from(JSON.parse(await readFile(join(dir, GRAPH_FILE), 'utf8')))
            : new MemoryGraph();
        const embedding = opts.embedding ?? manifest?.embedding;
        const vectors = manifest && embedding ? await readVectors(dir, embedding) : undefined;

        const store = new MemoryStore(dir, graph, vectors, embedding);
        if (opts.lock !== false) {
            store.#claim();
        }
        return store;
    }

    get embedding(): MemoryEmbedding | undefined {
        return this.#embedding;
    }

    /**
     * Records the vectoriser actually in use. A width is only knowable from a
     * real response, so a memory embedded for the first time learns it here
     * rather than making the caller declare a number it would have to keep in
     * step with the model.
     */
    adopt(embedding: MemoryEmbedding): void {
        const held = this.#embedding;
        if (held) {
            if (held.model !== embedding.model || held.dimensions !== embedding.dimensions) {
                throw new MemoryError(
                    `this memory was embedded with ${held.model} (${held.dimensions}d), ` +
                        `but ${embedding.model} (${embedding.dimensions}d) is configured`,
                    're-embed it with `zen memory reembed`, or restore the original model',
                );
            }
            return;
        }
        this.#embedding = embedding;
    }

    /** Absent when no embedder is configured; recall then falls back to term overlap. */
    get vectors(): VectorBlock | undefined {
        if (!this.#vectors && this.#embedding) {
            this.#vectors = new VectorBlock(this.#embedding.dimensions);
        }
        return this.#vectors;
    }

    filePath(name: string): string {
        return join(this.dir, FILES_DIR, name);
    }

    /** Manifest last: a torn commit reads as no memory, never as a partial one. */
    async commit(): Promise<void> {
        await atomic(join(this.dir, GRAPH_FILE), JSON.stringify(this.graph.export()));

        const vectors = this.#vectors;
        if (vectors) {
            const raw = vectors.bytes();
            await atomic(
                join(this.dir, VECTORS_FILE),
                new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
            );
            await atomic(
                join(this.dir, VECTOR_IDS_FILE),
                JSON.stringify({ dims: vectors.dims, ids: vectors.ids }),
            );
        }

        const manifest: MemoryManifest = {
            version: MEMORY_VERSION,
            ...(this.#embedding ? { embedding: this.#embedding } : {}),
            nodes: this.graph.order,
            edges: this.graph.size,
            updatedAt: new Date().toISOString(),
        };
        await atomic(join(this.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 4)}\n`);
    }

    release(): void {
        if (!this.#locked) {
            return;
        }
        this.#locked = false;
        try {
            unlinkSync(join(this.dir, LOCK_FILE));
        } catch {
            // Already gone, or taken over as stale: neither is worth failing a run for.
        }
    }

    /**
     * `wx` makes the create and the check one operation, so two runs racing for
     * the same project cannot both win.
     */
    #claim(): void {
        const path = join(this.dir, LOCK_FILE);
        const lock: Lock = {
            pid: process.pid,
            host: hostname(),
            startedAt: new Date().toISOString(),
        };
        const body = `${JSON.stringify(lock, null, 4)}\n`;
        try {
            writeFileSync(path, body, { flag: 'wx' });
            this.#locked = true;
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw err;
            }
        }
        const held = readLock(path);
        if (held && held.host === hostname() && alive(held.pid)) {
            throw new MemoryError(
                `this memory is in use (pid ${held.pid}, since ${held.startedAt})`,
                'wait for that run to finish, or remove .lock if it crashed',
            );
        }
        writeFileSync(path, body);
        this.#locked = true;
    }
}

async function readManifest(dir: string): Promise<MemoryManifest | undefined> {
    try {
        const manifest = JSON.parse(
            await readFile(join(dir, MANIFEST_FILE), 'utf8'),
        ) as MemoryManifest;
        if (manifest.version !== MEMORY_VERSION) {
            throw new MemoryError(
                `this memory is version ${manifest.version}, but this build reads version ${MEMORY_VERSION}`,
                'export it with the older build, or start a new memory',
            );
        }
        return manifest;
    } catch (err) {
        if (err instanceof MemoryError) {
            throw err;
        }
        return undefined;
    }
}

async function readVectors(
    dir: string,
    embedding: MemoryEmbedding,
): Promise<VectorBlock | undefined> {
    let ids: string[];
    let dims: number;
    try {
        const meta = JSON.parse(await readFile(join(dir, VECTOR_IDS_FILE), 'utf8')) as {
            dims: number;
            ids: string[];
        };
        ids = meta.ids;
        dims = meta.dims;
    } catch {
        return new VectorBlock(embedding.dimensions);
    }
    if (dims !== embedding.dimensions) {
        return new VectorBlock(embedding.dimensions);
    }
    const raw = await readFile(join(dir, VECTORS_FILE));
    // Copied rather than viewed: a Buffer from the pool is not guaranteed to sit
    // on a 4-byte boundary, and Float32Array over an unaligned buffer throws.
    const data = new Float32Array(Math.floor(raw.byteLength / 4));
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).set(raw);
    return VectorBlock.load(dims, ids, data);
}

async function atomic(path: string, body: string | Uint8Array): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body);
    try {
        await rename(tmp, path);
    } catch (err) {
        await rm(tmp, { force: true });
        throw err;
    }
}

function readLock(path: string): Lock | undefined {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Lock;
    } catch {
        return undefined;
    }
}

/**
 * `kill(pid, 0)` sends no signal and only asks whether the process exists.
 * EPERM means it exists and belongs to someone else, which still counts.
 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}
