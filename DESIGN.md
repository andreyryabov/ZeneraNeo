# Agent Runtime v2 — Design Specification

Status: draft
Scope: `experiments/src.js/agent/agent.ts` rewrite

## 1. Goals

1. **No turn budget.** Remove `maxTurns` everywhere; the loop ends only on a final
   answer, an abort signal, or an unrecoverable error.
2. **Two-tier event model.**
   - *Stream events* — ephemeral, fine-grained progress (thinking deltas, text
     deltas, partial tool-argument JSON with the tool name). Never required for
     correctness; safe to drop.
   - *Checkpoint events* — coarse-grained state transitions emitted **before
     every LLM call** and **before every tool call** (and after each, and on
     handoff / finish). Each carries the full serializable state so the run can
     be persisted and resumed from exactly that point (Temporal-ready).
3. **Explicit state creation.** Starting a run is a separate, explicit step that
   produces an `AgentState`; the loop only ever *advances* an existing state.
4. **Typed result.** The caller passes a **Zod** schema and receives a parsed,
   validated `z.infer<typeof schema>` as `RunResult<T>.output` — the TypeScript
   type comes from the same declaration that drives validation.
5. **Trajectory instead of raw messages.** The state stores a typed, append-only
   log of everything that happened (`UserInput`, `SystemPrompt`, `LoadSkills`,
   `LlmCall`, `ToolCall`, `ToolResult`, `Handoff`, `Compaction`, …). Messages
   for the provider are a *projection* of the trajectory, computed on demand.
6. **Large-value offloading.** Every non-trivial string (system prompts,
   thinking chains, tool outputs, skill content) lives behind a `Payload`
   reference — uniformly, never inline — so the state has a small, predictable
   size regardless of how much data flowed through the run.
7. **Full accounting.** Every LLM call node records the model id and token usage
   (input / cached-input / output / reasoning), so total consumption is exactly
   reconstructable from the trajectory alone.
8. **Trajectory as the context-manipulation tool.** Compaction, handoff-time
   noise stripping etc. are expressed as trajectory nodes that *mask* earlier
   nodes for projection purposes while keeping the originals for audit/replay.
9. **Pluggable memory.** Agents search, write, update and delete long-lived
   memories through a `MemoryStore` interface; scopes decide what is private to
   an agent and what is shared between agents.
10. **On-demand skills.** Instruction bundles are discovered and loaded through a
    `SkillProvider` interface instead of permanently occupying the prompt.
11. **Fork / join.** An agent can split into parallel branches that really run
    concurrently (LLM and tool calls alike) and rejoin into one result, while the
    parent's history stays linear — as if the work had been sequential.

## 2. Non-goals

- Provider streaming beyond OpenAI (the `Model` interface defines the stream
  contract; only `OpenAIModel` (chat completions) and `OpenAIResponsesModel`
  (responses) implement it initially).
- Automatic context compaction policy (only the mechanism: `CompactionNode`).
- Concrete `MemoryStore` / `SkillProvider` backends (pgvector, filesystem, …):
  this document specifies the interfaces and how they touch the trajectory; a
  trivial in-memory implementation is the only one shipped initially.
- Cross-run orchestration. One `AgentState` is still one logical run; a fork
  creates *child runs* (§10) that are linked by reference, not merged.

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
    store: string;      // store id, e.g. 's3://bucket' or 'mem'
    sha256: string;     // content address — also the key
    size: number;       // bytes, for budgeting without fetching
    preview?: string;   // first ~200 chars, for logs, UIs and debugging
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
  is re-serialized at *every* checkpoint, making write amplification quadratic in
  trajectory length. Temporal would reject it outright (payload limits ~2 MB).
  With uniform refs the state is O(number of nodes), full stop.
- **One code path.** No discriminant to switch on, no "is it here or not"
  question at every use site, no threshold to tune per deployment.
- **Free deduplication.** The key *is* the content hash, so an identical value
  is stored once no matter how often it recurs — system prompts repeated after
  each handoff, inherited fork context shared by N branches, identical tool
  results from retries. With a size threshold, dedup silently stopped applying
  below the threshold.
