import { CliError, EXIT } from '@zenera/cli/lib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MANIFEST_FILE, readHead, type IndexHead, type IndexSpec } from '../common/manifest.ts';
import type { DocFormat } from './parse.ts';

// ---------------------------------------------------------------------------
// What a document index is, on disk
//
// A directory, written in an order that is the whole crash story: the manifest
// goes last, so a half-built index has no manifest and reads as "not indexed"
// rather than as a store that quietly lost half its documents.
//
//   manifest.json   what this index is and what built it
//   outline.json    the headings and tables of every document, read whole
//   sources/        the documents themselves, verbatim
//   lance/          the chunks: the search text, the vectors, the filters
//
// `sources/` is not a convenience here, the way it is for a schema index — it
// is where the answers come from. A search returns line ranges, and the lines
// are read back out of these copies, so what is quoted is the document and not
// a reconstruction of it. That also makes the index one portable thing: nothing
// in it names a path outside itself, so it can be moved, shipped, or mounted
// somewhere else in an agent's sandbox and still answer.
//
// It is also why there is no table of lines. The original design kept one row
// per physical line beside the chunks, carrying the text and its structure. With
// the document itself sitting in `sources/`, that table would be a second copy
// of the same bytes; the per-line structure it also held is derivable from the
// outline, since a section runs from its heading to the next heading at the same
// depth or shallower. One store, one copy, same answers.
//
// `outline.json` is deliberately thin — headings, tables, counts — because it is
// parsed whole every time anything is asked. It is what makes `list`, `show` and
// section scoping work with no store, no embedder and no credential.
// ---------------------------------------------------------------------------

export const INDEX_VERSION = 1;

/** How a document index is found, read, and refused. */
export const DOCS_INDEX: IndexSpec = {
    kind: 'docs',
    version: INDEX_VERSION,
    defaultDir: './docs-db',
    envName: 'ZEN_DOCS_DB',
};

export const OUTLINE_FILE = 'outline.json';
export const LANCE_DIR = 'lance';
export const SOURCES_DIR = 'sources';

export interface HeadingRecord {
    /** the heading's own line, 1-based */
    line: number;
    /** where the section ends, which is the line before the next one at this depth */
    end: number;
    level: number;
    title: string;
    id: string;
    path: string;
}

export interface TableRecord {
    id: string;
    path: string;
    /** the structure path of the section it sits in */
    section: string;
    line: number;
    end: number;
    columns: string[];
    rows: number;
    caption: string;
}

/** One document's shape, without a word of its text. */
export interface FileOutline {
    name: string;
    title: string;
    format: DocFormat;
    lines: number;
    chunks: number;
    headings: HeadingRecord[];
    tables: TableRecord[];
}

export interface Outline {
    files: FileOutline[];
}

export interface DocRecord {
    /** the document's name within the index: a relative path, and its identity */
    name: string;
    /** what the file was called on the machine that built this */
    file: string;
    /** the copy kept beside the index, relative to it */
    path: string;
    sha256: string;
    format: DocFormat;
    title: string;
    bytes: number;
    lines: number;
    sections: number;
    tables: number;
    chunks: number;
}

export interface Counts {
    documents: number;
    chunks: number;
    lines: number;
    sections: number;
    tables: number;
}

export interface Manifest extends IndexHead {
    sources: DocRecord[];
    counts: Counts;
}

export interface WrittenIndex {
    manifest: Manifest;
    outline: Outline;
    /** the documents to keep beside the index, verbatim, by name */
    documents: Readonly<Record<string, string>>;
}

export interface OpenDocs {
    dir: string;
    manifest: Manifest;
    outline: Outline;
}

export const lancePath = (dir: string): string => join(dir, LANCE_DIR);

export async function writeIndex(dir: string, index: WrittenIndex): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, OUTLINE_FILE), JSON.stringify(index.outline));

    for (const [name, text] of Object.entries(index.documents)) {
        const target = join(dir, SOURCES_DIR, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text);
    }
    await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(index.manifest, null, 4)}\n`);
}

export async function openIndex(dir: string): Promise<OpenDocs> {
    const manifest = await readManifest(dir);
    const outline = JSON.parse(await readFile(join(dir, OUTLINE_FILE), 'utf8')) as Outline;
    return { dir, manifest, outline };
}

export const readManifest = (dir: string): Promise<Manifest> => readHead<Manifest>(dir, DOCS_INDEX);

/**
 * A document, verbatim, as it was indexed. The name is looked up in the
 * manifest rather than joined onto the directory, so nothing a caller types
 * ever reaches the filesystem — and a name that is not in the index is told so
 * instead of becoming a path that happens not to exist.
 */
export async function readSource(index: OpenDocs, name: string): Promise<string> {
    const record = index.manifest.sources.find((s) => s.name === name);
    if (!record) {
        throw new CliError(
            `${index.dir} holds no document called ${name}`,
            EXIT.failed,
            `list them with \`zen rag docs list files\``,
        );
    }
    return await readFile(join(index.dir, record.path), 'utf8');
}

/** The same document, split the way every line number in the index counts it. */
export async function readLines(index: OpenDocs, name: string): Promise<string[]> {
    return (await readSource(index, name)).split('\n');
}
