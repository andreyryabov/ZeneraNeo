# Agent Runtime v2 — Design Specification

Status: draft
Scope: `experiments/src.js/agent/agent.ts` rewrite

## 1. Goals

1. **No turn budget.** Remove `maxTurns` everywhere; the loop ends only on a final
   answer, an abort signal, or an unrecoverable error.
2. **Two-tier event model.**
    - _Stream events_ — ephemeral, fine-grained progress (thinking deltas, text
      deltas, partial tool-argument JSON with the tool name). Never required for
      correctness; safe to drop.
    - _Checkpoint events_ — coarse-grained state transitions emitted **before
      every LLM call** and **before every tool call** (and after each, and on
      handoff / finish). Each carries the full serializable state so the run can
      be persisted and resumed from exactly that point (Temporal-ready).
3. **Explicit state creation.** Starting a run is a separate, explicit step that
   produces an `AgentState`; the loop only ever _advances_ an existing state.
4. **Typed result.** The caller passes a **Zod** schema and receives a parsed,
   validated `z.infer<typeof schema>` as `RunResult<T>.output` — the TypeScript
   type comes from the same declaration that drives validation.
5. **Trajectory instead of raw messages.** The state stores a typed, append-only
   log of everything that happened (`UserInput`, `SystemPrompt`, `LoadSkills`,
   `LlmCall`, `ToolCall`, `ToolResult`, `Handoff`, `Compaction`, …). Messages
   for the provider are a _projection_ of the trajectory, computed on demand.
6. **Large-value offloading.** Every non-trivial string (system prompts,
   thinking chains, tool outputs, skill content) lives behind a `Payload`
   reference — uniformly, never inline — so the state has a small, predictable
   size regardless of how much data flowed through the run.
7. **Full accounting.** Every LLM call node records the model id and token usage
   (input / cached-input / output / reasoning), so total consumption is exactly
   reconstructable from the trajectory alone.
8. **Trajectory as the context-manipulation tool.** Compaction, handoff-time
   noise stripping and branch summarizing are all one operation — select nodes,
   summarize them, append a node that _covers_ them for projection purposes
   while the originals stay for audit and replay.
9. **Pluggable memory.** Agents search, write, update and delete long-lived
   memories through a `MemoryStore` interface; scopes decide what is private to
   an agent and what is shared between agents.
10. **On-demand skills.** Instruction bundles are discovered and loaded through a
    `SkillProvider` interface instead of permanently occupying the prompt.
11. **Fork / join.** An agent can split into parallel branches that really run
    concurrently (LLM and tool calls alike) and rejoin into one result. Each
    branch's history is nested inside the join that reports it, so nothing is
    lost — while the parent's own log stays linear, as if the work had been
    sequential.

## 2. Non-goals

- Provider streaming beyond OpenAI (the `Model` interface defines the stream
  contract; only `OpenAIModel` (chat completions) and `OpenAIResponsesModel`
  (responses) implement it initially).
- Automatic context compaction policy (only the mechanism: `CompactionNode`).
- Concrete `MemoryStore` / `SkillProvider` backends (pgvector, filesystem, …):
  this document specifies the interfaces and how they touch the trajectory; a
  trivial in-memory implementation is the only one shipped initially.
- Cross-run orchestration. One `AgentState` is still one logical run; a fork
  creates _child runs_ (§10) that are linked by reference, not merged.

## 3. Architecture overview

Two layers, so the same core works both as a local async loop and inside a
Temporal workflow:

```
┌────────────────────────────────────────────────────────────┐
│ AgentRunner (driver)                                       │
│   run()/resume() → RunStream: emits StreamEvent +          │
│   CheckpointEvent, awaits Model/Tool/Branch promises       │
└──────────────┬─────────────────────────────────────────────┘
               │ calls (pure w.r.t. state, no I/O)
┌──────────────▼─────────────────────────────────────────────┐
│ kernel.ts (deterministic state machine — plain functions)   │
│   createState()      – explicit initial context            │
│   nextAction(state)  – llm | tools | fork | done           │
│   buildRequest(state)– trajectory → ModelRequest           │
│   applyLlmResponse(state, res)                             │
│   applyToolResult(state, callId, res)                      │
│   applyJoin(state, forkId, branchResults)                  │
│   applyHandoff(state, …) / applyCompaction(state, …)       │
└──────────────┬─────────────────────────────────────────────┘
               │ resolved by the driver, never by the kernel
┌──────────────▼─────────────────────────────────────────────┐
│ PayloadStore  (InMemory | S3 | …)            — §4          │
│ MemoryStore   (InMemory | pgvector | …)      — §8          │
│ SkillProvider (fs | static | vector-backed)  — §9          │
└────────────────────────────────────────────────────────────┘
```

- **Kernel** functions are synchronous or I/O-free except `PayloadStore`
  resolution; all nondeterminism (LLM, tools, clock, ids) enters via arguments.
  This is what makes Temporal integration trivial: the workflow owns the state,
  the activities do the I/O.
- **Runner** is a convenience driver reproducing today's `RunStream` ergonomics.

## 4. Payloads and the PayloadStore

Every string in the trajectory that is not a short identifier is a `Payload` —
always a **reference**, never an inline value:

```ts
export interface Payload {
    store: string; // store id, e.g. 's3://bucket' or 'mem'
    sha256: string; // content address — also the key
    size: number; // bytes, for budgeting without fetching
    preview?: string; // first ~200 chars, for logs, UIs and debugging
}

export interface PayloadStore {
    readonly id: string;
    put(value: string): Promise<Payload>;
    get(p: Payload): Promise<string>;
    /** one round trip for a whole projection */
    getMany(ps: Payload[]): Promise<string[]>;
}
```

### 4.1 Why uniform references (no inline variant)

An `inline | ref` union was considered and rejected:

- **Predictable state size.** With inline values, a long run of many
  individually-small tool results grows the state without bound — and that state
  is re-serialized at _every_ checkpoint, making write amplification quadratic in
  trajectory length. Temporal would reject it outright (payload limits ~2 MB).
  With uniform refs the state is O(number of nodes), full stop.
- **One code path.** No discriminant to switch on, no "is it here or not"
  question at every use site, no threshold to tune per deployment.
- **Free deduplication.** The key _is_ the content hash, so an identical value
  is stored once no matter how often it recurs — system prompts repeated after
  each handoff, inherited fork context shared by N branches, identical tool
  results from retries. With a size threshold, dedup silently stopped applying
  below the threshold.
- **Tractable GC.** Reference counting over `sha256` across stored states is
  well-defined; "which inline blobs are still reachable" is not a question you
  can even ask.

The two things inline bought us are recovered explicitly:

- _Locality_ — the default `InMemoryStore` resolves from a `Map`, so a local run
  does zero I/O. Refs are not synonymous with network.
- _Self-containment_ — `exportRun(state, stores)` produces
  `{ state, blobs: Record<sha256, string> }`, a single portable artifact for
  tests, bug reports and archival; `importRun(bundle, store)` writes the blobs
  into any `PayloadStore`. This is better than inline was: it is explicit, it is deduped, and it
  covers child runs reachable by ref.

### 4.2 Rules

- The kernel never dereferences payloads except in `buildRequest`, where the
  projection needs actual text. `buildRequest` is therefore `async`, and it is
  the **only** place that resolves. Everything else — appending nodes,
  `nextAction`, compaction covering, usage summation — works on refs alone.
- Resolution goes through `getMany`, so a projection costs one batched round
  trip; a resolver-level LRU cache makes repeated projections of a growing
  trajectory cheap (the prefix is unchanged and content-addressed, so cache hits
  are exact).
- `size` exists so token/size budgeting never needs a fetch. `preview` exists so
  logs, admin UIs and debuggers can show something useful without one.
