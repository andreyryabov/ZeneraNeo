import type { z } from 'zod';
import { Agent, AgentRegistry, type AgentOptions } from './agent.ts';
import {
    EventQueue,
    RunStream,
    type AgentEvent,
    type BranchRef,
    type CheckpointEvent,
    type EventBase,
    type PendingToolCall,
    type StreamDelta,
} from './events.ts';
import { systemClock, type IdClock } from './ids.ts';
import * as Kernel from './kernel.ts';
import type { MemoryStore } from './memory.ts';
import { renderMemories } from './memory.ts';
import type { Model, ModelRequest } from './model.ts';
import { PayloadResolver, type PayloadStore } from './payload.ts';
import { Services } from './services.ts';
import type { SkillProvider } from './skills.ts';
import { lastText, type AgentState, type RunResult } from './state.ts';
import {
    lastOfType,
    projectMessages,
    type ForkNode,
    type HandoffNode,
    type TrajectoryNode,
} from './trajectory.ts';
import {
    isToolReturn,
    stringify,
    zeroUsage,
    type AnyTool,
    type Input,
    type TokenUsage,
    type ToolEffect,
    type ToolOutcome,
} from './types.ts';

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * Collapsing history is two decisions, and they belong on different sides of
 * the I/O line: *which* nodes go (pure, so the kernel can stay pure) and *how*
 * they are rendered (a model call, so the driver owns it).
 */
export interface HandoffPolicy {
    /** nodes the outgoing agent leaves behind, or null to keep everything */
    select(state: AgentState, handoff: HandoffNode): TrajectoryNode[] | null;
}

export type Summary = string | { text: string; usage?: TokenUsage };

export interface Summarizer {
    summarize(nodes: TrajectoryNode[], reason: string, services: Services): Promise<Summary>;
}

export interface JoinPolicy {
    /** what the parent sees for this branch */
    summarize(child: AgentState, services: Services): Promise<string>;
    /** whether one branch's failure aborts the others */
    onBranchError?: 'continue' | 'abort_siblings';
}

const defaultJoinPolicy: JoinPolicy = {
    summarize: (child, services) => lastText(child, services.payloads),
    onBranchError: 'continue',
};

/** Used when no summarizer is configured: says what went, spends no tokens. */
const structuralSummarizer: Summarizer = {
    summarize(nodes, reason) {
        const counts = new Map<string, number>();
        for (const n of nodes) {
            counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
        }
        const what = [...counts].map(([type, n]) => `${n}\u00d7 ${type}`).join(', ');
        return Promise.resolve(`[${reason}] ${nodes.length} earlier steps were dropped: ${what}.`);
    },
};

const SUMMARY_INSTRUCTIONS =
    'You compress an agent transcript. Rewrite the excerpt below as a short plain-text ' +
    'briefing that preserves every decision, fact and open question a successor would ' +
    'need. Do not add commentary and do not invent detail.';

/** A summarizer that asks a model, so the compaction node holds real prose. */
export function modelSummarizer(model: Model, instructions = SUMMARY_INSTRUCTIONS): Summarizer {
    return {
        async summarize(nodes, reason, services): Promise<Summary> {
            // The summarizer reads exactly what the model read.
            const { messages } = await projectMessages(nodes, services.payloads);
            const req: ModelRequest = {
                system: instructions,
                messages: [
                    ...messages,
                    {
                        role: 'user',
                        content: [{ type: 'text', text: `Summarize the above (${reason}).` }],
                    },
                ],
                tools: [],
                toolChoice: 'auto',
            };
            const res = await model.generate(req);
            return { text: res.text, usage: res.usage };
        },
    };
}

export interface RunnerOptions<TCtx = unknown> {
    /** default model for agents that do not pin their own */
    model?: Model;
    context?: TCtx;
    services?: Services;
    payloads?: PayloadStore | PayloadResolver;
    memory?: MemoryStore[];
    skills?: SkillProvider[];
    handoffPolicy?: HandoffPolicy;
    /** renders the nodes a policy selected; defaults to a structural note */
    summarizer?: Summarizer;
    joinPolicy?: JoinPolicy;
    /** use `Model.stream` when the model implements it (default: true) */
    stream?: boolean;
    clock?: IdClock;
}

