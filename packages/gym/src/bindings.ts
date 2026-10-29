import { Cache as Store, NO_CACHE, type CacheStore } from '@zenera/cli/lib';
import { ACCOUNTS, OWNER_TYPE, type Binding, type Bindings as Map } from './runtime.ts';
import { digest } from './store.ts';

// ---------------------------------------------------------------------------
// Bindings: which collection each type lives in
//
// The one decision every handler of an API must agree on, so it is made once
// and written down rather than left to each handler's author to rediscover. A
// handler names types — `ctx.lookup('Message', id)` — and the first handler
// to use a type binds it to the collection it used; every later one is told
// the binding and held to it by the judge.
//
// Add-only. Changing where a type lives would strand every record already
// stored under the old name and every handler written against it, so the only
// way to rebind is to clear the cache (and, sensibly, the world).
//
// Kept beside the handlers, in the machine's cache, and keyed by the set of type
// names the documents declare — the same documents served from anywhere share
// one set of bindings, as they share their handlers.
// ---------------------------------------------------------------------------

export const BINDINGS_KIND = 'gym-bindings';

export interface BindingsOptions {
    /** keep them somewhere other than the shared store */
    cacheDir?: string;
    /** keep nothing */
    ephemeral?: boolean;
}

export class Bindings {
    readonly #store: CacheStore;
    readonly #key: string;
    #map: Record<string, Binding>;

    constructor(types: readonly string[], opts: BindingsOptions = {}) {
        this.#store = opts.ephemeral
            ? NO_CACHE
            : new Store(BINDINGS_KIND, { dir: opts.cacheDir, mode: 0o600 });
        this.#key = digest(JSON.stringify([...types].sort()));
        this.#map = this.#load();
    }

    /** Every binding, the owner account included. */
    all(): Map {
        return { ...this.#map, [OWNER_TYPE]: { collection: ACCOUNTS, idField: 'id' } };
    }

    of(type: string): Binding | undefined {
        return this.all()[type];
    }

    /** The type a collection holds, if anything is bound to it. */
    typeOf(collection: string): string | undefined {
        return Object.entries(this.all()).find(([, b]) => b.collection === collection)?.[0];
    }

    /**
     * Records a binding. Nothing happens if it is already there; an error comes
     * back if the type lives elsewhere or the collection holds another type.
     */
    bind(type: string, binding: Binding): string | undefined {
        // Another process may have bound something since this one started.
        this.#map = { ...this.#load(), ...this.#map };
        const problem = this.conflict(type, binding);
        if (problem || this.#map[type]) {
            return problem;
        }
        this.#map[type] = binding;
        this.#store.put(this.#key, this.#map);
        return undefined;
    }

    /** Why this binding cannot be made, or undefined if it can (or exists). */
    conflict(type: string, binding: Binding): string | undefined {
        const current = this.of(type);
        if (current) {
            if (current.collection !== binding.collection) {
                return `\`${type}\` lives in \`${current.collection}\`, not \`${binding.collection}\``;
            }
            if (current.idField !== binding.idField) {
                return `\`${type}\` records are keyed by \`${current.idField}\`, not \`${binding.idField}\``;
            }
            return undefined;
        }
        const holder = this.typeOf(binding.collection);
        if (holder && holder !== type) {
            return `\`${binding.collection}\` holds \`${holder}\` records, not \`${type}\``;
        }
        return undefined;
    }

    #load(): Record<string, Binding> {
        return { ...(this.#store.get<Record<string, Binding>>(this.#key) ?? {}) };
    }
}
