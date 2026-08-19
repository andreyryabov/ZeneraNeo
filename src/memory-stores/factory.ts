import { InMemoryMemoryStore, type MemoryStore } from '../memory.ts';
import { FileMemoryStore, type FileMemoryStoreOptions } from './file.ts';

// ---------------------------------------------------------------------------
// Memory store factory
// ---------------------------------------------------------------------------

export interface MemoryMemoryStoreSpec {
    kind: 'memory';
    id?: string;
}

export interface FileMemoryStoreSpec extends FileMemoryStoreOptions {
    kind: 'file';
}

/** Grows a member per backend (`pgvector`, `redis`, …). */
export type MemoryStoreSpec = MemoryMemoryStoreSpec | FileMemoryStoreSpec;

/** Shorthand: `mem`, `memory`, `file:./.data/memory`. */
export type MemoryStoreRef = MemoryStoreSpec | string;

export function createMemoryStore(ref: MemoryStoreRef): MemoryStore {
    const spec = typeof ref === 'string' ? parseRef(ref) : ref;
    switch (spec.kind) {
        case 'memory':
            return new InMemoryMemoryStore(spec.id);
        case 'file':
            return new FileMemoryStore(spec);
        default:
            throw new TypeError(
                `unknown memory store kind: ${(spec as MemoryStoreSpec).kind as string}`,
            );
    }
}

function parseRef(ref: string): MemoryStoreSpec {
    if (ref === 'mem' || ref === 'memory') {
        return { kind: 'memory' };
    }
    const colon = ref.indexOf(':');
    const scheme = colon < 0 ? ref : ref.slice(0, colon);
    const rest = colon < 0 ? '' : ref.slice(colon + 1);
    if (scheme === 'file') {
        if (!rest) {
            throw new TypeError(`missing directory in "${ref}" (expected file:<dir>)`);
        }
        return { kind: 'file', dir: rest };
    }
    throw new TypeError(`unknown memory store ref: "${ref}"`);
}
