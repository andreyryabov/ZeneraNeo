# Copilot instructions — agent projects

> Written by `zen init` into `.github/copilot-instructions.md`. VS Code loads it
> automatically for every request in this folder, so it is the standing brief
> for anyone — human or agent — editing this project.
>
> It describes the Zenera Neo runtime, not this particular project. Edit it
> freely: add the conventions this project has, delete the sections it does not
> use. The runtime's own reference is `docs/agents-yaml.md`, `docs/projects.md`
> and `DESIGN.md` in the zenera-neo repository — where they disagree with this
> file, they win.

---

## 0. What this repository is

This is **not a normal application repository**. It is a folder of declarative
artefacts — YAML, Markdown, and a thin seam of TypeScript — that assemble into a
running multi-agent system.

The centre of gravity is **prose**, not code. Most valuable changes here are
edits to a prompt, a skill, or one line of `agents.yaml`. Reach for TypeScript
only when the system needs a capability the model cannot have by reading:
network calls, database access, arithmetic that must be exact, side effects.

**Default posture when working in this repo:**

1. Find which artefact owns the behaviour before editing anything (§10).
2. Prefer editing a prompt or skill over adding an agent.
3. Prefer adding a skill over lengthening a prompt.
4. Prefer adding a tool over asking the model to compute or remember.
5. Never add an agent to solve a problem that is really a prompt problem.
6. Every change must still load: `agents.yaml` is validated strictly at load.

---

## 1. Mental model

### 1.1 What an agent actually is

An agent is four things and nothing more:

| Part            | Where it lives                           | What it decides               |
| --------------- | ---------------------------------------- | ----------------------------- |
| **Instruction** | `AGENTS.md` + `agents/prompts/<name>.md` | How it behaves                |
| **Model**       | `agents.yaml` → `model:`                 | How well and how expensively  |
| **Tools**       | `agents.yaml` → `tools:` + TS impls      | What it can _do_              |
| **Knowledge**   | `agents/skills/*` + memory               | What it can _know_, on demand |

Plus two relations: **handoffs** — which other agents it may transfer control to
— and **fork** — whether it may split into parallel branches at all (§6.4).

There is no hidden orchestration layer. If behaviour is wrong, one of those six
things is wrong.

### 1.2 The loop

```
user input
   ↓
[system prompt][tool schemas][transcript]  →  model
   ↓
model returns: text  → done
              tools  → execute → append results → loop
              handoff→ switch agent, re-render system prompt → loop
              fork   → run N branches in parallel → join → loop
```

Every step appends to an **append-only trajectory**. Nothing is ever mutated or
deleted; compaction _covers_ older nodes rather than removing them, so the audit
trail survives context pressure. A conversation _is_ its `AgentState`; the loaded
project is immutable and shared by every conversation in the process.

### 1.3 The single most important idea: context is the product

The model sees exactly one thing: a token sequence. Your entire job as an author
is deciding **what is in that sequence and in what order**.

```
┌─────────────────────────────────────────────┐
│ tool schemas          fixed at load         │  ← stable, cacheable
│ AGENTS.md             shared by all agents  │  ← stable, cacheable
│ agent prompt          this agent's brief    │  ← stable per agent
│ skill index           names + descriptions  │  ← stable per agent
│ preloaded skills      activated turn 0      │  ← stable, in the cached prefix
├─────────────────────────────────────────────┤
│ transcript            grows                 │  ← the volatile part
└─────────────────────────────────────────────┘
```

Two consequences that drive nearly every design rule in this document:

- **Stable prefix = cache hit.** Providers cache by prefix. Anything appended
  mid-run _after_ the first reply — a tool schema, an instruction, a late skill
  activation — invalidates the cache from that point on. This is why tool schemas
  are fixed at load and skill-owned tools are declared from turn 0 and merely
  _gated_ at call time.
- **Everything in the prefix is paid for on every call.** A 4 000-token prompt
  covering twelve perils costs on every turn, whether or not the case involves
  any of them. Progressive disclosure (§5) is not an optimisation; it is the
  organising principle.

### 1.4 What a good system looks like

- Each agent has **one job you can state in one sentence**.
- The prompt says what to do, not what the software is.
- Facts live in skills or tools, never in a prompt that must be edited to change
  a number.