- Stores are content-addressed and therefore **write-once**: `put` of existing
  content is a no-op returning the same `Payload`. This makes writes idempotent
  under retry and replay for free.
- The trajectory stays JSON-serializable: a `Payload` is four scalar fields.
  Rehydrating on another machine requires a store registry keyed by `store` id.
- Payload fields: `SystemPromptNode.prompt`, `LlmCallNode.text/thinking`,
  `ToolCallNode.args`, `ToolResultNode.result`, `CompactionNode.summary`,
  `LoadSkillsNode.content`, `MemoryRecallNode.content`,
  `JoinNode.branches[].output`, `UserInputNode` content parts.
- Degenerate values are not special-cased: the empty string is one well-known
  content address shared by every node that has no text, costing one entry
  globally.

## 5. Trajectory

Append-only ordered log — the run's single source of truth. Nodes are never
removed, rewritten or reordered; **position is order**, so there is no index
field to keep dense. Every node:

```ts
export interface NodeBase {
    id: string; // ulid — unique within the trajectory
    ts: string; // ISO timestamp (informational, not used for logic)
    agent: string; // active agent when the node was created
}
```

Node types (`type` is the discriminant):

```ts
export type TrajectoryNode =
    | UserInputNode // { type:'user_input',  content: PayloadPart[] }
    | SystemPromptNode // { type:'system_prompt', prompt: Payload }
    | LoadSkillsNode // §9.3 — skill activation (content + unlocked tools)
    | MemoryRecallNode // §8.4 — memories injected before an LLM call
    | MemoryOpNode // §8.4 — memory write/update/delete effect record
    | LlmCallNode // see below
    | ToolCallNode // { type:'tool_call', callId, name, args: Payload }
    | ToolResultNode // { type:'tool_result', callId, name, result: Payload,
    //   isError: boolean, durationMs?: number }
    | HandoffNode // { type:'handoff', from, to, reason?: string }
    | ForkNode // §10.2 — the branch plan
    | JoinNode // §10.2 — per-branch outcomes
    | CompactionNode // see below
    | FinalOutputNode; // { type:'final_output', output: Payload,
//   parsed?: unknown /* when an output schema was set */ }
```

### 5.1 LlmCallNode — the accounting record

```ts
export interface TokenUsage {
    inputTokens: number;
    cachedInputTokens: number; // subset of inputTokens served from cache
    outputTokens: number;
    reasoningTokens: number; // subset of outputTokens (thinking)
}

export interface LlmCallNode extends NodeBase {
    type: 'llm_call';
    model: string; // exact model id used
    requestDigest: string; // sha256 of the projected request, for replay checks
    text: Payload; // assistant prose ('' allowed)
    thinking?: Payload; // reasoning chain if the provider returns it
    toolCalls: { callId: string; name: string; args: Payload }[];
    usage: TokenUsage;
    stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}
```

`sum(usage)` over every `llm_call` and `compaction` node reproduces total
consumption exactly, including cache hits. Tokens spent inside a fork are
reached by recursing into the branch histories nested in each `JoinNode`
(§10.6) — the one place anything deliberately crosses the branch boundary. No
separate counters to keep in sync (a cached `usage` total on the state is
allowed but derived).

### 5.2 CompactionNode — covering, not deleting

```ts
export interface CompactionNode extends NodeBase {
    type: 'compaction';
    /** the tool call id this compaction projects as */
    callId: string;
    /** ids of the nodes this summary stands in for — any set, not a range */
    covers: string[];
    /** what the model sees instead; may be empty */
    summary: Payload;
    reason: 'handoff_noise' | 'token_budget' | 'branch_context' | 'manual' | string;
    usage: TokenUsage; // what the summarizer itself cost
}
```

- Covered nodes stay in the trajectory untouched — audit and replay always see
  full history; only the projection skips them.
- `covers` is a **set of ids**, not a range. Selection and summarization are one
  operation ("collapse"), and the selector is free to skip nodes it wants to
  keep; `repairToolCalls` restores provider validity afterwards.
- Later compactions may cover earlier `CompactionNode`s (re-compaction). The
  covered set is an **unconditional union** over every compaction in the array,
  so compaction is monotone: covering a summary can never resurrect what that
  summary was hiding.
- Handoff noise stripping = the runner appending a `CompactionNode` right after a
  `HandoffNode` (§7.4), covering the previous agent's chatter.

### 5.3 One array, one filter

A run's trajectory contains only that run's own nodes. Branch histories are
nested inside the `JoinNode` that reports them (§10.2), so an ordinary walk of
the array never encounters them — the fork scope is structural, not a convention
that every consumer has to remember to honour.

That leaves exactly one filter between the log and the model:

```ts
/** what survives compaction */
export function projected(nodes: TrajectoryNode[]): TrajectoryNode[] {
    const covered = coveredIds(nodes);
    return covered.size ? nodes.filter((n) => !covered.has(n.id)) : nodes;
}
```

| view                                   | who reads it                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| the array                              | `nextAction`, `turns`, `lastText`, `lastUserInput`, `HandoffPolicy.select`, export |
| `projected(array)`                     | `projectMessages`, `activeSkills`, `applySystemPrompt` — the model's world         |
| recursing into `join.branches[].nodes` | `totalUsage` only                                                                  |

The nesting also settles compaction scope for free: a branch may compact the
prefix it inherited, naming ids the parent also has, but those `CompactionNode`s
live in the branch's own array and `coveredIds` never sees them.

### 5.4 Projection: trajectory → messages

```ts
async function projectMessages(
    trajectory: TrajectoryNode[],
    stores: PayloadResolver,
): Promise<{ system?: string; messages: Message[] }>;
```

Algorithm:

1. Take `projected(trajectory)`.
2. Walk the survivors in array order:
    - `system_prompt` → becomes the _current_ system prompt (last one wins;
      earlier ones are superseded, not emitted as messages).
    - `user_input` → `UserMessage`.
    - `load_skills` → `UserMessage` (or system append — provider-dependent).
    - `llm_call` → `AssistantMessage` (text + toolCalls). Thinking is **not**
      projected (provider-specific; kept for audit only).
    - `tool_call` → folded into the owning `AssistantMessage` (they share the
      `llm_call` node in practice; standalone `ToolCallNode` exists so a
      checkpoint can be cut _between_ LLM response and tool execution).
    - `tool_result` → `ToolMessage`.
    - `handoff` → nothing by itself (the transfer tool call/result pair already
      projects); the _effect_ is that subsequent `system_prompt` differs.
    - `memory_recall` → `UserMessage` with the rendered memories block (§8.4).
    - `memory_op` → nothing (the memory tool's call/result pair already
      projects; the node exists for provenance and idempotency).
    - `fork` → nothing (the `fork` tool call projects from its `llm_call`).
    - `join` → the `tool_result` for the fork call: one labelled list of branch
      outputs (§10.5).
    - `compaction` → a synthetic assistant `compact` tool call plus its tool
      result carrying the summary. A tool pair, not a user turn: the summary is
      something the _system_ did to the history, and putting it in the user
      channel invites the model to answer it.
    - `final_output` → `AssistantMessage`, unless it repeats the assistant
      message just emitted. An untyped run records its answer twice — once as the
      `llm_call`'s text, once as the `final_output` node that ends the turn — and
      without the check every later turn of the conversation re-reads it.
3. Collect every payload referenced by the surviving nodes and resolve them in
   **one** `getMany` batch before assembling the messages.
4. Run `repairToolCalls`: drop assistant tool calls whose result did not survive.

Invariant: every projected `tool_call` id has a matching `tool` message — held by
the kernel during a run (a tool call without a recorded result blocks the next
LLM call), and restored by step 4 after arbitrary covering.

## 6. AgentState