- **Tractable GC.** Reference counting over `sha256` across stored states is
  well-defined; "which inline blobs are still reachable" is not a question you
  can even ask.

The two things inline bought us are recovered explicitly:

- *Locality* — the default `InMemoryStore` resolves from a `Map`, so a local run
  does zero I/O. Refs are not synonymous with network.
- *Self-containment* — `exportRun(state, stores)` produces
  `{ state, blobs: Record<sha256, string> }`, a single portable artifact for
  tests, bug reports and archival; `importRun(bundle, store)` re-registers the
  blobs. This is better than inline was: it is explicit, it is deduped, and it
  covers child runs reachable by ref.

### 4.2 Rules

- The kernel never dereferences payloads except in `buildRequest`, where the
  projection needs actual text. `buildRequest` is therefore `async`, and it is
  the **only** place that resolves. Everything else — appending nodes,
  `nextAction`, compaction masking, usage summation — works on refs alone.
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
  `InheritedContextNode.messages`, `JoinNode.results[].output/childStateRef`,
  `UserInputNode` content parts.
- Degenerate values are not special-cased: the empty string is one well-known
  content address shared by every node that has no text, costing one entry
  globally.

## 5. Trajectory

Append-only ordered log. Every node:

```ts
export interface NodeBase {
    id: string;        // ulid — unique, sortable
    seq: number;       // dense index in the trajectory (0..n-1)
    ts: string;        // ISO timestamp (informational, not used for logic)
    agent: string;     // active agent when the node was created
}
```

Node types (`type` is the discriminant):

```ts
export type TrajectoryNode =
    | UserInputNode        // { type:'user_input',  content: PayloadPart[] }
    | SystemPromptNode     // { type:'system_prompt', prompt: Payload }
    | LoadSkillsNode       // §9.3 — skill activation (content + unlocked tools)
    | MemoryRecallNode     // §8.4 — memories injected before an LLM call
    | MemoryOpNode         // §8.4 — memory write/update/delete effect record
    | LlmCallNode          // see below
    | ToolCallNode         // { type:'tool_call', callId, name, args: Payload }
    | ToolResultNode       // { type:'tool_result', callId, name, result: Payload,
                           //   isError: boolean, durationMs?: number }
    | HandoffNode          // { type:'handoff', from, to, reason?: string }
    | ForkNode             // §10.2 — branch plan + child run ids
    | JoinNode             // §10.2 — per-branch results, usage, child state refs
    | InheritedContextNode // §10.3 — frozen parent context (child runs only)
    | CompactionNode       // see below
    | FinalOutputNode;     // { type:'final_output', output: Payload,
                           //   parsed?: unknown /* when an output schema was set */ }
```

### 5.1 LlmCallNode — the accounting record

```ts
export interface TokenUsage {
    inputTokens: number;
    cachedInputTokens: number;   // subset of inputTokens served from cache
    outputTokens: number;
    reasoningTokens: number;     // subset of outputTokens (thinking)
}

export interface LlmCallNode extends NodeBase {
    type: 'llm_call';
    model: string;               // exact model id used
    requestDigest: string;       // sha256 of the projected request, for replay checks
    text: Payload;               // assistant prose ('' allowed)
    thinking?: Payload;          // reasoning chain if the provider returns it
    toolCalls: { callId: string; name: string; args: Payload }[];
    usage: TokenUsage;
    stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}
```

`sum(trajectory.filter(llm_call).usage) + sum(trajectory.filter(join).usage)`
reproduces total consumption exactly, including cache hits and tokens spent in
parallel branches (§10.6) — no separate counters to keep in sync (a cached
`usage` total on the state is allowed but derived).

### 5.2 CompactionNode — masking, not deletion

```ts
export interface CompactionNode extends NodeBase {
    type: 'compaction';
    /** seq range (inclusive) whose nodes are hidden from projection */
    maskFrom: number;
    maskTo: number;
    /** what the model sees instead of the masked range; may be empty */
    summary: Payload;
    reason: 'handoff_noise' | 'token_budget' | 'manual' | string;
}
```

- Masked nodes stay in the trajectory untouched — audit and replay always see
  full history; only `projectMessages` skips them.
