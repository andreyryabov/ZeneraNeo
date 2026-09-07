import { CliError, EXIT } from '@zenera/cli/lib';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isGlob, wildcard } from '../common/match.ts';
import type { Chunk, ChunkOptions } from './chunk.ts';
import type { FileOutline } from './files.ts';
import { NO_PARSE_CACHE, openParseCache, parseKey, type ParseCache } from './parse-cache.ts';
import { normalize, type DocFormat } from './parse.ts';
import { parseAll, type Parsed, type ParseInput } from './pool.ts';

// ---------------------------------------------------------------------------
// Finding the documents, and reading them
//
// What can be named is a file, a directory, or a pattern. A directory is walked,
// because "index my notes" is the question people actually have and asking them
// to enumerate it would be answering a different one. Hidden directories and
// `node_modules` are skipped: a document nobody can see is not one anybody meant
// to index.
//
// Every document is given a NAME, which is its path relative to the common root
// of everything that was named — so indexing two release trees keeps
// `nsx_4.1.0/api/routing.md` and `nsx_4.2.0/api/routing.md` apart, and a search
// can be narrowed to one of them with a pattern over exactly that string. The
// name is the identity: it is stamped on every chunk, it is what `sources/`
// files are called, and nothing anywhere records where the file was on the
// machine that built the index.
// ---------------------------------------------------------------------------

/** Markdown, and plain text read as paragraphs. Anything else is not a document. */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt', '.text'] as const;

/** A file larger than this is a data dump, not something anyone wrote. */
const MAX_BYTES = 16 * 1024 * 1024;

/** Enough for a documentation tree; far short of a filesystem. */
const MAX_FILES = 20_000;

export interface LoadedDoc {
    name: string;
    file: string;
    sha256: string;
    bytes: number;
    format: DocFormat;
    /** the document verbatim, CRLF normalized: what goes into `sources/` */
    text: string;
    chunks: Chunk[];
    outline: FileOutline;
}

export interface Corpus {
    docs: LoadedDoc[];
    /** files that were found and not read, with the reason */
    skipped: { name: string; reason: string }[];
    /** documents whose chunks came from a previous build rather than the parser */
    cached: number;
}

export interface LoadOptions {
    chunk?: ChunkOptions;
    /** remember what documents parse to; on by default */
    cache?: boolean;
    /** keep the parses somewhere other than the shared store */
    cacheDir?: string;
    onProgress?: (done: number, total: number, pending: readonly string[]) => void;
}

/**
 * Reading is cheap and parsing is not, so the two are split: every file is read
 * and hashed here, and only the documents the cache has never seen are handed
 * to the pool. On a rebuild of an unchanged corpus that is none of them.
 */
export async function loadDocuments(
    inputs: readonly string[],
    cwd: string,
    options: LoadOptions = {},
): Promise<Corpus> {
    const found = await discover(inputs, cwd);
    if (found.length === 0) {
        throw new CliError(
            'nothing to index',
            EXIT.invalid,
            `no ${DOC_EXTENSIONS.join(', ')} files were found under ${inputs.join(', ')}`,
        );
    }
    const root = commonRoot(found);
    const taken = new Set<string>();
    const chunk = options.chunk ?? {};
    const cache: ParseCache =
        options.cache === false ? NO_PARSE_CACHE : openParseCache(options.cacheDir);

    const read: Read[] = [];
    const skipped: Corpus['skipped'] = [];

    for (const absolute of found) {
        const name = distinct(nameOf(root, absolute), taken);
        const info = await stat(absolute);
        if (info.size > MAX_BYTES) {
            skipped.push({ name, reason: `larger than ${MAX_BYTES / 1024 / 1024} MB` });
            continue;
        }
        const raw = await readFile(absolute);
        read.push({
            name,
            file: basename(absolute),
            sha256: createHash('sha256').update(raw).digest('hex'),
            bytes: raw.byteLength,
            format: formatOf(absolute),
            text: normalize(raw.toString('utf8')),
            key: parseKey(raw, name, chunk),
        });
    }

    const parsed = new Array<Parsed>(read.length);
    const misses: ParseInput[] = [];
    const missAt: number[] = [];

    for (const [at, doc] of read.entries()) {
        const hit = doc.key === undefined ? undefined : cache.get(doc.key);
        if (hit) {
            parsed[at] = hit;
        } else {
            missAt.push(at);
            misses.push({ name: doc.name, text: doc.text, format: doc.format });
        }
    }

    const done = read.length - misses.length;
    options.onProgress?.(done, read.length, []);
    const fresh = await parseAll(misses, {
        chunk,
        onProgress: (at, _of, pending) => options.onProgress?.(done + at, read.length, pending),
    });
    for (const [i, result] of fresh.entries()) {
        const at = missAt[i]!;
        parsed[at] = result;
        const key = read[at]!.key;
        if (key !== undefined) {
            cache.put(key, result);
        }
    }
    cache.commit();

    const docs = read.map((doc, at): LoadedDoc => ({
        name: doc.name,
        file: doc.file,
        sha256: doc.sha256,
        bytes: doc.bytes,
        format: doc.format,
        text: doc.text,
        chunks: parsed[at]!.chunks,
        outline: parsed[at]!.outline,
    }));
    return { docs, skipped, cached: cache.hits };
}

