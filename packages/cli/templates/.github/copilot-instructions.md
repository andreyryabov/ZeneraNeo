# Copilot instructions — agent projects

> Written by `zen init` into `.github/copilot-instructions.md`, alongside the
> prompt files and skills in the same tree (§2.4). VS Code loads it
> automatically for every request in this folder, so it is the standing brief
> for anyone — human or agent — editing this project.
>
> It describes the Zenera Neo runtime, not this particular project, and `zen`
> rewrites the whole tree on `init` and `open` — so put this project's own
> conventions in `INSTRUCTIONS.md`, where they will survive. The runtime's own
> reference is `docs/agents-yaml.md`, `docs/projects.md` and `DESIGN.md` in the
> @zenera/neo repository — where they disagree with this file, they win.

---

## 0. What this repository is

This is **not a normal application repository**. There is no application code
here. It is a folder of declarative artefacts — YAML and Markdown — that
assemble into a running multi-agent system, driven by the `zen` CLI.

The centre of gravity is **prose**. Every valuable change here is an edit to a
prompt, a skill, or one line of `agents.yaml`. Behaviour is configured, not
programmed: what an agent knows, which model answers, and which of the tools
`zen run` provides it may reach for.

**Default posture when working in this repo:**

1. Find which artefact owns the behaviour before editing anything (§10).
2. Prefer editing a prompt or skill over adding an agent.
3. Prefer adding a skill over lengthening a prompt.
4. Prefer granting a tool over asking the model to compute or remember.
5. Never add an agent to solve a problem that is really a prompt problem.
6. Every change must still load: `agents.yaml` is validated strictly at load,
   and `zen check` says so before a model is ever called.

---

## 1. Mental model

### 1.1 What an agent actually is

An agent is four things and nothing more:

| Part            | Where it lives                                 | What it decides               |
| --------------- | ---------------------------------------------- | ----------------------------- |
| **Instruction** | `INSTRUCTIONS.md` + `agents/prompts/<name>.md` | How it behaves                |
| **Model**       | `agents.yaml` → `model:`                       | How well and how expensively  |
| **Tools**       | `agents.yaml` → `tools:`                       | What it can _do_              |
| **Knowledge**   | `agents/skills/*` + memory                     | What it can _know_, on demand |

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
│ INSTRUCTIONS.md       shared by all agents  │  ← stable, cacheable
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
├── .github/                      the editor's brief — §2.4
│   ├── copilot-instructions.md   this file
│   ├── prompts/*.prompt.md       tasks you invoke by name
│   └── skills/*/SKILL.md         reference the editor loads on demand
├── .env                          credentials — NEVER committed
├── INSTRUCTIONS.md               house rules, prepended to every agent
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
└── sessions/                     run state, memory, whatever the agent wrote
```

Only `agents.yaml` is required, and only `agents:` is required inside it.
The config is found by name, in order: `agents.yaml`, `agents.yml`,
`agents/agents.yaml`, `agents/agents.yml`.

### 2.2 Variants

**Single agent, knowledge-heavy** — the most under-used shape. One agent, one
prompt, a large skill catalog. Prefer this until routing is genuinely needed.

```
INSTRUCTIONS.md · agents.yaml · agents/prompts/assistant.md · agents/skills/**  (20 skills)
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

### 2.4 The two audiences

There are two sets of instructions in this repository and they are not for the
same reader. Keeping them apart is the single easiest thing to get wrong.

| Tree                         | Read by                                    | About                               |
| ---------------------------- | ------------------------------------------ | ----------------------------------- |
| `INSTRUCTIONS.md`, `agents/` | the **project's** agents, at run time      | the domain this system works in     |
| `.github/`                   | the **editor's** assistant, while you edit | how a project of this kind is built |

The `.github/` tree follows the same progressive-disclosure discipline the
agents do, for the same reason — it is a prefix somebody pays for:

- **`copilot-instructions.md`** is always on. Everything in it is loaded for
  every request in this folder, so it holds only what is true of every task.
- **`.github/skills/<name>/SKILL.md`** is reference the editor loads when its
  `description` matches what you asked. Put long, occasional material here —
  a command surface, a vendor's quirks, a format spec — not in the file above.
  The `description` is the routing key; §3.4 applies to these as much as to the
  project's own skills.
- **`.github/prompts/<name>.prompt.md`** is a task you invoke by name (`/name`),
  with `mode: agent` and a `description` in its frontmatter. Write one when a
  job is done repeatedly and has a right order — adding an agent, adding a
  skill, reviewing before a commit.

`zen init` and `zen open` rewrite this whole tree from the version of `zen` in
hand, so **edits inside `.github/` do not survive**. Project-specific conventions
belong in `INSTRUCTIONS.md` and the agent prompts, which are never overwritten.

---

## 3. File formats

### 3.1 `agents.yaml`

The schema is **strict**: an unknown key is a load error, not a value silently
ignored. Errors name the path — `agents.yaml: agents[1].skills.discovery — …`.

```yaml
version: 1 # schema version, defaults to 1
default: intake # entry agent; wins over any `default: true`

providers: {} # named connections (credentials + endpoint)
provider: openai # the provider an unprefixed model id belongs to — §7.3
models: {} # named model configurations
model: fast # fallback for agents that do not pin their own
embeddings: {} # named vectorisers — §3.1.1
embedding: small # the one `AgentProject.embedder()` returns when asked for no name
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

| Field         | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `name`        | **Required.** See §2.3                                                               |
| `description` | What a sibling's `transfer_to_<name>` tool tells the model. Write it _for the model_ |
| `system`      | Prompt path, relative to root. Defaults to `agents/prompts/<name>.md` if present     |
| `model`       | A `models:` alias or shorthand. Falls back to top-level `model:`                     |
| `tools`       | Selectors over the tools `zen run` provides — see §3.6                               |
| `handoffs`    | Agent names this one may transfer to. Bare strings; no per-edge config               |
| `skills`      | Skill binding — see §5.2                                                             |
| `fork`        | `true`, or `{ agents, maxBranches }` — opt-in to parallel branches; see §6.4         |
| `default`     | `true` marks the entry point when no top-level `default:`                            |

**Providers** — a provider is a _connection_, not a model. One client is built
per name and shared, so five agents on one key open one connection pool.

| Field                     | Meaning                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `kind`                    | `openai` \| `google` \| `vertex` \| `anthropic` \| `openrouter` \| `openai-compatible` (default `openai`) |
| `apiKey` / `apiKeyEnv`    | Literal, `${VAR}`, or the name of the env var holding it                                                  |
| `baseURL` / `baseURLEnv`  | For gateways and compatible endpoints                                                                     |
| `project` / `location`    | **vertex only** — GCP project id and region (or `global`)                                                 |
| `headers`                 | Sent on every request: routing, attribution, api versions                                                 |
| `timeoutMs`, `maxRetries` | Per-request timeout and retry count                                                                       |

`openai`, `google`, `vertex`, `anthropic`, `openrouter` and `openai-compatible`
are usable as provider _names_ with no declaration at all. Declare a
`providers:` entry only when it says something the default does not — a second
key, a region, a base url.

`${VAR}` and `${VAR:-fallback}` expand from the environment, compose inside
longer values (`https://${GATEWAY}/v1`), and are **lazy**: a declared-but-unused
provider with a missing key does not fail loading.

**Errors caught at load** — rely on these instead of defensive checks:

- any unknown key; any name breaking the pattern
- `models.<alias>.provider` naming an undeclared provider
- `embeddings.<alias>.provider` naming an undeclared provider
- `agents[].tools` naming a tool the runtime does not provide, or a group with nothing in it
- `agents[].handoffs` naming an unknown agent, or the agent itself
- `agents[].skills.provider` / `.allow` / `.preload` naming something absent
- a `preload:` entry missing from `allow:`
- `agents[].fork.agents` naming an unknown agent, or being empty; `maxBranches` below 2
- `system:` pointing at a missing file, or outside the project root

**Not caught at load** — a model id whose prefix is missing and so resolves to the
wrong provider (§7.3), and any combination of knobs the vendor rejects at request
time, such as OpenAI reasoning on chat completions (§7.6). Both surface on the
first call, so read §7 before writing a `models:` entry.

**Comments in `agents.yaml`** — this file is the architecture diagram of the
project, and its comments are read by whoever has to change it next. Write them
at that level:

- Say **what a block is for** and **why it exists**: what this agent owns, why
  this one is on the deep tier, why this handoff edge is there.
- Keep them **short** — one line above a block, a few words at the end of a line.
  A comment longer than the thing it describes is a design doc in the wrong file.
- Do **not** restate the runtime. How skills are discovered, how the trajectory
  is appended, how prompt caching works, what the loader validates — none of that
  belongs here. It is documented in this file and in `docs/agents-yaml.md`.
- Do **not** restate the key. `# the model this agent uses` above `model:` is
  noise; `# cheap: it only classifies` is not.
- Do not narrate edits (`# added 2026-08`, `# was gpt-4o`). Git owns that.

```yaml
# Intake classifies and routes; it never answers.
- name: intake
  model: router # cheap tier — one sentence in, one handoff out
  handoffs: [adjuster, escalation]
```

### 3.1.1 `embeddings:`

A vectoriser turns text into a vector, for retrieval rather than for answering.
It resolves through the **same `providers:`**, so a key declared once generates
and embeds without being written twice.

```yaml
providers:
    house:
        apiKey: ${ACME_OPENAI_KEY}

embeddings:
    small: openai:text-embedding-3-small # a shorthand string...
    large: # ...or the object form
        provider: house
        model: text-embedding-3-large
        dimensions: 256

embedding: small
```

| Field                    | Meaning                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `provider`               | A `providers:` name or a built-in kind. Defaults to the default provider |
| `model`                  | **Required.** The bare id — the object form never re-parses a shorthand  |
| `dimensions`             | Truncate to this width, where the model supports it                      |
| `apiKey` / `baseURL` / … | The same credential fields a provider takes, for a one-off connection    |
| `title`                  | **gemini only** — a document title the retrieval task type weighs        |
| `maxBatch`               | **gemini only** — texts per request; see below                           |
| `routing`                | **openrouter only** — which upstream provider serves the request         |

Four things differ from `models:` and are worth knowing before you write one:

- **No `api:` field.** `/v1/responses` has no embeddings endpoint, so naming an
  api means nothing on any protocol. The shorthand is `[provider:]model`.
- **`kind: anthropic` has no embeddings API at all.** Anthropic publishes none
  and points at third parties; an `embeddings:` entry on an Anthropic provider
  fails at load. Use another provider — the connection need not be the one the
  agents talk through.
- **Not a per-agent key.** Nothing in the runtime consumes a vectoriser yet, so
  there is no `agents[].embedding:`. A TypeScript host reaches one with
  `project.embedder()` for the default, or `project.embedder('large')` by name.
- **Vectors come back unit length**, so cosine and dot product agree. This is a
  guarantee of the runtime, not of the vendor: truncating with `dimensions:` is a
  raw slice and only some models rescale afterwards — `gemini-embedding-2` does,
  `gemini-embedding-001` returns |v| ≈ 0.58 at 768 of its 3072. Pass
  `normalize: false` on a call to see what the model actually said.

Google's `embedContent` takes one document per request for every
`gemini-embedding-*` model, and the adapter splits a batch across requests to
hide that. `maxBatch` therefore defaults to `1`; raise it only for a
`text-embedding-*` model, which accepts more.

`zen check` and `zen models` report every declared embedding beside the models,
with the credential each one would need.

### 3.2 `INSTRUCTIONS.md`

House rules, read **once** and prepended to every agent's system prompt. It is
the stable head of the cached prefix, so it should change rarely. The name is
deliberately not `AGENTS.md` — that one belongs to the coding assistant reading
this file, and these rules address the project's own agents.

Put here only what is true for **every** agent:

- identity and domain ("You work the property claims desk")
- non-negotiable prohibitions (regulatory, legal, safety)
- global format and tone constraints
- domain vocabulary and identifier formats

Do **not** put here: anything one agent needs and another does not; anything that
changes weekly; long reference data (that is a skill).

**When writing it, remember what it is: a prefix on every agent's system prompt.**
It is not a README and not a design document — every line is paid for on every
call, by every agent, and each one is an instruction the model will try to
follow. So:

- It is a **prompt**: §4.2 applies in full — second person, imperative, no
  hedging, no meta-talk about the runtime, failure paths stated.
- Carry the **shared model of the project**: what this system is, what the agents
  are collectively for, how the work flows between them, and the vocabulary and
  identifier formats they all use. Enough for any agent to know where it sits;
  not a tour of the codebase.
- Describe the architecture in **one short paragraph or a handful of lines**, in
  terms the agents can act on ("the adjuster owns coverage decisions; you do
  not"), not in terms of files, YAML keys or the runtime.
- Anything only one agent needs goes in that agent's prompt instead. If you find
  yourself writing "if you are the router…", you are in the wrong file.

Target 20–60 lines. If it exceeds ~100, split the stable half out into a
preloaded skill.

### 3.3 `agents/prompts/<name>.md`

Plain Markdown, no frontmatter. This is the agent's _job description_, appended
after `INSTRUCTIONS.md`.

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

Write it as a prompt, under the rules in §4.2 — **instructive and concise**. It
tells one agent what to do; it never explains the system (`INSTRUCTIONS.md`
already did, §3.2), never repeats a house rule, and never describes the runtime.
Every line should be an instruction the model can act on or a boundary it can
check itself against.

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

### 3.5 Tools

A tool is what an agent can _do_ rather than say. `zen run` provides three
groups — the workspace tools (§3.6), the sandbox tools (§3.7) and the web tools
(§3.8) — and `agents.yaml` decides which agent holds which. Nothing else reaches
the machine, so `tools:` is the whole permission model: an agent that does not
name a tool cannot use it, whatever its prompt says.

Two rules follow:

- **Grant the narrowest set the job needs.** An agent that only reviews should
  not be holding the tools that overwrite files.
- **Say in the prompt when to reach for what.** A granted tool the prompt never
  mentions is used at the model's discretion, which is not the same as never.

Skills can own tools too — `tools:` in a skill's frontmatter (§3.4) names tools
that refuse to run until that skill is active.

### 3.6 The workspace tools (`workspace:*`)

`zen run` builds this set for you, rooted at the session's workspace directory.
Nothing else reaches the file system, so an agent whose `tools:` does not name
them cannot see a file at all.

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

Paths are written relative to the root, and `/workspace/...` — the name the same
directory has inside the sandbox (§3.7) — is accepted as well, so a path copied
out of a command's output does not have to be translated first. When a mount is
configured the tools also _report_ that name, so the two toolsets speak one
vocabulary and a path can be passed from either to the other unchanged; with no
container involved there is no second name and everything stays relative.

**Selecting them.** A `tools:` entry is a selector, not only a name:

| Selector      | Selects                                           |
| ------------- | ------------------------------------------------- |
| `read_file`   | that one tool                                     |
| `workspace:*` | every tool in the group                           |
| `'*'`         | every tool the runtime provides                   |
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

### 3.7 The sandbox tools (`sandbox:*`)

The second group `zen run` builds. These run a shell command in a Linux
container with the same workspace mounted at `/workspace`, so an agent can
build, test, install and inspect rather than only read and write.

| Tool                     | What it does                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| `run_command`            | Runs to completion. Returns exit code, stdout, stderr, duration          |
| `run_command_background` | Starts a long process (a server, a watch build) and returns a `job_id`   |
| `read_command_output`    | A window of a job's output from `start_line`, plus whether it still runs |
| `stop_command`           | Signals a job's process group                                            |

The container is the boundary. Nothing inspects the command — there is no
allow-list of binaries and no pattern matching on what the model wrote, because
both are trivially defeated and neither survives a shell. What holds is that
only the workspace and the session's `/home/agent` are mounted, the container
is removed at the end of the session, and the command is never a shell argument
on the host: it travels on stdin to `/bin/sh` inside.

**Configuring it.** A top-level `sandbox:` block in `agents.yaml` describes the
container. Every field has a default, so the block is optional — write only the
lines that differ:

```yaml
sandbox:
    persist: true # recommended — see below
    image: docker.io/library/python:3.14-slim-bookworm # the default
    cpus: 4 # fractional cores
    memory: 4096 # MiB
    network: bridge # `none` for a project that must not reach out
    timeout: 300 # seconds per command
    env: [HTTPS_PROXY, NO_PROXY] # host variables to forward, by NAME
```

| Field     | Default                                       | Meaning                                      |
| --------- | --------------------------------------------- | -------------------------------------------- |
| `image`   | `docker.io/library/python:3.14-slim-bookworm` | The base image commands run in               |
| `cpus`    | the host's                                    | Fractional cores                             |
| `memory`  | the host's                                    | MiB                                          |
| `network` | `bridge`                                      | `bridge` / `none` / `host`                   |
| `workdir` | `/workspace`                                  | Mount point and default cwd                  |
| `timeout` | `120`                                         | Seconds per command                          |
| `user`    | the image's                                   | uid, name, or `uid:gid`                      |
| `persist` | `false` — **set it to `true`**                | Keep the container between runs of a session |
| `env`     | none                                          | Host variables to forward, **names**         |

`env:` takes **names, never values** — a value here would be a secret in the
repository — and anything credential-shaped (`KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `CREDENTIAL`) is refused at load.

Agents share one container, because they share the workspace and a hand-off is
meant to be continuous. An agent that needs something else says so and gets its
own, with its block merged over the top-level one:

```yaml
sandbox:
    image: docker.io/library/python:3.14-slim-bookworm

agents:
    - name: builder
      tools: [workspace:*, sandbox:*]
      sandbox:
          image: docker.io/library/node:22-bookworm-slim
          memory: 8192
    - name: analyst
      tools: [workspace:*, sandbox:*] # shares the project's container
```

**Write `persist: true` unless you have a reason not to.** By default the
container is _removed_ when the session closes, and only two paths survive it:
`/workspace`, and `/home/agent` — which is `$HOME` inside, backed by the session
directory. That covers `pip install --user`, `npm config` and `~/.cache`, but it
does **not** cover the ordinary thing an agent actually does: `pip install X` or
`apt-get install X` as root writes to the container's system paths, and those
are gone on the next `zen run`. The agent then reinstalls, silently, every
single time — and usually does not realise it has, because the previous run's
transcript says it succeeded.

```yaml
sandbox:
    persist: true
```

With it, the container is _stopped_ rather than removed, and the next run of
that session starts the same one back up with everything still installed. The
cost is containers that outlive their sessions — `zen sandbox status` lists them
and `zen sandbox clean` removes them.

Changing any field renames the container, so bumping the image gets a fresh one
rather than an old one quietly persisting with the wrong contents. That is also
the one sharp edge of `persist: true`: a config change abandons the old
container with whatever was installed in it, so a long-lived setup still belongs
in `image:` rather than in an accumulated rootfs.

Granting the group is what makes the project need Podman: `zen run` checks the
engine before the first turn and exits `5` with an install command if it is
missing. `zen sandbox status` answers the same question on its own. Full
reference: `docs/agents-yaml.md`.

**Prompting for them.** Two lines earn their place:

- The workspace is at `/workspace` and is the same directory the file tools
  see — an edit made with `apply_patch` is what a command will compile, and a
  path from either side works on both.
- Anything that does not return, returns — use `run_command_background` for a
  server, not `run_command` with a large timeout.

### 3.8 The web tools (`exa:*`)

The third group `zen run` builds. These reach the live web through
[Exa](https://exa.ai) — a search index built for models rather than for people,
so a query is a sentence describing what is wanted, not a bag of keywords.

| Tool         | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `web_search` | Ranked pages for a described query, each with a short excerpt of why it matched |
| `web_read`   | The readable text of pages, several at once, boilerplate stripped               |
| `web_answer` | A written answer to a question, with the sources it was drawn from              |

The three are meant to be used in that order: **search to find, read to quote.**
An excerpt is enough to judge which source to trust and never enough to cite
from — `web_search` returns the sentences that made a page match, not the page.
`web_answer` runs a search _and_ a model on the other side, so it is the slowest
and dearest of the three; it earns its cost when the answer is a fact spread
over several pages, and wastes it when a specific document is wanted.

```yaml
agents:
    - name: researcher
      tools: [exa:*, workspace:*]

    - name: fact-checker
      # Find and read, but never let a model on the far side do the reasoning.
      tools: [web_search, web_read]
```

**The key.** All three read `$EXA_API_KEY` **when they are called**, not when the
project loads. So a project naming `exa:*` still loads on a machine that has no
key — the tools simply refuse, on the turn that tried, saying which variable is
missing. Get a key from <https://dashboard.exa.ai/api-keys> and hold it in
either place:

```
zen key add exa            # the keyring; materialised into the environment per run
EXA_API_KEY=...            # or .env, which wins over the keyring
```

`zen check` warns when an agent selects one of these tools and neither place
holds a key. Unlike a model credential this is a warning, not an error: the
project is still valid, it just cannot search yet.

**Notable arguments.** Defaults are chosen so that the common call is
`{ "query": "…" }` and nothing else:

| Argument                                   | On           | Why it exists                                                                   |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| `num_results`                              | `web_search` | 8 by default, 25 at most                                                        |
| `include_domains` / `exclude_domains`      | `web_search` | The replacement for `site:` — operators in the query text do not work here      |
| `start_published_date` / `end_published_…` | `web_search` | ISO 8601. The only reliable way to exclude a stale answer                       |
| `category`                                 | `web_search` | `company`, `publication`, `news`, `personal site`, `financial report`, `people` |
| `max_characters`                           | `web_read`   | 4 000 by default, 10 000 at most; `truncated` says when a page was cut          |
| `max_age_hours`                            | `web_read`   | `0` forces a live crawl. Omit it unless the page changes by the hour            |

Every reply is bounded — pages are cut at the cap and the whole call at 128 KiB
of text — so one call cannot flood the context. Each carries `cost_usd`, which
is what the vendor charged for that call.

A failure is **reported, not raised**: a refused key, an exhausted balance, a
url nothing serves all come back as `{ error, hint }` for the model to read and
act on. `web_read` reports per-url failures in `failed` alongside the pages that
did load, so one bad link does not lose the rest.

**Prompting for them.** Three lines earn their place in any prompt granting this
group:

- Search with a sentence, not keywords — the query is read by a model.
- Never quote an excerpt. `web_search` says which page to open; `web_read` says
  what it contains.
- Say when the web is allowed to override what the model already believes, and
  when it is not. Without that line, a retrieved page and a memorised fact carry
  equal weight.

### 3.9 Running it

`zen run` is what turns this folder into a running system. It reads the
directory, checks it, builds the workspace and sandbox tools against the
session's workspace, and starts the conversation:

```
zen run                         open the entry agent on this project
zen run "what changed?"         one shot; stdout is the answer
zen run --session <id>          continue a session
zen run --workspace ./repo      what the agent may read and write
zen run --model careful         override the default model for this run
zen run --image <ref>           override the sandbox image for this run
zen run --read-only             withhold every tool that can write
```

The project is read **once, up front**: a missing prompt, an unknown tool name,
a handoff to nobody all fail before the first call, with the offending key
named. Flags always win over the file — the repository states intent, the
invocation overrides it.

A session owns a workspace, a trajectory, memory and whatever the agent wrote,
under `sessions/`. None of it is source; none of it is committed.

### 3.10 `.env`

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_APPLICATION_CREDENTIALS=./.keys/vertex.json
EXA_API_KEY=...
```

Never commit. Never inline a key into `agents.yaml` — use `${VAR}`. Never print a
key in a log line, a test fixture, or a chat message.

---

## 4. Writing prompts

### 4.1 Composition order

```
1. INSTRUCTIONS.md        (shared, once, all agents)
2. agents/prompts/<n>.md  (this agent)
3. skill index            (rendered by the runtime — do not hand-write it)
4. preloaded skills       (activated before the first call)
```

Never duplicate `INSTRUCTIONS.md` content into an agent prompt; never hand-render
a list of skills into a prompt (the runtime does it, and a hand-written one goes
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
3. Is it _contradicted_ by `INSTRUCTIONS.md` or a skill? Adjacent contradictions
   win over distant ones; later text usually wins over earlier.
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
| `INSTRUCTIONS.md`   | every call, every agent | true always, for everyone                             |
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
**scope** is a namespace string; agents bound to the same scope share what is
in it, and the default scope is the agent's own — so memory is private until
something says otherwise. Recall is automatic: matches for the current input
are injected before each call, which is what makes memory work without the
model remembering to look, and an agent with write access also gets tools to
search, add, update and delete entries.

It is a session-level facility rather than an `agents.yaml` key: `zen run`
binds each session's store under `sessions/`, so memory travels with the
session and is not part of this repository.

Do not treat memory as a database. It is for things learned that should
persist. Anything authoritative — a rate, a policy clause, a procedure — belongs
in a skill, where it is versioned and reviewable.

### 5.4 Cache discipline

Rules that follow directly from "stable prefix = cache hit":

- Do not reorder `agents.yaml` for cosmetic reasons — tool order is prompt order.
- Do not put timestamps, run ids, or "today is …" in `INSTRUCTIONS.md` or a
  prompt. A changing prefix is a permanent cache miss. Put volatile facts in a
  tool result.
- Prefer `preload` over an instruction telling the model to load a skill first.
- Keep the volatile half of an instruction in the agent prompt and the stable
  half in `INSTRUCTIONS.md`, not the reverse.

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

A turn ends when the model replies with no tool calls — that text is the answer.
There is no turn limit, so an agent that must stop somewhere needs a prompt that
says where: what "done" looks like, and what to do when it cannot get there.

So say in the prompt which handoff ends the turn, or what the final answer
should contain. An agent with no stated finish keeps working the problem.

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
`openai:ft:gpt-4o:acme::a1b2`.

**Always write the prefix.** The first segment is a provider _name_, not a vendor
hint — nothing reads `gemini-3.5-flash` and infers Google. An unprefixed id goes
to the default provider, which is `openai` unless a top-level `provider:` says
otherwise, so a bare `gemini-3.5-flash` asks OpenAI for a Google model and fails
with `OPENAI_API_KEY is not set`. The message names the provider it resolved to;
read it as "the prefix is missing", not "the key is missing".

Anything the shorthand cannot express (keys, base urls, `api:`, reasoning knobs)
needs the object form. The object form does **not** re-parse a shorthand: its
`model:` is the bare id and the provider goes in `provider:` beside it. Writing
`model: openai:gpt-5.4-mini` there sends that whole string to the API.

Resolution order for any `model:` value: `zen run --model` → this file's
`models:` → the shorthand parser. Two agents naming `balanced` share one model
over one connection.

### 7.4 Vendor knobs

| Field                   | Applies to                    | Notes                                                                                                      |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `reasoningEffort`       | openai, openrouter            | Free string on purpose — the API is the authority on validity. On openai **needs `api: responses`** — §7.6 |
| `reasoningSummary`      | openai, openrouter            | `auto` \| `concise` \| `detailed`. On openai **needs `api: responses`** — §7.6                             |
| `maxTokens`             | anthropic, gemini, openrouter | Cap on **output** tokens, not context. Anthropic requires one (default 8192)                               |
| `thinkingBudgetTokens`  | anthropic                     | Extended thinking budget                                                                                   |
| `thinkingBudget`        | gemini 2.5                    | Tokens: `0` off, `-1` auto                                                                                 |
| `thinkingLevel`         | gemini 3                      | `minimal` \| `low` \| `medium` \| `high`                                                                   |
| `includeThoughts`       | gemini                        | Thought summaries; default `true`                                                                          |
| `routing` / `fallbacks` | openrouter                    | Upstream provider preferences, and models to fall back to — §7.5                                           |

Knobs that do not apply to the chosen vendor are ignored, not rejected.
`api:` exists only for the OpenAI protocol — naming it on a Gemini or Anthropic
model is an error.

Each vendor's own SDK is used rather than its OpenAI-compatible endpoint, because
those endpoints drop exactly what this runtime is built on: thinking budgets,
thought signatures, cache accounting. `openai-compatible` is the shim kind — vLLM,
a self-hosted gateway. `openrouter` used to be that shim with its base url
(`https://openrouter.ai/api/v1`) and key env (`OPENROUTER_API_KEY`) filled in; it
now has its own SDK, which is what makes provider routing and fallback chains
available — §7.5.

### 7.5 OpenRouter

A gateway: one key and one endpoint in front of several hundred models from
every vendor. Useful when a project wants to compare families without holding
four accounts, and when a cheap tier should be swappable by editing one id.

The whole declaration is the kind — `baseURL` and `OPENROUTER_API_KEY` are its
defaults, and built-in kinds are usable as provider names, so a `providers:`
entry is only worth writing when it adds something:

```yaml
agents:
    - name: triage
      model: openrouter:anthropic/claude-sonnet-4.5
```

**Model ids** are `vendor/model` and may carry a variant suffix after a colon —
`:free`, `:nitro` (throughput-routed), `:floor` (price-routed), `:online` (web
search). Both survive the shorthand, because only the _first_ colon separates:

| Ref                              | Provider     | Model                 |
| -------------------------------- | ------------ | --------------------- |
| `openrouter:openai/gpt-5.4-nano` | `openrouter` | `openai/gpt-5.4-nano` |
| `openrouter:z-ai/glm-5.2:free`   | `openrouter` | `z-ai/glm-5.2:free`   |

The `vendor/` prefix is part of the _id_, not a provider name: what precedes the
first colon is the provider, and the `provider/api` slash is only read there.

**No api to choose.** This kind speaks one protocol, its own, so `api: responses`
and `openrouter/responses:…` are both a load error ("has one api, so … means
nothing here") rather than a 404 from the gateway at the first request. Reasoning
arrives on the message and is read into `thinking` deltas; `reasoningEffort` and
`reasoningSummary` are both forwarded, and the gateway maps effort onto whatever
the destination model understands.

**Routing and fallbacks** are the reason this kind has an SDK. `routing` picks
the upstream provider (OpenRouter's `provider` field, renamed because `provider:`
already means the connection); `fallbacks` lists other _models_ to try when none
can serve it (its `models` field). `allowFallbacks`, below, is a third thing
again — whether the gateway may look past `order`:

```yaml
models:
    routed:
        provider: openrouter
        model: openai/gpt-5.4-nano
        routing:
            order: [azure, openai]
            requireParameters: true
            sort: throughput
        fallbacks: [anthropic/claude-sonnet-4.5]
```

`routing` belongs to a **model**, not to a `providers:` entry: it is chosen per
request, not per connection, and the provider schema is strict, so writing it
there is a load error.

| Key                 | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `order`             | Providers to try first — a _preference_, not a restriction                   |
| `only` / `ignore`   | Restrict serving to, or away from, these                                     |
| `allowFallbacks`    | May the gateway go beyond `order` — **on** unless set `false`                |
| `sort`              | `price`, `throughput`, `latency`, `exacto`                                   |
| `requireParameters` | Skip a provider that would drop a parameter rather than serve it             |
| `dataCollection`    | `allow` \| `deny`                                                            |
| `quantizations`     | `int4` `int8` `fp4` `mxfp4` `nvfp4` `fp6` `fp8` `mxfp8` `fp16` `bf16` `fp32` |
| `zdr`               | Zero-data-retention endpoints only                                           |

`serviceTier` (`auto` \| `default` \| `fast` \| `flex` \| `priority` \| `scale`)
sits alongside `routing`, not inside it.

**A typo in `order` is invisible.** Provider names and `sort` are free strings
for the same reason `reasoningEffort` is — the gateway's list moves faster than a
schema would — so nothing local rejects them, and since `allowFallbacks` defaults
on, an unknown name is skipped and the request quietly succeeds somewhere else.
What _is_ checked is checked by the API rather than at load: a bad `sort` or
`quantizations` returns `400 provider.sort: Invalid input`. Use `only`, or
`allowFallbacks: false`, when the constraint is meant to bind — an unroutable
request is then a 404 instead of a silent reroute.

**Attribution** goes in `headers:`; there is no dedicated field because that one
already means "sent on every request":

```yaml
providers:
    openrouter:
        kind: openrouter
        headers:
            HTTP-Referer: https://example.com
            X-Title: My Agent
```

**Check capabilities before pinning an id.** A gateway routes to whoever serves
that model, so a request can fail on a capability rather than on the model
existing (`404 No endpoints found that support image input`). The catalog is
public and needs no key:

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '
  .data[] | select(.id == "z-ai/glm-5.2:free")
  | "modalities: \(.architecture.input_modalities | join("+"))",
    "params:     \(.supported_parameters | join(","))"'
```

`input_modalities` decides whether images may be sent at all;
`supported_parameters` decides whether `tools`, `tool_choice` and
`reasoning_effort` are honoured. An agent with tools needs `tools` in that list.

**Not modelled yet:** `transforms`, `usage.include`, and per-call cost — the
gateway reports a price on every response, but it is not surfaced in the token
accounting. `plugins` exists in code only. Four `provider` fields the SDK accepts
have no yaml spelling either — `maxPrice`, `preferredMaxLatency`,
`preferredMinThroughput`, `enforceDistillableText` — and `sort` takes the string
form only, not the `{ by, partition }` object. `models:` entries are strict, so
writing any of these is a load error rather than a key that is silently dropped.

**`maxRetries` is honoured only as `0`.** This SDK takes a retry _strategy_, not
a count, so `0` disables retries and any other number leaves the default backoff
in place. `timeoutMs` and `headers` behave normally.

**Keys:** `zen key add openrouter` stores it under `OPENROUTER_API_KEY`.

### 7.6 Turning reasoning on

Ask two separate questions: does the model **reason**, and does it **say what it
reasoned**. They are different knobs, and the second is off by default on every
vendor except Gemini — which is why a reasoning model can burn thousands of
thinking tokens while the CLI shows no progress at all.

**OpenAI** — reasoning text only exists on the **responses** API, and only as a
summary. `api: responses` is not optional here, and not only for visibility:
chat completions is the default, and it **refuses `reasoningEffort` together with
function tools** — `400 Function tools with reasoning_effort are not supported
for <model> in /v1/chat/completions`. So any OpenAI agent that both reasons and
holds tools — which is nearly all of them — must name the api.

```yaml
models:
    default:
        provider: openai
        api: responses # required — chat completions refuses tools + reasoning
        model: gpt-5.4-nano
        reasoningEffort: medium # how hard it thinks
        reasoningSummary: auto # whether you get to see it
```

**Anthropic** — `thinkingBudgetTokens` turns extended thinking on, and it is spent
_out of_ `maxTokens`, so raise that too or the answer has no room left after the
thinking. The runtime keeps 1024 tokens of headroom whatever you write, so a cap
below the budget is corrected rather than rejected. Read §7.7 first: this
combination is unsafe for tool-using agents.

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
up (§7.8).

### 7.7 Known traps

- **A model id with no provider prefix** — `gemini-3.5-flash` resolves to the
  default provider, not to Google, and the failure reads as a missing OpenAI key.
  Write `google:gemini-3.5-flash` — §7.3.
- **OpenAI reasoning without `api: responses`** — chat completions rejects
  `reasoningEffort` alongside function tools with a `400`, and exposes no
  reasoning summary even without tools — §7.6.
- **Anthropic + `thinkingBudgetTokens` + multi-turn tool use** — thinking-block
  signatures are not replayed, and the API rejects the follow-up. Leave extended
  thinking off for tool-using agents.
- **`reasoningEffort: minimal`** is rejected by the `gpt-5.4-*` family; use `low`.
- **Vertex** needs a project id, resolved from `project:` → `GOOGLE_CLOUD_PROJECT`
  → the `project_id` inside the key file named by `GOOGLE_APPLICATION_CREDENTIALS`.
  gcloud user credentials and metadata-server credentials carry no project id, so
  those deployments must set the variable.
- **OpenRouter + a capability the route does not have** — a valid id and a valid
  key still fail at the first request (`404 No endpoints found that support image
input`, or tools quietly unused). This is not a config error and `zen check`
  cannot see it: check the catalog (§7.5). Cheap `:free` tiers are the usual
  offenders — they are frequently text-only.
- **Swapping an OpenRouter id is not a like-for-like change.** Two models behind
  one gateway differ in modalities, tool support and reasoning; re-run the case
  that uses the capability, not just any case.
- **An `embeddings:` entry on an Anthropic provider** fails at load: that vendor
  publishes no embeddings API. Point it at another provider — §3.1.1.
- **Changing `dimensions:` on an embedding invalidates every stored vector.**
  Widths are not comparable, so anything already indexed has to be re-embedded.

### 7.8 How to choose, in practice

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

1. **`zen check`.** Most structural mistakes are load errors, and this is the
   fastest way to see all of them: it validates `agents.yaml`, checks that every
   prompt, skill and catalog it names is on disk, that hand-offs and tool
   selectors resolve, and that the models have credentials — without stopping at
   the first problem and without calling anything. `zen check --json` if you are
   parsing it.
2. **Run the case that motivated the change**, plus one that must _not_ change.
3. **Read the inspect report** — it shows the assembled prompt, every request and
   response, tool calls, skill activations and cost. Behaviour questions are
   answered there, not by re-reading the YAML.
4. **Re-run `zen check` after any rename.** It is what catches the handoff, the
   skill or the prompt path that a rename silently unlinked.
5. **Watch the token accounting.** A change that doubles prefix size is a
   regression even if the answer improved.
6. **After changing a model id, exercise the capability it was chosen for** —
   send an image, force a tool call, ask for reasoning. `zen check` proves the
   credential resolves, not that the route serves images or honours `tools`; on a
   gateway that gap is a request-time 404 (§7.5).

CLI (`zen --help` for the authoritative list): `zen init`, `zen run`, `zen check`,
`zen inspect`, `zen models`, `zen key`, `zen list`. **stdout is the answer, stderr
is the narration**; every command takes `--json`. Exit codes: `0` ok, `1` failed,
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
- [ ] Comments explain the design, not the runtime or the key they sit above

**Prompts**

- [ ] `INSTRUCTIONS.md` carries the shared architecture and nothing agent-specific
- [ ] Nothing duplicated between `INSTRUCTIONS.md` and an agent prompt
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

- [ ] Every agent holds the narrowest set its job needs
- [ ] An agent that only reads is not holding `write_file`, `apply_patch`,
      `move_file` or `delete_file` — subtract them from `workspace:*`
- [ ] `sandbox:*` is granted only where a shell is actually needed
- [ ] `sandbox.persist: true`, unless a throwaway rootfs is wanted on purpose
- [ ] The `sandbox:` image carries what the work needs, rather than the prompt
      installing it every run
- [ ] `sandbox.env` lists names only, and nothing credential-shaped
- [ ] `exa:*` is granted only where the live web is actually needed, and the
      prompt says when to trust it over what the model already believes
- [ ] Every granted tool the prompt expects is named in that prompt

**Models**

- [ ] Aliases are role names, not vendor names
- [ ] Vendor knobs valid for the chosen vendor (no `api:` on gemini/anthropic)
- [ ] No agent silently on the fallback `model:` when it needed a specific tier

**Cache and cost**

- [ ] No timestamps or run-specific text in the prefix
- [ ] Prefix growth is intentional and worth it

**Secrets**

- [ ] No key literal in YAML, prompt, skill or log — `${VAR}` only
- [ ] `.env` is git-ignored

---

## 10. Where to change what

| Symptom                                    | Change this                                                |
| ------------------------------------------ | ---------------------------------------------------------- |
| Wrong tone, wrong format, wrong length     | `INSTRUCTIONS.md` (all agents) or the agent prompt         |
| Says something forbidden                   | `INSTRUCTIONS.md` prohibition, stated specifically         |
| Ignores a rule that only applies sometimes | Move the rule into a skill with a sharp description        |
| Never loads the skill it should            | The skill's `description`; or `preload` it                 |
| Loads too much, answers slowly             | `allow:`, `maxIndexEntries:`, or `discovery: search`       |
| Invents a number                           | A skill holding the figure, or a command that computes it  |
| Rewrites a whole file to change one line   | A prompt line preferring `apply_patch` — §3.6              |
| Edits files it should only be reading      | Subtract the mutating tools, or `zen run --read-only`      |
| Cannot run the build or the tests          | Grant `sandbox:*`; pick an `image:` that has the toolchain |
| Installs the same packages on every run    | `sandbox.persist: true`, or set `sandbox.image` — §3.7     |
| Answers from stale knowledge of the world  | Grant `web_search` + `web_read`, and say when — §3.8       |
| Cites a page it only saw the excerpt of    | A prompt line: `web_read` before quoting — §3.8            |
| Every web call refuses                     | No Exa key: `zen key add exa` — `zen check` warns — §3.8   |
| Answers instead of routing                 | Router prompt prohibition; check `handoffs:`               |
| Routes to the wrong specialist             | The target agents' `description:` fields                   |
| Loses a detail after a handoff             | Say it in the handoff; check the collapse policy           |
| Works through N independent items serially | `fork:` on that agent, and a prompt line — §6.4            |
| Forks when the steps actually depend       | Prompt line: branches cannot see each other                |
| Slow and expensive on trivial cases        | Demote that agent's model tier / reasoning effort          |
| Fails only on genuinely hard cases         | Promote that agent's tier, or split the hard path out      |
| Shows no reasoning while it works          | Turn summaries on for that model — §7.6                    |
| Forgets across conversations               | Continue the session rather than starting a new one        |
| Breaks at load with a named path           | Read the message — it names the exact key                  |

---

## 11. Anti-patterns

- **The mega-prompt.** 300 lines covering twelve scenarios. Split into skills.
- **Agent sprawl.** Eight agents that share one model, one tool set and one
  prompt style. Collapse into one with a catalog.
- **Facts in prompts.** A fee schedule inside `INSTRUCTIONS.md`. It cannot be
  versioned, cannot be shared, and is paid for on every call.
- **Politeness padding.** "Please try your best to be helpful." Costs tokens,
  changes nothing.
- **Commented implementation notes.** `agents.yaml` explaining how skill
  discovery or prompt caching works. That is this file's job — §3.1.
- **Fixing prompts with models.** See §4.4.
- **The chatty router.** A router that answers before handing off, because its
  prompt never forbade it.
- **Ping-pong handoffs.** Specialists that hand back to the router, which hands
  back to a specialist.
- **Forking a chain.** Branches never see each other, so a fork whose second
  branch needs the first branch's answer is a sequence wearing a fork's clothes.
- **Installing the toolchain every run.** A prompt that begins with `apt-get
install` is an `image:` that was never set — §3.7.
- **Volatile prefix.** "Current date: …" in `INSTRUCTIONS.md`. Permanent cache
  miss.

---

## 12. Maintaining this file

This file is loaded on every request in this repository, so it is subject to its
own rules: stable, factual, no hedging. Before adding a section, ask whether it
is true of every task — if it is not, it is a skill under `.github/skills/`, or
a prompt file under `.github/prompts/` if it is a procedure (§2.4).

Update it when:

- the layout changes (a new directory, a moved catalog)
- a model alias is added, retired or repointed — §7.2 must match `agents.yaml`
- a vendor trap is discovered — add it to §7.7
- a recurring review comment appears twice — turn it into a checklist line in §9
- a runtime capability is added — describe it here, or it will not be used

Do not let it grow without pruning. When a section is only true of one agent, it
belongs in that agent's prompt, not here.