- Later compactions may mask earlier `CompactionNode`s too (re-compaction).
- Handoff noise stripping = the runner (or a policy hook) appending a
  `CompactionNode` right after a `HandoffNode` that masks the previous agent's
  `tool_call`/`tool_result` chatter and summarizes it.

### 5.3 Projection: trajectory → messages

```ts
async function projectMessages(
    trajectory: TrajectoryNode[],
    stores: PayloadResolver,
): Promise<{ system?: string; messages: Message[] }>;
```

Algorithm:

1. Compute the mask set: union of `[maskFrom, maskTo]` of every non-masked
   `CompactionNode`.
2. Walk nodes in `seq` order, skipping masked ones:
   - `system_prompt` → becomes the *current* system prompt (last one wins;
     earlier ones are superseded, not emitted as messages).
   - `user_input` → `UserMessage`.
   - `load_skills` → `UserMessage` (or system append — provider-dependent).
   - `llm_call` → `AssistantMessage` (text + toolCalls). Thinking is **not**
     projected (provider-specific; kept for audit only).
   - `tool_call` → folded into the owning `AssistantMessage` (they share the
     `llm_call` node in practice; standalone `ToolCallNode` exists so a
     checkpoint can be cut *between* LLM response and tool execution).
   - `tool_result` → `ToolMessage`.
   - `handoff` → nothing by itself (the transfer tool call/result pair already
     projects); the *effect* is that subsequent `system_prompt` differs.
   - `memory_recall` → `UserMessage` with the rendered memories block (§8.4).
   - `memory_op` → nothing (the memory tool's call/result pair already
     projects; the node exists for provenance and idempotency).
   - `inherited_context` → the frozen parent messages, spliced in verbatim
     (child runs only, always the first node; §10.3).
   - `fork` → nothing (the `fork` tool call projects from its `llm_call`).
   - `join` → the `tool_result` for the fork call: one labelled list of branch
     outputs. Child trajectories are never projected into the parent (§10.5).
   - `compaction` → one synthetic `UserMessage`/`ToolMessage` containing the
     summary (only if non-empty).
   - `final_output` → `AssistantMessage`.
3. Collect every payload referenced by the surviving nodes and resolve them in
   **one** `getMany` batch before assembling the messages.

Invariant: every projected `tool_call` id has a matching `tool` message —
enforced by the kernel (a tool call without a recorded result blocks the next
LLM call; see resume semantics).

## 6. AgentState

```ts
export type RunPhase =
    | 'created'           // initial context built, nothing executed
    | 'awaiting_llm'      // next step is a model call
    | 'awaiting_tools'    // model returned tool calls; some results missing
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
    /** set on child runs created by a fork (§10) */
    parent?: { runId: string; forkId: string; branch: string };
    forkDepth: number;           // 0 for a root run
}

export interface AgentState {
    version: 1;                  // schema version for forward migration
    runId: string;
    spec: RunSpec;               // immutable config
    agentName: string;           // active agent (mutable — changes on handoff)
    phase: RunPhase;
    trajectory: TrajectoryNode[];
    /** tool calls from the last llm_call still lacking a tool_result, by callId */
    pendingToolCalls: string[];
    /** branches of an in-flight fork still lacking a result, by branch name */
    pendingBranches: string[];
    /** derived cache; always recomputable from trajectory (incl. JoinNode.usage) */
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
    runId?: string;             // default: ulid()
    agent: string;              // starting agent name
    input?: Input;              // optional first user message
    context?: unknown;          // app context — must be serializable
    output?: z.ZodType<T>;      // typed-result request (see §6.1)
    systemPrompt?: string;      // pre-rendered; else rendered on first step
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

| Where                  | What                                                   |
|------------------------|--------------------------------------------------------|
| `CreateStateOptions.output` | the Zod schema — source of both `T` and validation |
| `state.spec.outputSchema`   | `z.toJSONSchema(output, { target: 'draft-2020-12' })` — plain JSON, sent to the provider |
| Runner / kernel call site   | the Zod schema again, supplied at run/resume time  |

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
    | { kind: 'llm' }                                  // call the model
    | { kind: 'tools'; calls: PendingToolCall[] }      // execute these
    | { kind: 'fork'; forkId: string; branches: BranchPlan[] }   // §10
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
    scope: string;              // memory space this record belongs to
    kind: string;               // app-defined: 'fact' | 'preference' | 'episode' | …
    text: string;               // the retrievable content
    metadata?: Record<string, unknown>;   // filterable attributes
    createdAt: string;
    updatedAt: string;
    revision: number;           // optimistic-concurrency token
}

export interface MemoryQuery {
    text?: string;              // semantic query; omitted ⇒ pure filter listing
    filter?: Record<string, unknown>;     // exact-match metadata constraints
    kind?: string;
    limit?: number;             // default 8
    minScore?: number;
}

export interface MemoryHit {
    record: MemoryRecord;
    score: number;              // 0..1, backend-normalized
}

export interface MemoryStore {
    readonly id: string;
    search(scope: string, q: MemoryQuery): Promise<MemoryHit[]>;
    get(scope: string, id: string): Promise<MemoryRecord | undefined>;
    /** `opId` makes writes idempotent under retry/replay (see §8.4) */
    write(scope: string, rec: MemoryDraft, opId: string): Promise<MemoryRecord>;
    update(scope: string, id: string, patch: MemoryPatch, opId: string):
        Promise<MemoryRecord>;
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
    store: string;              // MemoryStore id
    scope: string;              // namespace; default: `agent:${agent.name}`
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
  `scope: \`user:${ctx.userId}\`` — resolved at `buildRequest` time, and the
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
    hits: { id: string; score: number; revision: number }[];  // ids, not bodies
    content: Payload;           // the rendered block the model actually saw
}

