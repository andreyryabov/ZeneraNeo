---
description: Change SPECIFICATION.md as the request after the command asks - written in the specification's own structure and voice, checked against what the runtime can actually do - and nothing else.
argument-hint: what to add, change or remove in the specification
---

Edit `SPECIFICATION.md` the way the request after this command asks. The
specification is the intent of the project; you are changing the intent, not
the implementation. Making the project match it is `/spec-sync-project`, which
runs after this.

You change one file: `SPECIFICATION.md`. Not `agents.yaml`, not a prompt, not a
skill, not `SPECIFICATION-FEEDBACK.md`.

## 0. Everything you need is already attached

These files are attached to this prompt so the work starts without a round of
reads. Use them as they are; do not read them again with a tool.

The project:

- [SPECIFICATION.md](../../SPECIFICATION.md) - the file you are editing.
- [SPECIFICATION-FEEDBACK.md](../../SPECIFICATION-FEEDBACK.md) - the questions
  still open against it, and the ones already answered. It may not exist; that
  only means nothing is open.

What the runtime can do, so that what you write is something it can build:

- [zen-cli](../skills/zen-cli/SKILL.md) - every `zen` command, and
  [its models reference](../skills/zen-cli/references/models.md) - how to find
  which models this machine can actually use.
- [zen-instructions](../skills/zen-instructions/SKILL.md) - house rules: what
  every agent is told, and what belongs there rather than in a prompt.
- [zen-topology](../skills/zen-topology/SKILL.md) - one agent or several,
  hand-off or fork, and what each costs.
- [zen-memory](../skills/zen-memory/SKILL.md) - what memory is, who may read and
  write it, and what a strategy for it has to say.
- [zen-rag-docs](../skills/zen-rag-docs/SKILL.md) - an index over a folder of
  markdown documents.
- [zen-rag-schema](../skills/zen-rag-schema/SKILL.md) - an index over an OpenAPI
  description.
- [zen-sandbox](../skills/zen-sandbox/SKILL.md) - the container: what it mounts,
  what it can reach, what persists.

If any of these did not arrive attached - your editor does not resolve links in
prompt files - read all of them in **one** batch of parallel reads before doing
anything else, `SPECIFICATION-FEEDBACK.md` included if it exists. Never one at a
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

If there is no request after the command, ask what to change and stop.

## 1. Understand the request against what is there

Before writing a line, work out:

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
- **Scope** - what one request covers, what is in and what is not, and what has
  to happen before the system acts (a confirmation, a missing value asked for).
- **Models** - every model and embedding by its full id, and which agent or job
  uses which. One line each, with the reason where there is more than one.
- **Setup** - what has to exist before a run: an index built, a document
  fetched, a file generated. Each is a step `scripts/_setup.sh` runs; say what it
  produces, from what, and where it lands - not the commands.
- **Agents** - one entry per agent: its name, its one job, who it hands to or
  forks, and the behaviours that are specific to it. Whether a second agent
  should exist at all is **zen-topology**; a job one agent can do with a skill is
  not a new agent.
- **Tools and boundaries** - what each agent may reach for (files, shell,
  memory, an index, the network, an API) and what nothing may reach. Every
  capability named here has an agent that holds it.
- **Knowledge** - each index: what it holds, where it lives under `assets/`,
  which agents search it, and how - see **zen-rag-docs** and **zen-rag-schema**.
- **Memory** - what is worth remembering and what is not, who may read and who
  may write, and when an agent recalls before working and commits after it. The
  strategy, not the tool calls - see **zen-memory**.
- **Environment** - the sandbox (image, network, persistence), credentials by
  name, and external services the project expects to be running - see
  **zen-sandbox**.
- **Testing** - how a change to the project is checked: `zen check`, setup run
  twice, and the real requests a run must handle.
- **Done means** - how a finished job is told from an unfinished one, written as
  acceptance tests in prose that a reviewer could check against a run.
- **Out of scope** - what the runtime could do that this project deliberately
  does not, so nobody adds it because it seemed useful.

## 3. How to write it

- **Change the smallest thing that does what was asked.** Leave every sentence
  the request does not reach exactly as it is - no rewording, no reflowing, no
  tidying of sections you were not sent to.
- **Write in the specification's own voice.** Its tense, its list style, its
  heading levels, and the words it already uses for things. A new line should
  read as if the original author wrote it.
- **Say what and why, never how.** The specification is not `agents.yaml` in
  prose. A line that could be pasted into `agents.yaml` unchanged, a tool
  schema, a prompt sentence addressed to the model, a shell command for a setup
  step - those are implementation, and `/spec-sync-project` derives them.
- **Be specific where a reader could decide either way.** A limit is a number,
  a model is an id, a failure has a stated outcome. "Handles large inputs" is
  not implementable; "a request over 200 files is refused with a count" is.
- **Never invent a value the request did not give.** A model id, a limit, a
  path, a retry count, a URL. If the edit cannot be written without one, ask for
  all the missing values together in one message before editing. If it can,
  leave the value unstated - the next sync pass raises it as a question - rather
  than writing one that sounds right. When the missing value is a model, the
  question offers two to four ids from the `zen models` list, never one from
  memory.
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

## 5. User Request:

Following is the user request that the specification should address (if any):
