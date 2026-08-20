import { z } from 'zod';
import { Agent, AgentRegistry, handoffTarget, handoffTool } from './agent.ts';
import type { PendingToolCall } from './events.ts';
import { systemClock, type IdClock } from './ids.ts';
import { memoryTools, type MemoryOpSpec, type MemoryRecallSpec } from './memory.ts';
import type { ModelRequest, ModelResponse } from './model.ts';
import { hash, type Payload } from './payload.ts';
import type { Services } from './services.ts';
import {
    allows,
    renderSkillIndex,
    renderSkills,
    skillContentHash,
    skillTools,
    type Skill,
    type SkillLoadSpec,
} from './skills.ts';
import type { AgentState, RunPhase, RunSpec } from './state.ts';
import {
    lastOfType,
    nodePayloads,
    projectMessages,
    projected,
    totalUsage,
    type CompactionNode,
    type FinalOutputNode,
    type ForkNode,
    type HandoffNode,
    type JoinNode,
    type LlmCallNode,
    type LoadSkillsNode,
    type MemoryOpNode,
    type MemoryRecallNode,
    type NodeBody,
    type PayloadPart,
    type SystemPromptNode,
    type ToolCallNode,
    type ToolResultNode,
    type TrajectoryNode,
    type UserInputNode,
} from './trajectory.ts';
import {
    FINAL_OUTPUT_TOOL,
    FORK_TOOL,
    addUsage,
    parseArgs,
    toContent,
    zeroUsage,
    type AnyTool,
    type Input,
    type JsonSchema,
    type TokenUsage,
    type ToolOutcome,
    type ToolSchema,
} from './types.ts';

/**
 * The kernel is a module of plain functions: it holds no state and no
 * configuration, so there is nothing to instantiate and nothing hidden. All
 * nondeterminism (ids, clock) and all I/O (payloads, memory, skills) enter
 * through the explicit `KernelEnv` argument, which is what makes the same code
 * usable inside a replay-based workflow engine.
 *
 * Deviation from the spec worth knowing: several `apply*` and `createState` are
 * async, because offloading a value to the `PayloadStore` is I/O. Nothing else
 * in the kernel touches the outside world.
 */
export interface KernelEnv {
    services: Services;
    /** Zod schema of a typed run; must match `state.spec.outputSchemaHash`. */
    output?: z.ZodType;
    clock?: IdClock;
}

const FINAL_OUTPUT_INSTRUCTIONS =
    `When you have the complete answer, deliver it by calling the \`${FINAL_OUTPUT_TOOL}\` ` +
    `tool with arguments matching its schema. Plain prose is not accepted as the final answer.`;

// ---------------------------------------------------------------------------
// Node drafting
// ---------------------------------------------------------------------------

interface Draft {
    add<T extends TrajectoryNode>(body: NodeBody<T>, agent?: string): T;
    commit(patch: Partial<AgentState>): AgentState;
}

/**
 * Every `apply*` returns a *new* state object; old snapshots stay valid, which
 * is exactly what a checkpointing caller needs. Nodes carry no index: the array
 * *is* the order.
 */
function begin(state: AgentState, env: KernelEnv): Draft {
    const clock = env.clock ?? systemClock;
    const nodes: TrajectoryNode[] = [];
    return {
        add<T extends TrajectoryNode>(body: NodeBody<T>, agent = state.agentName): T {
            const node = {
                id: clock.newId(),
                ts: clock.now(),
                agent,
                ...body,
            } as T;
            nodes.push(node);
            return node;
        },
        commit(patch: Partial<AgentState>): AgentState {
            const trajectory = [...state.trajectory, ...nodes];
            return { ...state, ...patch, trajectory, usage: ownUsage(state, trajectory) };
        },
    };
}

/**
 * What *this* run consumed. A branch starts from a copy of the parent's prefix,
 * whose `llm_call` nodes were paid for by the parent, so they are excluded.
 */
function ownUsage(state: AgentState, trajectory: TrajectoryNode[]): TokenUsage {
    return totalUsage(trajectory.slice(state.spec.prefixLength ?? 0));
}

function put(env: KernelEnv, value: string): Promise<Payload> {
    return env.services.payloads.put(value);
}

