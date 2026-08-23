import type { Agent, AgentRegistry } from './agent.ts';
import type { Model } from './model.ts';
import type { Services } from './services.ts';
import type { SkillBinding, SkillSummary } from './skills.ts';
import { HANDOFF_PREFIX } from './types.ts';

// ---------------------------------------------------------------------------
// Architecture — the wiring, as data
//
// A trajectory says what one run did. It cannot say what the run *could* have
// done: the agent nobody handed off to, the tool nobody called and the skill
// nobody loaded leave no trace in it, and those are exactly the things a
// misconfiguration hides behind. This module projects the live object graph —
// registry, services, the runner's default model — into plain JSON, so the
// declared wiring can be drawn next to the observed one, logged at startup, or
// diffed between two deploys.
//
// Everything here is serializable by construction. No functions, no class
// instances, no payload references: a snapshot survives `JSON.stringify` and
// means the same thing on the other side.
// ---------------------------------------------------------------------------

export interface ArchTool {
    name: string;
    description?: string;
    /** the skill that unlocks it; absent for tools the agent always carries */
    skill?: string;
}

export interface ArchSkill {
    name: string;
    description?: string;
    version?: string;
    /** loaded before the first model call, so it is never in the rendered index */
    preload?: boolean;
    /** tools this skill unlocks, by name */
    toolNames?: string[];
}

export interface ArchMemory {
    store: string;
    /** `(per run)` when the binding resolves its scope from the run context */
    scope: string;
    access: 'read' | 'read-write';
    autoRecall?: boolean;
}

export interface ArchAgent {
    name: string;
    description?: string;
    /** model id, from the agent or inherited from the runner */
    model?: string;
    /** true when the id above came from the runner rather than the agent */
    inheritedModel?: boolean;
    tools: ArchTool[];
    /** agent names this one may transfer to */
    handoffs: string[];
    skills?: {
        provider: string;
        discovery: SkillBinding['discovery'];
        /** empty when the provider is not registered with the services */
        catalog: ArchSkill[];
        /** the binding names a provider the services do not know */
        unresolved?: boolean;
    };
    memory: ArchMemory[];
    fork?: { agents?: string[]; maxBranches?: number };
}

export interface Architecture {
    /**
     * `declared` comes from the registry and is complete. `observed` is
     * reconstructed from a trajectory and only contains what a run touched —
     * the fallback when nobody handed the report a runner.
     */
    source: 'declared' | 'observed';
    agents: ArchAgent[];
}

export interface DescribeOptions<TCtx = unknown> {
    /** needed to enumerate skill catalogs */
    services?: Services;
    /** the runner's fallback model, for agents that do not pin one */
    defaultModel?: Model;
    /** resolves context-dependent memory scopes; omitted leaves them symbolic */
    context?: TCtx;
}

/**
 * Projects a registry into a snapshot. Async only because a skill catalog is
 * an index a provider has to be asked for — everything else is already in
 * memory.
 */
export async function describeArchitecture<TCtx = unknown>(
    registry: AgentRegistry<TCtx>,
    opts: DescribeOptions<TCtx> = {},
): Promise<Architecture> {
    const agents: ArchAgent[] = [];
    for (const agent of registry.agents.values()) {
        agents.push(await describeAgent(agent, opts));
    }
    return { source: 'declared', agents };
}

async function describeAgent<TCtx>(
    agent: Agent<TCtx>,
    opts: DescribeOptions<TCtx>,
): Promise<ArchAgent> {
    const skills = await describeSkills(agent, opts.services);
    const own = new Set(agent.tools.map((t) => t.name));
    const tools: ArchTool[] = agent.tools
        // A hand-off is already an edge between two agents; listing its
        // synthetic `transfer_to_*` tool as well would draw it twice.
        .filter((t) => !t.name.startsWith(HANDOFF_PREFIX))
        .map((t) => ({ name: t.name, description: t.description }));
    for (const skill of skills?.catalog ?? []) {
        for (const name of skill.toolNames ?? []) {
            if (own.has(name)) {
                continue;
            }
            own.add(name);
            tools.push({
                name,
                description: opts.services?.skillProvider(skills!.provider).tool(name)?.description,
                skill: skill.name,
            });
        }
    }

    const model = agent.model?.id ?? opts.defaultModel?.id;
    return {
        name: agent.name,
        description: agent.description,
        model,
        inheritedModel: model !== undefined && !agent.model ? true : undefined,
        tools,
        handoffs: [...agent.handoffs],
        skills,
        memory: describeMemory(agent, opts.context),
        fork: agent.fork
            ? { agents: agent.fork.agents, maxBranches: agent.fork.maxBranches }
            : undefined,
    };
}

async function describeSkills<TCtx>(
    agent: Agent<TCtx>,
    services: Services | undefined,
): Promise<ArchAgent['skills']> {
    const binding = agent.skills;
    if (!binding) {
        return undefined;
    }
    const head = { provider: binding.provider, discovery: binding.discovery };
    if (!services?.hasSkills(binding.provider)) {
        return { ...head, catalog: [], unresolved: true };
    }
    const preload = new Set(binding.preload ?? []);
    const keep = allowFilter(binding);
    const summaries = (await services.skillProvider(binding.provider).list()).filter(keep);
    return {
        ...head,
        catalog: summaries.map((s) => ({
            name: s.name,
            description: s.description,
            version: s.version,
            preload: preload.has(s.name) ? true : undefined,
            toolNames: s.toolNames,
        })),
    };
}

function allowFilter(binding: SkillBinding): (s: SkillSummary) => boolean {
    const allow = binding.allow;
    if (!allow) {
        return () => true;
    }
    if (typeof allow === 'function') {
        return allow;
    }
    const set = new Set(allow);
    return (s) => set.has(s.name);
}

/**
 * With a context in hand this is exactly what the run will record. Without
 * one, a scope function is left symbolic rather than called: it would be
 * handed `undefined` and either throw or invent a space no run ever uses.
 */
function describeMemory<TCtx>(agent: Agent<TCtx>, context: TCtx | undefined): ArchMemory[] {
    if (context !== undefined) {
        return agent.memoryBindings(context).map((b) => ({
            store: b.store,
            scope: b.scope,
            access: b.access,
            autoRecall: b.autoRecall ? true : undefined,
        }));
    }
    return agent.memory.map((b) => ({
        store: b.store,
        scope: typeof b.scope === 'function' ? '(per run)' : (b.scope ?? `agent:${agent.name}`),
        access: b.access,
        autoRecall: b.autoRecall ? true : undefined,
    }));
}
