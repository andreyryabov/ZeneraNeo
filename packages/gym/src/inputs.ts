import { invalidError } from '@zenera/cli/lib';
import { isGlob, wildcard } from '@zenera/neo';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// What the user named
//
// Three kinds of input, each a list of files, directories or patterns: the API
// documents (`--schema`, or bare arguments), the story of the world
// (`--story`), and reference material (`--docs`). Nobody is asked to know how
// any of them is indexed; that is gym's business.
//
// A directory named for documents is walked and only the files that actually
// declare `swagger:` or `openapi:` are kept, so pointing at a folder of mixed
// JSON — a project, or an index somebody built — finds the APIs in it. A file
// named outright is taken at its word.
// ---------------------------------------------------------------------------

const SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);

/** Enough for any API collection; far short of a filesystem. */
const MAX_FILES = 5000;

/** `swagger: "2.0"` or `"openapi": "3.1.0"`, at the top of a line. */
const DECLARES = /^\s*["']?(swagger|openapi)["']?\s*:/m;

/**
 * Every API document the arguments name, absolute, de-duplicated, in the order
 * named (and sorted within a directory or a pattern, so a start is repeatable).
 */
export async function expandSchemas(args: readonly string[], cwd: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (file: string): void => {
        if (!seen.has(file)) {
            seen.add(file);
            out.push(file);
        }
    };

    for (const arg of args) {
        const path = resolve(cwd, arg);
        if (isGlob(arg)) {
            const matched = await specsIn(await matching(path));
            if (matched.length === 0) {
                throw invalidError(`no API document matches ${arg}`, globHint(arg));
            }
            matched.forEach(add);
            continue;
        }
        const info = await stat(path).catch(() => undefined);
        if (!info) {
            throw invalidError(`no such file or directory: ${arg}`);
        }
        if (info.isDirectory()) {
            const found = await specsIn(await walk(path, SPEC_EXTENSIONS));
            if (found.length === 0) {
                throw invalidError(
                    `${arg} holds no API document`,
                    'a document is a .yaml, .yml or .json file that declares `swagger:` or `openapi:`',
                );
            }
            found.forEach(add);
            continue;
        }
        if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
            throw invalidError(
                `${arg} is not an API document`,
                'pass the story of the world with --story, and reference material with --docs',
            );
        }
        add(path);
    }
    return out;
}

/**
 * Checks story and docs arguments before anything reads them. They are read by
 * `@zenera/rag`, which takes a named file at its word — so an API document
 * passed here by mistake would quietly become a very long story.
 */
export async function checkTexts(
    args: readonly string[],
    cwd: string,
    flag: '--story' | '--docs',
): Promise<void> {
    for (const arg of args) {
        if (isGlob(arg)) {
            continue;
        }
        const path = resolve(cwd, arg);
        const info = await stat(path).catch(() => undefined);
        if (!info) {
            throw invalidError(`no such file or directory: ${arg}`, `named by ${flag}`);
        }
        if (info.isFile() && SPEC_EXTENSIONS.has(extname(path).toLowerCase())) {
            throw invalidError(
                `${arg} looks like an API document, not ${flag === '--story' ? 'a story' : 'reference material'}`,
                'pass API documents with --schema, or as bare arguments',
            );
        }
    }
}

// ---------------------------------------------------------------------------

/** The files that declare themselves OpenAPI or Swagger; the rest are not ours. */
async function specsIn(files: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
        if (!SPEC_EXTENSIONS.has(extname(file).toLowerCase())) {
            continue;
        }
        const text = await readFile(file, 'utf8').catch(() => '');
        if (DECLARES.test(text)) {
            out.push(file);
        }
    }
    return out;
}

async function walk(root: string, extensions: ReadonlySet<string>): Promise<string[]> {
    const out: string[] = [];
    const queue = [root];
    while (queue.length > 0 && out.length < MAX_FILES) {
        const dir = queue.shift()!;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(path);
            } else if (extensions.has(extname(entry.name).toLowerCase())) {
                out.push(path);
            }
        }
    }
    return out.sort();
}

/** Files under the deepest directory a pattern names outright, that match it. */
async function matching(pattern: string): Promise<string[]> {
    const parts = pattern.split(sep);
    const at = parts.findIndex((part) => isGlob(part));
    const anchor = (at === -1 ? parts : parts.slice(0, at)).join(sep) || sep;
    const root = isAbsolute(anchor) ? anchor : dirname(pattern);
    const match = wildcard(pattern, { caseSensitive: true });
    return (await walk(root, SPEC_EXTENSIONS)).filter((file) => match(file));
}

const globHint = (arg: string): string =>
    `quote the pattern so gym expands it, e.g. --schema '${arg}'`;