```ts
export type RunPhase =
    | 'created' // initial context built, nothing executed
    | 'awaiting_llm' // next step is a model call
    | 'awaiting_tools' // model returned tool calls; some results missing
    | 'awaiting_branches' // a fork is in flight; some branches unfinished
    | 'done'
    | 'failed';

/**
 * Immutable run configuration. Written once by `createState`, never touched by
 * `apply*`. Lives inside the state so a run is a single persistable blob.
 */
export interface RunSpec {
    startAgent: string;
    /** JSON Schema projection of the caller's Zod schema (see §6.1) */
    outputSchema?: JsonSchema;
    /** sha256 of `outputSchema`, for cheap mismatch detection on resume */
    outputSchemaHash?: string;
    /** set on branch states created by a fork (§10) */
    parent?: { runId: string; forkId: string; branch: string };
    /** where this run's own history begins — an inherited prefix sits before it */
    prefixLength?: number;
    forkDepth: number; // 0 for a root run
}

export interface AgentState {
    version: 1; // schema version for forward migration
    runId: string;
    spec: RunSpec; // immutable config
    agentName: string; // active agent (mutable — changes on handoff)
    phase: RunPhase;
    trajectory: TrajectoryNode[];
    /** tool calls from the last llm_call still lacking a tool_result, by callId */
    pendingToolCalls: string[];
    /** the in-flight fork, if any, and its branches still lacking a result */
    pendingFork?: { callId: string; branches: string[] };
    /** derived cache; always recomputable from the raw trajectory */
    usage: TokenUsage;
    /** serialized user context (must be JSON) */
    context?: unknown;
}
```

Properties:

- **Plain JSON.** No class instances, no functions, no prototypes to restore.
  `JSON.parse(JSON.stringify(state))` is identity. Helpers (`lastText`,
  `totalUsage`) are free functions, not methods.
- **Explicit creation** — the only way to obtain a state:

```ts
import { z } from 'zod';
import * as Kernel from './kernel.js';

export interface CreateStateOptions<T = string> {
    runId?: string; // default: ulid()
    agent: string; // starting agent name
    input?: Input; // optional first user message
    context?: unknown; // app context — must be serializable
    output?: z.ZodType<T>; // typed-result request (see §6.1)
    systemPrompt?: string; // pre-rendered; else rendered on first step
}

const state = Kernel.createState({
    agent: 'planner',
    input: 'Plan a 3-day trip to Lisbon.',
    output: z.object({
        days: z.array(z.object({ day: z.number().int(), plan: z.string() })),
        totalCostEur: z.number(),
    }),
});
// state.phase === 'awaiting_llm' (or 'created' when there is no input yet)
// state.spec.outputSchema === z.toJSONSchema(opts.output)   — plain JSON
```

- `pendingToolCalls` is what makes mid-turn resume safe: after a crash between
  tool executions, the resumed run re-executes only the calls without results.

### 6.1 Zod schemas vs. serializable state

A Zod schema is a live object with functions — it cannot live inside a
JSON-serializable state. The split:

| Where                       | What                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `CreateStateOptions.output` | the Zod schema — source of both `T` and validation                                       |
| `state.spec.outputSchema`   | `z.toJSONSchema(output, { target: 'draft-2020-12' })` — plain JSON, sent to the provider |
| Runner / kernel call site   | the Zod schema again, supplied at run/resume time                                        |

Why the JSON Schema is stored at all instead of being a pure run argument:

1. It is **part of the prompt** — it becomes the `final_output` tool's
   `parameters`. Without it a restarted process cannot rebuild the same
   request, and `LlmCallNode.requestDigest` checks would fail spuriously.
2. A run stays a **single self-contained blob**: a generic "resume this run"
   worker or admin UI needs no application code to continue it.
3. Audit: the contract in force for a finished run is recoverable from storage.

Rules:

- `createState` derives and stores the JSON Schema once; the wire format is
  therefore stable across restarts even if application code changes.
- Validation of the model's `final_output` arguments uses the **Zod** schema
  (`schema.safeParse`), not the JSON Schema — one validator, no Ajv dependency,
  and Zod transforms/refinements/defaults apply.
- On `resume(state)` the caller must pass the same Zod schema:
  `runner.resume(state, { output: TripSchema })`. The kernel compares
  `sha256(z.toJSONSchema(output))` with `state.spec.outputSchemaHash` and throws
  on mismatch — a persisted run cannot silently change its contract.
- If `resume` gets no `output` while `state.spec.outputSchema` is set, the run
  degrades to JSON-Schema-only validation (Ajv-free structural check) and
  `RunResult.output` is typed `unknown`. This keeps generic tooling (an admin
  "continue this run" button) possible without the original schema object.
- Requires `zod@^4` (built-in `z.toJSONSchema`). Add to
  `experiments/src.js/agent/package.json`.

## 7. Kernel API (deterministic core)

The kernel is a module of **plain exported functions** — `kernel.ts`. It holds no
state and no configuration, so there is nothing to instantiate; consumers do
`import * as Kernel from './kernel.js'` and call `Kernel.applyLlmResponse(...)`.
(No class, no singleton object: that would only add a wrapper that defeats
tree-shaking and invites hidden state.)

```ts
export type NextAction =
    | { kind: 'llm' } // call the model
    | { kind: 'tools'; calls: PendingToolCall[] } // execute these
    | { kind: 'fork'; forkId: string; branches: BranchPlan[] } // §10
    | { kind: 'done'; output: FinalOutputNode };

export function createState<T = string>(opts: CreateStateOptions<T>): AgentState;

/** Pure inspection: what must happen next. */
export function nextAction(state: AgentState): NextAction;

/**
 * Projection + tool schemas + system prompt for the active agent. Async only
 * because payload refs must be resolved.
 */
export function buildRequest(
    state: AgentState,
    reg: AgentRegistry,
    stores: PayloadResolver,
): Promise<ModelRequest>;

/** Appends llm_call (+tool_call nodes), updates phase/pending/usage. */
export function applyLlmResponse(
    state: AgentState,
    res: ModelResponse,
    model: string,
): Promise<AgentState>;

/**
 * Appends tool_result; when it was a transfer_to_* call, also appends a
 * HandoffNode (+ optional CompactionNode from the handoff policy) and switches
 * agentName.
 */
export function applyToolResult(
    state: AgentState,
    callId: string,
    result: ToolOutcome,
): Promise<AgentState>;

export function applyUserInput(state: AgentState, input: Input): Promise<AgentState>;

/**
 * Appends the ForkNode to the parent and derives a self-contained child state
 * per branch (inherited context frozen into a Payload, §10.3).
 */
export function createChildState(
    state: AgentState,
    forkId: string,
    branch: BranchPlan,
): Promise<AgentState>;

/** Appends join, folds branch usage into the parent (§10.4). */
export function applyJoin(
    state: AgentState,
    forkId: string,
    results: BranchResult[],
): Promise<AgentState>;

/** Records a memory recall / mutation performed by the driver (§8.4). */
export function applyMemoryEffect(
    state: AgentState,
    effect: MemoryRecallSpec | MemoryOpSpec,
): Promise<AgentState>;

/** Records a skill activation and the tools it unlocked (§9.3). */
export function applySkillLoad(state: AgentState, skills: Skill[]): Promise<AgentState>;

export function applyCompaction(
    state: AgentState,
    c: Omit<CompactionNode, keyof NodeBase>,
): AgentState;
```

- All `apply*` return a **new state object** (structural sharing of the
  trajectory array via spread). Old snapshots stay valid — exactly what a
  checkpointing caller needs.
- Async `apply*` only because writing large values through `PayloadStore.put`
  may be I/O.
