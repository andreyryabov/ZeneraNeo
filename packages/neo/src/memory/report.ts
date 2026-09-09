import { readFile, stat } from 'node:fs/promises';
import { hostPath } from './files.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryEdge, MemoryFile, MemoryNode } from './types.ts';

// ---------------------------------------------------------------------------
// The memory, flattened for reading
//
// This is the debugging view, and it is deliberately the *whole* graph: no
// mask, no ranking, no recall. Everything a mask would hide is exactly what
// you are looking for when a mask is the thing that is wrong, so audiences
// arrive as data to filter by rather than as a filter already applied.
//
// The one thing it does not do is grow without bound. A remembered file can be
// two megabytes and there can be a lot of them, so content is inlined up to a
// ceiling and replaced by a reason past it — a page that fails to open tells
// you nothing about the memory it was supposed to show.
// ---------------------------------------------------------------------------

/** Beyond this a file is named and measured, not shown. */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** Rendered inline as a data URL; anything else is offered as a path. */
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
};

/** Why a remembered file is not shown. */
export type Omitted = 'too-big' | 'binary' | 'missing' | 'unreadable';

export interface ReportNode {
    id: string;
    kind: string;
    text: string;
    audience: string[];
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string;
    useCount: number;
    revision: number;
    metadata?: Record<string, unknown>;
    file?: MemoryFile;
    /** the file's text, when it is text and small enough to show */
    content?: string;
    /** an image file, as a data URL */
    image?: string;
    omitted?: Omitted;
    /** superseded by a newer node; still here, because why it changed matters */
    stale: boolean;
    /** edges touching this node, in either direction */
    degree: number;
}

export interface MemoryReport {
    title: string;
    dir: string;
    generatedAt: string;
    embedding?: { model: string; dimensions: number };
    vectors?: { rows: number; dims: number; bytes: number };
    nodes: ReportNode[];
    edges: MemoryEdge[];
    /** every kind present, for the filter */
    kinds: string[];
    /** every audience present, for the filter */
    audiences: string[];
}

export interface MemoryReportOptions {
    title?: string;
    /** ceiling on inlined file content; 0 to inline nothing */
    maxContentBytes?: number;
    /** override the clock, for tests */
    now?: () => string;
}

export async function buildMemoryReport(
    store: MemoryStore,
    opts: MemoryReportOptions = {},
): Promise<MemoryReport> {
    const graph = store.graph;
    const nodes = graph.nodes();
    const edges = graph.edges();
    const stale = graph.superseded();
    const limit = opts.maxContentBytes ?? MAX_CONTENT_BYTES;

    const degree = new Map<string, number>();
    for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    // Files are read in parallel: one memory can hold hundreds, and they are
    // independent.
    const built = await Promise.all(
        nodes.map(async (n) => ({
            ...plain(n),
            stale: stale.has(n.id),
            degree: degree.get(n.id) ?? 0,
            ...(n.file ? await body(store.dir, n.file, limit) : {}),
        })),
    );

    const vectors = store.vectors;
    return {
        title: opts.title ?? 'Memory',
        dir: store.dir,
        generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
        embedding: store.embedding,
        vectors: vectors
            ? { rows: vectors.rows, dims: vectors.dims, bytes: vectors.rows * vectors.dims * 4 }
            : undefined,
        nodes: built,
        edges,
        kinds: [...new Set(nodes.map((n) => n.kind))].sort(),
        audiences: [...new Set(nodes.flatMap((n) => n.audience))].sort(),
    };
}

/** The node's own fields, without the graph attributes graphology adds. */
function plain(n: MemoryNode): Omit<ReportNode, 'stale' | 'degree'> {
    return {
        id: n.id,
        kind: n.kind,
        text: n.text,
        audience: [...n.audience],
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        lastUsedAt: n.lastUsedAt,
        useCount: n.useCount,
        revision: n.revision,
        metadata: n.metadata,
        file: n.file,
    };
}

/**
 * A remembered file, as much of it as is worth carrying. The recorded size is
 * not trusted for the decision — the bytes on disk are what the page would
 * have to hold — and a file that has gone missing says so rather than making
 * the node look contentless.
 */
async function body(
    dir: string,
    file: MemoryFile,
    limit: number,
): Promise<Pick<ReportNode, 'content' | 'image' | 'omitted'>> {
    const path = hostPath(dir, file);
    let size: number;
    try {
        size = (await stat(path)).size;
    } catch {
        return { omitted: 'missing' };
    }
    if (size > limit) {
        return { omitted: 'too-big' };
    }
    let buf: Buffer;
    try {
        buf = await readFile(path);
    } catch {
        return { omitted: 'unreadable' };
    }
    if (IMAGE_FORMATS.has(file.format)) {
        return { image: `data:${MIME[file.format]};base64,${buf.toString('base64')}` };
    }
    // A NUL byte in the first few KiB is the cheap, boring test for "this is
    // not text", and it is right about every format anyone remembers on purpose.
    if (buf.subarray(0, 8192).includes(0)) {
        return { omitted: 'binary' };
    }
    return { content: buf.toString('utf8') };
}
