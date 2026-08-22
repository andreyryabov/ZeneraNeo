import type { MemoryBinding, ResolvedBinding } from './memory.ts';
import type { Model } from './model.ts';
import type { Instructions } from './prompt.ts';
import type { SkillBinding } from './skills.ts';
import { HANDOFF_PREFIX, type AnyTool } from './types.ts';

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface ForkOptions {
    /** agents a branch may run; defaults to any registered agent */
    agents?: string[];
    maxBranches?: number;
}

export interface AgentOptions<TCtx = unknown> {
    name: string;
    description?: string;
    /**
     * A string, a function of the run's immutable config, or an ordered list of
     * both plus files. Composed into one prompt — and the files it names are
     * recorded on the `system_prompt` node, so the trajectory says which
     * document to edit.
     */
    instructions?: Instructions<TCtx>;
    model?: Model;
    tools?: AnyTool<TCtx>[];
    /** agents this one may hand the conversation over to (by name or instance) */
    handoffs?: (string | Agent<TCtx>)[];
    /** long-lived memory spaces this agent may read and/or write */
    memory?: MemoryBinding<TCtx>[];
    /** on-demand instruction bundles */
    skills?: SkillBinding;
    /** opt-in to parallel sub-agents */
    fork?: ForkOptions;
}

/**
 * Note what is *not* here any more: `maxTurns`. A run ends on a final answer,
 * an abort or an unrecoverable error — never because a counter ran out.
 */
export class Agent<TCtx = unknown> {
    readonly name: string;
    readonly description?: string;
    readonly instructions?: Instructions<TCtx>;
    readonly model?: Model;
    readonly tools: AnyTool<TCtx>[];
    readonly handoffs: string[];
    readonly memory: MemoryBinding<TCtx>[];
    readonly skills?: SkillBinding;
    readonly fork?: ForkOptions;

    constructor(opts: AgentOptions<TCtx>) {
        this.name = opts.name;
        this.description = opts.description;
        this.instructions = opts.instructions;
        this.model = opts.model;
        this.tools = opts.tools ?? [];
        this.handoffs = (opts.handoffs ?? []).map((h) => (typeof h === 'string' ? h : h.name));
        this.memory = opts.memory ?? [];
        this.skills = opts.skills;
        this.fork = opts.fork;
    }

    /**
     * Memory bindings with their scope resolved against the run context. The
     * resolved value is what gets recorded in the trajectory, so a resumed run
     * cannot drift into another user's space.
     */
    memoryBindings(ctx: TCtx): ResolvedBinding[] {
        return this.memory.map((b) => ({
            store: b.store,
            scope: typeof b.scope === 'function' ? b.scope(ctx) : (b.scope ?? `agent:${this.name}`),
            access: b.access,
            autoRecall: b.autoRecall,
        }));
    }

    /**
     * Copy with fields overridden. `...this` works because every option maps to
     * a same-named own property; `handoffs` round-trips as `string[]`, which the
     * constructor accepts.
     */
    with(patch: Partial<AgentOptions<TCtx>>): Agent<TCtx> {
        return new Agent<TCtx>({ ...this, ...patch });
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry<TCtx = unknown> {
    readonly agents = new Map<string, Agent<TCtx>>();

    /** Registers agents; chainable. */
    add(...agents: Agent<TCtx>[]): this {
        for (const a of agents) {
            if (this.agents.has(a.name)) {
                throw new Error(`duplicate agent name: ${a.name}`);
            }
            this.agents.set(a.name, a);
        }
        return this;
    }

    /** Creates + registers + returns an agent in one call. */
    agent(opts: AgentOptions<TCtx>): Agent<TCtx> {
        const a = new Agent<TCtx>(opts);
        this.add(a);
        return a;
    }

    find(name: string): Agent<TCtx> | undefined {
        return this.agents.get(name);
    }

    get(name: string): Agent<TCtx> {
        const a = this.agents.get(name);
        if (!a) {
            throw new Error(
                `unknown agent: ${name} (known: ${[...this.agents.keys()].join(', ')})`,
            );
        }
        return a;
    }

    names(): string[] {
        return [...this.agents.keys()];
    }
}

// Hand-offs are modelled as ordinary tools named `transfer_to_<agent>`, so the
// model picks the next agent with the same mechanism it uses for everything
// else. The kernel recognises them purely by this prefix.
export function handoffTool<TCtx>(target: string, description?: string): AnyTool<TCtx> {
    return {
        name: `${HANDOFF_PREFIX}${target}`,
        description: description ?? `Hand the conversation over to the "${target}" agent.`,
        parameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Why the hand-off is needed.' } },
            required: [],
            additionalProperties: false,
        },
        // The switch itself happens in the kernel; this body only produces the
        // tool message that acknowledges the call to the model.
        execute: () => `transferred to ${target}`,
    };
}

export function handoffTarget(toolName: string): string | undefined {
    return toolName.startsWith(HANDOFF_PREFIX) ? toolName.slice(HANDOFF_PREFIX.length) : undefined;
}
