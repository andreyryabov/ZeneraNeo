import { CliError, dim, EXIT, json, note, type Context } from '@zenera/cli/lib';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { IndexHead, IndexHealth } from './manifest.ts';

// ---------------------------------------------------------------------------
// Putting the vectors back
//
// An index carries the documents it was made from, so it can be rebuilt from
// itself: no corpus to go and find, no download, no question of whether what is
// on disk is still what was indexed. That is what makes `restore` a different
// command from `index` rather than a flag on it — the inputs are not the same
// inputs, and the settings are read back out of the manifest instead of being
// typed again and quietly mistyped.
//
// It is written to a staging directory and renamed into place, which costs a
// second copy on disk for as long as the rebuild takes. The alternative is to
// re-embed in place, and the failure that leaves behind is precisely the one
// this command exists to fix: a valid manifest sitting over a half-written
// table, which reads as a finished index everywhere except a search.
//
// Both staging names are hidden, because the search for the nearest index looks
// for a `manifest.json` and skips dotted directories. A sibling called
// `docs-db.restoring` would be found by it, and answering a search from a
// half-built copy of the index next door is a worse failure than any this is
// guarding against.
// ---------------------------------------------------------------------------

export interface Staging {
    /** where the rebuild is written */
    dir: string;
    /** the old index, kept until the new one is in place */
    previous: string;
}

export function stagingFor(dir: string): Staging {
    const parent = dirname(dir);
    const name = basename(dir);
    return {
        dir: join(parent, `.${name}.restoring`),
        previous: join(parent, `.${name}.previous`),
    };
}

/**
 * Two renames, because a rename cannot replace a directory that has anything in
 * it. If the second fails the first is undone, so the window in which neither
 * directory is the index is as short as two syscalls and never ends with one
 * missing.
 */
export async function swapIn(dir: string, staging: Staging): Promise<void> {
    await rm(staging.previous, { recursive: true, force: true });
    await rename(dir, staging.previous);
    try {
        await rename(staging.dir, dir);
    } catch (err) {
        await rename(staging.previous, dir).catch(() => undefined);
        throw err;
    }
    await rm(staging.previous, { recursive: true, force: true });
}

/**
 * The answer to `ready` is the exit code, so that a setup step can be written
 * as `if zen rag docs ready -d "$OUT" --quiet; then …` and never have to parse
 * anything. With `--json` the same answer is a document, and it is printed for
 * both outcomes: a caller that asked for JSON gets JSON whatever the news is.
 */
export function reportReady(health: IndexHealth, ctx: Context, quiet = false): void {
    if (ctx.json) {
        json({
            ready: health.state === 'ready',
            dir: health.dir,
            state: health.state,
            embedding: health.head?.embedding ?? null,
            reason: health.reason,
            ...(health.fix ? { fix: health.fix } : {}),
        });
    }
    if (health.state !== 'ready') {
        throw new CliError(health.reason, EXIT.invalid, health.fix);
    }
    if (!quiet && !ctx.json) {
        note(dim(`  ${health.reason}`));
    }
}

/**
 * What a restore is about to do, said before it starts, because the two things
 * worth objecting to — a different model, and chunking that was never recorded
 * — are both cheap to say and expensive to discover afterwards.
 */
export function announce(head: IndexHead, ref: string, entities: string): void {
    if (ref !== head.embedding.ref) {
        note(dim(`  embedder ${head.embedding.ref} → ${ref}; the manifest will be rewritten`));
    }
    note(dim(`  re-embedding ${entities} with ${ref} …`));
}
