import type { PayloadStore } from '../payload.ts';
import { FilePayloadStore, type FilePayloadStoreOptions } from './file.ts';
import { InMemoryPayloadStore } from './in-memory.ts';

// ---------------------------------------------------------------------------
// Payload store factory
// ---------------------------------------------------------------------------

export interface MemoryPayloadStoreSpec {
    kind: 'memory';
    id?: string;
}

export interface FilePayloadStoreSpec extends FilePayloadStoreOptions {
    kind: 'file';
}

/** Grows a member per backend (`s3`, …); `kind` is the discriminator. */
export type PayloadStoreSpec = MemoryPayloadStoreSpec | FilePayloadStoreSpec;

/** Shorthand: `mem`, `memory`, `file:./.data/blobs`. */
export type PayloadStoreRef = PayloadStoreSpec | string;

export function createPayloadStore(ref: PayloadStoreRef): PayloadStore {
    const spec = typeof ref === 'string' ? parseRef(ref) : ref;
    switch (spec.kind) {
        case 'memory':
            return new InMemoryPayloadStore(spec.id);
        case 'file':
            return new FilePayloadStore(spec);
        default:
            throw new TypeError(
                `unknown payload store kind: ${(spec as PayloadStoreSpec).kind as string}`,
            );
    }
}

function parseRef(ref: string): PayloadStoreSpec {
    if (ref === 'mem' || ref === 'memory') {
        return { kind: 'memory' };
    }
    // Only the first colon separates the scheme: a path may contain colons.
    const colon = ref.indexOf(':');
    const scheme = colon < 0 ? ref : ref.slice(0, colon);
    const rest = colon < 0 ? '' : ref.slice(colon + 1);
    if (scheme === 'file') {
        if (!rest) {
            throw new TypeError(`missing directory in "${ref}" (expected file:<dir>)`);
        }
        return { kind: 'file', dir: rest };
    }
    throw new TypeError(`unknown payload store ref: "${ref}"`);
}
