---
name: spec-edit
description: Change SPECIFICATION.md as the request given with the command asks - written in the specification's own structure and voice, checked against what the runtime can actually do - and nothing else.
argument-hint: 'what to add, change or remove in the specification'
disable-model-invocation: true
---

Edit `SPECIFICATION.md` the way the request given with this command asks. The
specification is the intent of the project; you are changing the intent, not
the implementation. Making the project match it is `/spec-sync-project`, which
runs after this.

You change one file: `SPECIFICATION.md`. Not `agents.yaml`, not a prompt, not a
skill, not `SPECIFICATION-FEEDBACK.md`.

## 0. Read everything you need first

These are the files the work depends on. Read them before anything else, so
the work starts from all of them rather than from a round of reads later.

The project:

- [SPECIFICATION.md](../../../SPECIFICATION.md) - the file you are editing.
- [SPECIFICATION-FEEDBACK.md](../../../SPECIFICATION-FEEDBACK.md) - the questions
  still open against it, and the ones already answered. It may not exist; that
  only means nothing is open.

What the runtime can do, so that what you write is something it can build:

- [zen-cli](../zen-cli/SKILL.md) - every `zen` command, and
  [its models reference](../zen-cli/references/models.md) - how to find
  which models this machine can actually use.
- [zen-instructions](../zen-instructions/SKILL.md) - house rules: what
  every agent is told, and what belongs there rather than in a prompt.
- [zen-topology](../zen-topology/SKILL.md) - one agent or several,
  hand-off or fork, and what each costs.
- [zen-memory](../zen-memory/SKILL.md) - what memory is, who may read and
  write it, and what a strategy for it has to say.
- [zen-rag-docs](../zen-rag-docs/SKILL.md) - an index over a folder of
  markdown documents.
- [zen-rag-schema](../zen-rag-schema/SKILL.md) - an index over an OpenAPI
  description.
- [zen-sandbox](../zen-sandbox/SKILL.md) - the container: what it mounts,
  what it can reach, what persists.
- [zen-code-python](../zen-code-python/SKILL.md) - reusable scripts as
  tools, where they live, and which agents own them.

Any of these already in your context - attached, or loaded as a skill - you
need not read again. Read the rest in **one** batch of parallel reads before
doing anything else, `SPECIFICATION-FEEDBACK.md` included if it exists. Never one at a
time, and never skip one because the request seems not to need it: a request
about an agent's job can still decide what that agent may remember.

In the same first step, run once from the project root and keep the output:

```sh
zen models && zen models ls --chat && zen models ls --embeddings
```

That is the list of models with a credential on this machine - the only ones a
**Models** line may name. A model the request names that is not in it: run
`zen models search <name>` once; if it is still absent, say so in the chat and
do not write it.

If no request was given with the command, ask what to change and stop.

## 1. Understand the request against what is there

Before writing a line, work out:

- **Whether this is defining the project from the initial scaffold or editing an
  existing domain specification.** A freshly initialised `SPECIFICATION.md` is a
  generic placeholder ("Carry out work inside a workspace on request…",
  "Currently: no steps", "the only agent; nobody to hand work to") written as
  meta-commentary about what each section does. When the request asks to make or
  define a specification for a project or domain on top of that scaffold, it
  reaches **every** section: replace all generic template sentences and
  meta-explanations with a complete, concrete specification for that domain.
  When `SPECIFICATION.md` already describes a real domain project and the
  request asks for a specific change, keep the pass narrow and touch only the
  sections the change implicates.
- **Which sections the request touches.** Usually more than the one it names: a
  new agent changes **Agents**, **Tools and boundaries** and **Done means**; an
  index changes **Setup**, **Knowledge** and **Environment**.
- **What it contradicts.** A sentence already in the specification that the
  request makes false is part of the edit - change it too, and report it.
- **What it settles in the feedback file.** An open question the request
  answers, or an answered one it reverses. Do not edit the feedback file; say
  which questions in the chat.
- **Whether the runtime can do it.** Check the request against the skills above.
  Something no tool, agent setting or script can provide is not written into the
  specification as if it could be: say so in the chat, offer the nearest thing
  the runtime does do, and write that only if the request leaves no doubt it is
  wanted.

## 2. The structure of a specification

Keep the sections the file already has, in its order. Add a section only when
the request needs one, at its place in this order, and leave out any section
that would be empty:

```markdown
# Specification

## Purpose

## Scope

## Models

## Setup

## Agents

## Tools and boundaries

## Knowledge

## Memory

## Environment

## Testing

## Done means

## Out of scope
```

What each one answers:

- **Purpose** - what the system produces, and for whom, in one paragraph.
- **Scope** - what one request covers, what is in and what is not, hard numeric
  bounds (when a request is refused with a count rather than truncated), and
  what has to happen before the system acts.
- **Models** - every chat and embedding model by its full id from `zen models`,
  and which agent or job uses which. Keep the chat model already in
  `SPECIFICATION.md` unless the request asks to change it; add an embedding
  model from `zen models ls --embeddings` whenever the specification uses
  `memory/`, `assets/docs-db`, or `assets/schema-db`.
- **Setup** - what has to exist before a run: OpenAPI specs or reference
  documents fetched, a `zen rag schema` index built in `assets/schema-db`, a
  `zen rag docs` index built in `assets/docs-db`, or reference files generated.
  Each is a named step `scripts/_setup.sh` runs in order; say what it produces,
  from what inputs, and where it lands.