- Nondeterminism policy: node `id`/`ts` are generated by an injectable
  `IdClock` (`{ newId(): string; now(): string }`) so a Temporal workflow can
  supply `workflow.uuid4`/`workflow.now`. It is passed explicitly as the last
  argument of the functions that create nodes (defaulting to a ulid/`Date`
  implementation), never read from module scope — module-level mutable config
  would break determinism under concurrent runs.

## 8. Memory

Memory is **long-lived knowledge that outlives a run**, in contrast to the
trajectory, which is the record of a single run. It is an interface, so the
backend (pgvector, SQLite, Redis, plain in-memory map) is a deployment choice.

### 8.1 Interface

```ts
export interface MemoryRecord {
    id: string;
    scope: string; // memory space this record belongs to
    kind: string; // app-defined: 'fact' | 'preference' | 'episode' | …
    text: string; // the retrievable content
    metadata?: Record<string, unknown>; // filterable attributes
    createdAt: string;
    updatedAt: string;
    revision: number; // optimistic-concurrency token
}

export interface MemoryQuery {
    text?: string; // semantic query; omitted ⇒ pure filter listing
    filter?: Record<string, unknown>; // exact-match metadata constraints
    kind?: string;
    limit?: number; // default 8
    minScore?: number;
}

export interface MemoryHit {
    record: MemoryRecord;
    score: number; // 0..1, backend-normalized
}

export interface MemoryStore {
    readonly id: string;
    search(scope: string, q: MemoryQuery): Promise<MemoryHit[]>;
    get(scope: string, id: string): Promise<MemoryRecord | undefined>;
    /** `opId` makes writes idempotent under retry/replay (see §8.4) */
    write(scope: string, rec: MemoryDraft, opId: string): Promise<MemoryRecord>;
    update(scope: string, id: string, patch: MemoryPatch, opId: string): Promise<MemoryRecord>;
    delete(scope: string, id: string, opId: string): Promise<void>;
}
```

Embedding generation is the store's business, not the kernel's: a pgvector
implementation embeds inside `write`/`search`, an in-memory one may fall back to
substring matching. The kernel never sees vectors.

### 8.2 Scoping — private vs. shared

A **scope** is a namespace string. Agents that name the same scope share memory;
agents with distinct scopes are isolated. Binding is per agent, and access is
declared, so a reader agent cannot corrupt a writer's space:

```ts
export interface MemoryBinding {
    store: string; // MemoryStore id
    scope: string; // namespace; default: `agent:${agent.name}`
    access: 'read' | 'read-write';
    /** inject top-k matches before each LLM call (see §8.3) */
    autoRecall?: { query: 'last_user_input' | 'none'; limit: number };
}

export interface AgentOptions<TCtx> {
    // …
    memory?: MemoryBinding[];
}
```

Patterns this covers:

- **Private**: omit `memory` (no memory) or bind `agent:<name>` — the default.
- **Shared team memory**: several agents bind `scope: 'team:support'`.
- **Read-only common knowledge**: bind `scope: 'org:policies'` with
  `access: 'read'`; a separate curator agent has `read-write`.
- **Per-user memory**: scope built from run context, e.g.
  `scope: \`user:${ctx.userId}\``— resolved at`buildRequest` time, and the
  resolved value is recorded in the trajectory so a resumed run cannot drift to
  another user's space.

### 8.3 How the agent uses it

Two paths, both landing in the trajectory:

1. **Explicit tools** — the kernel injects `memory_search`, `memory_write`,
   `memory_update`, `memory_delete` for every writable binding (search-only for
   `read`). They are ordinary tools, so they already produce
   `ToolCallNode`/`ToolResultNode` and need no special loop handling.
2. **Auto-recall** — when `autoRecall` is set, `buildRequest` runs a search
   before the LLM call and appends a `MemoryRecallNode`, projected as a system
   or user block ("Relevant memories: …"). This is what makes memory work
   without the model having to remember to look.

### 8.4 Trajectory nodes and replay safety

```ts
export interface MemoryRecallNode extends NodeBase {
    type: 'memory_recall';
    store: string;
    scope: string;
    query: MemoryQuery;
    hits: { id: string; score: number; revision: number }[]; // ids, not bodies
    content: Payload; // the rendered block the model actually saw
}

export interface MemoryOpNode extends NodeBase {
    type: 'memory_op';
    op: 'write' | 'update' | 'delete';
    store: string;
    scope: string;
    opId: string; // sha256(runId, callId) — deterministic
    recordId: string;
    revision: number; // post-op revision, or the deleted one
    before?: Payload; // prior content, for audit/undo
    after?: Payload;
}
```

Why a separate node when the tool call is already recorded:

- **Idempotency.** `opId` is derived from `runId + callId`, not generated
  randomly, so a retried or replayed step re-issues the _same_ write and the
  store deduplicates. Without this, Temporal retries would duplicate memories.
- **Compaction survivability.** A `memory_search` `ToolResultNode` can be bulky
  and is a prime compaction target; the `MemoryOpNode`/`MemoryRecallNode` stays
  as compact provenance ("this run wrote record X at revision 3"), so the audit
  trail survives context compaction.
- **Projection asymmetry.** `MemoryOpNode` does **not** project into messages
  (the tool result already did); `MemoryRecallNode` does.

Memory mutations are the one place where the kernel is not side-effect free.
They are therefore performed by the **runner/activity layer**, and the kernel
only records the outcome — same split as tool execution.

## 9. Skills

A **skill** is curated, reusable instruction content (plus optional tools) that
is loaded on demand instead of permanently occupying the system prompt —
progressive disclosure. Structurally it is the read-only twin of memory: same
search shape, different lifecycle (authored and versioned, not written by the
agent).

### 9.1 Interface

```ts
export interface SkillSummary {
    name: string;
    description: string; // one line — this is what search/index sees
    tags?: string[];
    version?: string;
}

export interface Skill extends SkillSummary {
    content: Payload; // full instructions (offloadable — often large)
    tools?: AnyTool<unknown>[]; // tools unlocked while the skill is active
    path?: string; // where the skill's own files are, if the host mounted them
}

export interface SkillProvider {
    readonly id: string;
    list(): Promise<SkillSummary[]>; // cheap index
    search(query: string, limit?: number): Promise<SkillSummary[]>;
    load(name: string, version?: string): Promise<Skill>; // full content
}
```

Implementations are pluggable and out of scope here: a filesystem provider over
`SKILL.md` directories, a static in-code registry, or a vector-backed provider
sharing infrastructure with `MemoryStore`.

### 9.2 Configuration

```ts
export interface SkillBinding {
    provider: string; // SkillProvider id
    /** how the agent discovers skills */
    discovery: 'index' | 'search' | 'none';
    /** always loaded at run start, before the first LLM call */
    preload?: string[];
    /** cap on the index rendered into the system prompt */
    maxIndexEntries?: number; // default 50
    /** restrict what this agent may load at all */
    allow?: string[] | ((s: SkillSummary) => boolean);
}

export interface AgentOptions<TCtx> {
    // …
    skills?: SkillBinding;
}
```

- `discovery: 'index'` — names + descriptions are rendered into the system
  prompt; the model calls `skill_load`. Best for small catalogs.
- `discovery: 'search'` — only a `skill_search` tool is exposed; nothing is
  pre-rendered. Best for large catalogs.
- `preload` — loaded unconditionally; the equivalent of "always-on" instructions
  but still recorded as a node, so it can be compacted or audited like anything
  else.

### 9.3 Loading, and why the tool set is derived from the trajectory

`skill_load` appends the `LoadSkillsNode` already declared in §5:

```ts
export interface LoadSkillsNode extends NodeBase {
    type: 'load_skills';
    provider: string;
    skills: { name: string; version?: string; contentHash: string }[];
    content: Payload; // concatenated instructions the model saw
    toolNames: string[]; // tools this activation unlocked
}
```

Consequence for resume: the tool list offered to the model is **not** a static
property of the agent — it is

