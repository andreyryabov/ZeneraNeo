import type { Skill, SkillProvider, SkillSummary } from '../skills.ts';
import type { AnyTool } from '../types.ts';

/** Skills handed over in code, held in a map. No I/O, no catalog to scan. */
export class StaticSkillProvider implements SkillProvider {
    readonly id: string;
    readonly #skills = new Map<string, Skill>();
    readonly #tools = new Map<string, AnyTool<any>>();

    constructor(skills: Skill[] = [], id = 'static') {
        this.id = id;
        for (const s of skills) {
            this.#skills.set(s.name, s);
            for (const t of s.tools ?? []) {
                this.#tools.set(t.name, t);
            }
        }
    }

    async list(): Promise<SkillSummary[]> {
        return [...this.#skills.values()].map(({ name, description, tags, version, tools }) => ({
            name,
            description,
            tags,
            version,
            toolNames: tools?.length ? tools.map((t) => t.name) : undefined,
        }));
    }

    async search(query: string, limit = 8): Promise<SkillSummary[]> {
        const q = query.toLowerCase();
        const all = await this.list();
        return all
            .filter(
                (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.description.toLowerCase().includes(q) ||
                    (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
            )
            .slice(0, limit);
    }

    async load(name: string, version?: string): Promise<Skill> {
        const s = this.#skills.get(name);
        if (!s) {
            throw new Error(`unknown skill: ${name}`);
        }
        if (version && s.version && s.version !== version) {
            throw new Error(`skill ${name} is at ${s.version}, ${version} was requested`);
        }
        return s;
    }

    tool(name: string): AnyTool<any> | undefined {
        return this.#tools.get(name);
    }
}
