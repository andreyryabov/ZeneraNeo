import type { Embedder } from '@zenera/neo';
import { embedStream, NO_CACHE, openCache, type VectorCache } from '../common/cache.ts';
import { beginBuild, type Journal, type PhaseTiming } from '../common/progress.ts';
import { formatLines, type ChunkOptions } from './chunk.ts';
import {
    INDEX_VERSION,
    SOURCES_DIR,
    writeIndex,
    type Counts,
    type DocRecord,
    type Manifest,
    type Outline,
} from './files.ts';
import { loadDocuments, type Corpus } from './load.ts';
import { DOCS_REPORT, PHASES, type Phase } from './readme.ts';
import { openChunks, type ChunkRecord, type ChunkWriter } from './store.ts';

// ---------------------------------------------------------------------------
// Building an index
//
// Documents in, a directory out. The embedder is passed in rather than resolved
// here: which model made the vectors is recorded in the manifest and enforced on
// every later search, so it is a decision the caller has to have made out loud.
//
// The copies in `sources/` are not optional, unlike a schema index, where they
// are a record. Here they are where every answer comes from: a search returns
// line ranges and the lines are read back out of them, so an index without them
// could rank passages and never quote one.
// ---------------------------------------------------------------------------

export interface BuildOptions {
    /** files, directories or patterns, as they were named */
    files: readonly string[];
    cwd: string;
    out: string;
    embedder: Embedder;
    /** the reference as it was written, which is what a later search will type */
    embeddingRef?: string;
    /** told the manifest, so a store can say what wrote it */
    indexer: string;
    chunk?: ChunkOptions;
    /** reuse vectors and parses this machine already has; on by default */
    cache?: boolean;
    /** keep them somewhere other than the shared store */
    cacheDir?: string;
    signal?: AbortSignal;
    /** what the documents turned out to hold, before a vector has been paid for */
    onRead?: (summary: BuildSummary) => void;
    /** documents parsed so far, and what the pool is still on */
    onReading?: (done: number, total: number, pending: readonly string[]) => void;
    onProgress?: (done: number, total: number) => void;
}

export interface BuildSummary {
    sources: DocRecord[];
    counts: Counts;
    skipped: Corpus['skipped'];
}

export interface BuildResult {
    manifest: Manifest;
    chunks: ChunkRecord[];
    /** what each phase cost, so a slow build can say which part was slow */
    timings: readonly PhaseTiming[];
    /** what came out of the shared cache instead of being done again */
    reused: Reused;
}

export interface Reused {
    parses: number;
    vectors: number;
}

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
    const journal = beginBuild<Counts, Manifest, Phase>({
        dir: options.out,
        files: options.files,
        embedding: options.embeddingRef ?? options.embedder.id,
        indexer: options.indexer,
        phases: PHASES,
        report: DOCS_REPORT,
    });
    const ref = options.embeddingRef ?? options.embedder.id;
    const cache =
        options.cache === false
            ? NO_CACHE
            : openCache(options.embedder, { ref, dir: options.cacheDir });
    let writer: ChunkWriter | undefined;

    try {
        const corpus = await loadDocuments(options.files, options.cwd, {
            chunk: options.chunk,
            cache: options.cache !== false,
            cacheDir: options.cacheDir,
            onProgress: (done, total, pending) => {
                journal.progress(done, total, pending);
                options.onReading?.(done, total, pending);
            },
        });
        const chunks = recordsOf(corpus);
        const sources = corpus.docs.map((doc): DocRecord => ({
            name: doc.name,
            file: doc.file,
            path: `${SOURCES_DIR}/${doc.name}`,
            sha256: doc.sha256,
            format: doc.format,
            title: doc.outline.title,
            bytes: doc.bytes,
            lines: doc.outline.lines,
            sections: doc.outline.headings.length,
            tables: doc.outline.tables.length,
            chunks: doc.chunks.length,
        }));
        const counts: Counts = {
            documents: sources.length,
            chunks: chunks.length,
            lines: sources.reduce((n, s) => n + s.lines, 0),
            sections: sources.reduce((n, s) => n + s.sections, 0),
            tables: sources.reduce((n, s) => n + s.tables, 0),
        };
        journal.read(counts, chunks.length);
        options.onRead?.({ sources, counts, skipped: corpus.skipped });

        journal.phase('embedding');
        writer = await openChunks(options.out);
        const dimensions = await embedAll(chunks, options, journal, cache, writer);
        journal.phase('writing');
        const written = await writer.finish();

        const manifest: Manifest = {
            version: INDEX_VERSION,
            kind: 'docs',
            createdAt: new Date().toISOString(),
            indexer: options.indexer,
            embedding: {
                ref,
                id: options.embedder.id,
                dimensions,
            },
            sources,
            counts,
            indexes: { fts: written.fts, vector: written.vector },
        };
        const outline: Outline = { files: corpus.docs.map((doc) => doc.outline) };
        const documents = Object.fromEntries(corpus.docs.map((doc) => [doc.name, doc.text]));

        await writeIndex(options.out, { manifest, outline, documents });
        cache.commit();
        journal.finish(manifest);
        return {
            manifest,
            chunks,
            timings: journal.timings,
            reused: { parses: corpus.cached, vectors: cache.hits },
        };
    } catch (err) {
        writer?.close();
        cache.abandon();
        journal.fail(err);
        throw err;
    }
}

/** One row per chunk, with the render set encoded and the document name on it. */
function recordsOf(corpus: Corpus): ChunkRecord[] {
    return corpus.docs.flatMap((doc) =>
        doc.chunks.map((chunk): ChunkRecord => ({
            id: `${doc.name}#c${chunk.index}`,
            path: doc.name,
            ordinal: chunk.index,
            kind: chunk.kind,
            text: chunk.text,
            embedText: chunk.embedText,
            lineSpec: formatLines(chunk.lineNumbers),
            bodyStart: chunk.bodyStart,
            bodyEnd: chunk.bodyEnd,
            structureId: chunk.structureId,
            structurePath: chunk.structurePath,
            headings: chunk.headings,
            tokens: chunk.tokens,
        })),
    );
}

async function embedAll(
    chunks: readonly ChunkRecord[],
    options: BuildOptions,
    journal: Journal<Counts, Manifest, Phase>,
    cache: VectorCache,
    writer: ChunkWriter,
): Promise<number> {
    // A window at a time, rather than the whole corpus in one call. How many
    // texts fit in a request, and how many requests may be in flight, are still
    // the embedder's to answer — it knows the model's caps and it is the one
    // that sees the 429s. What the window decides is only how much is resident.
    return embedStream({
        embedder: options.embedder,
        cache,
        records: chunks,
        textOf: (chunk) => chunk.embedText,
        signal: options.signal,
        onProgress: (done, total) => {
            journal.progress(done, total);
            options.onProgress?.(done, total);
        },
        onWindow: (window, vectors) => writer.add(window, vectors),
    });
}
