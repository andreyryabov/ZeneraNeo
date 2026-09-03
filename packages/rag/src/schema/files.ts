import { CliError, EXIT } from '@zenera/cli/lib';
import { MultiDirectedGraph } from 'graphology';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiGraph, EdgeAttrs, NodeAttrs } from './graph.ts';
import type { Schema } from './schema.ts';
import type { Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// What an index is, on disk
//
// A directory, and the order it is written in is the whole crash story: the
// manifest goes last, so a half-built index has no manifest and reads as "not
// indexed" rather than as a store that quietly lost half its operations.
//
// `graph.json` is deliberately thin — names, directions, edges — because it is
// parsed whole on every search. The schemas are the bulk of the bytes and are
// wanted only when something is being printed, so they live apart and are read
// on first use.
//
// `sources/` holds the documents themselves, bundled, so the index is one
// portable thing: nothing in it names a path outside itself, it can be moved or
// shipped whole, and the graph can be rebuilt — or re-embedded with another
// model — without going looking for the files it was made from.
// ---------------------------------------------------------------------------

export const INDEX_VERSION = 3;

export const MANIFEST_FILE = 'manifest.json';
export const GRAPH_FILE = 'graph.json';
export const SCHEMAS_FILE = 'schemas.json';
export const OPERATIONS_FILE = 'operations.json';
export const LANCE_DIR = 'lance';
export const SOURCES_DIR = 'sources';

export interface SourceRecord {
    /** the document's name within the index: what every entity's `source` says */
    name: string;
    /** what the file was called on the machine that built this */
    file: string;
    /** the bundled copy, relative to the index; absent when none was kept */
    path?: string;
    sha256: string;
    dialect: string;
    title: string;
    version: string;
    paths: number;
    methods: number;
    types: number;
    properties: number;
}

export interface Counts {
    methods: number;
    types: number;
    properties: number;
    entities: number;
}

export interface Manifest {
    version: number;
    createdAt: string;
    indexer: string;
    /** `ref` as it was typed, `id` as the embedder answers to it */
    embedding: { ref: string; id: string; dimensions: number };
    sources: SourceRecord[];
    counts: Counts;
    /** whether the table carries an fts index, and whether it carries a vector one */
    indexes: { fts: boolean; vector: boolean };
}

export interface WrittenIndex {
    manifest: Manifest;
    graph: ApiGraph;
    types: Readonly<Record<string, Schema>>;
    operations: readonly Operation[];
    /** the bundled documents to keep beside the index, by name */
    documents: Readonly<Record<string, string>>;
}

export interface OpenIndex {
    dir: string;
    manifest: Manifest;
    graph: ApiGraph;
    /** the raw schemas, read once and remembered */
    schemas(): Promise<Record<string, Schema>>;
    /** the operations, likewise */
    operations(): Promise<Operation[]>;
}

export const lancePath = (dir: string): string => join(dir, LANCE_DIR);

export async function writeIndex(dir: string, index: WrittenIndex): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, GRAPH_FILE), JSON.stringify(index.graph.export()));
    await writeFile(join(dir, SCHEMAS_FILE), JSON.stringify(index.types));
    await writeFile(join(dir, OPERATIONS_FILE), JSON.stringify(index.operations));

    const documents = Object.entries(index.documents);
    if (documents.length > 0) {
        await mkdir(join(dir, SOURCES_DIR), { recursive: true });
        for (const [name, text] of documents) {
            await writeFile(join(dir, SOURCES_DIR, `${name}.json`), text);
        }
    }
    await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(index.manifest, null, 4)}\n`);
}

export async function openIndex(dir: string): Promise<OpenIndex> {
    const manifest = await readManifest(dir);
    const graph = new MultiDirectedGraph<NodeAttrs, EdgeAttrs>();
    graph.import(JSON.parse(await readFile(join(dir, GRAPH_FILE), 'utf8')));

    return {
        dir,
        manifest,
        graph,
        schemas: once(() => read<Record<string, Schema>>(dir, SCHEMAS_FILE)),
        operations: once(() => read<Operation[]>(dir, OPERATIONS_FILE)),
    };
}

async function read<T>(dir: string, file: string): Promise<T> {
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as T;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => (pending ??= load());
}

export async function readManifest(dir: string): Promise<Manifest> {
    let text: string;
    try {
        text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
    } catch {
        throw new CliError(
            `${dir} does not hold an index`,
            EXIT.invalid,
            'build one first with `zen rag schema index`',
        );
    }
    const manifest = JSON.parse(text) as Manifest;
    if (manifest.version !== INDEX_VERSION) {
        throw new CliError(
            `${dir} is a version ${manifest.version} index, and this indexer reads version ${INDEX_VERSION}`,
            EXIT.invalid,
            'rebuild it with `zen rag schema index`',
        );
    }
    return manifest;
}

/**
 * A store answers with the neighbours of a vector, and a vector means nothing
 * without the model that produced it. Asking one model's index a question
 * embedded by another returns rows, in an order that is noise.
 *
 * Either spelling is accepted, because `openai:text-embedding-3-small` and
 * `text-embedding-3-small` are one model and which of them was typed is not
 * something anyone should have to remember.
 */
export function assertSameEmbedding(manifest: Manifest, ref: string): void {
    if (ref !== manifest.embedding.ref && ref !== manifest.embedding.id) {
        throw new CliError(
            `this index was built with ${manifest.embedding.ref}, not ${ref}`,
            EXIT.invalid,
            `search it with --embedding ${manifest.embedding.ref}, or rebuild it`,
        );
    }
}