async function toPayloadParts(env: KernelEnv, input: Input): Promise<PayloadPart[]> {
    return Promise.all(
        toContent(input).map(async (p): Promise<PayloadPart> =>
            p.type === 'text'
                ? { type: 'text', text: await put(env, p.text) }
                : { type: p.type, url: p.url, mimeType: p.mimeType },
        ),
    );
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

export interface CreateStateOptions<T = string, TCtx = unknown> {
    /** default: a fresh ulid */
    runId?: string;
    /** starting agent name */
    agent: string;
    input?: Input;
    /** app context — must be JSON-serializable */
    context?: TCtx;
    /** typed-result request: the source of both `T` and validation */
    output?: z.ZodType<T>;
    /** pre-rendered; otherwise rendered on the first step */
    systemPrompt?: string;
    maxForkDepth?: number;
}

/**
 * The only way to obtain a state. Starting a run is explicit; the loop then
 * only ever *advances* an existing state.
 */
export async function createState<T = string, TCtx = unknown>(
    opts: CreateStateOptions<T, TCtx>,
    env: KernelEnv,
): Promise<AgentState> {
    const clock = env.clock ?? systemClock;
    const spec: RunSpec = {
        startAgent: opts.agent,
        forkDepth: 0,
        maxForkDepth: opts.maxForkDepth ?? 2,
    };
    if (opts.output) {
        const { schema, wrapped } = outputJsonSchema(opts.output);
        spec.outputSchema = schema;
        spec.outputSchemaHash = hash(JSON.stringify(schema));
        spec.outputWrapped = wrapped;
    }

    const state: AgentState = {
        version: 1,
        runId: opts.runId ?? clock.newId(),
        spec,
        agentName: opts.agent,
        phase: 'created',
        trajectory: [],
        pendingToolCalls: [],
        usage: zeroUsage(),
        context: opts.context,
    };

    const b = begin(state, env);
    if (opts.systemPrompt !== undefined) {
        b.add<SystemPromptNode>({ type: 'system_prompt', prompt: await put(env, opts.systemPrompt) });
    }
    if (opts.input !== undefined) {
        b.add<UserInputNode>({ type: 'user_input', content: await toPayloadParts(env, opts.input) });
    }
    return b.commit({ phase: opts.input === undefined ? 'created' : 'awaiting_llm' });
}

/**
 * A Zod schema is a live object with functions, so it cannot live in a
 * JSON-serializable state; its JSON Schema projection can, and must, because it
 * is part of the prompt (the `final_output` tool's parameters).
 */
function outputJsonSchema(schema: z.ZodType): { schema: JsonSchema; wrapped: boolean } {
    let json: unknown;
    try {
        json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    } catch (e) {
        // Transforms, refinements and z.custom have no JSON Schema equivalent:
        // the model sees the looser shape and safeParse enforces the rest.
        console.warn(`output schema is only partly representable as JSON Schema: ${String(e)}`);
        json = z.toJSONSchema(schema, {
            target: 'draft-2020-12',
            io: 'input',
            unrepresentable: 'any',
        });
    }
    const obj = json as Record<string, unknown>;
    if (obj.type === 'object') {
        return { schema: obj as JsonSchema, wrapped: false };
    }
    // Non-object roots (a bare string, array, union …) cannot be tool
    // parameters, so they travel in a single `value` property.
    return {
        schema: {
            type: 'object',
            properties: { value: obj },
            required: ['value'],
            additionalProperties: false,
        },
        wrapped: true,
    };
}

/** A persisted run must not silently change its contract on resume. */
export function checkOutputSchema(state: AgentState, env: KernelEnv): void {
    if (!env.output) {
        return;
    }
    const { schema } = outputJsonSchema(env.output);
    const given = hash(JSON.stringify(schema));
    if (state.spec.outputSchemaHash && given !== state.spec.outputSchemaHash) {
        throw new Error(
            `output schema mismatch: run ${state.runId} was created with a different schema`,
        );
    }
}

// ---------------------------------------------------------------------------
// What happens next
// ---------------------------------------------------------------------------

export interface BranchPlan {
    name: string;
    agent: string;
    childRunId: string;
}

export type NextAction =
    | { kind: 'llm' }
    | { kind: 'tools'; calls: PendingToolCall[] }
    | { kind: 'fork'; forkId: string; branches: BranchPlan[] }
    | { kind: 'done'; output: FinalOutputNode };

/** Pure inspection: what must happen next. No I/O, no payload resolution. */
export function nextAction(state: AgentState): NextAction {
    if (state.phase === 'failed') {
        throw new Error(`run ${state.runId} failed: ${state.error ?? 'unknown error'}`);
    }
    if (state.phase === 'done') {
        const output = lastOfType(state.trajectory, 'final_output');
        if (!output) {
            throw new Error(`run ${state.runId} is done but has no final output`);
        }
        return { kind: 'done', output };
    }
    // Tool results are what unblock the next model call, so they come first even
    // when a fork is also pending.
    if (state.pendingToolCalls.length) {
        const byId = new Map(
            state.trajectory.flatMap((n) => (n.type === 'tool_call' ? [[n.callId, n] as const] : [])),
        );
        const calls = state.pendingToolCalls.flatMap((id): PendingToolCall[] => {
            const n = byId.get(id);
            return n ? [{ callId: n.callId, name: n.name, args: n.args }] : [];
        });
        if (calls.length) {
            return { kind: 'tools', calls };
        }
    }
    const pendingFork = state.pendingFork;
    if (pendingFork?.branches.length) {
        // Looked up by call id, not by "the last fork node": with two forks in
        // one run the most recent one is not necessarily the pending one.
        const fork = state.trajectory.find(
            (n): n is ForkNode => n.type === 'fork' && n.callId === pendingFork.callId,
        );
        if (fork) {
            const branches = fork.branches
                .filter((b) => pendingFork.branches.includes(b.name))
                .map(({ name, agent, childRunId }) => ({ name, agent, childRunId }));
            return { kind: 'fork', forkId: fork.callId, branches };
        }
    }
    return { kind: 'llm' };
}

// ---------------------------------------------------------------------------
// Tool set — derived from the state, not a static agent property
// ---------------------------------------------------------------------------

const FORK_PARAMETERS: JsonSchema = {
    type: 'object',
    properties: {
        branches: {
            type: 'array',
            minItems: 2,
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'stable branch label' },
                    instructions: { type: 'string', description: 'what this branch must do' },
                    agent: { type: 'string', description: 'agent to run the branch' },
                },
                required: ['name', 'instructions'],
                additionalProperties: false,
            },
        },
        context: { type: 'string', enum: ['inherit', 'compact', 'none'] },
    },
    required: ['branches'],
    additionalProperties: false,
};