```
tools(state) = agent.tools
             + handoff tools
             + memory tools (from bindings)
             + skill tools (from surviving LoadSkillsNodes of the active agent)
             + fork tool (if forkable)
             + final_output (typed runs)
```

`buildRequest` computes this from the state, so a rehydrated run offers exactly
the same tools it had before the crash. `toolNames` is stored in the node so the
set is recoverable even if the provider's catalog changed since — a load whose
`contentHash` no longer matches the provider is a hard error, not a silent
substitution.

Covering a `LoadSkillsNode` via compaction therefore also **deactivates its
tools**, which is the intended semantics: dropping a skill's instructions while
leaving its tools callable would leave the model with tools it no longer knows
how to use.

The converse is the reason §10.3 filters skill loads by agent when seeding a
branch: `activeSkills` scopes tools to the current agent, but `load_skills`
projects as an ordinary message, so without the filter a branch would _read_
another agent's skill text — "call `tool_y`" — while holding none of its tools.

## 10. Fork / join — parallel sub-agents

The model asks for parallel work through a built-in `fork` tool; the run splits
into N independent child runs, and rejoins into a single result. From the
parent's message history the whole episode looks like **one tool call and one
tool result** — sequential semantics, parallel execution.

### 10.1 The fork tool

```ts
// parameters (Zod, projected to JSON Schema like any other tool)
z.object({
    branches: z
        .array(
            z.object({
                name: z.string(), // stable branch label
                instructions: z.string(), // what this branch must do
                agent: z.string().optional(), // defaults to the forking agent
            }),
        )
        .min(2),
    context: z.enum(['inherit', 'compact', 'none']).default('inherit'),
});
```

Agent opt-in: `AgentOptions.fork?: { agents?: string[]; maxBranches?: number }`.

### 10.2 Data model

**Fork is a scope.** A branch executes against a state of its own while it runs
— that is what makes real parallelism possible — but when it finishes, its
history is **nested inside the `JoinNode`** that reports it. The parent's array
holds the parent's own nodes and nothing else:

```
[ 1, 2, 3, fork, join, 4, 5 ]
                  └── branches[].nodes: [b1₁, b1₂], [b2₁, b2₂, b2₃]
```

The scope is structural, so it holds without anyone maintaining it: branch nodes
never project, never activate skills, never count as turns, because no ordinary
walk of the parent array can reach them.

Two nodes rather than one, because they record two events at two times and the
log is append-only. `ForkNode` is written _before_ the branches run — the record
of intent, and the thing a crash-mid-fork resumes from. `JoinNode` is written
after, and carries the outcomes.

```ts
export interface ForkNode extends NodeBase {
    type: 'fork';
    callId: string; // the fork tool call — the fork's identity
    contextMode: 'inherit' | 'compact' | 'none';
    branches: { name: string; agent: string; instructions: Payload; childRunId: string }[];
}

export interface JoinNode extends NodeBase {
    type: 'join';
    callId: string; // same id as the ForkNode
    /** always in declared branch order, never completion order */
    branches: {
        name: string;
        agent: string;
        status: 'ok' | 'error' | 'aborted';
        output: Payload; // branch answer or summary
        error?: string;
        usage: TokenUsage; // display only
        nodes: TrajectoryNode[]; // the branch's own history
    }[];
    usage: TokenUsage; // sum over branches — display only
}
```

There is no `childStateRef`: the branch history is right there in the join, so
branch `AgentState`s are pure execution scaffolding, discarded once the join
lands. `collectPayloads` is a generic deep JSON walk, so `exportRun` descends
into the nested nodes without knowing forks exist.

Nested forks need no extra machinery either — a branch's `nodes` may contain its
own `JoinNode`, and the only traversal that crosses the boundary (`totalUsage`)
is already recursive.

### 10.3 Branch seeding

A branch starts from a **prefix of the parent's own nodes**, not from a frozen
blob of messages. `branchPrefix` takes `projected(parent.trajectory)` up to the
`ForkNode` and filters it by `contextMode`:

- `inherit` — the prefix as-is, minus `load_skills` nodes belonging to a
  different agent (§9).
- `compact` — the same, additionally dropping `tool_call`, `tool_result` and
  `memory_recall`: the branch inherits _what was decided_, not the raw tool
  noise that got there. The recommended default for wide fan-outs.
- `none` — empty. The branch starts from its agent's system prompt plus its
  instructions only. Cheapest; good for independent lookups.

The branch state records `spec.prefixLength`, which is both where its own
history begins and, at join time, exactly what to keep: the inherited prefix is
the parent's own history and is already in the parent's array, so only the slice
past it is nested.

Then the assignment, and how it arrives depends on whether there is a
conversation to arrive in:

- `inherit` / `compact` — a **`ToolResultNode` answering the `fork` call itself**.
  The branch inherited the assistant turn that called `fork`, so its assignment
  is that call coming back: the model reads a result for a tool it can see
  itself calling, rather than a second user message appearing after its own
  words. This is also what keeps the fork call in the prompt at all — unanswered,
  `repairToolCalls` (§6) strips it, and the branch never learns it fanned out.
  The result restates which branch this run is, and names the siblings running
  beside it: the assignments themselves are already visible in the inherited
  call arguments, but _which one is mine_, _who has the rest_ and _what becomes
  of my answer_ exist nowhere else. Without them a branch re-derives work a
  sibling owns and writes an answer shaped for a user rather than for a merge.
- `none` — a `UserInputNode` carrying the instructions, because there is no call
  above to answer.

From that point the branch is an ordinary run: it may call tools, hand off, use
memory, and fork again (`spec.forkDepth` increments; an optional `maxForkDepth`
guards runaway recursion — a structural bound, not a turn budget).

**Fork erases the branch's memory; only its result survives.** Everything a
branch inherits is a copy it may compact, hand off or discard freely, because
nothing it does can reach back into the parent's projection.

### 10.4 Execution and state machine

`RunPhase` gains `'awaiting_branches'`; `AgentState` gains
`pendingFork?: { callId, branches }`, mirroring `pendingToolCalls` but naming the
fork explicitly so a run with two forks resolves the right one. `NextAction`
gains:

```ts
| { kind: 'fork'; forkId: string; branches: BranchPlan[] }
```

Runner behaviour:

```
case 'fork':
    emit before_fork(state)                          // ← persistence point
    results = await Promise.all(branches.map(b =>
        runBranch(b)))                               // real parallelism:
                                                     // concurrent LLM + tool calls
    state = await Kernel.applyJoin(state, forkId, results)
    emit after_join(state)
```

- Branches run truly concurrently — each has its own model client call and its
  own tool executions. Nothing serializes them.
- `applyJoin` nests branch histories in **declared branch order**, so the
  trajectory is identical regardless of completion order. This is what keeps
  replay deterministic and the parent's prompt cacheable.
- Partial failure is data, not an exception: a failed branch is recorded with
  `status: 'error'`, and the fork `ToolResultNode` reports it so the model can
  retry or route around it. The run itself only fails if the join policy says so.
- Resume: a crash mid-fork leaves `phase: 'awaiting_branches'` with
  `pendingFork.branches` naming the unfinished ones; a second `applyJoin` for the
  same `callId` clears the rest.

### 10.5 Collapsing parallel history

**Collapse = select + summarize**, and it is the same operation everywhere —
handoff noise, token budget, branch results. The parent's projection of a whole
fork episode is exactly two messages: the `fork` assistant tool call, and one
tool result listing the per-branch outputs. N parallel agents cost the parent
O(N × summary), not O(N × full history).

