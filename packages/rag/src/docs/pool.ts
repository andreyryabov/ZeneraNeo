import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { chunkDocument, type Chunk, type ChunkOptions } from './chunk.ts';
import type { FileOutline } from './files.ts';
import { outlineOf } from './outline.ts';
import type { ParseDone, ParseJob } from './parse-worker.ts';
import { parseDocument } from './parse.ts';

// ---------------------------------------------------------------------------
// Parsing several documents at once
//
// Remark is synchronous and holds the thread for as long as a document takes,
// so a corpus is parsed strictly one file at a time no matter how many cores
// are idle. A pool fixes that and nothing else: the work is pure, the inputs are
// independent, and the answers are placed by index, so the result is the same
// list in the same order that one thread would have produced.
//
// It is not always the faster choice. Starting a thread costs more than parsing
// a small document, so a handful of files are done here; and a caller that
// supplied its own `tokenCount` cannot be helped at all, because a function is
// not something `postMessage` can clone. Every one of those paths runs the same
// three functions in this thread instead, which is why the fallback is safe
// rather than merely convenient.
// ---------------------------------------------------------------------------

/** Below this, starting threads costs more than the parsing they would save. */
const MIN_DOCUMENTS = 8;

/** More than this and the threads contend for memory bandwidth, not for work. */
const MAX_WORKERS = 8;

export interface ParseInput {
    name: string;
    text: string;
    format: 'markdown' | 'text';
}

export interface Parsed {
    chunks: Chunk[];
    outline: FileOutline;
}

/** One short of the machine, so the thread doing everything else keeps a core. */
export const poolSize = (): number =>
    Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1));

const EXTENSION = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
// Built from `import.meta.url` because the extension changes on the way to
// `dist/`, and `rewriteRelativeImportExtensions` does not touch string literals.
const WORKER = new URL(`./parse-worker${EXTENSION}`, import.meta.url);

export interface ParseAllOptions {
    chunk?: ChunkOptions;
    /** how many threads to allow; 1 keeps everything here */
    workers?: number;
    onProgress?: (done: number, total: number, pending: readonly string[]) => void;
}

/** How many documents run between yields, so a long parse still narrates. */
const YIELD_EVERY = 32;

export async function parseAll(
    inputs: readonly ParseInput[],
    options: ParseAllOptions = {},
): Promise<Parsed[]> {
    const chunk = options.chunk ?? {};
    const workers = Math.min(options.workers ?? poolSize(), inputs.length);
    const out = new Array<Parsed | undefined>(inputs.length);

    if (workers > 1 && inputs.length >= MIN_DOCUMENTS && typeof chunk.tokenCount !== 'function') {
        try {
            await threaded(out, inputs, chunk, workers, options.onProgress);
        } catch {
            // A thread that would not start, or died. Whatever it did finish is
            // in `out` already and is not parsed again; `here` fills the rest.
        }
    }
    return here(out, inputs, chunk, options.onProgress);
}

async function here(
    out: (Parsed | undefined)[],
    inputs: readonly ParseInput[],
    chunk: ChunkOptions,
    onProgress?: (done: number, total: number, pending: readonly string[]) => void,
): Promise<Parsed[]> {
    let done = out.reduce<number>((n, parsed) => (parsed ? n + 1 : n), 0);

    for (const [at, input] of inputs.entries()) {
        if (out[at]) {
            continue;
        }
        const parsed = parseDocument(input.text, input.name, input.format);
        const chunks = chunkDocument(parsed, chunk);
        out[at] = { chunks, outline: outlineOf(parsed, chunks.length) };
        onProgress?.(++done, inputs.length, [input.name]);
        if (done % YIELD_EVERY === 0) {
            // Remark is synchronous, so a corpus parsed here would hold the loop
            // for minutes and freeze the very report saying it is still working.
            await new Promise<void>((resume) => setImmediate(resume));
        }
    }
    return out as Parsed[];
}

/**
 * The threaded path on its own. `parseAll` falls back to this thread when the
 * workers cannot run, which is right for a build and useless for a test: a
 * worker that never starts would look exactly like a fast one. Tests call this.
 */
export async function parseThreaded(
    inputs: readonly ParseInput[],
    chunk: ChunkOptions,
    size: number,
    onProgress?: (done: number, total: number, pending: readonly string[]) => void,
): Promise<Parsed[]> {
    const out = new Array<Parsed | undefined>(inputs.length);
    await threaded(out, inputs, chunk, size, onProgress);
    return out as Parsed[];
}

async function threaded(
    out: (Parsed | undefined)[],
    inputs: readonly ParseInput[],
    chunk: ChunkOptions,
    size: number,
    onProgress?: (done: number, total: number, pending: readonly string[]) => void,
): Promise<void> {
    const workers = Array.from({ length: size }, () => new Worker(WORKER, { workerData: chunk }));
    // What each thread is on, so a corpus with two pathological documents in it
    // can name them instead of looking stalled a hair short of the total.
    const busy = new Map<Worker, string>();
    let next = 0;
    let done = 0;

    const pump = async (worker: Worker): Promise<void> => {
        while (next < inputs.length) {
            const at = next++;
            busy.set(worker, inputs[at]!.name);
            out[at] = await ask(worker, { at, ...inputs[at]! });
            busy.delete(worker);
            onProgress?.(++done, inputs.length, [...busy.values()]);
        }
    };

    try {
        await Promise.all(workers.map(pump));
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
    }
}

function ask(worker: Worker, job: ParseJob): Promise<Parsed> {
    return new Promise((resolve, reject) => {
        const done = (): void => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
        };
        const onMessage = (reply: ParseDone): void => {
            if (reply.at !== job.at) {
                return;
            }
            done();
            if (reply.error !== undefined) {
                reject(new Error(`${job.name}: ${reply.error}`));
            } else {
                resolve({ chunks: reply.chunks as Chunk[], outline: reply.outline as FileOutline });
            }
        };
        const onError = (err: Error): void => {
            done();
            reject(err);
        };
        const onExit = (code: number): void => {
            done();
            reject(new Error(`parse worker stopped with code ${code}`));
        };

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage(job);
    });
}