interface Read {
    name: string;
    file: string;
    sha256: string;
    bytes: number;
    format: DocFormat;
    text: string;
    /** absent when the chunk settings cannot be hashed, which means no caching */
    key: string | undefined;
}

export const formatOf = (path: string): DocFormat =>
    ['.txt', '.text'].includes(extname(path).toLowerCase()) ? 'text' : 'markdown';

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

async function discover(inputs: readonly string[], cwd: string): Promise<string[]> {
    const out = new Set<string>();

    for (const input of inputs) {
        const path = resolve(cwd, input);
        if (isGlob(input)) {
            // The pattern is anchored at the deepest directory it names outright,
            // so a walk of the whole tree is never needed to answer one.
            const anchor = staticPrefix(path);
            const match = wildcard(path, { caseSensitive: true });
            for (const file of await walk(anchor)) {
                if (match(file)) {
                    out.add(file);
                }
            }
            continue;
        }
        const info = await stat(path).catch(() => undefined);
        if (!info) {
            throw new CliError(`no such file or directory: ${input}`, EXIT.invalid);
        }
        if (info.isDirectory()) {
            for (const file of await walk(path)) {
                out.add(file);
            }
        } else {
            // A file named outright is indexed whatever it is called: someone
            // who types a name has already decided it is a document.
            out.add(path);
        }
    }
    return [...out].sort();
}

async function walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const queue = [root];

    while (queue.length > 0 && out.length < MAX_FILES) {
        const dir = queue.shift()!;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(path);
            } else if (indexable(entry.name)) {
                out.push(path);
            }
        }
    }
    return out;
}

const indexable = (name: string): boolean =>
    (DOC_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase());

/** The part of a pattern before the first wildcard, which is a real directory. */
function staticPrefix(pattern: string): string {
    const parts = pattern.split(sep);
    const at = parts.findIndex((part) => isGlob(part));
    const head = (at === -1 ? parts : parts.slice(0, at)).join(sep);
    return head && isAbsolute(head) ? head : dirname(pattern.split('*')[0] ?? pattern);
}

/**
 * The deepest directory holding every file, which is what names are taken
 * relative to. One file is its own directory, so a single document is named by
 * its basename rather than by an accident of where it was kept.
 */
function commonRoot(files: readonly string[]): string {
    const parts = files.map((file) => dirname(file).split(sep));
    const first = parts[0] ?? [];
    let at = 0;
    while (at < first.length && parts.every((p) => p[at] === first[at])) {
        at++;
    }
    return first.slice(0, at).join(sep) || sep;
}

function nameOf(root: string, absolute: string): string {
    const rel = relative(root, absolute);
    // A file outside the common root cannot happen by construction; if it ever
    // did, a name climbing out of the index directory must not.
    return !rel || rel.startsWith('..') || isAbsolute(rel)
        ? basename(absolute)
        : rel.split(sep).join('/');
}

function distinct(name: string, taken: Set<string>): string {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) {
        const dot = name.lastIndexOf('.');
        candidate = dot === -1 ? `${name}_${n}` : `${name.slice(0, dot)}_${n}${name.slice(dot)}`;
    }
    taken.add(candidate);
    return candidate;
}