```ts
export interface JoinPolicy {
    /** what the parent sees for this branch */
    summarize(child: AgentState): Promise<Payload>;
    /** whether one branch's failure aborts the others */
    onBranchError?: 'continue' | 'abort_siblings';
}

/** the selector half — pure, so it is trivially testable */
export interface HandoffPolicy {
    select(state: AgentState, handoff: HandoffNode): TrajectoryNode[] | null;
}

/** the summarizing half — the only half that needs I/O */
export interface Summarizer {
    summarize(nodes: TrajectoryNode[], reason: string, services: Services): Promise<Summary>;
}
```

The default `Summarizer` is structural (it counts node types and costs nothing);
`modelSummarizer(model)` projects the selected nodes and asks a model, returning
its own token usage so the compaction pays for itself in the accounting.

### 10.6 Accounting across branches

`totalUsage` sums `llm_call` and `compaction` nodes and recurses into
`join.branches[].nodes`, so one call covers the whole fork tree at any nesting
depth. This is the **only** traversal in the system that crosses a branch
boundary, and it says so explicitly — which is the point of nesting: the common
case (stay in this run's scope) is free and the rare case is opt-in.
`JoinNode.usage` and `branches[].usage` are display only; adding them would
double-count the nodes they summarize.

A branch's own `state.usage`, by contrast, is computed over
`trajectory.slice(prefixLength)`: the inherited prefix was paid for by the
parent, so a branch is never billed for the context it was handed.

## 11. Termination and typed results (no maxTurns)

`maxTurns` is deleted from `AgentOptions`, `RunnerOptions`, `RunOptions` and the
loop. Termination conditions:

1. **Untyped run** (no `output` schema): the model responds with zero tool
   calls → `FinalOutputNode` from `res.text`, `phase = 'done'`. (Unchanged.)
2. **Typed run** (Zod `output` schema given): a synthetic tool `final_output`
   with `parameters = state.spec.outputSchema` (the JSON Schema projection) is
   added, and the request uses `toolChoice: 'auto'` with instructions that the
   run must end by calling it.
    - When the model calls `final_output`, args go through `schema.safeParse`.
      Success → `FinalOutputNode { parsed: result.data }` (post-transform,
      post-default value), done. Failure → an error `ToolResultNode` carrying
      `z.prettifyError(result.error)` is appended and the loop continues, letting
      the model repair its output.
    - A plain no-tool-call text response in typed mode gets a nudge
      `ToolResultNode`-style user message ("respond via final_output") rather
      than terminating with an unparseable answer.
3. **Abort**: `signal` aborts propagate as before; state remains resumable
   (`phase` stays `awaiting_llm`/`awaiting_tools`).

```ts
export interface RunResult<T = string> {
    output: T; // z.infer of the output schema when given
    agent: string;
    state: AgentState;
    usage: TokenUsage;
    stopReason: 'final' | 'aborted';
}

// T flows from the Zod schema, no manual assertion at the call site:
const res = await runner.run('planner', 'Plan a trip.', { output: TripSchema });
res.output.totalCostEur; // number
```

The same `z.ZodType` inference can later be reused for tool arguments
(`tool({ parameters: z.object(...) })`), replacing the hand-written
`JsonSchema` + explicit `TArgs` pair — out of scope here, but the schema
projection helper is shared.

Runaway protection is the caller's job (wall-clock/token budget hooks can be
added later as policies, not as a hardcoded turn counter).

## 12. Events

Every event — stream _and_ checkpoint — carries the same origin tag, so a
consumer can always tell which run in a fork tree produced it:

```ts
export interface BranchRef {
    forkId: string; // the fork that created this branch
    name: string; // declared branch name
    runId: string; // the child run's id
    depth: number; // spec.forkDepth of the emitting run
}

export interface EventBase {
    runId: string; // emitting run (root run id on the trunk)
    agent: string; // active agent in that run
    /** absent on the trunk; set on every event emitted by a branch */
    branch?: BranchRef;
}
```

- `runId` is the primary key: an event belongs to exactly one `AgentState`.
- `branch` is the _lineage_ of that run — present on nested forks too, where
  `depth > 1`. A UI groups by `branch.forkId` to build lanes, and by `runId` to
  attach the right state snapshot.
- On the trunk, `branch` is `undefined` and `runId === state.runId` of the root.

### 12.1 Stream events (ephemeral, no state attached)

Emitted only when the model transport supports streaming; consumers must treat
them as best-effort UI feed. `argsSoFar` allows rendering partial tool args
without the consumer buffering deltas.

```ts
export type StreamEvent = EventBase &
    (
        | { type: 'thinking_delta'; delta: string }
        | { type: 'text_delta'; delta: string }
        | {
              type: 'tool_args_delta';
              callId: string;
              name: string;
              delta: string;
              argsSoFar: string;
          }
        | { type: 'tool_call_detected'; callId: string; name: string }
    );
```

Branch stream events interleave freely (the branches really do run at the same
time) while the trajectories they write stay separate and ordered — `branch` is
what lets a consumer demultiplex the interleaved feed back into lanes.

`Model` gains an optional streaming entry point; non-streaming models keep
working, they just never produce `StreamEvent`s:

```ts
export interface Model {
    readonly id: string;
    generate(req: ModelRequest): Promise<ModelResponse>;
    stream?(req: ModelRequest, onEvent: (e: StreamEvent) => void): Promise<ModelResponse>;
}
```

`ModelResponse.usage` becomes `TokenUsage` (cached + reasoning included);
`OpenAIModel` maps `prompt_tokens_details.cached_tokens` and
`completion_tokens_details.reasoning_tokens`.

### 12.2 Checkpoint events (each carries the full state)

```ts
export type CheckpointEvent = EventBase &
    (
        | { type: 'run_created'; state: AgentState }
        | { type: 'before_llm_call'; state: AgentState }
        | { type: 'after_llm_call'; state: AgentState; node: LlmCallNode }
        | { type: 'before_tool_call'; state: AgentState; call: PendingToolCall }
        | { type: 'after_tool_call'; state: AgentState; node: ToolResultNode }
        | { type: 'handoff'; state: AgentState; from: string; to: string }
        | { type: 'before_fork'; state: AgentState; node: ForkNode }
        | { type: 'branch_started'; state: AgentState; child: BranchRef; childState: AgentState }
        | {
              type: 'branch_finished';
              state: AgentState;
              child: BranchRef;
              childState: AgentState;
              status: 'ok' | 'error' | 'aborted';
          }
        | { type: 'after_join'; state: AgentState; node: JoinNode }
        | { type: 'run_finished'; state: AgentState; result: RunResult }
    );

export type AgentEvent = StreamEvent | CheckpointEvent;
```

Tagging rules, which are what make persistence unambiguous:

- `state` always belongs to the **emitting** run, i.e. the one named by
  `runId`/`branch`. A `before_llm_call` from a branch carries the _child's_
  state — persist it under `branch.runId` and resume that branch alone.
- `before_fork` / `branch_started` / `branch_finished` / `after_join` are emitted
  by the **parent**, so their `branch` field describes the _parent's_ own lineage
  (absent on the trunk). The branch they talk about is the separate `child`
  field — two different things that must not be conflated.
- `branch_started`/`branch_finished` therefore carry two states: `state` (parent,
  telling you which branches are still pending) and `childState` (the branch
  snapshot).
- Nested forks compose: a child emits its own full checkpoint stream tagged with
  its own `BranchRef`, so a whole fork tree is observable from a single stream
  and reconstructable by grouping on `runId`.

Contract: the `state` in every checkpoint event is a **complete snapshot** —
persisting it and later calling `runner.resume(state)` continues the run with
no loss (pending tool calls re-executed, LLM call re-issued). Because `apply*`
returns fresh objects, the snapshot needs no defensive copy.

`RunStream` keeps its current triple interface (async-iterable / `final()` /
thenable) and iterates `AgentEvent`.

## 13. Runner loop (replacing `#loop`)