/** Skills activated by still-projected `load_skills` nodes of the active agent. */
async function activeSkills(state: AgentState, env: KernelEnv): Promise<Skill[]> {
    const nodes = projected(state.trajectory).filter(
        (n): n is LoadSkillsNode => n.type === 'load_skills' && n.agent === state.agentName,
    );
    const out: Skill[] = [];
    for (const node of nodes) {
        const provider = env.services.skillProvider(node.provider);
        for (const ref of node.skills) {
            const skill = await provider.load(ref.name, ref.version);
            // A silent substitution would leave the model with instructions it
            // never saw, so a drifted catalog is a hard error.
            if (skillContentHash(skill) !== ref.contentHash) {
                throw new Error(
                    `skill "${ref.name}" changed since it was loaded in run ${state.runId}`,
                );
            }
            out.push(skill);
        }
    }
    return out;
}

/**
 * tools(state) = agent tools + handoffs + memory + active skills + fork +
 * final_output. Computed from the state so a rehydrated run offers exactly the
 * tools it had before the crash.
 */
export async function resolveTools<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<AnyTool<TCtx>[]> {
    const agent = reg.get(state.agentName);
    const ctx = state.context as TCtx;
    const tools: AnyTool<TCtx>[] = [...agent.tools];

    for (const name of agent.handoffs) {
        tools.push(handoffTool<TCtx>(name, reg.find(name)?.description));
    }
    tools.push(...memoryTools<TCtx>(agent.memoryBindings(ctx)));
    if (agent.skills) {
        tools.push(...skillTools<TCtx>(agent.skills));
        for (const skill of await activeSkills(state, env)) {
            tools.push(...(skill.tools ?? []));
        }
    }
    if (agent.fork && state.spec.forkDepth < state.spec.maxForkDepth) {
        tools.push({
            name: FORK_TOOL,
            description:
                'Split the work into independent branches that run in parallel and ' +
                'rejoin into one result. Use it for genuinely independent sub-tasks.',
            parameters: FORK_PARAMETERS,
            // Never executed as a tool: the runner drives branches and the join
            // becomes the tool result.
            execute: () => 'fork scheduled',
        });
    }
    if (state.spec.outputSchema) {
        tools.push({
            name: FINAL_OUTPUT_TOOL,
            description: 'Deliver the final answer. Ends the run.',
            parameters: state.spec.outputSchema,
            execute: () => 'final output accepted',
        });
    }
    return tools;
}

