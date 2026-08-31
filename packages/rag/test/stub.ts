import type { Embedder, EmbeddingRequest, EmbeddingResponse } from '@zenera/core';

// ---------------------------------------------------------------------------
// An embedder with no network behind it
//
// Hashed bag of words: two texts sharing words come out close, and nothing
// else is claimed. That is weak semantics but real ones — enough that a
// ranking assertion means something, and unlike a counter it cannot pass while
// the batch is transposed.
// ---------------------------------------------------------------------------

const DIMENSIONS = 96;

export class StubEmbedder implements Embedder {
    readonly id: string;

    constructor(id = 'stub:bag-of-words') {
        this.id = id;
    }

    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        const vectors = request.input.map((text) => unit(encode(text)));
        return { vectors, dimensions: DIMENSIONS };
    }
}

function encode(text: string): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const word of text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        vector[hash(word) % DIMENSIONS]! += 1;
    }
    return vector;
}

function hash(word: string): number {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
        h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

function unit(vector: number[]): number[] {
    const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    return length === 0
        ? vector.map(() => 1 / Math.sqrt(DIMENSIONS))
        : vector.map((x) => x / length);
}
