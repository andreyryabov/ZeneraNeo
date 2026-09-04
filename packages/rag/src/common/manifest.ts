import { CliError, EXIT } from '@zenera/cli/lib';
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
    /** `ref` as it was typed, `id` as the embedder answers to it */
    embedding: { ref: string; id: string; dimensions: number };
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
            `search it with --embedding ${head.embedding.ref}, or rebuild it`,
        );
    }
}
