import { hash } from './payload.ts';
import { SKILL_LOAD_TOOL, SKILL_SEARCH_TOOL, type AnyTool, tool, withEffects } from './types.ts';

// ---------------------------------------------------------------------------
// Skills — curated instruction bundles, loaded on demand
// ---------------------------------------------------------------------------

export interface SkillSummary {
    name: string;
    /** one line — this is what search and the prompt index see */
    description: string;
    tags?: string[];
    version?: string;
}

/**
 * Note on the spec: `content` is a plain string here rather than a `Payload`,
 * because a provider is a content source and must not need a payload store.
 * The kernel offloads it when the activation is recorded in the trajectory.
 */
export interface Skill extends SkillSummary {
    content: string;
    /** tools unlocked while the skill is active; the context type is the host agent's */
    tools?: AnyTool<any>[];
    resources?: Record<string, string>;
}

export interface SkillProvider {
    readonly id: string;
    /** cheap index */
    list(): Promise<SkillSummary[]>;
    search(query: string, limit?: number): Promise<SkillSummary[]>;
    /** full content */
    load(name: string, version?: string): Promise<Skill>;
}

export interface SkillBinding {
    /** SkillProvider id */
    provider: string;
    /**
     * 'index'  — names + descriptions rendered into the system prompt.
     * 'search' — only a `skill_search` tool; nothing pre-rendered.
     * 'none'   — preloads only.
     */
    discovery: 'index' | 'search' | 'none';
    /** always loaded at run start, before the first LLM call */
    preload?: string[];
    maxIndexEntries?: number;
    allow?: string[] | ((s: SkillSummary) => boolean);
}

export interface SkillLoadSpec {
    kind: 'skill_load';
    provider: string;
    skills: Skill[];
}

export function skillContentHash(s: Skill): string {
    return hash(s.content);
}

export function renderSkills(skills: Skill[]): string {
    return skills
        .map((s) => `## Skill: ${s.name}${s.version ? ` (${s.version})` : ''}\n${s.content}`)
        .join('\n\n');
}

export function renderSkillIndex(summaries: SkillSummary[], max: number): string {
    const shown = summaries.slice(0, max);
    if (!shown.length) {
        return '';
    }
    const lines = shown.map((s) => `- ${s.name}: ${s.description}`);
    return (
        `Available skills (load with the \`${SKILL_LOAD_TOOL}\` tool before ` +
        `relying on them):\n${lines.join('\n')}`
    );
}

export function allows(binding: SkillBinding, s: SkillSummary): boolean {
    if (!binding.allow) {
        return true;
    }
    return typeof binding.allow === 'function'
        ? binding.allow(s)
        : binding.allow.includes(s.name);
}

// ---------------------------------------------------------------------------
// Default provider
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Built-in skill tools
// ---------------------------------------------------------------------------

/**
 * `skill_load` deliberately returns a short acknowledgement: the instructions
 * themselves reach the model through the `LoadSkillsNode` projection, so they
 * are not duplicated in the tool result and can be compacted independently.
 */
export function skillTools<TCtx>(binding: SkillBinding): AnyTool<TCtx>[] {
    const tools: AnyTool<TCtx>[] = [
        tool<{ names: string[] }, TCtx>({
            name: SKILL_LOAD_TOOL,
            description: 'Load skill instructions (and any tools they unlock) into the context.',
            parameters: {
                type: 'object',
                properties: {
                    names: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['names'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const provider = tc.services.skillProvider(binding.provider);
                const index = await provider.list();
                const loaded: Skill[] = [];
                for (const name of args.names) {
                    const summary = index.find((s) => s.name === name);
                    if (summary && !allows(binding, summary)) {
                        throw new Error(`skill "${name}" is not available to this agent`);
                    }
                    loaded.push(await provider.load(name, summary?.version));
                }
                const unlocked = loaded.flatMap((s) => (s.tools ?? []).map((t) => t.name));
                return withEffects(
                    `loaded: ${loaded.map((s) => s.name).join(', ')}` +
                        (unlocked.length ? `; tools unlocked: ${unlocked.join(', ')}` : ''),
                    { kind: 'skill_load', spec: { kind: 'skill_load', provider: provider.id, skills: loaded } },
                );
            },
        }),
    ];
    if (binding.discovery === 'search') {
        tools.push(
            tool<{ query: string; limit?: number }, TCtx>({
                name: SKILL_SEARCH_TOOL,
                description: 'Find skills by topic before loading them.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
                    required: ['query'],
                    additionalProperties: false,
                },
                execute: async (args, tc) => {
                    const provider = tc.services.skillProvider(binding.provider);
                    const found = await provider.search(args.query, args.limit);
                    return found.filter((s) => allows(binding, s));
                },
            }),
        );
    }
    return tools;
}