function toSchema(t: ToolSchema): ToolSchema {
    return { name: t.name, description: t.description, parameters: t.parameters };
}

/**
 * Projection + tool schemas + system prompt for the active agent. The only
 * place in the kernel that dereferences payloads — everything else works on
 * refs alone.
 */
export async function buildRequest<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<ModelRequest> {
    const agent = reg.get(state.agentName);
    const { system, messages } = await projectMessages(state.trajectory, env.services.payloads);
    const tools = await resolveTools(state, reg, env);

    const extras: string[] = [];
    if (agent.skills?.discovery === 'index') {
        const provider = env.services.skillProvider(agent.skills.provider);
        const index = (await provider.list()).filter((s) => allows(agent.skills as never, s));
        const rendered = renderSkillIndex(index, agent.skills.maxIndexEntries ?? 50);
        if (rendered) {
            extras.push(rendered);
        }
    }
    if (state.spec.outputSchema) {
        extras.push(FINAL_OUTPUT_INSTRUCTIONS);
    }

    return {
        system: [system, ...extras].filter(Boolean).join('\n\n') || undefined,
        messages,
        tools: tools.map(toSchema),
        toolChoice: 'auto',
    };
}

/** Stable fingerprint of a request, for replay divergence detection. */
export function requestDigest(req: ModelRequest): string {
    return hash(
        JSON.stringify({
            system: req.system ?? '',
            messages: req.messages,
            tools: req.tools.map((t) => t.name),
        }),
    );
}

/**
 * A request as it goes onto an `llm_call` node: everything that shaped the
 * call, minus the `signal`, which is machinery rather than content and is not
 * JSON anyway. Pretty-printed, since the whole point of keeping it is that a
 * human reads it later.
 */
export function serializeRequest(req: ModelRequest): string {
    const { signal: _signal, ...rest } = req;
    return JSON.stringify(rest, null, 2);
}

// ---------------------------------------------------------------------------
// Advancing the state
// ---------------------------------------------------------------------------

export async function applyUserInput(
    state: AgentState,
    input: Input,
    env: KernelEnv,
    synthetic = false,
): Promise<AgentState> {
    const b = begin(state, env);
    b.add<UserInputNode>({
        type: 'user_input',
        content: await toPayloadParts(env, input),
        synthetic: synthetic || undefined,
    });
    return b.commit({ phase: 'awaiting_llm' });
}

/**
 * Renders the active agent's instructions into the trajectory. Idempotent: a
 * matching prompt already in force produces no node, so re-entering the loop
 * (or resuming) does not litter the history.
 */
export async function applySystemPrompt<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<AgentState> {
    const agent = reg.get(state.agentName);
    const prompt = agent.systemPrompt(state.context as TCtx, state);
    if (prompt === undefined) {
        return state;
    }
    const current = lastOfType(projected(state.trajectory), 'system_prompt');
    if (current && current.agent === state.agentName && current.prompt.sha256 === hash(prompt)) {
        return state;
    }
    const b = begin(state, env);
    b.add<SystemPromptNode>({ type: 'system_prompt', prompt: await put(env, prompt) });
    return b.commit({});
}

interface ForkArgs {
    branches: { name: string; instructions: string; agent?: string }[];
    context?: 'inherit' | 'compact' | 'none';
}

function parseForkArgs(raw: string): ForkArgs | string {
    const args = parseArgs(raw);
    const branches = args.branches;
    if (!Array.isArray(branches) || branches.length < 2) {
        return 'fork requires at least two branches';
    }
    const parsed: ForkArgs['branches'] = [];
    for (const b of branches as Record<string, unknown>[]) {
        if (typeof b?.name !== 'string' || typeof b?.instructions !== 'string') {
            return 'every branch needs a "name" and "instructions"';
        }
        parsed.push({
            name: b.name,
            instructions: b.instructions,
            agent: typeof b.agent === 'string' ? b.agent : undefined,
        });
    }
    if (new Set(parsed.map((b) => b.name)).size !== parsed.length) {
        return 'branch names must be unique';
    }
    const mode = args.context;
    return {
        branches: parsed,
        context:
            mode === 'inherit' || mode === 'compact' || mode === 'none' ? mode : 'inherit',
    };
}

