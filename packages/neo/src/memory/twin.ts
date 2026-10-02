import { flatten } from './index.ts';
import type { MemoryNode } from './types.ts';

// ---------------------------------------------------------------------------
// When two memories are the same memory
//
// Shared by `merge`, which folds a twin onto the node already held, and `diff`,
// which reports it. One rule, so what diff calls a re-commit is exactly what
// merge would have folded.
// ---------------------------------------------------------------------------

export function comparable(a: MemoryNode, b: MemoryNode): boolean {
    return a.id !== b.id && a.kind === b.kind && !a.file && audienceKey(a) === audienceKey(b);
}

export function twinKey(node: MemoryNode): string {
    return [node.kind, audienceKey(node), flatten(node.text)].join('\u0000');
}

export function audienceKey(node: MemoryNode): string {
    return [...node.audience].sort().join('|');
}

export function sameContent(a: MemoryNode, b: MemoryNode): boolean {
    return (
        a.kind === b.kind &&
        a.text === b.text &&
        audienceKey(a) === audienceKey(b) &&
        a.file?.sha256 === b.file?.sha256 &&
        deep(a.metadata, b.metadata)
    );
}

function deep(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((k) => deep(left[k], right[k]));
}
