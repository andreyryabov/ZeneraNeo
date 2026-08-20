import type { Skill, SkillProvider, SkillSummary } from '../skills.ts';

/** Skills handed over in code, held in a map. No I/O, no catalog to scan. */
export class StaticSkillProvider implements SkillProvider {
    readonly id: string;
    readonly #skills = new Map<string, Skill>();

    constructor(skills: Skill[] = [], id = 'static') {
        this.id = id;
        for (const s of skills) {
            this.#skills.set(s.name, s);
        }
    }

    async list(): Promise<SkillSummary[]> {
        return [...this.#skills.values()].map(({ name, description, tags, version }) => ({
            name,
            description,
            tags,
            version,
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
}
