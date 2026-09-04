import { CliError, EXIT } from '@zenera/cli/lib';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { MANIFEST_FILE } from './files.ts';

// ---------------------------------------------------------------------------
// Which index, when nobody said
//
// `--dir` and `$ZEN_SCHEMA_DB` are taken as written, missing or not: naming a
// directory that turns out not to hold an index has to fail saying so, because
// quietly using a different one would be a worse answer than an error.
//
// With neither, the directory is looked for. There is no list of blessed names
// here and there should not be — an index is self-describing, so what is being
// looked for is a `manifest.json`, not a directory called `schema-db`.
// `schema-db` is only the name a *new* index is given, and nothing reads it
// back. The search is nearest-first: this directory, then what is under it,
// then up a level and again, so `/assets/…/whatever` is reachable from
// `/workspace` because the two meet at a shared root on the way up.
//
// Three things bound it, and each is bounding a different kind of mistake.
// Depth and a visit budget bound the cost. The ceiling — the home directory,
// or the filesystem root when the search began outside it — bounds the
// blast radius, because an index in someone else's tree is not yours. And two
// indexes at the same distance is an ambiguity rather than a tie to break:
// choosing one silently is the one failure worth ruling out entirely, since
// the wrong index does not error, it answers confidently about another API.
// ---------------------------------------------------------------------------

/** The name a new index is given. Nothing searches for it; only `index --out` writes it. */
export const DEFAULT_DIR = './schema-db';

export const DIR_ENV = 'ZEN_SCHEMA_DB';

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

export function locateIndex(cwd: string, flag?: string, options: LocateOptions = {}): Located {
    const env = options.env ?? process.env;
    if (flag) {
        return { dir: resolve(cwd, flag), from: 'flag' };
    }
    const named = env[DIR_ENV]?.trim();
    if (named) {
        return { dir: resolve(cwd, named), from: 'env' };
    }
    const found = search(resolve(cwd), options.ceiling ?? ceilingFor(cwd));
    // Nothing found still answers with the default, so the error names the
    // directory everyone expects rather than the last place that was searched.
    return found
        ? { dir: found, from: 'found' }
        : { dir: resolve(cwd, DEFAULT_DIR), from: 'default' };
}

/** Where a new index goes: the same environment variable, minus the search. */
export function outputDir(
    cwd: string,
    flag?: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolve(cwd, flag ?? env[DIR_ENV]?.trim() ?? DEFAULT_DIR);
}

/** An index is a directory with a manifest in it; nothing else is asserted here. */
export function isIndex(dir: string): boolean {
    try {
        return statSync(join(dir, MANIFEST_FILE)).isFile();
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------

interface Budget {
    left: number;
    /** subtrees already searched, so climbing does not walk back down into them */
    seen: Set<string>;
}

function search(cwd: string, ceiling: string): string | undefined {
    const budget: Budget = { left: MAX_VISITS, seen: new Set() };
    let dir = cwd;

    for (let level = 0; level < MAX_LEVELS; level++) {
        const found = nearest(dir, budget);
        if (found.length === 1) {
            return found[0];
        }
        if (found.length > 1) {
            throw new CliError(
                `more than one index is equally close to here: ${found.join(', ')}`,
                EXIT.usage,
                `say which with --dir, or set ${DIR_ENV}`,
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
function nearest(root: string, budget: Budget): string[] {
    let frontier = [root];

    for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
        const found = frontier.filter(isIndex);
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