export interface RunOptions<T = string, TCtx = unknown> {
    context?: TCtx;
    /** typed result: the schema drives both validation and `RunResult<T>` */
    output?: z.ZodType<T>;
    signal?: AbortSignal;
    maxForkDepth?: number;
}

/** Internal: what a branch driver needs on top of the caller's options. */
interface DriveOptions<T, TCtx> extends RunOptions<T, TCtx> {
    branch?: BranchRef;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The driver: it owns all nondeterminism and all I/O, and calls the kernel to
 * advance the state. Every checkpoint event carries a complete snapshot, so a
 * consumer can persist it and later `resume()` from exactly that point.
 *
 * There is no turn budget. A run ends on a final answer, an abort or an
 * unrecoverable error.
 */
export class AgentRunner<TCtx = unknown> {
    readonly registry = new AgentRegistry<TCtx>();
    readonly services: Services;
    readonly #model?: Model;
    readonly #context?: TCtx;
    readonly #handoffPolicy?: HandoffPolicy;
    readonly #summarizer: Summarizer;
    readonly #joinPolicy: JoinPolicy;
    readonly #stream: boolean;
    readonly #clock: IdClock;

    constructor(opts: RunnerOptions<TCtx> = {}) {
        this.#model = opts.model;
        this.#context = opts.context;
        this.services =
            opts.services ??
            new Services({
                payloads: opts.payloads,
                memory: opts.memory,
                skills: opts.skills,
            });
        this.#handoffPolicy = opts.handoffPolicy;
        this.#summarizer = opts.summarizer ?? structuralSummarizer;
        this.#joinPolicy = opts.joinPolicy ?? defaultJoinPolicy;
        this.#stream = opts.stream ?? true;
        this.#clock = opts.clock ?? systemClock;
    }

    /** Registers agents; chainable. */
    add(...agents: Agent<TCtx>[]): this {
        this.registry.add(...agents);
        return this;
    }

    /** Creates + registers + returns an agent in one call. */
    agent(opts: AgentOptions<TCtx>): Agent<TCtx> {
        return this.registry.agent(opts);
    }

    get(name: string): Agent<TCtx> {
        return this.registry.get(name);
    }

