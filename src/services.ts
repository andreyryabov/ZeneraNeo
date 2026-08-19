import { InMemoryPayloadStore, PayloadResolver, type PayloadStore } from './payload.ts';
import type { MemoryStore } from './memory.ts';
import type { SkillProvider } from './skills.ts';

/**
 * The I/O the kernel is not allowed to do itself: payload resolution, memory
 * backends and skill catalogs. Held by the driver (runner or Temporal
 * activity) and handed to the kernel and to tools explicitly, so nothing reads
 * ambient state.
 */
export class Services {
    readonly payloads: PayloadResolver;
    readonly #memory = new Map<string, MemoryStore>();
    readonly #skills = new Map<string, SkillProvider>();

    constructor(opts: {
        payloads?: PayloadResolver | PayloadStore;
        memory?: MemoryStore[];
        skills?: SkillProvider[];
    } = {}) {
        const p = opts.payloads ?? new InMemoryPayloadStore();
        this.payloads = p instanceof PayloadResolver ? p : new PayloadResolver(p);
        for (const m of opts.memory ?? []) {
            this.#memory.set(m.id, m);
        }
        for (const s of opts.skills ?? []) {
            this.#skills.set(s.id, s);
        }
    }

    memoryStore(id: string): MemoryStore {
        const s = this.#memory.get(id);
        if (!s) {
            throw new Error(`unknown memory store: ${id} (known: ${[...this.#memory.keys()]})`);
        }
        return s;
    }

    skillProvider(id: string): SkillProvider {
        const p = this.#skills.get(id);
        if (!p) {
            throw new Error(`unknown skill provider: ${id} (known: ${[...this.#skills.keys()]})`);
        }
        return p;
    }

    hasMemory(id: string): boolean {
        return this.#memory.has(id);
    }
}
