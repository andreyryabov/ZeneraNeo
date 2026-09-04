import { CliError, EXIT } from '@zenera/cli/lib';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { MANIFEST_FILE, type IndexHead, type IndexKind, type IndexSpec } from './manifest.ts';

// ---------------------------------------------------------------------------
// Which index, when nobody said
//
// `--dir` and the environment variable are taken as written, missing or not:
// naming a directory that turns out not to hold an index has to fail saying so,
// because quietly using a different one would be a worse answer than an error.
//
// With neither, the directory is looked for. There is no list of blessed names
// here and there should not be — an index is self-describing, so what is being
// looked for is a `manifest.json`, not a directory called `schema-db`. That
// name is only what a *new* index is given, and nothing reads it back. The
// search is nearest-first: this directory, then what is under it, then up a
// level and again, so `/assets/…/whatever` is reachable from `/workspace`
// because the two meet at a shared root on the way up.
//
// The manifest is read rather than merely counted, because a tree holding both
// an API index and a document index has two answers to "the nearest index" and
// only one of them is the one being asked for. Scoping the search by kind is
// what stops the other from being found — and stops two subjects that happen to
// sit side by side from reading as an ambiguity.
//
// Three things bound it, and each is bounding a different kind of mistake.
// Depth and a visit budget bound the cost. The ceiling — the home directory,
// or the filesystem root when the search began outside it — bounds the
// blast radius, because an index in someone else's tree is not yours. And two
// indexes at the same distance is an ambiguity rather than a tie to break:
// choosing one silently is the one failure worth ruling out entirely, since
// the wrong index does not error, it answers confidently about another corpus.
// ---------------------------------------------------------------------------

/** Far enough to climb out of a package into its workspace, not far enough to roam. */
const MAX_LEVELS = 6;

/** How far below a directory an index may sit and still count as being in it. */
const MAX_DEPTH = 3;

/** A directory with more entries than this is a data store, not a place to keep an index. */
const MAX_ENTRIES = 128;

/** Directories the whole search may read, however it is shaped. */
const MAX_VISITS = 400;

/** How the directory was arrived at, which is what decides whether to say so. */
export type DirSource = 'flag' | 'env' | 'found' | 'default';

export interface Located {
    dir: string;
    from: DirSource;
}

export interface LocateOptions {
    env?: NodeJS.ProcessEnv;
    /** do not climb above this; the home directory, or the root, by default */
    ceiling?: string;
}

export function locateIndex(
    cwd: string,
    flag: string | undefined,
    spec: IndexSpec,
    options: LocateOptions = {},
): Located {
    const env = options.env ?? process.env;
    if (flag) {
        return { dir: resolve(cwd, flag), from: 'flag' };
    }
    const named = env[spec.envName]?.trim();
    if (named) {
        return { dir: resolve(cwd, named), from: 'env' };
    }
    const found = search(resolve(cwd), options.ceiling ?? ceilingFor(cwd), spec);
    // Nothing found still answers with the default, so the error names the
    // directory everyone expects rather than the last place that was searched.
    return found
        ? { dir: found, from: 'found' }
        : { dir: resolve(cwd, spec.defaultDir), from: 'default' };
}

/** Where a new index goes: the same environment variable, minus the search. */
export function outputDir(
    cwd: string,
    flag: string | undefined,
    spec: IndexSpec,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolve(cwd, flag ?? env[spec.envName]?.trim() ?? spec.defaultDir);
}

/** An index of this kind is a directory with a manifest saying so; nothing else is asserted. */
export function isIndex(dir: string, kind: IndexKind): boolean {
    let text: string;
    try {
        text = readFileSync(join(dir, MANIFEST_FILE), 'utf8');
    } catch {
        return false;
    }
    let found: IndexKind | undefined;
    try {
        found = (JSON.parse(text) as Partial<IndexHead>).kind;
    } catch {
        // A manifest too broken to parse is still an index, and saying so is
        // what gets the caller that error instead of "nothing found".
        return true;
    }
    return (found ?? 'schema') === kind;
}

// ---------------------------------------------------------------------------

interface Budget {
    left: number;
    /** subtrees already searched, so climbing does not walk back down into them */
    seen: Set<string>;
}

function search(cwd: string, ceiling: string, spec: IndexSpec): string | undefined {
    const budget: Budget = { left: MAX_VISITS, seen: new Set() };
    let dir = cwd;

    for (let level = 0; level < MAX_LEVELS; level++) {
        const found = nearest(dir, budget, spec.kind);
        if (found.length === 1) {
            return found[0];
        }
        if (found.length > 1) {
            throw new CliError(
                `more than one index is equally close to here: ${found.join(', ')}`,
                EXIT.usage,
                `say which with --dir, or set ${spec.envName}`,
            );
        }
        budget.seen.add(dir);
        const up = dirname(dir);
        if (up === dir || dir === ceiling) {
            break;
        }
        dir = up;
    }
    return undefined;
}

/** Every index at the shallowest depth that has any, so a tie can be reported as one. */
function nearest(root: string, budget: Budget, kind: IndexKind): string[] {
    let frontier = [root];

    for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
        const found = frontier.filter((dir) => isIndex(dir, kind));
        if (found.length > 0) {
            return found;
        }
        const next: string[] = [];
        for (const dir of frontier) {
            if (budget.left <= 0) {
                return [];
            }
            budget.left--;
            next.push(...children(dir).filter((child) => !budget.seen.has(child)));
        }
        frontier = next;
    }
    return [];
}

/**
 * The subdirectories of one directory. Hidden directories and `node_modules`
 * are skipped: an index kept out of sight is not one anybody meant to be found
 * by looking.
 */
function children(dir: string): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    if (entries.length > MAX_ENTRIES) {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => join(dir, e.name));
}

/**
 * Home is the ceiling for anyone working inside it. Starting outside it —
 * a container whose workspace is `/workspace`, a CI checkout — there is no
 * home to stay within, so the root is the only stop.
 */
function ceilingFor(cwd: string): string {
    const home = homedir();
    const below = relative(home, resolve(cwd));
    return below === '' || (!below.startsWith('..') && !isAbsolute(below))
        ? home
        : parse(resolve(cwd)).root;
}