    /**
     * Starts a new run. State creation is explicit inside, so the first event a
     * consumer sees (`run_created`) already carries a persistable snapshot.
     */
    run<T = string>(
        agent: Agent<TCtx> | string,
        input?: Input,
        opts: RunOptions<T, TCtx> = {},
    ): RunStream<T> {
        // Generators are lazy: nothing executes until the stream is iterated or
        // awaited, so building a RunStream costs nothing.
        return new RunStream<T>(this.#start(agent, input, opts));
    }

    /** Continues a persisted run from its own snapshot. */
    resume<T = string>(state: AgentState, opts: RunOptions<T, TCtx> = {}): RunStream<T> {
        return new RunStream<T>(this.#drive(state, opts));
    }

    /** Adds a follow-up message to a finished (or paused) run and continues it. */
    send<T = string>(
        state: AgentState,
        input: Input,
        opts: RunOptions<T, TCtx> = {},
    ): RunStream<T> {
        return new RunStream<T>(this.#sendAndDrive(state, input, opts));
    }

    async *#sendAndDrive<T>(
        state: AgentState,
        input: Input,
        opts: RunOptions<T, TCtx>,
    ): AsyncGenerator<AgentEvent, RunResult<T>> {
        const next = await Kernel.applyUserInput(state, input, this.#env(opts));
        return yield* this.#drive(next, opts);
    }

    #env<T>(opts: RunOptions<T, TCtx>): Kernel.KernelEnv {
        return {
            services: this.services,
            output: opts.output as z.ZodType | undefined,
            clock: this.#clock,
        };
    }

    async *#start<T>(
        agent: Agent<TCtx> | string,
        input: Input | undefined,
        opts: RunOptions<T, TCtx>,
    ): AsyncGenerator<AgentEvent, RunResult<T>> {
        const name = typeof agent === 'string' ? agent : agent.name;
        this.registry.get(name);
        const state = await Kernel.createState<T, TCtx>(
            {
                agent: name,
                input,
                context: (opts.context ?? this.#context) as TCtx,
                output: opts.output,
                maxForkDepth: opts.maxForkDepth,
            },
            this.#env(opts),
        );
        yield tag(state, undefined, { type: 'run_created', state });
        return yield* this.#drive(state, opts);
    }

    /**
     * The loop. `state` is reassigned rather than mutated: every kernel call
     * returns a fresh object, so the snapshot inside an already-emitted event
     * stays valid.
     */
    async *#drive<T>(
        initial: AgentState,
        opts: DriveOptions<T, TCtx>,
    ): AsyncGenerator<AgentEvent, RunResult<T>> {
        const env = this.#env(opts);
        Kernel.checkOutputSchema(initial, env);
        const branch = opts.branch;
        const signal = opts.signal;
        let state = initial;

        for (;;) {
            if (signal?.aborted) {
                return yield* this.#finish(state, branch, 'aborted');
            }
            const action = Kernel.nextAction(state);

            switch (action.kind) {
                case 'done':
                    return yield* this.#finish(state, branch, 'final');

                case 'llm': {
                    state = await Kernel.applySystemPrompt(state, this.registry, env);
                    state = await this.#autoRecall(state, env);
                    yield tag(state, branch, { type: 'before_llm_call', state });

                    const req = await Kernel.buildRequest(state, this.registry, env);
                    const digest = Kernel.requestDigest(req);
                    const model = this.#modelFor(state);

                    const deltas = new EventQueue<AgentEvent>();
                    const call = (
                        this.#stream && model.stream
                            ? model.stream({ ...req, signal }, (d: StreamDelta) =>
                                  deltas.push(tag(state, branch, d)),
                              )
                            : model.generate({ ...req, signal })
                    ).finally(() => deltas.close());
                    // Deltas arrive in a callback, which a generator cannot
                    // yield from; draining the queue while the call is in
                    // flight bridges the two.
                    yield* deltas.drain();
                    const res = await call;

                    const before = state;
                    state = await Kernel.applyLlmResponse(
                        state,
                        res,
                        model.id,
                        env,
                        digest,
                        this.registry,
                    );
                    const node = appended(before, state).find((n) => n.type === 'llm_call');
                    if (node) {
                        yield tag(state, branch, { type: 'after_llm_call', state, node });
                    }
                    break;
                }

                case 'tools': {
                    const tools = await Kernel.resolveTools(state, this.registry, env);
                    for (const call of action.calls) {
                        yield tag(state, branch, { type: 'before_tool_call', state, call });
                        const was = state;
                        const outcome = await this.#runTool(state, tools, call, opts);
                        state = await Kernel.applyToolResult(state, call.callId, outcome, env);
                        const added = appended(was, state);
                        const node = added.find((n) => n.type === 'tool_result');
                        if (node) {
                            yield tag(state, branch, { type: 'after_tool_call', state, node });
                        }
                        const handoff = added.find((n) => n.type === 'handoff');
                        if (handoff) {
                            state = await this.#compactHandoff(state, handoff, env);
                            yield tag(state, branch, {
                                type: 'handoff',
                                state,
                                from: handoff.from,
                                to: handoff.to,
                            });
                        }
                    }
                    break;
                }

                case 'fork': {
                    const fork = state.trajectory.find(
                        (n): n is ForkNode => n.type === 'fork' && n.callId === action.forkId,
                    );
                    if (fork) {
                        yield tag(state, branch, { type: 'before_fork', state, node: fork });
                    }
                    const results = yield* this.#runBranches(state, action, opts);
                    const before = state;
                    state = await Kernel.applyJoin(state, action.forkId, results, env);
                    const node = appended(before, state).find((n) => n.type === 'join');
                    if (node) {
                        yield tag(state, branch, { type: 'after_join', state, node });
                    }
                    break;
                }
            }
        }
    }

    /**
     * Branches really run in parallel — each has its own model calls and its own
     * tool executions. Their events are interleaved into the parent stream but
     * stay demultiplexable through the `branch` tag, while their trajectories
     * remain separate and ordered.
     */
    async *#runBranches<T>(
        parent: AgentState,
        action: Extract<Kernel.NextAction, { kind: 'fork' }>,
        opts: DriveOptions<T, TCtx>,
    ): AsyncGenerator<AgentEvent, Kernel.BranchResult[]> {
        const env = this.#env(opts);
        const queue = new EventQueue<AgentEvent>();
        const siblings = new AbortController();
        const signal =
            this.#joinPolicy.onBranchError === 'abort_siblings'
                ? anySignal(opts.signal, siblings.signal)
                : opts.signal;

        const tasks = action.branches.map(async (plan): Promise<Kernel.BranchResult> => {
            const child = await Kernel.createChildState(parent, action.forkId, plan.name, env);
            const ref: BranchRef = {
                forkId: action.forkId,
                name: plan.name,
                runId: child.runId,
                depth: child.spec.forkDepth,
            };
            queue.push(
                tag(parent, opts.branch, {
                    type: 'branch_started',
                    state: parent,
                    child: ref,
                    childState: child,
                }),
            );
            // Branches are plain runs: tools, handoffs, memory, skills and even
            // nested forks work inside them exactly as on the trunk.
            const gen = this.#drive(child, {
                ...opts,
                output: undefined,
                signal,
                branch: ref,
            } as DriveOptions<string, TCtx>);

            let result: RunResult<string> | undefined;
            let error: string | undefined;
            try {
                for (;;) {
                    const step = await gen.next();
                    if (step.done) {
                        result = step.value;
                        break;
                    }
                    queue.push(step.value);
                }
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
                if (this.#joinPolicy.onBranchError === 'abort_siblings') {
                    siblings.abort();
                }
            }

            const childState = result?.state ?? child;
            const status: Kernel.BranchResult['status'] = error
                ? 'error'
                : result?.stopReason === 'aborted'
                  ? 'aborted'
                  : 'ok';
            queue.push(
                tag(parent, opts.branch, {
                    type: 'branch_finished',
                    state: parent,
                    child: ref,
                    childState,
                    status,
                }),
            );
            return {
                name: plan.name,
                status,
                output:
                    status === 'ok'
                        ? await this.#joinPolicy.summarize(childState, this.services)
                        : (error ?? ''),
                error,
                usage: childState.usage ?? zeroUsage(),
                childRunId: child.runId,
                childState,
            };
        });

