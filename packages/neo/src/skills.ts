import { hash } from './payload.ts';
import type { AgentState } from './state.ts';
import { projected } from './trajectory.ts';
import {
    SKILL_LOAD_TOOL,
    SKILL_SEARCH_TOOL,
    tool,
    withEffects,
    type AnyTool,
    type ToolSchema,
} from './types.ts';

// ---------------------------------------------------------------------------
// Skills — curated instruction bundles, loaded on demand
// ---------------------------------------------------------------------------

export interface SkillSummary {
    name: string;
    /** one line — this is what search and the prompt index see */
    description: string;
    tags?: string[];
    version?: string;
    /**
     * Tools this skill unlocks, by name. On the *summary* rather than only on
     * the loaded skill, because the declared tool set has to be known before
     * anything is loaded — see `lockedSkillTools`. Names only: a summary comes
     * from a cheap index, and code cannot live in one.
     */
    toolNames?: string[];
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
    /** absolute path of the source file, if known (set by file-backed providers) */
    file?: string;
}

export interface SkillProvider {
    readonly id: string;
    /** cheap index */
    list(): Promise<SkillSummary[]>;
    search(query: string, limit?: number): Promise<SkillSummary[]>;
    /** full content */
    load(name: string, version?: string): Promise<Skill>;
    /**
     * Resolves a tool name declared by some skill in this catalog to its
     * implementation, *without* loading the skill. The declared tool set is
     * built from this, so it must not depend on what is currently active.
     */
    tool(name: string): AnyTool<any> | undefined;
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
    return typeof binding.allow === 'function' ? binding.allow(s) : binding.allow.includes(s.name);
}

// ---------------------------------------------------------------------------
// Locked tools
//
// A tool a skill unlocks is declared to the model from the first turn and never
// withdrawn; only its *execution* is gated. The alternative \u2014 appending the
// tool once its skill activates \u2014 mutates the `tools` array mid-conversation,
// and since tool definitions are serialized ahead of the system prompt and the
// transcript, that puts the first differing token near position 0 and costs a
// full re-read of the entire context at exactly the point where it is largest.
//
// So the gate lives in the closure, never in the schema: `name`, `description`
// and `parameters` are derived from the catalog alone and are byte-identical on
// every turn.
//
// The gate itself captures nothing. It reads the trajectory it is handed at the
// moment of the call, which makes `lockedSkillTools` a pure function of the
// binding and the catalog — the stability the cache depends on is then a
// property of the code rather than a discipline callers have to keep.
// ---------------------------------------------------------------------------

/**
 * Skills activated by still-projected `load_skills` nodes of the active agent.
 *
 * Reads the names straight off the nodes rather than re-loading the skills: an
 * activation records what it activated, so the provider has nothing left to
 * say, and a gate that did I/O could not be a plain predicate.
 *
 * Exported because `preload` needs exactly the same answer: "what is active for
 * this agent, right now?" One derivation, so a preloaded skill and a
 * model-loaded one are indistinguishable to the gate.
 */
export function activeSkillNames(state: AgentState): Set<string> {
    const out = new Set<string>();
    for (const n of projected(state.trajectory)) {
        if (n.type === 'load_skills' && n.agent === state.agentName) {
            for (const s of n.skills) {
                out.add(s.name);
            }
        }
    }
    return out;
}

/** Thrown by a locked tool whose skill is not active. Reaches the model as an ordinary error result. */
export class SkillRequiredError extends Error {
    readonly code = 'SKILL_REQUIRED';
    readonly tool: string;
    /** every skill that unlocks this tool, in catalog order */
    readonly candidates: SkillSummary[];

    constructor(tool: string, candidates: SkillSummary[]) {
        super(skillRequiredMessage(tool, candidates));
        this.name = 'SkillRequiredError';
        this.tool = tool;
        this.candidates = candidates;
    }
}

/**
 * With one candidate the model has nothing to decide, so the message is an
 * instruction. With several it does, so the message states the choice and
 * carries each description \u2014 under `discovery: 'search'` there is no index in
 * the prompt, and this error is the only place those descriptions appear.
 */