/** What the driver knows about a model call that the response itself omits. */
export interface LlmCallOptions<TCtx = unknown> {
    /** stable fingerprint of the request, for replay divergence detection */
    digest?: string;
    /** the request as sent; stored as a payload on the node when given */
    request?: ModelRequest;
    /** needed to validate a `fork` call against the agent's declaration */
    registry?: AgentRegistry<TCtx>;
}

/**
 * Appends the `llm_call` node (plus the nodes its tool calls imply) and moves
 * the phase on. Typed runs are resolved here too: `final_output` never reaches
 * tool execution, it is validated against the run's schema on the spot.
 */
export async function applyLlmResponse<TCtx>(
    state: AgentState,
    res: ModelResponse,
    model: string,
    env: KernelEnv,
    opts: LlmCallOptions<TCtx> = {},
): Promise<AgentState> {
    const reg = opts.registry;
    const b = begin(state, env);
    const toolCalls = await Promise.all(
        res.toolCalls.map(async (c) => ({
            callId: c.id,
            name: c.name,
            args: await put(env, c.args),
        })),
    );
    b.add<LlmCallNode>({
        type: 'llm_call',
        model,
        requestDigest: opts.digest ?? (opts.request ? requestDigest(opts.request) : ''),
        request: opts.request ? await put(env, serializeRequest(opts.request)) : undefined,
        text: await put(env, res.text),
        thinking: res.thinking ? await put(env, res.thinking) : undefined,
        toolCalls,
        usage: res.usage ?? zeroUsage(),
        stopReason: res.stopReason ?? (res.toolCalls.length ? 'tool_calls' : 'stop'),
    });

    // --- no tool calls: either the run is over, or the model owes us a call ---
    if (!res.toolCalls.length) {
        if (!state.spec.outputSchema) {
            b.add<FinalOutputNode>({ type: 'final_output', output: await put(env, res.text) });
            return b.commit({ phase: 'done', pendingToolCalls: [] });
        }
        b.add<UserInputNode>({
            type: 'user_input',
            content: [
                {
                    type: 'text',
                    text: await put(
                        env,
                        `Your answer must be delivered through the \`${FINAL_OUTPUT_TOOL}\` tool.`,
                    ),
                },
            ],
            synthetic: true,
        });
        return b.commit({ phase: 'awaiting_llm', pendingToolCalls: [] });
    }

    const pending: string[] = [];
    let pendingFork = state.pendingFork;
    let done = false;

    for (let i = 0; i < res.toolCalls.length; i++) {
        const call = res.toolCalls[i];
        const ref = toolCalls[i];

        if (call.name === FINAL_OUTPUT_TOOL && state.spec.outputSchema) {
            const parsed = validateOutput(state, env, call.args);
            if (parsed.ok) {
                b.add<FinalOutputNode>({
                    type: 'final_output',
                    output: await put(env, stringifyOutput(parsed.value)),
                    parsed: parsed.value,
                });
                done = true;
            } else {
                // Repairable: the model sees its own mistake and tries again.
                b.add<ToolResultNode>({
                    type: 'tool_result',
                    callId: call.id,
                    name: call.name,
                    result: await put(env, parsed.message),
                    isError: true,
                });
            }
            continue;
        }

        if (call.name === FORK_TOOL) {
            const args = parseForkArgs(call.args);
            const problem =
                typeof args === 'string' ? args : forkProblem(state, args, reg);
            if (typeof args === 'string' || problem) {
                b.add<ToolResultNode>({
                    type: 'tool_result',
                    callId: call.id,
                    name: call.name,
                    result: await put(env, `error: ${problem ?? (args as string)}`),
                    isError: true,
                });
                continue;
            }
            const clock = env.clock ?? systemClock;
            const branches = await Promise.all(
                args.branches.map(async (br) => ({
                    name: br.name,
                    agent: br.agent ?? state.agentName,
                    instructions: await put(env, br.instructions),
                    childRunId: clock.newId(),
                })),
            );
            b.add<ForkNode>({
                type: 'fork',
                callId: call.id,
                contextMode: args.context ?? 'inherit',
                branches,
            });
            pendingFork = { callId: call.id, branches: branches.map((br) => br.name) };
            continue;
        }

        b.add<ToolCallNode>({
            type: 'tool_call',
            callId: call.id,
            name: call.name,
            args: ref.args,
        });
        pending.push(call.id);
    }

    if (done) {
        return b.commit({ phase: 'done', pendingToolCalls: [], pendingFork: undefined });
    }
    const phase: RunPhase = pending.length
        ? 'awaiting_tools'
        : pendingFork?.branches.length
          ? 'awaiting_branches'
          : 'awaiting_llm';
    return b.commit({ phase, pendingToolCalls: pending, pendingFork });
}

