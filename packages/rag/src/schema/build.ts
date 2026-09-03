import type { Embedder } from '@zenera/neo';
import { relative } from 'node:path';
import { toEntities, type EntityRecord } from './entities.ts';
import {
    INDEX_VERSION,
    writeIndex,
    type Counts,
    type Manifest,
    type SourceRecord,
} from './files.ts';
import { buildGraph } from './graph.ts';
import { beginBuild, type Journal } from './progress.ts';
import { loadSpecs, type Corpus } from './spec.ts';
import { writeStore } from './store.ts';

// ---------------------------------------------------------------------------
// Building an index
//
// Documents in, a directory out. The embedder is passed in rather than
// resolved here: which model made the vectors is recorded in the manifest and
// enforced on every later search, so it is a decision the caller has to have
// made out loud.
// ---------------------------------------------------------------------------

export interface BuildOptions {
    files: readonly string[];
    out: string;
    embedder: Embedder;
    /** the reference as it was written, which is what a later search will type */
    embeddingRef?: string;
    /** told the manifest, so a store can say what wrote it */
    indexer: string;
    /** texts sent to the embedder at once */
    batch?: number;
    signal?: AbortSignal;
    /** what the documents turned out to hold, before a vector has been paid for */
    onRead?: (summary: BuildSummary) => void;
    onProgress?: (done: number, total: number) => void;
}

export interface BuildSummary {
    sources: SourceRecord[];
    counts: Counts;
}

export interface BuildResult {
    manifest: Manifest;
    entities: EntityRecord[];
}

const DEFAULT_BATCH = 96;

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
    const journal = beginBuild({
        dir: options.out,
        files: options.files,
        embedding: options.embeddingRef ?? options.embedder.id,
        indexer: options.indexer,
    });

    try {
        const corpus = await loadSpecs(options.files);
        journal.phase('graph');
        const { graph, types } = buildGraph(corpus);
        const entities = toEntities(graph);

        const summary: BuildSummary = {
            sources: sourcesOf(corpus, entities, options.files, options.out),
            counts: {
                methods: entities.filter((e) => e.kind === 'method').length,
                types: entities.filter((e) => e.kind === 'type').length,
                properties: entities.filter((e) => e.kind === 'property').length,
                entities: entities.length,
            },
        };
        journal.read(summary.counts);
        options.onRead?.(summary);

        journal.phase('embedding');
        const vectors = await embedAll(entities, options, journal);
        journal.phase('writing');
        const written = await writeStore(options.out, entities, vectors);

        const manifest: Manifest = {
            version: INDEX_VERSION,
            createdAt: new Date().toISOString(),
            indexer: options.indexer,
            embedding: {
                ref: options.embeddingRef ?? options.embedder.id,
                id: options.embedder.id,
                dimensions: vectors[0]?.length ?? 0,
            },
            sources: summary.sources,
            counts: summary.counts,
            indexes: { fts: written.fts, vector: written.vector },
        };

        await writeIndex(options.out, { manifest, graph, types, operations: corpus.operations });
        journal.finish(manifest);
        return { manifest, entities };
    } catch (err) {
        journal.fail(err);
        throw err;
    }
}

async function embedAll(
    entities: readonly EntityRecord[],
    options: BuildOptions,
    journal: Journal,
): Promise<Float32Array[]> {
    const size = options.batch ?? DEFAULT_BATCH;
    const out: Float32Array[] = [];

    for (let at = 0; at < entities.length; at += size) {
        const slice = entities.slice(at, at + size);
        const response = await options.embedder.embed({
            input: slice.map((e) => e.text),
            taskType: 'document',
            signal: options.signal,
        });
        if (response.vectors.length !== slice.length) {
            throw new Error(
                `${options.embedder.id} answered ${response.vectors.length} vectors for ${slice.length} texts`,
            );
        }
        out.push(...response.vectors.map((v) => Float32Array.from(v)));
        journal.progress(out.length, entities.length);
        options.onProgress?.(out.length, entities.length);
    }
    return out;
}

/**
 * Counted off the entities rather than the corpus, so a schema the document
 * never named — an inline request body, say — is credited to the file it came
 * from instead of going missing.
 */
function sourcesOf(
    corpus: Corpus,
    entities: readonly EntityRecord[],
    files: readonly string[],
    out: string,
): SourceRecord[] {
    return corpus.docs.map((doc, index) => {
        const mine = entities.filter((e) => e.source === doc.source);
        const operations = corpus.operations.filter((op) => op.source === doc.source);
        const file = files[index];
        return {
            path: file ? relative(out, file) : doc.source,
            sha256: doc.sha256,
            dialect: doc.dialect,
            title: doc.title,
            version: doc.version,
            paths: new Set(operations.map((op) => op.path)).size,
            methods: operations.length,
            types: mine.filter((e) => e.kind === 'type').length,
            properties: mine.filter((e) => e.kind === 'property').length,
        };
    });
}
