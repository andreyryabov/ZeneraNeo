import type { Embedder } from '@zenera/neo';
import { beginBuild, type Journal } from '../common/progress.ts';
import { toEntities, type EntityRecord } from './entities.ts';
import {
    INDEX_VERSION,
    SOURCES_DIR,
    writeIndex,
    type Counts,
    type Manifest,
    type SourceRecord,
} from './files.ts';
import { buildGraph } from './graph.ts';
import { PHASES, SCHEMA_REPORT, type Phase } from './readme.ts';
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
    /** keep a bundled copy of each document in the index. On by default. */
    sources?: boolean;
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

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
    const journal = beginBuild<Counts, Manifest, Phase>({
        dir: options.out,
        files: options.files,
        embedding: options.embeddingRef ?? options.embedder.id,
        indexer: options.indexer,
        phases: PHASES,
        report: SCHEMA_REPORT,
    });

    try {
        const corpus = await loadSpecs(options.files);
        journal.phase('graph');
        const { graph, types } = buildGraph(corpus);
        const entities = toEntities(graph);

        const keep = options.sources !== false;
        const summary: BuildSummary = {
            sources: sourcesOf(corpus, entities, keep),
            counts: {
                methods: entities.filter((e) => e.kind === 'method').length,
                types: entities.filter((e) => e.kind === 'type').length,
                properties: entities.filter((e) => e.kind === 'property').length,
                entities: entities.length,
            },
        };
        journal.read(summary.counts, summary.counts.entities);
        options.onRead?.(summary);

        journal.phase('embedding');
        const vectors = await embedAll(entities, options, journal);
        journal.phase('writing');
        const written = await writeStore(options.out, entities, vectors);

        const manifest: Manifest = {
            version: INDEX_VERSION,
            kind: 'schema',
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

        await writeIndex(options.out, {
            manifest,
            graph,
            types,
            operations: corpus.operations,
            documents: keep ? corpus.documents : {},
        });
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
    journal: Journal<Counts, Manifest, Phase>,
): Promise<Float32Array[]> {
    // Everything in one call. How many texts fit in a request, and how many
    // requests may be in flight, are the embedder's to answer — it knows the
    // model's caps and it is the one that sees the 429s.
    const response = await options.embedder.embed({
        input: entities.map((e) => e.text),
        taskType: 'document',
        signal: options.signal,
        onProgress: (done, total) => {
            journal.progress(done, total);
            options.onProgress?.(done, total);
        },
    });
    return response.vectors.map((v) => Float32Array.from(v));
}

/**
 * Counted off the entities rather than the corpus, so a schema the document
 * never named — an inline request body, say — is credited to the file it came
 * from instead of going missing.
 */
function sourcesOf(
    corpus: Corpus,
    entities: readonly EntityRecord[],
    keep: boolean,
): SourceRecord[] {
    return corpus.docs.map((doc) => {
        const mine = entities.filter((e) => e.source === doc.source);
        const operations = corpus.operations.filter((op) => op.source === doc.source);
        return {
            name: doc.source,
            file: doc.file,
            path: keep ? `${SOURCES_DIR}/${doc.source}.json` : undefined,
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
