import { CliError, EXIT } from '@zenera/cli/lib';
import { MultiDirectedGraph } from 'graphology';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILE, readHead, type IndexHead, type IndexSpec } from '../common/manifest.ts';
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

/** How a schema index is found, read, and refused. */
export const SCHEMA_INDEX: IndexSpec = {
    kind: 'schema',
    version: INDEX_VERSION,
    defaultDir: './schema-db',
    envName: 'ZEN_SCHEMA_DB',
};

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

export interface Manifest extends IndexHead {
    sources: SourceRecord[];
    counts: Counts;
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

/**
 * The bundled document as it was indexed. Kept only when the index was built
 * with sources, which is why the manifest is asked first: the difference
 * between "no such document" and "this index did not keep them" is the whole
 * of what the caller can do next.
 */
export async function readSource(dir: string, name: string): Promise<string | undefined> {
    const manifest = await readManifest(dir);
    const record = manifest.sources.find((s) => s.name === name);
    if (!record) {
        throw new CliError(
            `${dir} holds no document called ${name}`,
            EXIT.failed,
            `it has: ${manifest.sources.map((s) => s.name).join(', ')}`,
        );
    }
    if (!record.path) {
        return undefined;
    }
    return await readFile(join(dir, record.path), 'utf8');
}

export const readManifest = (dir: string): Promise<Manifest> =>
    readHead<Manifest>(dir, SCHEMA_INDEX);