function forkProblem<TCtx>(
    state: AgentState,
    args: ForkArgs,
    reg?: AgentRegistry<TCtx>,
): string | undefined {
    const agent = reg?.find(state.agentName);
    if (agent && !agent.fork) {
        return 'this agent cannot fork';
    }
    const max = agent?.fork?.maxBranches;
    if (max && args.branches.length > max) {
        return `at most ${max} branches are allowed`;
    }
    for (const b of args.branches) {
        const name = b.agent ?? state.agentName;
        if (reg && !reg.find(name)) {
            return `unknown agent for branch "${b.name}": ${name}`;
        }
        if (agent?.fork?.agents && !agent.fork.agents.includes(name)) {
            return `agent "${name}" may not run a branch of this fork`;
        }
    }
    return undefined;
}

function stringifyOutput(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/**
 * Validation uses the Zod schema when the caller supplied one — transforms,
 * defaults and refinements included. A run resumed by generic tooling without
 * the original schema degrades to a structural JSON Schema check.
 */
function validateOutput(
    state: AgentState,
    env: KernelEnv,
    raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
    let args: unknown;
    try {
        args = JSON.parse(raw || '{}');
    } catch (e) {
        return { ok: false, message: `error: arguments are not valid JSON: ${String(e)}` };
    }
    const payload = state.spec.outputWrapped
        ? (args as Record<string, unknown>)?.value
        : args;

    if (env.output) {
        const parsed = env.output.safeParse(payload);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : { ok: false, message: `error: output does not match the schema:\n${z.prettifyError(parsed.error)}` };
    }
    const schema = state.spec.outputSchema;
    if (!state.spec.outputWrapped && schema?.required?.length) {
        const obj = (payload ?? {}) as Record<string, unknown>;
        const missing = schema.required.filter((k) => obj[k] === undefined);
        if (missing.length) {
            return { ok: false, message: `error: missing required fields: ${missing.join(', ')}` };
        }
    }
    return { ok: true, value: payload };
}

/**
 * Appends the tool result, folds in whatever the tool did to memory or skills,
 * and performs a hand-off when the call was a `transfer_to_*`.
 */
export async function applyToolResult(
    state: AgentState,
    callId: string,
    outcome: ToolOutcome,
    env: KernelEnv,
): Promise<AgentState> {
    const call = state.trajectory.find(
        (n): n is ToolCallNode => n.type === 'tool_call' && n.callId === callId,
    );
    if (!call) {
        throw new Error(`no pending tool call ${callId} in run ${state.runId}`);
    }
    const b = begin(state, env);
    b.add<ToolResultNode>({
        type: 'tool_result',
        callId,
        name: call.name,
        result: await put(env, outcome.output),
        isError: outcome.isError,
        durationMs: outcome.durationMs,
    });

    for (const effect of outcome.effects ?? []) {
        if (effect.kind === 'memory_op') {
            await addMemoryOp(b, env, effect.spec);
        } else {
            await addSkillLoad(b, env, effect.spec);
        }
    }

    const target = outcome.isError ? undefined : handoffTarget(call.name);
    let agentName = state.agentName;
    if (target) {
        b.add<HandoffNode>({
            type: 'handoff',
            from: state.agentName,
            to: target,
            reason: asReason(call),
        });
        agentName = target;
    }

    const pendingToolCalls = state.pendingToolCalls.filter((id) => id !== callId);
    const phase: RunPhase = pendingToolCalls.length
        ? 'awaiting_tools'
        : state.pendingFork?.branches.length
          ? 'awaiting_branches'
          : 'awaiting_llm';
    return b.commit({ phase, pendingToolCalls, agentName });
}

function asReason(call: ToolCallNode): string | undefined {
    // The reason travels in the call arguments, which are behind a payload; the
    // preview is enough for a human-readable trace and costs no I/O.
    const preview = call.args.preview;
    if (!preview) {
        return undefined;
    }
    const reason = parseArgs(preview).reason;
    return typeof reason === 'string' ? reason : undefined;
}

async function addMemoryOp(b: Draft, env: KernelEnv, spec: MemoryOpSpec): Promise<void> {
    b.add<MemoryOpNode>({
        type: 'memory_op',
        op: spec.op,
        store: spec.store,
        scope: spec.scope,
        opId: spec.opId,
        recordId: spec.recordId,
        revision: spec.revision,
        before: spec.before === undefined ? undefined : await put(env, spec.before),
        after: spec.after === undefined ? undefined : await put(env, spec.after),
    });
}

async function addSkillLoad(b: Draft, env: KernelEnv, spec: SkillLoadSpec): Promise<void> {
    b.add<LoadSkillsNode>({
        type: 'load_skills',
        provider: spec.provider,
        skills: spec.skills.map((s) => ({
            name: s.name,
            version: s.version,
            contentHash: skillContentHash(s),
        })),
        content: await put(env, renderSkills(spec.skills)),
        toolNames: spec.skills.flatMap((s) => (s.tools ?? []).map((t) => t.name)),
    });
}

/** Records a memory recall or mutation performed by the driver. */
export async function applyMemoryEffect(
    state: AgentState,
    effect: MemoryRecallSpec | MemoryOpSpec,
    env: KernelEnv,
): Promise<AgentState> {
    const b = begin(state, env);
    if (effect.kind === 'op') {
        await addMemoryOp(b, env, effect);
    } else {
        b.add<MemoryRecallNode>({
            type: 'memory_recall',
            store: effect.store,
            scope: effect.scope,
            query: effect.query,
            hits: effect.hits,
            content: await put(env, effect.content),
        });
    }
    return b.commit({});
}

/** Records a skill activation and the tools it unlocked. */
export async function applySkillLoad(
    state: AgentState,
    provider: string,
    skills: Skill[],
    env: KernelEnv,
): Promise<AgentState> {
    const b = begin(state, env);
    await addSkillLoad(b, env, { kind: 'skill_load', provider, skills });
    return b.commit({});
}

export interface CompactionSpec {
    /** ids of the nodes this summary replaces; need not be contiguous */
    covers: string[];
    summary: string;
    reason: CompactionNode['reason'];
    /** the model's call id when it compacted itself; synthesized otherwise */
    callId?: string;
    /** tokens the summarizer burned */
    usage?: TokenUsage;
}

/**
 * Containment, not deletion: the covered nodes stay in the trajectory for audit
 * and replay, and only the projection skips them. The log stays append-only.
 */
export async function applyCompaction(
    state: AgentState,
    spec: CompactionSpec,
    env: KernelEnv,
): Promise<AgentState> {
    const clock = env.clock ?? systemClock;
    const b = begin(state, env);
    b.add<CompactionNode>({
        type: 'compaction',
        callId: spec.callId ?? `compact_${clock.newId()}`,
        covers: spec.covers,
        summary: await put(env, spec.summary),
        reason: spec.reason,
        usage: spec.usage ?? zeroUsage(),
    });
    return b.commit({});
}

export function applyFailure(state: AgentState, error: string): AgentState {
    return { ...state, phase: 'failed', error };
}

// ---------------------------------------------------------------------------
// Fork / join
// ---------------------------------------------------------------------------

/**
 * Derives a child state seeded with *real nodes* copied from the parent, not a
 * frozen `Message[]` blob: the branch can compact its own inherited context,
 * and at join those nodes splice back into one trajectory. The copy is a
 * snapshot, so the branch can execute in another process.
 */
export async function createChildState(
    state: AgentState,
    forkId: string,
    branch: string,
    env: KernelEnv,
): Promise<AgentState> {
    const fork = state.trajectory.find(
        (n): n is ForkNode => n.type === 'fork' && n.callId === forkId,
    );
    const plan = fork?.branches.find((b) => b.name === branch);
    if (!fork || !plan) {
        throw new Error(`unknown branch ${branch} of fork ${forkId}`);
    }

    const prefix = branchPrefix(state, fork, plan.agent);
    const child: AgentState = {
        version: 1,
        runId: plan.childRunId,
        spec: {
            startAgent: plan.agent,
            parent: { runId: state.runId, forkId, branch },
            forkDepth: state.spec.forkDepth + 1,
            maxForkDepth: state.spec.maxForkDepth,
            // Where the branch's own history begins: the parent already holds
            // the prefix, so only what follows is spliced back at join.
            prefixLength: prefix.length,
        },
        agentName: plan.agent,
        phase: 'created',
        trajectory: prefix,
        pendingToolCalls: [],
        usage: zeroUsage(),
        context: state.context,
    };

    const b = begin(child, env);
    b.add<UserInputNode>({
        type: 'user_input',
        // Reuses the instructions payload already written by the fork node.
        content: [{ type: 'text', text: plan.instructions }],
    });
    return b.commit({ phase: 'awaiting_llm' });
}

/** The parent history a branch starts from, as decided by `contextMode`. */
function branchPrefix(state: AgentState, fork: ForkNode, agent: string): TrajectoryNode[] {
    if (fork.contextMode === 'none') {
        return [];
    }
    const visible = projected(state.trajectory);
    const at = visible.findIndex((n) => n.id === fork.id);
    const before = at === -1 ? visible : visible.slice(0, at);
    return before.filter((n) => {
        // Skills are agent-scoped. Carrying the instructions text across an
        // agent change would leave the branch reading about tools it cannot
        // call, so text and tools have to disappear together.
        if (n.type === 'load_skills') {
            return n.agent === agent;
        }
        // 'compact': start from the conversation, not the parent's tool chatter.
        // The now-unanswered tool calls are dropped by `repairToolCalls`.
        if (fork.contextMode === 'compact') {
            return n.type !== 'tool_call' && n.type !== 'tool_result' && n.type !== 'memory_recall';
        }
        return true;
    });
}

export interface BranchResult {
    name: string;
    status: 'ok' | 'error' | 'aborted';
    /** what the parent sees for this branch — already summarized by the policy */
    output: string;
    error?: string;
    usage: TokenUsage;
    childRunId: string;
    childState: AgentState;
}

/**
 * Folds branches back into the parent. Each branch's history is nested inside
 * its row of the join, in *declared* branch order — so the result is identical
 * regardless of completion order, and a walk of the parent array never trips
 * over someone else's nodes.
 */
export async function applyJoin(
    state: AgentState,
    forkId: string,
    results: BranchResult[],
    env: KernelEnv,
): Promise<AgentState> {
    const fork = state.trajectory.find(
        (n): n is ForkNode => n.type === 'fork' && n.callId === forkId,
    );
    if (!fork) {
        throw new Error(`unknown fork ${forkId} in run ${state.runId}`);
    }
    const byName = new Map(results.map((r) => [r.name, r]));

    const b = begin(state, env);
    const rows: JoinNode['branches'] = [];
    let usage = zeroUsage();
    for (const plan of fork.branches) {
        const r = byName.get(plan.name);
        if (!r) {
            continue;
        }
        rows.push({
            name: plan.name,
            agent: plan.agent,
            status: r.status,
            output: await put(env, r.output),
            error: r.error,
            usage: r.usage,
            // Only what the branch itself did: the inherited prefix is the
            // parent's own history and is already right there in the array.
            nodes: r.childState.trajectory.slice(r.childState.spec.prefixLength ?? 0),
        });
        usage = addUsage(usage, r.usage);
    }

    b.add<JoinNode>({ type: 'join', callId: forkId, branches: rows, usage });
    const remaining = (state.pendingFork?.branches ?? []).filter((n) => !byName.has(n));
    return b.commit({
        pendingFork: remaining.length ? { callId: forkId, branches: remaining } : undefined,
        phase: remaining.length
            ? 'awaiting_branches'
            : state.pendingToolCalls.length
              ? 'awaiting_tools'
              : 'awaiting_llm',
    });
}

// ---------------------------------------------------------------------------
// Small read helpers used by drivers
// ---------------------------------------------------------------------------

export function lastUserInput(state: AgentState): UserInputNode | undefined {
    const nodes = state.trajectory;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.type === 'user_input' && !n.synthetic) {
            return n;
        }
    }
    return undefined;
}

export { Agent, AgentRegistry };