- Numbers come from tools; the model narrates, it does not compute.
- The failure mode of every instruction is stated ("if X is absent, say so and
  stop") — an unstated failure mode is an invented one.

---

## 2. Repository layout

### 2.1 Canonical

```
my-project/
├── .github/
│   └── copilot-instructions.md   this file
├── .env                          credentials — NEVER committed
├── AGENTS.md                     house rules, prepended to every agent
├── agents.yaml                   who exists, what they may reach for
├── agents/
│   ├── prompts/
│   │   ├── intake.md             one agent's own brief
│   │   └── adjuster.md
│   └── skills/
│       ├── house_style/
│       │   ├── SKILL.md          folder skill
│       │   └── examples.md       sibling files become `resources`
│       ├── water_damage/
│       │   └── SKILL.md
│       └── shipping_delays.md    flat skill (frontmatter + body)
├── src/
│   ├── tools/
│   │   ├── policy-lookup.ts      one tool per file
│   │   └── index.ts              exports the array passed to loadProject
│   └── main.ts                   the host: loadProject + run
└── test/
    └── project.test.ts           loads the project, asserts on wiring
```

Only `agents.yaml` is required, and only `agents:` is required inside it.
The config is found by name, in order: `agents.yaml`, `agents.yml`,
`agents/agents.yaml`, `agents/agents.yml`.

### 2.2 Variants

**Single agent, knowledge-heavy** — the most under-used shape. One agent, one
prompt, a large skill catalog. Prefer this until routing is genuinely needed.

```
AGENTS.md · agents.yaml · agents/prompts/assistant.md · agents/skills/**  (20 skills)
```

**Router + specialists** — a cheap intake agent that classifies and hands off.

```
agents/prompts/{intake,billing,technical,escalation}.md
```

**Pipeline** — fixed stages, each handing to the next; the last one answers.

```
research → draft → review
```

**Shared skills across projects** — `skills:` accepts a list, merged into one
catalog:

```yaml
skills:
    - agents/skills
    - ../shared/compliance-skills
```

Paths may not escape the project root unless the root is set to the common
ancestor. Several directories become **one** provider (id `project`) — "which
folder is this skill in?" is not a question an author should have to answer.

### 2.3 Naming rules (enforced)

Agent names, provider names and model alias keys must match:

```
^[a-z0-9]+(?:[-_][a-z0-9]+)*$
```

They reach the model as `transfer_to_<name>` and the file system as directory
names, so: `intake`, `order-triage`, `house_style`. No spaces, no capitals, no
dots.

---

## 3. File formats

### 3.1 `agents.yaml`

The schema is **strict**: an unknown key is a load error, not a value silently
ignored. Errors name the path — `agents.yaml: agents[1].skills.discovery — …`.

```yaml
version: 1 # schema version, defaults to 1
default: intake # entry agent; wins over any `default: true`

providers: {} # named connections (credentials + endpoint)
provider: openai # provider a bare model id belongs to
models: {} # named model configurations
model: fast # fallback for agents that do not pin their own
skills: agents/skills # one directory, or a list

agents: # the only required key; at least one entry
    - name: intake
      description: Takes the first message, gets the reference, routes the case.
      system: agents/prompts/intake.md
      model: router
      tools: [policy_lookup]
      handoffs: [adjuster]
```

**Agent fields**

| Field         | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `name`        | **Required.** See §2.3                                                                 |
| `description` | What a sibling's `transfer_to_<name>` tool tells the model. Write it _for the model_   |
| `system`      | Prompt path, relative to root. Defaults to `agents/prompts/<name>.md` if present       |
| `model`       | A `models:` alias or shorthand. Falls back to top-level `model:`                       |
| `tools`       | Selectors resolved against `ProjectOptions.tools` — see §3.6. Code cannot live in YAML |
| `handoffs`    | Agent names this one may transfer to. Bare strings; no per-edge config                 |
| `skills`      | Skill binding — see §5.2                                                               |
| `fork`        | `true`, or `{ agents, maxBranches }` — opt-in to parallel branches; see §6.4           |
| `default`     | `true` marks the entry point when no top-level `default:`                              |

**Providers** — a provider is a _connection_, not a model. One client is built
per name and shared, so five agents on one key open one connection pool.

| Field                     | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`                    | `openai` \| `google` \| `vertex` \| `anthropic` \| `openai-compatible` (default `openai`) |
| `apiKey` / `apiKeyEnv`    | Literal, `${VAR}`, or the name of the env var holding it                                  |
| `baseURL` / `baseURLEnv`  | For gateways and compatible endpoints                                                     |
| `project` / `location`    | **vertex only** — GCP project id and region (or `global`)                                 |
| `headers`                 | Sent on every request: routing, attribution, api versions                                 |
| `timeoutMs`, `maxRetries` | Per-request timeout and retry count                                                       |

`openai`, `google`, `vertex`, `anthropic` and `openai-compatible` are usable as
provider _names_ with no declaration at all. Declare a `providers:` entry only
when it says something the default does not — a second key, a region, a base url.

`${VAR}` and `${VAR:-fallback}` expand from the environment, compose inside
longer values (`https://${GATEWAY}/v1`), and are **lazy**: a declared-but-unused
provider with a missing key does not fail loading.

**Errors caught at load** — rely on these instead of defensive checks:

- any unknown key; any name breaking the pattern
- `models.<alias>.provider` naming an undeclared provider
- `agents[].tools` naming a tool not passed to `loadProject`, or a group with nothing in it
- `agents[].handoffs` naming an unknown agent, or the agent itself
- `agents[].skills.provider` / `.allow` / `.preload` naming something absent
- a `preload:` entry missing from `allow:`
- `agents[].fork.agents` naming an unknown agent, or being empty; `maxBranches` below 2
- `system:` pointing at a missing file, or outside the project root

### 3.2 `AGENTS.md`

House rules, read **once** and prepended to every agent's system prompt. It is
the stable head of the cached prefix, so it should change rarely.

Put here only what is true for **every** agent:

- identity and domain ("You work the property claims desk")
- non-negotiable prohibitions (regulatory, legal, safety)
- global format and tone constraints
- domain vocabulary and identifier formats

Do **not** put here: anything one agent needs and another does not; anything that
changes weekly; long reference data (that is a skill).

Target 20–60 lines. If it exceeds ~100, split the stable half out into a
preloaded skill.

### 3.3 `agents/prompts/<name>.md`

Plain Markdown, no frontmatter. This is the agent's _job description_, appended
after `AGENTS.md`.

Structure that works:

```markdown
<one sentence: who this agent is and what it owns>

<what it does, as a short numbered procedure or 3–5 rules>

<what it must NOT do — especially the neighbouring agent's job>

<how to finish: the shape of the answer, or which handoff ends the turn>
```

Real example (an intake agent, complete):

```markdown
You are the first person a claimant reaches.

Your job is small and you should finish it fast:

1. Read what happened.
2. Call `policy_lookup` with the claim reference to confirm the policy exists
   and see what it covers.
3. Hand the case to the `adjuster` agent, which owns the peril policies.

Do not quote coverage rules yourself — you do not have them. Do not ask the
claimant for anything the message already contains.
```

Note what makes it work: it is 9 lines; it names the tool and the handoff
literally; it states the boundary ("you do not have them") with the _reason_; it
forbids the specific failure that agent actually exhibits.

Target 10–40 lines. A 200-line prompt is a skill catalog that has not been split
yet.

### 3.4 Skills

A skill is curated, reusable instruction content — plus optional tools — loaded
**on demand** instead of permanently occupying the system prompt. Two layouts,
discovered in the same scan:

```
agents/skills/refund_policy.md          flat: frontmatter + body
agents/skills/refund_policy/SKILL.md    folder: sibling files become `resources`
```

Frontmatter is a deliberately small subset of YAML — `key: value`, plus `[a, b]`
flow lists for `tags` and `tools`. **Every key is optional**: `name` defaults to
the file/folder name, `description` to the first non-empty line of the body.

```markdown
---
name: refund_policy
description: When a refund is owed, and how much.
version: 2.0.0
tags: [billing, policy]
tools: [issue_refund]
---

A parcel counts as late once it passes its promised delivery date by 48 hours.

- **48h to 7 days late** — apologise, confirm the parcel is still moving, and
  refund the shipping fee. Do not refund the goods.
- **More than 7 days late** — treat the parcel as lost. Offer a replacement at
  no cost, or a full refund, whichever the customer prefers.

Never give a new delivery date. Say "still in transit" instead.
```

**The `description` is the routing key.** It is the only thing the model sees
before deciding to load the skill. Write it as the _condition under which this
skill is needed_, not as a title:

| Bad                         | Good                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `description: Refunds`      | `description: When a refund is owed, and how much.`                                  |
| `description: Water policy` | `description: Escape of water from plumbing and tanks — and the freezing exclusion.` |

**`tools:` in frontmatter** names skill-owned tools. They are declared to the
provider from turn 0 (the schema never changes) but **refuse to execute** until
the skill is active. This is how a tool can be gated without breaking the cache.

Use a folder skill when the content needs companions — a CSV rate table, an
example letter, a JSON schema. Siblings become `resources` the model can read.

### 3.5 Tools (TypeScript)

Config can _name_ things; it cannot _contain_ code. `ProjectOptions.tools` is the
seam.

```ts
import { tool } from 'zenera-neo';

export const policyLookup = tool<{ reference: string }>({
    name: 'policy_lookup',
    description: 'Looks up a policy by its NM- claim reference.',
    parameters: {
        type: 'object',
        properties: {
            reference: { type: 'string', description: 'NM- followed by six digits' },
        },
        required: ['reference'],
        additionalProperties: false,
    },
    execute: ({ reference }) => POLICIES[reference] ?? { error: 'no such policy', reference },
});
```

Rules:

- **`snake_case` names**, verb-first: `policy_lookup`, `issue_refund`,
  `search_orders`. The name is read by the model far more often than by you.
- **`description` is a prompt.** Say when to call it and what comes back, not how
  it is implemented.
- **`additionalProperties: false` and explicit `required`** — always. Loose
  schemas produce hallucinated parameters.
- **Errors are data, not exceptions.** Return `{ error: '…', … }` so the model
  can recover; throw only for programmer error.
- **Flat parameters.** Deeply nested objects are filled in wrong.
- **Idempotent where possible**, because retries and replays happen.
- **Never accept a secret as a parameter.** Credentials come from the environment.
- **Give a related set a `group:`** — `tool({ name: 'search_orders', group: 'orders', … })`
  — so `agents.yaml` can name the set instead of counting its members (§3.6).
- One tool per file under `src/tools/`, re-exported from `src/tools/index.ts`.

### 3.6 The workspace tools (`workspace:*`)

`zen run` builds one tool set for you: the **workspace** group, rooted at the
session's workspace directory. It is the only thing passed to `loadProject`, so
an agent whose `tools:` does not name them cannot see a file at all.

| Tool          | What it does                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| `read_file`   | Reads text; `start_line`/`end_line` for a range. Reports total lines and if it truncated |
| `list_dir`    | Entries with kind, format (text/binary/image/…), size, and line count for text           |
| `find_files`  | Paths containing a substring, case-insensitive                                           |
| `write_file`  | Creates or overwrites a whole file, making parent directories                            |
| `apply_patch` | Edits by surrounding context rather than line numbers; several files atomically          |
| `move_file`   | Moves or renames; refuses to clobber without `overwrite`                                 |
| `delete_file` | Deletes; a directory needs `recursive`                                                   |

Every path is resolved through one containment gate — symlinks followed, then
checked — so nothing outside the workspace root is reachable. Reads are capped
and listings bounded, so no single call can flood the context.

**Selecting them.** A `tools:` entry is a selector, not only a name:

| Selector      | Selects                                           |
| ------------- | ------------------------------------------------- |
| `read_file`   | that one tool                                     |
| `workspace:*` | every tool in the group                           |
| `'*'`         | everything the host passed to `loadProject`       |
| `-<any>`      | removes what it matches from the selection so far |

```yaml
agents:
    - name: editor
      tools: [workspace:*]

    - name: reviewer
      # Everything except the four that can change something.
      tools: [workspace:*, -write_file, -apply_patch, -move_file, -delete_file]
```

Selectors apply in the order written, so a `-` line reads as an exception to the
line above it. Quote a lone `'*'`: unquoted, YAML reads it as an alias and
refuses the file. `workspace:*` needs no quoting. There is no name globbing —
`read_*` is an unknown tool, because a selector should track a declared set, not
a naming habit.

`zen run --read-only` withholds the four mutating tools whatever `agents.yaml`
asks for: the deployment overriding the repository, as everywhere else.

**Prompting for them.** Three lines earn their place in any prompt that grants
this group:

- Read before editing — `apply_patch` matches on exact text, so a patch built
  from memory fails.
- Prefer `apply_patch` to `write_file` for an existing file. Rewriting a file to
  change one line costs the whole file in output tokens and loses everything the
  model did not think to repeat.
- `list_dir` before guessing a path; `find_files` when the name is known but the
  location is not.

### 3.7 The host (`src/main.ts`)

```ts
import { loadProject } from 'zenera-neo';
import { tools } from './tools/index.ts';

const project = await loadProject('.', { tools });

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    if (ev.type === 'text_delta') process.stdout.write(ev.text);
}
```

`loadProject` reads **every** file the project will ever need, up front. A
missing prompt, an unknown tool name, a handoff to nobody — all fail at load with
the offending key named, rather than surfacing three turns into production.

`AgentProject` is immutable and therefore shareable: load once per process, let
every chat use the same instance. Per-conversation data reaches tools through
`RunOptions.context`, never through the project.

`ProjectOptions` — the override seam. **Host options always win**; a repository
describes intent, a deployment overrides it:

| Option                 | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `tools`                | Tool implementations by name (agent `tools:` and skill `tools:`)      |
| `providers` / `models` | Merged **over** the YAML — repoint a key or an alias without a commit |
| `registry`             | An existing `ModelRegistry`, to share clients across projects         |
| `memory` / `payloads`  | Stores handed to the runner                                           |
| `skills`               | Extra `SkillProvider`s, appended to the project's own                 |

A host that wants the workspace tools asks for them — they are not wired in by
default, because what an agent may touch is a deployment decision:

```ts
import { loadProject, workspaceTools } from 'zenera-neo';

const project = await loadProject('.', {
    tools: [...workspaceTools({ root: '/srv/sandbox' }), ...tools],
});
```

### 3.8 `.env`

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_APPLICATION_CREDENTIALS=./.keys/vertex.json
```

Never commit. Never inline a key into `agents.yaml` — use `${VAR}`. Never print a
key in a log line, a test fixture, or a chat message.

---

## 4. Writing prompts

### 4.1 Composition order

```
1. AGENTS.md              (shared, once, all agents)
2. agents/prompts/<n>.md  (this agent)
3. skill index            (rendered by the runtime — do not hand-write it)
4. preloaded skills       (activated before the first call)
```

Never duplicate `AGENTS.md` content into an agent prompt; never hand-render a
list of skills into a prompt (the runtime does it, and a hand-written one goes
stale silently).

### 4.2 Rules

1. **Second person, imperative, present tense.** "Call `policy_lookup` with the
   reference." Not "The agent should be able to look up policies."
2. **Name things literally.** Tools in backticks by their exact name; agents by
   their exact `name:`. The model matches strings.
3. **State the boundary and the reason.** "Do not quote coverage rules — you do
   not have them." A prohibition without a reason gets rationalised away.
4. **Prefer prohibitions that are specific.** "Never say 'approved'" beats "be
   careful about commitments".
5. **Give the shape of the output, not a template to fill.** "Three short
   paragraphs: what happened, what the policy says, what happens next."
6. **State the failure path.** What to do when the tool errors, the reference is
   missing, the case does not fit. Unstated failure modes get invented.
7. **One instruction per line.** Contradictions become visible when they are
   adjacent.
8. **No meta-talk.** Do not explain the runtime, the trajectory, tokens, or that
   it is an AI. That is context the model must pay for and cannot act on.
9. **No hedging.** "Try to", "if possible", "generally" are read as permission
   to skip.
10. **Facts do not belong in prompts.** A number, a rate, a policy clause belongs
    in a skill (changeable, versioned, loaded when relevant) or a tool
    (authoritative, computed). A prompt that must be edited to change a fee is
    mis-factored.

### 4.3 Voice

Write like a competent colleague briefing a new hire on their first day: short
sentences, concrete nouns, the reason behind each rule. The model mirrors the
register it is given — a prompt written in bureaucratic hedging produces
bureaucratic hedging.

### 4.4 Debugging a prompt

When behaviour is wrong, in this order:

1. **Read the actual assembled prompt**, not the file. Use the inspect report.
2. Is the instruction _present_? (Missed skill load, wrong agent, compaction.)
3. Is it _contradicted_ by `AGENTS.md` or a skill? Adjacent contradictions win
   over distant ones; later text usually wins over earlier.
4. Is it _specific enough to be checkable_? Rewrite as a testable assertion.
5. Only then consider a stronger model.

Changing the model to fix an instruction-following bug hides the bug and pays for
it forever.

---

## 5. Context engineering

### 5.1 Progressive disclosure

The decision for every piece of knowledge:

| Where               | Cost                    | Use when                                              |
| ------------------- | ----------------------- | ----------------------------------------------------- |
| `AGENTS.md`         | every call, every agent | true always, for everyone                             |
| agent prompt        | every call, one agent   | true always, for this job                             |
| **preloaded skill** | every call, one agent   | always needed, but versioned/shared separately        |
| **indexed skill**   | one line until loaded   | needed _sometimes_, model can tell when from one line |
| **searched skill**  | nothing until searched  | catalog too large to index (>~30 entries)             |
| **tool**            | schema only             | needs live data, exact arithmetic, or a side effect   |
| **memory**          | recall block when hit   | learned across runs, not authored                     |

### 5.2 Skill bindings

```yaml
agents:
    - name: adjuster
      skills:
          provider: project # which catalog; defaults to the sole one
          discovery: index # index | search | none
          allow: [water_damage, storm_damage, house_style] # restrict the catalog
          preload: [house_style] # active before the first call
          maxIndexEntries: 20 # cap the rendered index
```

- **`index`** — names and descriptions rendered into the system prompt. The
  default and right answer for most catalogs.
- **`search`** — no index, only a `skill_search` tool. For catalogs too large to
  render.
- **`none`** — preloads only.
- **`preload`** — for content there is no case for the model to decline: house
  tone, a formatting contract. Making it choose is a wasted round trip.
  Preloaded skills are filtered _out_ of the rendered index, and their activation
  lands at the head of the transcript, inside the cached prefix.
- **`allow`** — how one catalog serves several agents without each seeing all of
  it. A `preload` entry must also be in `allow`.

### 5.3 Memory

Memory is the read-write twin of skills: written by the run, not authored. A
**scope** is a namespace string; agents naming the same scope share memory.

```ts
memory: [
    {
        store: 'main',
        scope: 'user:${ctx.userId}',
        access: 'read-write',
        autoRecall: { query: 'last_user_input', limit: 5 },
    },
    { store: 'main', scope: 'org:policies', access: 'read' },
];
```

- **Private** — omit `memory`, or bind `agent:<name>` (the default scope).
- **Shared team memory** — several agents bind `scope: 'team:support'`.
- **Read-only common knowledge** — bind with `access: 'read'`; a separate curator
  agent holds `read-write`.
- **Per-user** — build the scope from run context; the resolved value is recorded
  in the trajectory, so a resumed run cannot drift into another user's space.

`autoRecall` injects top-k matches before each call — this is what makes memory
work without the model remembering to look. Explicit `memory_search` /
`memory_write` / `memory_update` / `memory_delete` tools are injected for
writable bindings.

Do not use memory as a database. It is for things learned that should persist;
anything authoritative belongs behind a tool.

### 5.4 Cache discipline

Rules that follow directly from "stable prefix = cache hit":

- Do not reorder `agents.yaml` for cosmetic reasons — tool order is prompt order.
- Do not put timestamps, run ids, or "today is …" in `AGENTS.md` or a prompt.
  A changing prefix is a permanent cache miss. Put volatile facts in a tool
  result.
- Prefer `preload` over an instruction telling the model to load a skill first.
- Keep the volatile half of an instruction in the agent prompt and the stable
  half in `AGENTS.md`, not the reverse.

---

## 6. Organising agents

### 6.1 When to split

Split into a second agent when at least one is true:

- The two jobs want **different models** (a cheap router, a careful writer).
- The two jobs want **different tools**, and giving both to one agent invites
  misuse.
- The two jobs want **contradictory instructions** ("be exhaustive" vs "be brief").
- One job needs a **large knowledge slice** the other never touches.
- The boundary is a real **handoff in the business process** ("passed to an
  adjuster").

Do **not** split because:

- The prompt got long — split it into skills instead.
- It feels tidier — every handoff costs a full re-render of the system prompt and
  a fresh cache prefix.
- You want "a planner and an executor" with no distinct tools or models — that is
  one agent with a numbered procedure.

**Start with one agent. Add the second when a specific case forces it.**

### 6.2 Patterns

**Router + specialists.** A cheap, fast agent whose only job is classification
and handoff. Its prompt is short, it holds few tools, and it must be forbidden
from answering. Specialists never hand back to it.

```yaml
agents:
    - { name: intake, model: router, handoffs: [billing, technical, escalation] }
    - { name: billing, model: balanced, skills: { allow: [refund_policy, invoicing] } }
    - { name: technical, model: balanced, tools: [search_logs, restart_service] }
    - { name: escalation, model: careful }
```

**Pipeline.** Fixed stages, each handing to the next; only the last answers the
user. Encode the order in `handoffs:` so a stage cannot skip ahead.

**Fan-out / join.** For independent parallel work — ten regions, four review
lenses, six candidate suppliers — declare `fork:` on the agent that owns the
work and let the model split it. See §6.4.

**Single agent + rich catalog.** One agent, `discovery: index`, twenty skills.
Cheapest to run, cheapest to reason about, and correct far more often than the
multi-agent instinct suggests.

### 6.3 Handoffs

- `description:` on the target agent is what the model reads when deciding.
  Write it as a routing condition: _"Applies the written peril policies to a
  claim and explains the outcome."_ — not _"The adjuster agent."_
- Handoffs are bare name strings; there is no per-edge configuration.
- Self-handoff is a load error. Cycles are legal but usually a bug — a router in
  the `handoffs` of its own specialists produces ping-pong.
- Handoff collapses history by policy: the receiving agent sees a selection, not
  the full transcript. Do not assume it saw a detail three turns back; if it
  matters, put it in the handoff.

### 6.4 Forking (fan-out / join)

Forking is **opt-in per agent**. Without the key the agent is never offered the
`fork` tool and cannot split, however obviously parallel the work looks:

```yaml
agents:
    - name: trunk
      fork: true # unrestricted: any agent, any number of branches

    - name: sweep
      fork:
          agents: [prober] # every branch runs the specialist
          maxBranches: 6
```

| Field         | Default              | Meaning                               |
| ------------- | -------------------- | ------------------------------------- |
| `agents`      | every declared agent | Which agents a branch may run         |
| `maxBranches` | unlimited            | Cap on branches per call; minimum `2` |

The **model** decides the split: it names N branches, each with self-contained
instructions. They run truly concurrently and rejoin as **one tool call and one
tool result** in the parent's history — so N branches cost the parent
O(N × summary), not O(N × full history).

Rules worth knowing before you write the key:

- `agents:` **may include the forking agent itself** — unlike `handoffs:`, that
  is not an error, and one role fanned out over ten items is the common shape.
  The list reaches the model as an `enum`, so a name outside it cannot even be
  decoded.
- A fork always needs **at least two** branches. A one-branch call is refused
  with a message telling the model to do the work itself instead.
- **Branches cannot talk to each other.** If branch B needs branch A's answer,
  it is a sequence, not a fork — keep it in one conversation.
- Nesting is capped by the run's `maxForkDepth` (2 by default), so a branch may
  fork again but not without bound.
- Fork vs handoff: a handoff is _one_ conversation changing owner; a fork is the
  _same_ question asked N times at once and merged.

Choose `context:` deliberately — the model sets it per call, so say in the
agent's prompt which one this work wants:

- `inherit` — branch gets the full prefix. For work that depends on the case.
- `compact` — prefix minus tool calls, tool results and recalls: _what was
  decided_, not the raw noise. **The default for wide fan-outs.**
- `none` — system prompt plus instructions only. Cheapest; for independent
  lookups.

Declaring `fork:` only makes the tool available. Say in the agent's prompt when
to reach for it, in the terms of this domain — _"When the request covers more
than one region, fork one branch per region and merge their findings"_ — or a
weaker model will work through the list serially and never call it.

### 6.5 Termination

- **Untyped run**: the model replies with no tool calls → that text is the answer.
- **Typed run**: pass a Zod `output` schema; a synthetic `final_output` tool is
  added and the run ends when it validates. Parse failures come back as an error
  result so the model can repair its own output.

There is no `maxTurns`. Runaway protection is the host's job (wall-clock or token
budget), not a hidden turn counter.

---

## 7. Model selection

### 7.1 Tiers

Think in three tiers, and give them **role names, not vendor names** — so the
mapping changes in one place.

| Alias      | Role                                                        | Reasoning      |
| ---------- | ----------------------------------------------------------- | -------------- |
| `router`   | Classify, extract, route, validate. High volume, low stakes | minimal / none |
| `balanced` | The default worker: apply written rules, use tools, answer  | low / medium   |
| `careful`  | Ambiguity, multi-step planning, anything a human will sign  | high           |

Add `writer` only if tone matters enough to justify a separate model.

### 7.2 Worked example

```yaml
providers:
    # `vertex` needs no key: the GenAI SDK resolves Application Default
    # Credentials itself. Declared here only to pin the region.
    vertex-eu:
        kind: vertex
        location: europe-west4
    claude:
        kind: anthropic
        apiKey: ${ANTHROPIC_API_KEY}

models:
    router:
        provider: vertex-eu
        model: gemini-3.5-flash-lite
        thinkingLevel: minimal
    balanced:
        provider: vertex-eu
        model: gemini-3.5-flash
        thinkingLevel: high
    careful:
        provider: openai
        api: responses
        model: gpt-5.4-mini
        reasoningEffort: high
        reasoningSummary: auto # so the reasoning is visible while it works
    writer:
        provider: claude
        model: claude-sonnet-4-5
        maxTokens: 16000

model: balanced # fallback for agents that do not pin their own

agents:
    - { name: intake, model: router, handoffs: [adjuster] }
    - { name: adjuster, model: balanced, handoffs: [escalation] }
    - { name: escalation, model: careful }
```

### 7.3 Shorthand

```
[provider[/api]:]model
```

`gpt-4o` · `openai:gpt-4o` · `openai/responses:o3` · `vertex:gemini-3.5-flash`

Only the **first** colon separates, so a fine-tuned id must name its provider:
`openai:ft:gpt-4o:acme::a1b2`. The first segment is a provider _name_, not a
vendor. Anything the shorthand cannot express (keys, base urls, reasoning knobs)
needs the object form.

Resolution order for any `model:` value: host `ProjectOptions.models` → this
file's `models:` → the shorthand parser. Results are memoized, so two agents
naming `balanced` share one model over one client.

### 7.4 Vendor knobs

| Field                  | Applies to        | Notes                                                                   |
| ---------------------- | ----------------- | ----------------------------------------------------------------------- |
| `reasoningEffort`      | openai            | Free string on purpose — the API is the authority on validity           |
| `reasoningSummary`     | openai            | `auto` \| `concise` \| `detailed`. **Needs `api: responses`** — §7.5    |
| `maxTokens`            | anthropic, gemini | Anthropic **requires** one (default 8192) and bills thinking against it |
| `thinkingBudgetTokens` | anthropic         | Extended thinking budget                                                |
| `thinkingBudget`       | gemini 2.5        | Tokens: `0` off, `-1` auto                                              |
| `thinkingLevel`        | gemini 3          | `minimal` \| `low` \| `medium` \| `high`                                |
| `includeThoughts`      | gemini            | Thought summaries; default `true`                                       |

Knobs that do not apply to the chosen vendor are ignored, not rejected.
`api:` exists only for the OpenAI protocol — naming it on a Gemini or Anthropic
model is an error.

Each vendor's own SDK is used rather than its OpenAI-compatible endpoint, because
those endpoints drop exactly what this runtime is built on: thinking budgets,
thought signatures, cache accounting. `openai-compatible` is the shim kind — vLLM,
OpenRouter, a gateway.

### 7.5 Turning reasoning on

Ask two separate questions: does the model **reason**, and does it **say what it
reasoned**. They are different knobs, and the second is off by default on every
vendor except Gemini — which is why a reasoning model can burn thousands of
thinking tokens while the CLI shows no progress at all.

**OpenAI** — reasoning text only exists on the **responses** API, and only as a
summary. `api: responses` is therefore not optional here: on chat completions
there is nothing to stream.

```yaml
models:
    default:
        provider: openai
        api: responses # required — chat completions exposes no reasoning
        model: gpt-5.4-nano
        reasoningEffort: medium # how hard it thinks
        reasoningSummary: auto # whether you get to see it
```

**Anthropic** — `thinkingBudgetTokens` turns extended thinking on, and it is
billed against `maxTokens`, so raise that too. Read §7.6 first: this combination
is unsafe for tool-using agents.

```yaml
models:
    careful:
        provider: anthropic
        model: claude-sonnet-4-5
        maxTokens: 16000
        thinkingBudgetTokens: 8000
```

**Gemini** — thought summaries are on by default (`includeThoughts: true`); what
varies is the budget. Gemini 3 takes `thinkingLevel`, Gemini 2.5 takes
`thinkingBudget` in tokens.

```yaml
models:
    balanced:
        provider: vertex
        model: gemini-3.5-flash
        thinkingLevel: high
```

What this buys, in both views: `zen run` in the TUI streams the reasoning as a dim
running tail above the answer, and the one-shot path prints it under `--live`.
The full chain is kept in the trajectory either way and is in the inspect report,
so turning summaries off costs visibility, not the audit trail.

The cost is real — a summary is extra output tokens on every call — so leave it
on where someone is watching and reach for a cheaper tier before turning effort
up (§7.7).

### 7.6 Known traps

- **Anthropic + `thinkingBudgetTokens` + multi-turn tool use** — thinking-block
  signatures are not replayed, and the API rejects the follow-up. Leave extended
  thinking off for tool-using agents.
- **`reasoningEffort: minimal`** is rejected by the `gpt-5.4-*` family; use `low`.
- **Vertex** needs a project id, resolved from `project:` → `GOOGLE_CLOUD_PROJECT`
  → the `project_id` inside the key file named by `GOOGLE_APPLICATION_CREDENTIALS`.
  gcloud user credentials and metadata-server credentials carry no project id, so
  those deployments must set the variable.

### 7.7 How to choose, in practice

1. Start every agent on `balanced`.
2. Demote to `router` any agent whose job is classification, extraction, or a
   fixed handoff — measure, do not guess.
3. Promote to `careful` only after seeing a concrete failure that a stronger
   model actually fixes.
4. Never fix an instruction-following bug with a model upgrade (§4.4).
5. Raise reasoning effort before switching model families: it is a smaller,
   reversible change.

---

## 8. Evaluating changes

There is no compiler for prose. Substitutes, in order of value:

1. **Load the project.** Most structural mistakes are load errors — run the host
   or the test that calls `loadProject`.
2. **Run the case that motivated the change**, plus one that must _not_ change.
3. **Read the inspect report** — it shows the assembled prompt, every request and
   response, tool calls, skill activations and cost. Behaviour questions are
   answered there, not by re-reading the YAML.
4. **Keep a `test/` file that asserts wiring**: entry agent, handoff graph, which
   tools an agent holds, that every skill has a description. Cheap, and it catches
   the rename that silently unlinked a handoff.
5. **Watch the token accounting.** A change that doubles prefix size is a
   regression even if the answer improved.

CLI (`zen --help` for the authoritative list): `zen init`, `zen run`, `zen inspect`,
`zen models`, `zen key`, `zen list`. **stdout is the answer, stderr is the
narration**; every command takes `--json`. Exit codes: `0` ok, `1` failed,
`2` usage, `3` invalid project, `4` no usable credential.

---

## 9. Review checklist

Before finishing any change here:

**Structure**

- [ ] `agents.yaml` still loads; no unknown keys, no dangling names
- [ ] Top-level `default:` names the entry agent explicitly
- [ ] Every agent has a `description:` written as a routing condition
- [ ] No self-handoff; no accidental cycle back to the router
- [ ] Names match `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`
- [ ] An agent expected to fan out has `fork:`, and its prompt says when to use it

**Prompts**

- [ ] Nothing duplicated between `AGENTS.md` and an agent prompt
- [ ] Every tool and agent referenced by its exact name
- [ ] Failure paths stated for every instruction that can fail
- [ ] No facts, rates or figures embedded in a prompt
- [ ] No hedging, no meta-talk about the runtime

**Skills**

- [ ] Every skill has a `description` that says _when it is needed_
- [ ] `preload` is reserved for content the model would never decline
- [ ] `preload` entries also appear in `allow` where `allow` is used
- [ ] Catalog >~30 entries → `discovery: search`

**Tools**

- [ ] `snake_case`, verb-first, description written for the model
- [ ] `additionalProperties: false`, explicit `required`
- [ ] Errors returned as data, not thrown
- [ ] No secrets in parameters
- [ ] An agent that only reads is not holding `write_file`, `apply_patch`,
      `move_file` or `delete_file` — subtract them from `workspace:*`

**Models**

- [ ] Aliases are role names, not vendor names
- [ ] Vendor knobs valid for the chosen vendor (no `api:` on gemini/anthropic)
- [ ] No agent silently on the fallback `model:` when it needed a specific tier

**Cache and cost**

- [ ] No timestamps or run-specific text in the prefix
- [ ] Prefix growth is intentional and worth it

**Secrets**

- [ ] No key literal in YAML, source, test or log — `${VAR}` only
- [ ] `.env` is git-ignored

---

## 10. Where to change what

| Symptom                                    | Change this                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| Wrong tone, wrong format, wrong length     | `AGENTS.md` (all agents) or the agent prompt          |
| Says something forbidden                   | `AGENTS.md` prohibition, stated specifically          |
| Ignores a rule that only applies sometimes | Move the rule into a skill with a sharp description   |
| Never loads the skill it should            | The skill's `description`; or `preload` it            |
| Loads too much, answers slowly             | `allow:`, `maxIndexEntries:`, or `discovery: search`  |
| Invents a number                           | A tool; plus a prompt line naming the tool            |
| Rewrites a whole file to change one line   | A prompt line preferring `apply_patch` — §3.6         |
| Edits files it should only be reading      | Subtract the mutating tools, or `zen run --read-only` |
| Answers instead of routing                 | Router prompt prohibition; check `handoffs:`          |
| Routes to the wrong specialist             | The target agents' `description:` fields              |
| Loses a detail after a handoff             | Say it in the handoff; check the collapse policy      |
| Works through N independent items serially | `fork:` on that agent, and a prompt line — §6.4       |
| Forks when the steps actually depend       | Prompt line: branches cannot see each other           |
| Slow and expensive on trivial cases        | Demote that agent's model tier / reasoning effort     |
| Fails only on genuinely hard cases         | Promote that agent's tier, or split the hard path out |
| Shows no reasoning while it works          | Turn summaries on for that model — §7.5               |
| Forgets across conversations               | A memory binding with `autoRecall`                    |
| Breaks at load with a named path           | Read the message — it names the exact key             |

---

## 11. Anti-patterns

- **The mega-prompt.** 300 lines covering twelve scenarios. Split into skills.
- **Agent sprawl.** Eight agents that share one model, one tool set and one
  prompt style. Collapse into one with a catalog.
- **Facts in prompts.** A fee schedule inside `AGENTS.md`. It cannot be versioned,
  cannot be shared, and is paid for on every call.
- **Politeness padding.** "Please try your best to be helpful." Costs tokens,
  changes nothing.
- **Fixing prompts with models.** See §4.4.
- **The chatty router.** A router that answers before handing off, because its
  prompt never forbade it.
- **Ping-pong handoffs.** Specialists that hand back to the router, which hands
  back to a specialist.
- **Forking a chain.** Branches never see each other, so a fork whose second
  branch needs the first branch's answer is a sequence wearing a fork's clothes.
- **Tools that throw.** An exception ends the branch; an error object lets the
  model recover.
- **Volatile prefix.** "Current date: …" in `AGENTS.md`. Permanent cache miss.
- **Late tool schemas.** Anything that changes the declared tool set mid-run.

---

## 12. Maintaining this file

This file is loaded on every request in this repository, so it is subject to its
own rules: stable, factual, no hedging.

Update it when:

- the layout changes (a new directory, a moved catalog)
- a model alias is added, retired or repointed — §7.2 must match `agents.yaml`
- a vendor trap is discovered — add it to §7.6
- a recurring review comment appears twice — turn it into a checklist line in §9
- a runtime capability is added — describe it here, or it will not be used

Do not let it grow without pruning. When a section is only true of one agent, it
belongs in that agent's prompt, not here.