export interface MemoryOpNode extends NodeBase {
    type: 'memory_op';
    op: 'write' | 'update' | 'delete';
    store: string;
    scope: string;
    opId: string;               // sha256(runId, callId) — deterministic
    recordId: string;
    revision: number;           // post-op revision, or the deleted one
    before?: Payload;           // prior content, for audit/undo
    after?: Payload;
}
```

Why a separate node when the tool call is already recorded:

- **Idempotency.** `opId` is derived from `runId + callId`, not generated
  randomly, so a retried or replayed step re-issues the *same* write and the
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
    description: string;        // one line — this is what search/index sees
    tags?: string[];
    version?: string;
}

export interface Skill extends SkillSummary {
    content: Payload;           // full instructions (offloadable — often large)
    tools?: AnyTool<unknown>[]; // tools unlocked while the skill is active
    resources?: Record<string, Payload>;   // templates, examples, schemas
}

export interface SkillProvider {
    readonly id: string;
    list(): Promise<SkillSummary[]>;                       // cheap index
    search(query: string, limit?: number): Promise<SkillSummary[]>;
    load(name: string, version?: string): Promise<Skill>;  // full content
}
```

Implementations are pluggable and out of scope here: a filesystem provider over
`SKILL.md` directories, a static in-code registry, or a vector-backed provider
sharing infrastructure with `MemoryStore`.

### 9.2 Configuration

```ts
export interface SkillBinding {
    provider: string;           // SkillProvider id
    /** how the agent discovers skills */
    discovery: 'index' | 'search' | 'none';
    /** always loaded at run start, before the first LLM call */
    preload?: string[];
    /** cap on the index rendered into the system prompt */
    maxIndexEntries?: number;   // default 50
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
    content: Payload;           // concatenated instructions the model saw
    toolNames: string[];        // tools this activation unlocked
}
```

Consequence for resume: the tool list offered to the model is **not** a static
property of the agent — it is

```
tools(state) = agent.tools
             + handoff tools
             + memory tools (from bindings)
             + skill tools (from non-masked LoadSkillsNodes of the active agent)
             + fork tool (if forkable)
             + final_output (typed runs)
```

`buildRequest` computes this from the state, so a rehydrated run offers exactly
the same tools it had before the crash. `toolNames` is stored in the node so the
set is recoverable even if the provider's catalog changed since — a load whose
`contentHash` no longer matches the provider is a hard error, not a silent
substitution.

