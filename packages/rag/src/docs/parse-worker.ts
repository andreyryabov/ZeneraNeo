import { parentPort, workerData } from 'node:worker_threads';
import { chunkDocument, type ChunkOptions } from './chunk.ts';
import { outlineOf } from './outline.ts';
import { parseDocument } from './parse.ts';

// ---------------------------------------------------------------------------
// One thread, three pure functions
//
// Parsing a markdown tree is the only part of a build that is CPU and nothing
// else, so it is the only part worth moving off the thread everything else
// shares.
//
// The split is after chunking, not after parsing, and that is forced rather
// than chosen: `chunkDocument` decides what belongs together by comparing
// `Section` objects with `!==`, and a structured clone would give every chunk a
// section that is equal to its neighbours' and identical to none of them. So a
// `ParsedDoc` must never cross a thread boundary. What goes back is `Chunk[]`
// and a `FileOutline` — plain data, already flattened.
//
// The imports above are the whole module graph a thread pays for. It must stay
// that way: `load.ts` reaches the CLI and `store.ts` loads a native addon, and
// either of them here would be loaded once per worker for nothing.
// ---------------------------------------------------------------------------

export interface ParseJob {
    at: number;
    name: string;
    text: string;
    format: 'markdown' | 'text';
}

export interface ParseDone {
    at: number;
    chunks?: unknown;
    outline?: unknown;
    error?: string;
}

const options = (workerData ?? {}) as ChunkOptions;

parentPort?.on('message', (job: ParseJob) => {
    try {
        const parsed = parseDocument(job.text, job.name, job.format);
        const chunks = chunkDocument(parsed, options);
        parentPort!.postMessage({ at: job.at, chunks, outline: outlineOf(parsed, chunks.length) });
    } catch (err) {
        // Sent back rather than thrown: an uncaught throw here kills the thread,
        // and the pool would lose the other documents queued behind this one.
        parentPort!.postMessage({
            at: job.at,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