- **Agents** - one entry per agent: its name, its one job, who it hands to or
  forks, and the behaviours that are specific to it. Use **zen-topology** to
  choose the right shape: split into focused agents (for example, a lead
  coordinator/analyst, a dedicated quantitative/code agent, and a read-only
  research agent) when tasks have distinct tool boundaries or heavy code
  execution (**zen-code-python**), and specify `fork` (`context: none`) when a
  request compares multiple independent items or runs independent research
  tracks in parallel.
- **Tools and boundaries** - what each agent may reach for (files, shell,
  reusable scripts in `/workspace/scripts/`, web search/read, memory, indexes,
  external APIs), what is read-only, how transient network/API errors are
  retried and fallen back from, and what nothing may reach. Every capability
  named here has an agent that holds it.
- **Knowledge** - each index (`assets/schema-db`, `assets/docs-db`), each skill
  under `agents/skills/` (naming the skill and the concrete procedure, formulas,
  API conventions, or `rag_search` rules it holds), and the concrete external
  APIs or data sources the project queries (naming specific zero-key primary
  APIs and endpoints, required headers and rate limits, optional free-tier
  keyed APIs, and fallback order).
- **Memory** - what is worth remembering (reusable scripts as `file` nodes,
  verified identifiers/mappings, API schemas, workflows) and what is not (or
  how time-sensitive facts are bounded), who may read and write, and when an
  agent recalls before working and commits after it - see **zen-memory**.
- **Environment** - the sandbox (`sandbox/Dockerfile`, persistence, network),
  the exact languages, CLI tools, and libraries pre-installed in the image so
  agents never install packages at run time, where scripts and data outputs
  live under `/workspace`, and optional environment variables or credentials by
  name - see **zen-sandbox**.
- **Testing** - how a change to the project is checked: `zen check`,
  `scripts/_setup.sh --check`, `scripts/_setup.sh` run twice in a row reporting
  `skipped` the second time, and a concrete verification request the project
  must handle end-to-end.
- **Done means** - how a finished job is told from an unfinished one, written as
  concrete acceptance tests in prose that a reviewer could check against a run
  (exact attribution fields, script-computed numbers, verified page reads,
  reusable script paths, and required sections).
- **Out of scope** - what the runtime could do that this project deliberately
  does not, so nobody adds it because it seemed useful.

## 3. How to write it

- **Replace scaffold boilerplate on a greenfield request; change the smallest
  thing on an incremental edit.** When `SPECIFICATION.md` is still the initial
  `zen init` scaffold or the request asks to make a specification for a new
  project, rewrite every section for that domain and remove the scaffold's
  generic meta-commentary ("What the work always needs belongs in the image…",
  "Currently: no steps…", "The reply names what changed, file by file…"). When
  editing an already-written domain specification, leave every sentence the
  request does not reach as it is.
- **Write in a direct, declarative voice.** Match the clean heading and list
  structure of the specification, stating concrete project rules rather than
  abstract explanations of how Zenera works.
- **Say what and why, never raw config syntax.** The specification is not
  `agents.yaml` in prose. Name the agents, skills, setup steps, indexes, APIs,
  packages, paths, and behavioural rules clearly, without pasting raw YAML
  snippets or shell implementation internals that `/spec-sync-project` derives.
- **Turn high-level domain requests into concrete architectural choices.** When
  a request asks to design a project in broad terms (for example, "make a
  specification for financial analytics using open APIs"), do not repeat vague
  phrases like "open APIs" or "packages for data analysis". Make the concrete
  domain choices upfront so `/spec-sync-project` can build a working system
  without guessing:
    - Name specific, working zero-key public APIs and endpoints as primary
      sources (with required headers such as `User-Agent` and rate limits),
      optional keyed free-tier APIs as secondary sources with clean zero-key
      fallback when keys are absent, and `web_search` / `web_read` rules.
    - Name the concrete setup steps (`scripts/<name>.sh`), indexes
      (`assets/schema-db`, `assets/docs-db`), and domain skills under
      `agents/skills/`.
    - Name the exact Python/system libraries to pre-install in
      `sandbox/Dockerfile` and the `/workspace/scripts/` and `/workspace/data/`
      conventions from **zen-code-python**.
    - State explicit numeric limits (such as the maximum entities/tickers per
      request before refusing with a count), retry/fallback rules, and required
      citation fields.
- **Be specific where a reader could decide either way.** A limit is a number,
  a model is an id, a failure has a stated outcome. "Handles large inputs" is
  not implementable; "a request over 25 tickers is refused with a count, never
  truncated" is.
- **Never invent a model id or a user-owned secret.** Keep the model already in
  `SPECIFICATION.md` unless the request asks to change it, and take any new
  chat or embedding model strictly from the `zen models` output on this machine,
  never from memory. Ask before editing only when a required value belongs
  exclusively to the user (such as a private server URL or proprietary rule)
  and cannot be satisfied by a standard public default.
- **Make it checkable.** Every behaviour the request adds gets a line under
  **Done means** that a reviewer could verify against a recorded run.
- **Name what is now excluded.** When the request narrows the system, the thing
  it rules out goes under **Out of scope**.
- **Say it once.** If the rule already lives in another section, change it
  there rather than stating it a second time somewhere new.

## 4. Report

In the chat:

- every section you changed, with each new or changed line quoted
- every edit the request did not name but made necessary, and why
- every open question in `SPECIFICATION-FEEDBACK.md` the change settles or
  reopens, by number
- anything you did not write because the runtime cannot do it, or because it
  needs a value only the reader has
- then, in one line: send `/spec-sync-project` to make the project match.

## 5. The request

The words given with the command are the request the specification should
address. Without them, ask what to change and stop (§0).
