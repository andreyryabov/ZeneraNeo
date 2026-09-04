import type { Embedder } from '@zenera/neo';
import { beginBuild, type Journal } from '../common/progress.ts';
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
import { writeChunks, type ChunkRecord } from './store.ts';

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
    /** texts sent to the embedder at once */
    batch?: number;
    chunk?: ChunkOptions;
    signal?: AbortSignal;
    /** what the documents turned out to hold, before a vector has been paid for */
    onRead?: (summary: BuildSummary) => void;
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
}

const DEFAULT_BATCH = 96;

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
    const journal = beginBuild<Counts, Manifest, Phase>({
        dir: options.out,
        files: options.files,
        embedding: options.embeddingRef ?? options.embedder.id,
        indexer: options.indexer,
        phases: PHASES,
        report: DOCS_REPORT,
    });

    try {
        const corpus = await loadDocuments(options.files, options.cwd, options.chunk);
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
        const vectors = await embedAll(chunks, options, journal);
        journal.phase('writing');
        const written = await writeChunks(options.out, chunks, vectors);

        const manifest: Manifest = {
            version: INDEX_VERSION,
            kind: 'docs',
            createdAt: new Date().toISOString(),
            indexer: options.indexer,
            embedding: {
                ref: options.embeddingRef ?? options.embedder.id,
                id: options.embedder.id,
                dimensions: vectors[0]?.length ?? 0,
            },
            sources,
            counts,
            indexes: { fts: written.fts, vector: written.vector },
        };
        const outline: Outline = { files: corpus.docs.map((doc) => doc.outline) };
        const documents = Object.fromEntries(corpus.docs.map((doc) => [doc.name, doc.text]));

        await writeIndex(options.out, { manifest, outline, documents });
        journal.finish(manifest);
        return { manifest, chunks };
    } catch (err) {
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
): Promise<Float32Array[]> {
    const size = options.batch ?? DEFAULT_BATCH;
    const out: Float32Array[] = [];

    for (let at = 0; at < chunks.length; at += size) {
        const slice = chunks.slice(at, at + size);
        const response = await options.embedder.embed({
            input: slice.map((c) => c.embedText),
            taskType: 'document',
            signal: options.signal,
        });
        if (response.vectors.length !== slice.length) {
            throw new Error(
                `${options.embedder.id} answered ${response.vectors.length} vectors for ${slice.length} texts`,
            );
        }
        out.push(...response.vectors.map((v) => Float32Array.from(v)));
        journal.progress(out.length, chunks.length);
        options.onProgress?.(out.length, chunks.length);
    }
    return out;
}