Masking a `LoadSkillsNode` via compaction therefore also **deactivates its
tools**, which is the intended semantics: dropping a skill's instructions while
leaving its tools callable would leave the model with tools it no longer knows
how to use.

## 10. Fork / join — parallel sub-agents

The model asks for parallel work through a built-in `fork` tool; the run splits
into N independent child runs, and rejoins into a single result. From the
parent's message history the whole episode looks like **one tool call and one
tool result** — sequential semantics, parallel execution.

### 10.1 The fork tool

```ts
// parameters (Zod, projected to JSON Schema like any other tool)
z.object({
    branches: z.array(z.object({
        name: z.string(),                 // stable branch label
        instructions: z.string(),         // what this branch must do
        agent: z.string().optional(),     // defaults to the forking agent
    })).min(2),
    context: z.enum(['inherit', 'compact', 'none']).default('inherit'),
});
```

Agent opt-in: `AgentOptions.fork?: { agents?: string[]; maxBranches?: number }`.

### 10.2 Data model

Each branch is a **complete `AgentState` of its own** — not interleaved nodes in
the parent log. Interleaving parallel work into one trajectory would make `seq`
nondeterministic, break the "dense index" invariant and destroy prompt caching.

```ts
export interface ForkNode extends NodeBase {
    type: 'fork';
    forkId: string;
    callId: string;                       // the fork tool call that caused it
    contextMode: 'inherit' | 'compact' | 'none';
    /** what every child starts from; one blob, shared by all branches */
    inheritedContext?: Payload;
    branches: { name: string; agent: string; instructions: Payload;
                childRunId: string }[];
}

export interface JoinNode extends NodeBase {
    type: 'join';
    forkId: string;
    /** always in declared branch order, never completion order */
    results: {
        name: string;
        status: 'ok' | 'error' | 'aborted';
        output: Payload;                  // branch answer or summary
        error?: string;
        usage: TokenUsage;
        childRunId: string;
        childStateRef: Payload;           // full child state, offloaded
    }[];
    usage: TokenUsage;                    // sum over branches
}
```

`childStateRef` is a `Payload`, so a child's entire trajectory is one ref in the
parent (typically offloaded to S3) and the parent state stays small while full
history remains reachable. Children created with `context: 'inherit'` all point
at the same `inheritedContext` payload — no special handling needed, since every
payload is content-addressed, so N branches cost one blob rather than N copies.

### 10.3 Child seeding

The child's trajectory begins with:

```ts
export interface InheritedContextNode extends NodeBase {
    type: 'inherited_context';
    parent: { runId: string; seq: number };   // provenance pointer
    messages: Payload;                        // frozen projection of the parent
}
```

- `inherit` — the parent's projected messages up to the fork point are frozen
  into that payload. Copy, not reference: the child is self-contained (it can be
  executed in another process or Temporal child workflow), and the snapshot
  records exactly what the branch saw.
- `compact` — same, but the parent's compaction policy runs first, so branches
  start from a summary instead of raw tool noise. This is the default
  recommendation for wide fans-out.
- `none` — the child starts from its agent's system prompt plus its branch
  instructions only. Cheapest; good for independent lookups.

Then a `UserInputNode` carrying the branch instructions. From that point the
child is an ordinary run: it may call tools, hand off, use memory, and even fork
again (`spec.forkDepth` increments; an optional `maxForkDepth` guards runaway
recursion — a structural bound, not a turn budget).

### 10.4 Execution and state machine

`RunPhase` gains `'awaiting_branches'`; `AgentState` gains
`pendingBranches: string[]` (branch names without a result), mirroring
`pendingToolCalls`. `NextAction` gains:

```ts
| { kind: 'fork'; forkId: string; branches: BranchPlan[] }
```

Runner behaviour:

```
case 'fork':
    emit before_fork(state)                          // ← persistence point
    results = await Promise.all(branches.map(b =>
        runChild(b)))                                // real parallelism:
                                                     // concurrent LLM + tool calls
    state = await Kernel.applyJoin(state, forkId, results)
    emit after_join(state)
```

- Branches run truly concurrently — each has its own model client call and its
  own tool executions. Nothing serializes them.