function skillRequiredMessage(tool: string, candidates: SkillSummary[]): string {
    if (candidates.length === 1) {
        const { name } = candidates[0];
        return (
            `PREREQUISITE_MISSING: "${tool}" requires the "${name}" skill. ` +
            `Call ${SKILL_LOAD_TOOL}({"names":["${name}"]}), then retry this call.`
        );
    }
    const lines = candidates.map((c) => `  - ${c.name}: ${c.description}`);
    return (
        `PREREQUISITE_MISSING: "${tool}" requires at least one of these skills to be ` +
        `loaded first:\n${lines.join('\n')}\n` +
        'Decide which one applies to this call. If the case spans more than one, load ' +
        `them together. Then call ${SKILL_LOAD_TOOL}({"names":[...]}) and retry this call.`
    );
}

function lockedDescription(inner: ToolSchema, candidates: SkillSummary[]): string {
    const names = candidates.map((c) => `"${c.name}"`);
    const note =
        names.length === 1
            ? `Unlocked by the ${names[0]} skill; load it with \`${SKILL_LOAD_TOOL}\` first.`
            : `Unlocked by any of: ${names.join(', ')}; ` +
              `load whichever applies with \`${SKILL_LOAD_TOOL}\` first.`;
    return inner.description ? `${inner.description} (${note})` : note;
}

function lock<TCtx>(inner: AnyTool<any>, candidates: SkillSummary[]): AnyTool<TCtx> {
    return {
        name: inner.name,
        description: lockedDescription(inner, candidates),
        parameters: inner.parameters,
        // The three fields above are all the model is sent, and none of them can
        // see the run. The state enters here and only here, per call.
        execute: (args, tc) => {
            const active = activeSkillNames(tc.state);
            if (!candidates.some((c) => active.has(c.name))) {
                throw new SkillRequiredError(inner.name, candidates);
            }
            return inner.execute(args, tc);
        },
    };
}

/**
 * Every tool the binding's catalog can unlock, each gated on its own skills.
 * Depends on `binding` and the catalog, never on the trajectory \u2014 which is what
 * keeps the declared set stable across turns.
 *
 * `exclude` is the host agent's own tool names: an agent-level tool of the same
 * name wins and is never gated.
 */
export async function lockedSkillTools<TCtx>(
    binding: SkillBinding,
    provider: SkillProvider,

    exclude?: ReadonlySet<string>,
): Promise<AnyTool<TCtx>[]> {
    const index = (await provider.list())
        .filter((s) => allows(binding, s))
        // Not every provider promises an order; the declared tool list must not
        // depend on one that varies.
        .sort((a, b) => a.name.localeCompare(b.name));

    // name -> every skill declaring it. Two owners need no tie-break: either one
    // being active is enough, and both are offered when neither is.
    const owners = new Map<string, SkillSummary[]>();
    for (const summary of index) {
        for (const name of summary.toolNames ?? []) {
            if (exclude?.has(name)) {
                continue;
            }
            const known = owners.get(name);
            if (known) {
                known.push(summary);
            } else {
                owners.set(name, [summary]);
            }
        }
    }

    const out: AnyTool<TCtx>[] = [];
    for (const [name, candidates] of owners) {
        const inner = provider.tool(name);
        if (!inner) {
            // A catalog naming a tool nobody implements is a configuration
            // error, but throwing here would fail every turn of every run that
            // touches the provider, which is worse than leaving it undeclared.
            console.warn(
                `skill provider "${provider.id}": no implementation for tool "${name}" ` +
                    `(declared by ${candidates.map((c) => c.name).join(', ')})`,
            );
            continue;
        }
        out.push(lock<TCtx>(inner, candidates));
    }
    return out;
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
                // Two skills may declare the same tool; it is unlocked once.
                const unlocked = [
                    ...new Set(loaded.flatMap((s) => (s.tools ?? []).map((t) => t.name))),
                ];
                return withEffects(
                    `loaded: ${loaded.map((s) => s.name).join(', ')}` +
                        (unlocked.length ? `; tools unlocked: ${unlocked.join(', ')}` : ''),
                    {
                        kind: 'skill_load',
                        spec: { kind: 'skill_load', provider: provider.id, skills: loaded },
                    },
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