```
run(agent, input, opts)  → state = Kernel.createState(...), emit run_created
resume(state, opts?)     → validate version, continue below

loop:
  action = Kernel.nextAction(state)
  case 'done':
      emit run_finished; return result
  case 'llm':
      emit before_llm_call(state)                 // ← persistence point
      req  = await Kernel.buildRequest(state, registry, stores)
      res  = await model.stream?(req, emitStreamEvent) ?? model.generate(req)
      state = await Kernel.applyLlmResponse(state, res, model.id)
      emit after_llm_call(state)
  case 'tools':
      for call of action.calls (results applied in call order):
          emit before_tool_call(state, call)      // ← persistence point
          out   = await runTool(...)              // same failure-tolerant runTool
          state = await Kernel.applyToolResult(state, call.callId, out)
          emit after_tool_call(state)
          if handoff happened: emit handoff(state)
  case 'fork':
      emit before_fork(state, forkNode)           // ← persistence point
      results = await Promise.all(action.branches.map(async b => {
          child = await Kernel.createChildState(state, action.forkId, b)
          ref   = { forkId: action.forkId, name: b.name,
                    runId: child.runId, depth: child.spec.forkDepth }
          emit branch_started(state, ref, child)
          done  = await this.resume(child, { branch: ref })  // real concurrency;
                                                             // tags all nested events
          emit branch_finished(state, ref, done.state, done.status)
          return done
      }))
      state = await Kernel.applyJoin(state, action.forkId, results)
      emit after_join(state)
```

Notes:

- Tool execution stays failure-tolerant (errors become `tool_result` with
  `isError`), unchanged from v1.
- Parallel tool execution is still possible, but `applyToolResult` is applied
  in call order for deterministic trajectories; `before_tool_call` then fires
  per batch item before the batch starts.
- Handoffs remain `transfer_to_*` tools. On transfer the kernel appends
  `HandoffNode`, switches `agentName`, appends a fresh `SystemPromptNode` for
  the new agent, and invokes the optional handoff-compaction policy:

```ts
export interface HandoffPolicy {
    /** return a compaction covering the outgoing agent's noise, or null */
    compact(state: AgentState, handoff: HandoffNode): CompactionSpec | null;
}
```

- Branches are driven by the same `resume` loop, so everything above (tools,
  handoffs, memory, skills, nested forks) works identically inside a branch.
  Only the event tagging and the final summarization differ.
- Memory and skill I/O (`MemoryStore.*`, `SkillProvider.load`) happen in the
  driver, next to tool execution; the kernel only records the outcome via
  `applyMemoryEffect` / `applySkillLoad`.

## 14. Temporal mapping (informative)

| Concept                | Temporal construct                                          |
| ---------------------- | ----------------------------------------------------------- |
| `AgentState`           | workflow-local variable (checkpointed via event history)    |
| LLM call               | activity `llmGenerate(req) → ModelResponse` (retryable)     |
| Tool execution         | activity `runTool(name, args) → ToolOutcome`                |
| Kernel `apply*`        | inside the workflow (deterministic, uses `IdClock`)         |
| `PayloadStore.put/get` | inside activities only (I/O)                                |
| Memory op              | activity, keyed by `MemoryOpNode.opId` (idempotent §8.4)    |
| Skill load             | activity `loadSkill(name, version) → Skill`                 |
| Fork branch            | child workflow, one per branch                              |
| Join                   | `Promise.all` over child workflow handles, then `applyJoin` |
| checkpoint events      | implicit — every activity boundary is a checkpoint          |

Because `buildRequest` needs payload resolution (I/O), Temporal deployments
either (a) run projection inside the `llmGenerate` activity by passing the
trajectory slice, or (b) use a store whose `get` is a cache-backed activity.
Option (a) is the default recommendation: activity input = `state` (or a
payload-ref-only view), keeping the workflow free of I/O.

Uniform payload refs (§4.1) are what make this viable: the workflow-local state
is O(number of nodes) in size no matter how much data the run processed, so it
stays far below Temporal's payload and history limits even for long runs.

Re-execution safety: `LlmCallNode.requestDigest` lets a resumed run detect that
a recorded response no longer matches the projected request (e.g. after code
changes) and fail loudly instead of silently diverging.

## 15. What is deleted / migrated

| v1                                                            | v2                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `AgentState` class with `messages[]`                          | plain-JSON `AgentState` with `trajectory`                                                |
| `AgentState.from(json)`                                       | not needed (no prototype); `validateState(json)` type guard instead                      |
| `maxTurns` (agent/runner/run opts), `stopReason: 'max_turns'` | removed                                                                                  |
| `Usage {input,output}`                                        | `TokenUsage {input,cachedInput,output,reasoning}`                                        |
| implicit state creation in `run()`                            | `Kernel.createState` (runner `run()` calls it, `resume()` requires it)                   |
| `AgentEvent` (flat)                                           | `StreamEvent \| CheckpointEvent`                                                         |
| `state.turns`                                                 | derived: count of `llm_call` nodes                                                       |
| `Message[]` as source of truth                                | projection output only (`projectMessages`)                                               |
| untyped `RunResult.output: string`                            | `RunResult<T>` with `T = z.infer<schema>`                                                |
| —                                                             | immutable `state.spec` (`RunSpec`) separated from mutable progress                       |
| —                                                             | `MemoryStore` bindings + memory tools (§8)                                               |
| —                                                             | `SkillProvider` bindings + skill tools (§9)                                              |
| —                                                             | `fork`/join with child `AgentState`s (§10)                                               |
| static per-agent tool list                                    | tool set derived from state (agent + handoffs + memory + skills + fork + `final_output`) |

`Message`, `ContentPart`, `Tool`, `tool()`, `Agent`, `handoffTool`,
`RunStream`, `runTool` survive with minimal changes (`ToolContext.state` is now
the plain state; `Instructions<TCtx>` receives `(ctx, spec)` — narrowed from the
full state, §17.2).

## 16. Open questions

1. Should `LoadSkillsNode` content project as a system-prompt append or a user
   message? Provider-dependent; start with user message.
2. Payload GC: because every payload is content-addressed and reachable only
   through stored states, reclamation is a reference-counting or mark-and-sweep
   problem over `sha256` — well-defined, but the retention policy (how long a
   finished run stays replayable) is a deployment decision and is out of scope
   for v1.
3. Should typed output use provider-native structured outputs
   (`response_format: json_schema`) instead of the `final_output` tool when
   available? The tool approach is provider-agnostic and composes with tool
   use in the same turn; native mode can be a `Model` capability flag later.
4. Zod features with no JSON Schema equivalent (`z.transform`, `z.custom`,
   cross-field `superRefine`) serialize lossily: the model sees the looser
   input shape and only `safeParse` enforces the rest. Acceptable — the repair
   loop handles it — but `createState` should warn when
   `z.toJSONSchema` reports unrepresentable nodes (`io: 'input'` + `unrepresentable: 'any'`).
5. Memory conflict resolution: `revision` gives optimistic concurrency, but the
   policy on conflict (retry, merge, surface to the model) is left to the store
   implementation for now.
6. Should auto-recall (§8.3) run on every LLM call or only after new user input?
   Every call is simpler but costs tokens and hurts prompt caching; start with
   "after user input and after handoff".
7. Fork sharing: branches currently share nothing but the inherited snapshot.
   A shared scratch memory scope per fork (`scope: \`fork:${forkId}\``) would let
   branches cooperate, at the cost of nondeterministic interleaving — deferred.
8. Join policies beyond "collect all": first-success, quorum, and cancellation of
   siblings are natural extensions of `JoinPolicy` but are not specified here.

## 17. System prompt composition — a prompt is a list of sources