- `applyJoin` sorts results by **declared branch order** before appending, so the
  trajectory is identical regardless of completion order. This is what keeps
  replay deterministic and the parent's prompt cacheable.
- Partial failure is data, not an exception: a failed branch is recorded with
  `status: 'error'`, and the fork `ToolResultNode` reports it so the model can
  retry or route around it. The run itself only fails if the join policy says so.
- Resume: a crash mid-fork leaves `phase: 'awaiting_branches'` with
  `pendingBranches` naming the unfinished ones. Their child states were
  checkpointed independently, so restart re-runs **only** the incomplete
  branches, each from its own last checkpoint.

### 10.5 Compacting parallel history

Two levels, and this is where the trajectory-as-context-tool idea pays off:

1. **Inside the child, at completion.** A `JoinPolicy.summarize(childState)`
   produces the branch `output` — either the child's own final answer, or an
   LLM-generated summary of its trajectory. Implemented as an ordinary
   `CompactionNode` appended to the child before extraction, so the child's own
   record shows what was condensed and why (`reason: 'branch_summary'`).
2. **In the parent, at join.** The parent never ingests child trajectories. Its
   projection of the whole episode is exactly two messages: the `fork` assistant
   tool call, and one tool result containing the per-branch summaries. N parallel
   agents cost the parent O(N × summary), not O(N × full history).

```ts
export interface JoinPolicy {
    /** what the parent sees for this branch */
    summarize(child: AgentState): Promise<Payload>;
    /** whether one branch's failure aborts the others */
    onBranchError?: 'continue' | 'abort_siblings';
}
```

Projection rules for the new nodes:

- `fork` → nothing on its own (the tool call already projects).
- `join` → the `ToolResultNode` for the fork call, rendered as a labelled list
  of branch outputs.
- `inherited_context` → the frozen messages, spliced in verbatim (child only).
- Full child history is reachable through `childStateRef` for debugging,
  evaluation and token accounting — never for prompting.

### 10.6 Accounting across branches

`state.usage` is defined as "derived from the trajectory". The derivation now
includes `JoinNode.usage`, which is the sum of the branches' own derived totals.
Recursion terminates at leaf runs, so total consumption of a fork tree —
including cached tokens — is still exactly reconstructable from the root state
plus reachable child refs.

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
    output: T;                   // z.infer of the output schema when given
    agent: string;
    state: AgentState;
    usage: TokenUsage;
    stopReason: 'final' | 'aborted';
}

// T flows from the Zod schema, no manual assertion at the call site:
const res = await runner.run('planner', 'Plan a trip.', { output: TripSchema });
res.output.totalCostEur;   // number
```

The same `z.ZodType` inference can later be reused for tool arguments
(`tool({ parameters: z.object(...) })`), replacing the hand-written
`JsonSchema` + explicit `TArgs` pair — out of scope here, but the schema
projection helper is shared.

Runaway protection is the caller's job (wall-clock/token budget hooks can be
added later as policies, not as a hardcoded turn counter).

## 12. Events

Every event — stream *and* checkpoint — carries the same origin tag, so a
consumer can always tell which run in a fork tree produced it:

```ts
export interface BranchRef {
    forkId: string;      // the fork that created this branch
    name: string;        // declared branch name
    runId: string;       // the child run's id
    depth: number;       // spec.forkDepth of the emitting run
}