        const all = Promise.all(tasks).finally(() => queue.close());
        yield* queue.drain();
        return await all;
    }

    /**
     * Collapses what the outgoing agent left behind. The nodes stay in the
     * trajectory; only the projection replaces them with the summary.
     */
    async #compactHandoff(
        state: AgentState,
        handoff: HandoffNode,
        env: Kernel.KernelEnv,
    ): Promise<AgentState> {
        const nodes = this.#handoffPolicy?.select(state, handoff);
        if (!nodes?.length) {
            return state;
        }
        const summary = await this.#summarizer.summarize(nodes, 'handoff_noise', this.services);
        const { text, usage } = typeof summary === 'string' ? { text: summary, usage: undefined } : summary;
        return Kernel.applyCompaction(
            state,
            { covers: nodes.map((n) => n.id), summary: text, reason: 'handoff_noise', usage },
            env,
        );
    }

    /**
     * Auto-recall runs after new user input and after a hand-off, not before
     * every call: recalling on every turn costs tokens and defeats prompt
     * caching for a marginal gain.
     */
    async #autoRecall(state: AgentState, env: Kernel.KernelEnv): Promise<AgentState> {
        const agent = this.registry.get(state.agentName);
        const bindings = agent
            .memoryBindings(state.context as TCtx)
            .filter((b) => b.autoRecall && b.autoRecall.query !== 'none');
        if (!bindings.length || !shouldRecall(state)) {
            return state;
        }
        const input = Kernel.lastUserInput(state);
        if (!input) {
            return state;
        }
        const parts = await Promise.all(
            input.content.map((p) =>
                p.type === 'text' ? this.services.payloads.get(p.text) : Promise.resolve(''),
            ),
        );
        const query = parts.filter(Boolean).join('\n');
        if (!query) {
            return state;
        }

        let next = state;
        for (const b of bindings) {
            const hits = await this.services
                .memoryStore(b.store)
                .search(b.scope, { text: query, limit: b.autoRecall?.limit ?? 5 });
            if (!hits.length) {
                continue;
            }
            next = await Kernel.applyMemoryEffect(
                next,
                {
                    kind: 'recall',
                    store: b.store,
                    scope: b.scope,
                    query: { text: query, limit: b.autoRecall?.limit ?? 5 },
                    hits: hits.map((h) => ({
                        id: h.record.id,
                        score: h.score,
                        revision: h.record.revision,
                    })),
                    content: renderMemories(hits),
                },
                env,
            );
        }
        return next;
    }

    /**
     * Failure-tolerant on purpose: an unknown tool, malformed arguments or a
     * throwing implementation are all reported back to the model as ordinary
     * tool output, so an otherwise recoverable run continues.
     */
    async #runTool<T>(
        state: AgentState,
        tools: AnyTool<TCtx>[],
        call: PendingToolCall,
        opts: DriveOptions<T, TCtx>,
    ): Promise<ToolOutcome> {
        const started = Date.now();
        const fail = (output: string): ToolOutcome => ({
            output,
            isError: true,
            durationMs: Date.now() - started,
        });

        const def = tools.find((t) => t.name === call.name);
        if (!def) {
            return fail(`error: unknown tool "${call.name}"`);
        }
        const raw = await this.services.payloads.get(call.args);
        let args: unknown;
        try {
            args = JSON.parse(raw || '{}');
        } catch (e) {
            return fail(`error: arguments are not valid JSON: ${String(e)}`);
        }
        try {
            const out = await def.execute(args, {
                ctx: state.context as TCtx,
                state,
                agent: this.registry.get(state.agentName),
                callId: call.callId,
                services: this.services,
                signal: opts.signal,
            });
            const effects: ToolEffect[] = isToolReturn(out) ? out.effects : [];
            const value = isToolReturn(out) ? out.output : out;
            return {
                output: stringify(value),
                isError: false,
                durationMs: Date.now() - started,
                effects: effects.length ? effects : undefined,
            };
        } catch (e) {
            return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    #modelFor(state: AgentState): Model {
        const model = this.registry.get(state.agentName).model ?? this.#model;
        if (!model) {
            throw new Error(`no model configured for agent "${state.agentName}"`);
        }
        return model;
    }

    async *#finish<T>(
        state: AgentState,
        branch: BranchRef | undefined,
        stopReason: RunResult<T>['stopReason'],
    ): AsyncGenerator<AgentEvent, RunResult<T>> {
        const final = lastOfType(state.trajectory, 'final_output');
        const output = (
            state.spec.outputSchema && final && 'parsed' in final
                ? final.parsed
                : await lastText(state, this.services.payloads)
        ) as T;
        const result: RunResult<T> = {
            output,
            agent: state.agentName,
            state,
            usage: state.usage,
            stopReason,
        };
        yield tag(state, branch, {
            type: 'run_finished',
            state,
            result: result as RunResult<unknown>,
        });
        return result;
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tag<E extends StreamDelta | Omit<CheckpointEvent, keyof EventBase>>(
    state: AgentState,
    branch: BranchRef | undefined,
    event: E,
): AgentEvent {
    return { runId: state.runId, agent: state.agentName, branch, ...event } as AgentEvent;
}

/**
 * What a kernel call just appended. The trajectory is append-only and `apply*`
 * only ever appends, so the tail is exactly the new nodes — no backwards scan.
 */
function appended(before: AgentState, after: AgentState): TrajectoryNode[] {
    return after.trajectory.slice(before.trajectory.length);
}

/** Recall after new user input or a hand-off, and never twice in a row. */
function shouldRecall(state: AgentState): boolean {
    const nodes = state.trajectory;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.type === 'system_prompt') {
            continue;
        }
        if (n.type === 'memory_recall') {
            return false;
        }
        return n.type === 'handoff' || (n.type === 'user_input' && !n.synthetic);
    }
    return false;
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
    const present = signals.filter((s): s is AbortSignal => Boolean(s));
    if (!present.length) {
        return undefined;
    }
    return present.length === 1 ? present[0] : AbortSignal.any(present);
}
