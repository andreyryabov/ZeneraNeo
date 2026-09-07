import { classify, retryAfterMs, type Failure } from './rate-limit.ts';

// ---------------------------------------------------------------------------
// How fast to go, decided by the provider rather than by a constant
//
// Embedding a corpus is thousands of independent requests, and the only honest
// number for how many may be in flight is one nobody knows: it depends on the
// account, the model, the region, and what else is running against the same key
// right now. So it is not configured, it is discovered — additive increase
// while calls succeed, multiplicative decrease the moment one is refused.
//
// Two things make this different from putting a `Promise.all` around a slice
// of the work. The first is that there is no wave: a wave waits for its slowest
// member before starting the next, so one slow request idles every other slot.
// This grants a slot the instant one frees. The second is that a refusal is
// shared. Sixteen requests in flight against an exhausted quota produce sixteen
// 429s, and sixteen SDKs each backing off privately will return together and be
// refused together; here the first one pauses everybody.
//
// Which is also why the halving is guarded by an epoch. Those sixteen refusals
// are one event, not sixteen, and halving once per refusal takes the limit from
// 16 to 1 in a single round trip and then spends minutes climbing back. A task
// records the epoch it started in and its refusal is only acted on if nothing
// else has already lowered the limit since.
//
// Retries live here rather than in the SDK for the same reason. Every adapter
// turns the vendor's own retrying off for embeddings, because an SDK retry is
// invisible from out here: the call succeeds, the limiter learns nothing, and
// the run quietly takes four times as long as it reports.
// ---------------------------------------------------------------------------

export interface LimiterOptions {
    /** never go below this many in flight */
    min?: number;
    /** where to start, before anything is known */
    start?: number;
    /** never go above this many, whatever the provider tolerates */
    max?: number;
    /** consecutive successes, while saturated, that earn one more slot */
    stride?: number;
    /** the first wait after a refusal, doubling while they continue */
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    /** attempts after the first, per task */
    maxRetries?: number;
}

export const DEFAULT_MIN = 1;
export const DEFAULT_START = 4;
export const DEFAULT_MAX = 16;
export const DEFAULT_STRIDE = 8;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 4;

interface Waiter {
    grant(epoch: number): void;
    fail(reason: unknown): void;
}

export class RateLimiter {
    readonly #min: number;
    readonly #max: number;
    readonly #stride: number;
    readonly #initial: number;
    readonly #maxBackoff: number;
    readonly #retries: number;

    #limit: number;
    #active = 0;
    #successes = 0;
    /** bumped on every decrease; a refusal from an older one is already answered */
    #epoch = 0;
    #penalty: number;
    #pausedUntil = 0;
    #timer: ReturnType<typeof setTimeout> | undefined;
    readonly #waiting: Waiter[] = [];

    constructor(options: LimiterOptions = {}) {
        this.#min = Math.max(1, options.min ?? DEFAULT_MIN);
        this.#max = Math.max(this.#min, options.max ?? DEFAULT_MAX);
        this.#stride = Math.max(1, options.stride ?? DEFAULT_STRIDE);
        this.#initial = Math.max(0, options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS);
        this.#maxBackoff = Math.max(this.#initial, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
        this.#retries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
        this.#limit = clamp(options.start ?? DEFAULT_START, this.#min, this.#max);
        this.#penalty = this.#initial;
    }

    /** How many may be in flight as things stand. Moves; read it for reporting only. */
    get limit(): number {
        return this.#limit;
    }

    get inFlight(): number {
        return this.#active;
    }

    /**
     * Runs the task when there is room, retries it when the failure allows, and
     * gives up when it does not. The slot is released before any wait, so a
     * task serving its backoff is not also holding the concurrency down.
     */
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        let backoff = this.#initial;

        for (let attempt = 0; ; attempt++) {
            const epoch = await this.#acquire(signal);
            let failure: Failure = 'fatal';
            let err: unknown;
            try {
                const value = await task();
                this.#succeeded();
                return value;
            } catch (thrown) {
                err = thrown;
                failure = classify(thrown);
                // Before the slot is let go, so the pause is already in force
                // when the next waiter is granted one.
                if (failure === 'rate-limit') {
                    this.#slowDown(epoch, retryAfterMs(thrown));
                }
            } finally {
                this.#release();
            }

            if (failure === 'fatal' || attempt >= this.#retries) {
                throw err;
            }
            // A refusal is already being served by the shared pause, which the
            // next acquire blocks on; waiting again here would double it.
            if (failure === 'transient') {
                await sleep(jitter(Math.min(backoff, this.#maxBackoff)), signal);
                backoff *= 2;
            }
        }
    }

    #acquire(signal: AbortSignal | undefined): Promise<number> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason);
        }
        if (this.#free()) {
            this.#active++;
            return Promise.resolve(this.#epoch);
        }
        return new Promise<number>((resolve, reject) => {
            const waiter: Waiter = {
                grant: (epoch) => {
                    signal?.removeEventListener('abort', abort);
                    resolve(epoch);
                },
                fail: reject,
            };
            const abort = (): void => {
                const at = this.#waiting.indexOf(waiter);
                if (at >= 0) {
                    this.#waiting.splice(at, 1);
                }
                reject(signal?.reason);
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.#waiting.push(waiter);
        });
    }

    #free(): boolean {
        return this.#active < this.#limit && Date.now() >= this.#pausedUntil;
    }

    #release(): void {
        this.#active--;
        this.#pump();
    }

    /**
     * The slot is taken here rather than by the waiter, so several woken at
     * once cannot each see the same free one before any of them claims it.
     */
    #pump(): void {
        while (this.#waiting.length > 0 && this.#free()) {
            this.#active++;
            this.#waiting.shift()!.grant(this.#epoch);
        }
    }

    #succeeded(): void {
        this.#penalty = this.#initial;
        // Only a limit that is actually the constraint has earned being raised;
        // with nothing queued, more slots would go unused anyway.
        if (this.#waiting.length === 0) {
            return;
        }
        if (++this.#successes >= this.#stride) {
            this.#successes = 0;
            this.#limit = Math.min(this.#max, this.#limit + 1);
            this.#pump();
        }
    }

    #slowDown(epoch: number, retryAfter: number | undefined): void {
        if (epoch === this.#epoch) {
            this.#epoch++;
            this.#limit = Math.max(this.#min, Math.floor(this.#limit / 2));
            this.#successes = 0;
            this.#penalty = Math.min(this.#maxBackoff, this.#penalty * 2);
        }
        // Even a refusal that arrived too late to lower the limit still knows
        // how long this provider wants to be left alone.
        this.#pause(retryAfter ?? this.#penalty);
    }

    #pause(ms: number): void {
        const until = Date.now() + Math.max(0, ms);
        if (until <= this.#pausedUntil) {
            return;
        }
        this.#pausedUntil = until;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#pump();
        }, until - Date.now());
        this.#timer.unref?.();
    }
}

const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

/** Full jitter: without it, everything that backed off together returns together. */
const jitter = (ms: number): number => ms / 2 + Math.random() * (ms / 2);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        const abort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
