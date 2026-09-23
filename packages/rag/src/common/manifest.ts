import { CliError, EXIT } from '@zenera/cli/lib';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// What every index says about itself
//
// An index is a directory, and `manifest.json` is the first thing anything
// reads out of one. It is written LAST by a build, so its presence is the
// commit marker: a half-built directory has no manifest and reads as "not
// indexed" rather than as a store that quietly lost half of what it holds.
//
// `kind` is what keeps two subjects apart in one tree. Without it, pointing a
// document search at an API index is not an error — it is rows, in an order
// that means nothing, about the wrong corpus entirely. That is the failure
// worth spending a field on.
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = 'manifest.json';

/** Where the vectors live, in both kinds of index. */
export const LANCE_DIR = 'lance';

export const lancePath = (dir: string): string => join(dir, LANCE_DIR);

export type IndexKind = 'schema' | 'docs';

/** How to name a kind when something has to be said about it. */
export const SUBJECT: Record<IndexKind, { label: string; command: string }> = {
    schema: { label: 'a schema index', command: 'zen rag schema' },
    docs: { label: 'a document index', command: 'zen rag docs' },
};

/** The part of a manifest that does not depend on what was indexed. */
export interface IndexHead {
    /** the format version of this kind of index */
    version: number;
    kind: IndexKind;
    createdAt: string;
    indexer: string;
    /**
     * `ref` as it was typed, `id` as the embedder answers to it, `dimensions`
     * as the vectors actually came back. `requested` only when a width was
     * asked for out loud: a search has to ask for the same one, and asking for
     * the model's own default is not the same as not asking.
     */
    embedding: { ref: string; id: string; dimensions: number; requested?: number };
    /** whether the table carries an fts index, and whether it carries a vector one */
    indexes: { fts: boolean; vector: boolean };
}

/** One subject's identity: enough to find an index, read one, and refuse one. */
export interface IndexSpec {
    kind: IndexKind;
    version: number;
    /** the name a NEW index is given; nothing ever searches for it */
    defaultDir: string;
    envName: string;
}

/**
 * The manifest, or the reason there is not one. Three refusals, and each names
 * a different thing to do next: build one, use the other subject, rebuild.
 */
export async function readHead<T extends IndexHead>(dir: string, spec: IndexSpec): Promise<T> {
    const { label, command } = SUBJECT[spec.kind];
    let text: string;
    try {
        text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
    } catch {
        throw new CliError(
            `${dir} does not hold an index`,
            EXIT.invalid,
            `build one with \`${command} index\`, or name an existing one with --dir or $${spec.envName}`,
        );
    }
    const head = JSON.parse(text) as T;

    // Written since there was more than one kind; before that there was only
    // the one, so a manifest that does not say is a schema index.
    const kind = head.kind ?? 'schema';
    if (kind !== spec.kind) {
        throw new CliError(
            `${dir} holds ${SUBJECT[kind].label}, not ${label}`,
            EXIT.invalid,
            `read it with \`${SUBJECT[kind].command} search\``,
        );
    }
    if (head.version !== spec.version) {
        throw new CliError(
            `${dir} is a version ${head.version} index, and this indexer reads version ${spec.version}`,
            EXIT.invalid,
            `rebuild it with \`${command} index\``,
        );
    }
    return head;
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
export function assertSameEmbedding(head: IndexHead, ref: string): void {
    if (ref !== head.embedding.ref && ref !== head.embedding.id) {
        throw new CliError(
            `this index was built with ${head.embedding.ref}, not ${ref}`,
            EXIT.invalid,
            `search it with --embedding ${head.embedding.ref}, or move it to ${ref} with ` +
                `\`${SUBJECT[head.kind ?? 'schema'].command} restore --embedding ${ref}\``,
        );
    }
}

// ---------------------------------------------------------------------------
// Whether an index can actually answer
//
// The manifest is the commit marker, and for a long time that was the whole
// test: a manifest meant a finished build. It stopped being enough as soon as
// indexes started being committed, because `lance/` is binary, rebuildable and
// therefore git-ignored — so a clone has every file a complete index has except
// the vectors, and a manifest that says a build finished on someone else's
// machine. Checked by hand, that reads as done; searched, it fails deep in the
// store with "holds no searchable table".
//
// So the question a caller has is not "was this built" but "can this answer",
// and those have different answers on a machine that did not build it. The
// difference between them is exactly what `restore` exists to close, which is
// why `incomplete` is a state with a fix rather than a kind of failure.
//
// The table is opened rather than the directory counted: `lance/` holding some
// files is not the same as it holding a readable table, and being wrong here
// would put the error back where it was.
// ---------------------------------------------------------------------------

export type IndexState = 'absent' | 'incomplete' | 'ready';

interface Closable {
    close(): void;
}

export interface IndexHealth<T extends IndexHead = IndexHead> {
    dir: string;
    state: IndexState;
    /** absent when there is no manifest to read */
    head?: T;
    /** what is the matter, or what is there, in one line */
    reason: string;
    /** the command that would change the answer; empty when the answer is yes */
    fix: string;
}

/**
 * `open` is the subject's own store opener, so the readiness of an index is
 * decided by the same code a search would use rather than by a second opinion
 * about what a directory ought to contain.
 *
 * A manifest of the wrong kind or the wrong version still throws: those are not
 * states of this index, they are the caller asking about a different one.
 */
export async function inspectIndex<T extends IndexHead>(
    dir: string,
    spec: IndexSpec,
    open: (dir: string) => Promise<Closable>,
): Promise<IndexHealth<T>> {
    const { command } = SUBJECT[spec.kind];
    if (!existsSync(join(dir, MANIFEST_FILE))) {
        return {
            dir,
            state: 'absent',
            reason: `${dir} does not hold an index`,
            fix: `build one with \`${command} index\``,
        };
    }
    const head = await readHead<T>(dir, spec);

    let store: Closable;
    try {
        store = await open(dir);
    } catch {
        return {
            dir,
            state: 'incomplete',
            head,
            reason: `${dir} has no vectors — \`${LANCE_DIR}/\` is missing or unreadable`,
            fix: `re-embed them with \`${command} restore --dir ${dir}\``,
        };
    }
    store.close();
    return {
        dir,
        state: 'ready',
        head,
        reason: `${dir} is searchable — ${head.embedding.ref} (${head.embedding.dimensions}d)`,
        fix: '',
    };
}
