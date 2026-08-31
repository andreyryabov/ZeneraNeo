import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from '@zenera/cli/lib';
import type { Model } from '@zenera/neo';
import { GENERATORS, type Box } from './box.ts';
import { build, BuildFailed } from './generate.ts';
import type { Operation } from './spec.ts';
import type { Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// The cache
//
// Two layers over one identity. `Operation.key` is a function of the
// operation's shape, so a spec edit produces a new key and the old artefact is
// simply never asked for again — there is nothing to invalidate, which is the
// part of a cache that is usually wrong.
//
// The in-flight map is the other half and matters more than it looks: ten
// requests arriving together for an uncached operation must produce one build,
// not ten. A failed build is remembered too, for the same reason — an operation
// the model could not write for should not re-ask on every request.
// ---------------------------------------------------------------------------

export interface Generator {
    key: string;
    source: string;
    /** whether it came off disk rather than out of a model */
    cached: boolean;
}

export interface CacheEvent {
    operation: Operation;
    attempt?: number;
    diagnostics?: readonly string[];
}

export interface CacheOptions {
    box: Box;
    checks: Checks;
    model: Model;
    attempts?: number;
    /**
     * How many generators may be written at once. A client that walks every
     * route — which is exactly what people do to a new mock — would otherwise
     * open one model request per operation simultaneously and be rate limited
     * on all of them.
     */
    concurrency?: number;
    /** ignore what is on disk and write fresh */
    rebuild?: boolean;
    /** run generators but keep nothing */
    ephemeral?: boolean;
    onStart?: (e: CacheEvent) => void;
    onAttempt?: (e: CacheEvent) => void;
    onReady?: (e: CacheEvent & { cached: boolean; attempts: number }) => void;
    onFail?: (e: CacheEvent & { error: Error }) => void;
}

const DEFAULT_CONCURRENCY = 4;

export class Cache {
    readonly #opts: CacheOptions;
    readonly #live = new Map<string, Promise<Generator>>();
    readonly #settled = new Set<string>();
    readonly #slots: number;
    readonly #waiting: (() => void)[] = [];
    #running = 0;

    constructor(opts: CacheOptions) {
        this.#opts = opts;
        this.#slots = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    }

    /**
     * The generator for an operation, written if it does not exist yet. Callers
     * that arrive during a build wait for that build rather than starting one.
     *
     * `cached` answers "did this call cost a model turn", which is what the
     * response header is for — so it is false for the caller that triggered the
     * build and for everyone who waited on it, and true from then on.
     */
    ensure(operation: Operation): Promise<Generator> {
        const already = this.#settled.has(operation.key);
        const running = this.#live.get(operation.key);
        if (running) {
            return already ? running.then((g) => ({ ...g, cached: true })) : running;
        }
        const started = this.#make(operation).then(
            (g) => {
                this.#settled.add(operation.key);
                return g;
            },
            (err: unknown) => {
                // A model that tried and could not is remembered: re-asking it
                // once per request is how a mock server becomes an invoice.
                // Anything else — a rate limit, a dropped connection — is about
                // this moment rather than this operation, so it is forgotten
                // and the next request gets a fresh go.
                if (!(err instanceof BuildFailed)) {
                    this.#live.delete(operation.key);
                }
                throw err;
            },
        );
        this.#live.set(operation.key, started);
        return started;
    }

    async #make(operation: Operation): Promise<Generator> {
        const { box, model, checks, rebuild, ephemeral } = this.#opts;
        // Read before queueing: a cache hit costs nothing and must not wait
        // behind somebody else's model call.
        const source = rebuild ? undefined : await read(box, operation.key);

        if (source !== undefined) {
            this.#opts.onReady?.({ operation, cached: true, attempts: 0 });
            return { key: operation.key, source, cached: true };
        }

        await this.#enter();
        this.#opts.onStart?.({ operation });
        try {
            const built = await build(operation, {
                model,
                box,
                checks,
                attempts: this.#opts.attempts,
                onAttempt: (attempt, diagnostics) =>
                    this.#opts.onAttempt?.({ operation, attempt, diagnostics }),
            });
            if (!ephemeral) {
                writeJson(
                    join(box.root, GENERATORS, operation.key, 'meta.json'),
                    {
                        version: 1,
                        operationId: operation.operationId,
                        method: operation.method,
                        path: operation.path,
                        source: operation.source,
                        model: model.id,
                        attempts: built.attempts,
                        rebuilt: Boolean(rebuild),
                        createdAt: new Date().toISOString(),
                    },
                    0o644,
                );
            }
            this.#opts.onReady?.({ operation, cached: false, attempts: built.attempts });
            return { key: operation.key, source: built.source, cached: false };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.#opts.onFail?.({ operation, error });
            throw error;
        } finally {
            this.#leave();
        }
    }

    #enter(): Promise<void> {
        if (this.#running < this.#slots) {
            this.#running++;
            return Promise.resolve();
        }
        return new Promise<void>((admit) => this.#waiting.push(admit));
    }

    /** Hands the slot straight to whoever is next, so the count stays exact. */
    #leave(): void {
        const next = this.#waiting.shift();
        if (next) {
            next();
            return;
        }
        this.#running--;
    }
}

async function read(box: Box, key: string): Promise<string | undefined> {
    const path = box.sourceOf(key);
    if (!existsSync(path)) {
        return undefined;
    }
    try {
        const source = await readFile(path, 'utf8');
        return source.trim() ? source : undefined;
    } catch {
        return undefined;
    }
}

export { BuildFailed };