A real system prompt is never one string: it is an agent-specific file, a shared
`INSTRUCTIONS.md`, a house style block, a skill index, and a couple of runtime
notes, concatenated. Today all of that collapses into a single
`SystemPromptNode.prompt` blob (plus fragments appended inside `buildRequest`),
so the trajectory can say _what the model read_ but not _which file to edit to
change it_. This section makes the composition itself first-class.

### 17.1 Record the bytes, and the files that can change them

The node already holds the one thing replay needs: `prompt`, the exact string the
provider received. The single thing it is missing is _which files went into it_,
and that is all this section adds.

Everything else that could be recorded is either not editable or already known:

- **Inline text** lives in the code that declared it. Recording it as a "part"
  answers no question a reader can act on — there is no path to open — and the
  bytes are already inside `prompt`.
- **The skill index** is a rendering of the provider's catalog, not a document.
  What to edit is the skill file, which `SkillProvider` already knows
  (`Skill.file`) and `LoadSkillsNode` already records.
- **Runtime notes** are kernel source. Nobody edits them per-agent.

So a resolved part is a file, and a file is `{ path, content }`.

### 17.2 Authoring

`instructions` gains an array form; an element is a string, a function, or a
block of text that knows where it came from:

```ts
export interface PromptText {
    text: string;
    /** the editable document this text came from, if any */
    path?: string;
    section?: string;
}

export type PromptPart<TCtx = unknown> =
    | string // literal text
    | ((ctx: TCtx, spec: RunSpec) => string) // computed from immutable run config
    | PromptText;

/** reads the file once, at construction, and remembers the path */
export function promptFile(path: string, section?: string): PromptText;

export type Instructions<TCtx> =
    string | ((ctx: TCtx, spec: RunSpec) => string) | PromptPart<TCtx>[];
```

**A file is not a part kind — it is text plus a path.** An earlier draft had a
`{ file }` part that the composer resolved during the run, which meant the
runtime needed a file-reader interface, the composer had to be async and
I/O-doing, every part needed an `optional` flag for the missing-file case, and a
typo in a path surfaced on the first LLM call in production. Reading at
construction deletes all four: `promptFile` throws at startup with a stack trace
pointing at the agent, `optional` has no reason to exist (do not include the
part), and `path` becomes what it always was — metadata.

It also makes the prompt genuinely constant for the life of the agent, which is
what the provider's cache assumes anyway. A prompt that must change without a
restart is a different feature: rebuild the agent, or use the function form.

The scalar forms are the one-element case of the array, so nothing existing has
to move. Composition is array spreading:

```ts
const HOUSE = [promptFile('prompts/AGENT.md'), "Answer in the user's language."];

runner.agent({ name: 'triage', instructions: [...HOUSE, promptFile('prompts/intent1.md')] });
runner.agent({ name: 'resolve', instructions: [...HOUSE, promptFile('prompts/intent2.md')] });
```

No `id`, no `label`: a file is named by its path, and inline text needs no name
because nothing refers back to it. Ordering is array order; the derived text
(§17.5) is always appended after, which keeps the volatile part at the end
without anyone having to remember to put it there.

**The function form takes `RunSpec`, not `AgentState`** — narrowed from v1. The
system prompt is the provider's cache prefix; a prompt that varies with mutable
state invalidates that prefix on every single turn, and since a changed prompt
appends a node (§17.4), it also writes one `system_prompt` node per turn. It is
circular besides: the prompt is composed from a trajectory it is about to be
appended to. `RunSpec` is fixed at `createState` (§6), so the useful cases —
`forkDepth` to tell a branch prompt from a trunk one, the run's output contract,
anything derived from `ctx` — still work, while "prompt that grows with the
conversation" stops being expressible. Per-turn content belongs where the
projection already puts it: at the tail, as recalls, tool results and input.

### 17.3 The node

```ts
export interface SystemPromptNode extends NodeBase {
    type: 'system_prompt';
    /** exactly what the provider received — unchanged field, unchanged meaning */
    prompt: Payload;
    /** file-backed contributors, in the order they were rendered */
    sources?: { path: string; content: Payload }[];
}
```

Two fields, and each earns its place:

- `content` is a `Payload` because everything is (§4): `INSTRUCTIONS.md` shared by
  ten agents, by both sides of a handoff and by every fork branch is stored once,
  and the content address doubles as the drift hash — no parallel hash field.
- Offsets into `prompt` are deliberately absent. They would be a third
  representation of the same bytes, invalidated by any change to an earlier
  part, and an inspector that wants to highlight a region can find it by content.

`projectMessages` is untouched: the projection still emits one system string,
last-one-wins, and `sources` is metadata the model never sees.

### 17.4 Idempotency — the bytes are the identity

`applySystemPrompt` keeps comparing `prompt.sha256` against the freshly rendered
string, exactly as it does today. There is no composition hash, because two
compositions that render to the same bytes _are_ the same prompt as far as the
model, the provider cache and replay are concerned; appending a node to record
that a boundary moved would be noise in an append-only log. By the same argument
there is no renderer version: a renderer change that matters changes the bytes,
and one that does not, does not.

What follows from that:

- a re-entered loop or a resumed run renders identical bytes and appends nothing;
- a handoff renders the new agent's prompt, and the old node stays in the history
  where it belongs;
- an agent rebuilt from edited files renders different bytes, so the next run
  records the new revision — the change is dated in the log rather than inferred.

A prompt file that cannot be read is an error at construction (§17.2), not a run
that starts without it: silently dropping instructions would leave the model
holding a prompt nobody wrote, the same reason a drifted skill hash is fatal
(§9.3).

### 17.5 Derived text — no more hidden appends

`buildRequest` currently appends the skill index and the `final_output`
instruction _after_ projection, so part of the system prompt exists in no node at
all. Both move into the composer, appended after the authored parts in a fixed
order: the skill index (only when `discovery: 'index'`), then the runtime notes
(today only `final_output`, for typed runs).

They are not listed in `sources` — neither is a file anyone edits — but they are
now inside `prompt`, which is what the audit needed. That restores the invariant:
**the system prompt the model saw is exactly `SystemPromptNode.prompt`**, nothing
is added downstream, and `requestDigest` becomes a meaningful replay check for
the prompt.

### 17.6 Section markers

Markers such as `<intent> … </intent>` are opt-in per part (`section`), because a
marker is tokens the model reads and therefore changes behaviour — a wrapper that
"doesn't influence the content" does not exist for an LLM. Rendering is
deterministic: `<section>\n…\n</section>`, parts joined by a blank line. Nothing
needs to be versioned or hashed, because a change to any of it changes `prompt`
and therefore appends a new node on its own.

### 17.7 Derived view: what to edit

This is the feature the whole section exists for: "this instruction is wrong"
resolves to a path instead of a search, per agent, including the agents a handoff
passed through. It needs no API, because it is a fold over a public field:

```ts
const files = trajectory
    .filter((n) => n.type === 'system_prompt')
    .flatMap((n) => (n.sources ?? []).map((s) => ({ agent: n.agent, path: s.path })));
```

A shipped helper would have to guess the caller's question — newest-first or
oldest-first, deduped by path or by path and content, current agent or all of
them — and every guess is one line for the caller to write differently. The
provenance is the data; the query is not the core's business.

Skills answer through their own node for the same reason, plus a stronger one.
`LoadSkillsNode` gains `file` per skill where the provider knows it (`file.ts`
already tracks it), which is strictly more informative — it names the activation
that pulled the file in, not just the file. Merging the two into one list would
also mean one `sha256` field with two meanings, since a skill's hash covers its
body after frontmatter is stripped rather than the file's bytes.

### 17.8 Compatibility

`sources` is optional, so every node recorded before this section stays valid and
simply reports no files. No new node type, no migration of stored runs, and the
authoring change is additive — a string instruction keeps working and becomes the
one-element case.