export interface EventBase {
    runId: string;       // emitting run (root run id on the trunk)
    agent: string;       // active agent in that run
    /** absent on the trunk; set on every event emitted by a branch */
    branch?: BranchRef;
}
```

- `runId` is the primary key: an event belongs to exactly one `AgentState`.
- `branch` is the *lineage* of that run — present on nested forks too, where
  `depth > 1`. A UI groups by `branch.forkId` to build lanes, and by `runId` to
  attach the right state snapshot.
- On the trunk, `branch` is `undefined` and `runId === state.runId` of the root.

### 12.1 Stream events (ephemeral, no state attached)

Emitted only when the model transport supports streaming; consumers must treat
them as best-effort UI feed. `argsSoFar` allows rendering partial tool args
without the consumer buffering deltas.

```ts
export type StreamEvent = EventBase & (
    | { type: 'thinking_delta'; delta: string }
    | { type: 'text_delta'; delta: string }
    | { type: 'tool_args_delta'; callId: string;
        name: string; delta: string; argsSoFar: string }
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
export type CheckpointEvent = EventBase & (
    | { type: 'run_created';      state: AgentState }
    | { type: 'before_llm_call';  state: AgentState }
    | { type: 'after_llm_call';   state: AgentState; node: LlmCallNode }
    | { type: 'before_tool_call'; state: AgentState; call: PendingToolCall }
    | { type: 'after_tool_call';  state: AgentState; node: ToolResultNode }
    | { type: 'handoff';          state: AgentState; from: string; to: string }
    | { type: 'before_fork';      state: AgentState; node: ForkNode }
    | { type: 'branch_started';   state: AgentState; child: BranchRef;
                                  childState: AgentState }
    | { type: 'branch_finished';  state: AgentState; child: BranchRef;
                                  childState: AgentState;
                                  status: 'ok' | 'error' | 'aborted' }
    | { type: 'after_join';       state: AgentState; node: JoinNode }
    | { type: 'run_finished';     state: AgentState; result: RunResult }
);

export type AgentEvent = StreamEvent | CheckpointEvent;
```

Tagging rules, which are what make persistence unambiguous:

- `state` always belongs to the **emitting** run, i.e. the one named by
  `runId`/`branch`. A `before_llm_call` from a branch carries the *child's*
  state — persist it under `branch.runId` and resume that branch alone.
- `before_fork` / `branch_started` / `branch_finished` / `after_join` are emitted
  by the **parent**, so their `branch` field describes the *parent's* own lineage
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

| Concept        | Temporal construct                                     |
|----------------|--------------------------------------------------------|
| `AgentState`   | workflow-local variable (checkpointed via event history)|
| LLM call       | activity `llmGenerate(req) → ModelResponse` (retryable) |
| Tool execution | activity `runTool(name, args) → ToolOutcome`            |
| Kernel `apply*`| inside the workflow (deterministic, uses `IdClock`)     |
| `PayloadStore.put/get` | inside activities only (I/O)                    |
| Memory op      | activity, keyed by `MemoryOpNode.opId` (idempotent §8.4)|
| Skill load     | activity `loadSkill(name, version) → Skill`             |
| Fork branch    | child workflow, one per branch                          |
| Join           | `Promise.all` over child workflow handles, then `applyJoin` |
| checkpoint events | implicit — every activity boundary is a checkpoint   |

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

| v1                                   | v2                                        |
|--------------------------------------|-------------------------------------------|
| `AgentState` class with `messages[]` | plain-JSON `AgentState` with `trajectory` |
| `AgentState.from(json)`              | not needed (no prototype); `validateState(json)` type guard instead |
| `maxTurns` (agent/runner/run opts), `stopReason: 'max_turns'` | removed |
| `Usage {input,output}`               | `TokenUsage {input,cachedInput,output,reasoning}` |
| implicit state creation in `run()`   | `Kernel.createState` (runner `run()` calls it, `resume()` requires it) |
| `AgentEvent` (flat)                  | `StreamEvent \| CheckpointEvent`          |
| `state.turns`                        | derived: count of `llm_call` nodes        |
| `Message[]` as source of truth       | projection output only (`projectMessages`)|
| untyped `RunResult.output: string`   | `RunResult<T>` with `T = z.infer<schema>`  |
| —                                    | immutable `state.spec` (`RunSpec`) separated from mutable progress |
| —                                    | `MemoryStore` bindings + memory tools (§8) |
| —                                    | `SkillProvider` bindings + skill tools (§9) |
| —                                    | `fork`/join with child `AgentState`s (§10) |
| static per-agent tool list           | tool set derived from state (agent + handoffs + memory + skills + fork + `final_output`) |

`Message`, `ContentPart`, `Tool`, `tool()`, `Agent`, `handoffTool`,
`RunStream`, `runTool` survive with minimal changes (`ToolContext.state` is now
the plain state; `Instructions<TCtx>` receives `(ctx, state)` unchanged).

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
