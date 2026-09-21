---
description: Bring the project into compliance with SPECIFICATION.md, and record every open question in SPECIFICATION-FEEDBACK.md.
---

Make this project match `SPECIFICATION.md`. The specification is the intent;
the files are the implementation. Where they disagree, the specification wins -
except where it is ambiguous, contradictory or impossible, which is what
`SPECIFICATION-FEEDBACK.md` is for.

## 0. Decide the size of this pass

Load the `zen-spec-sync` skill first, before anything else and whatever state
the project is in - a project with no baseline is the one that needs it most,
because this pass has to make the first. Then, from the project root:

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh status
.github/skills/zen-spec-sync/scripts/snapshot.sh diff
```

`status` answers `full`, `incremental` or `tampered`. Say which in the chat
before reading anything, and on an incremental pass state the scope you drew
from the diffs - the skill says how. `full` and `tampered` both mean the whole
prompt as written below, from nothing.

The diff covers both sides. `SPECIFICATION.md` and `SPECIFICATION-FEEDBACK.md`
say what has been **asked for** since the last pass; `agents.yaml` and every
file under `agents/` say what has been **built or hand-edited** since then. The
first narrows the pass to the work nobody has done; the second only widens it,
because a prompt or skill someone changed outside a pass still has to be
accounted for against the specification.

The scope decides what you **read and edit**. It never decides what you
**verify**: §6, §7 and the five checks in the skill run at full size on every
pass, however small the diff.

## 1. Read before changing anything

Read, in this order, and do not edit until all of it is read:

1. `SPECIFICATION.md` - what the system is meant to be.
2. `agents.yaml` - providers, models, embeddings, agents, tools, handoffs,
   skills, sandbox.
3. Every `agents/*instructions.md` and every file under `agents/prompts/`.
4. Every `agents/skills/*/SKILL.md`, plus what each skill folder ships.
5. `assets/`, `sandbox/Dockerfile` and every script under `scripts/`, starting
   with `scripts/_setup.sh`.
6. `SPECIFICATION-FEEDBACK.md`, if it exists - do not re-raise something already
   open there.

On an incremental pass this list narrows to the artefacts the scope implicates,
and to the changed hunks of the specification rather than all of it. The
narrowing is a claim: name what you skipped and why the diff does not reach it.

Run `zen check` first and record what it said. A project that does not load is
the first thing to fix.

## 2. Build the difference

Produce a difference list before touching a file. For every item in the
specification, decide which of these it is:

- **present and correct** - leave it alone
- **missing** - the specification asks for it and nothing implements it
- **divergent** - implemented, but not as specified
- **extra** - implemented, and the specification does not ask for it
- **unclear** - the specification does not say enough to implement it

Check at least: the model and embedding ids and which agent uses which; that
every agent named in the specification exists with that job and no second job;
handoff edges and fork permissions; the tools each agent holds; every skill the
specification implies; and every setup step, index or asset it depends on.

Then build the difference the other way, because the list above can only find
what the specification asked for and nothing implements. Read every
`agents/*instructions.md`, each `agents/prompts/*.md` and each `SKILL.md` **line
by line**, and for every line name the specification item it serves. A line
serving none is an **extra** - the category covers a single sentence in a prompt,
not only a whole file. Three things to look for while reading, none of which the
forward pass can see:

- **A line that contradicts another file.** One prompt against another, a prompt
  against the house rules, or a prompt against `agents.yaml` - an instruction
  to use a tool the agent does not hold, to hand to an agent that is not in its
  `handoffs:`, or to load a skill outside its `allow:`.
- **A line that asks for something the system already supplies.** A question put
  to the user about a value that arrives from the environment, a file or an
  earlier step is unanswerable, and the answer would be discarded.
- **A line the agent cannot carry out** - naming a path it cannot reach, a tool
  it was not granted, or an agent it cannot transfer to.

These are bugs whatever the specification says: fix them in place and report each
one. An extra that is merely unspecified is reported under `➕`, not removed.

On an incremental pass this reverse reading covers every file this pass touched
plus every file the implementation diff in §0 named - an edit made in this
session, or made by hand since the last pass, is exactly where a fresh
contradiction comes from. On a full pass it is the whole tree, as above.

## 3. Change the smallest thing that closes the gap

Apply the fixes in the order the copilot instructions prefer: a prompt or skill
edit over a new skill, a new skill over a new agent, a tool grant over asking
the model to compute or remember. Specifically:

- A behaviour gap is a prompt or skill edit, not a new agent.
- A fact, rate, threshold or command surface goes in a skill, never in a prompt.
- Arithmetic or a fixed transformation goes in a script under the skill folder,
  called by its absolute `/skills/<name>/…` path.
- A capability gap is a `tools:` grant plus the prompt line that says when to
  use it. A granted tool no prompt mentions is not implemented.
- A toolchain the work always needs goes in `sandbox/Dockerfile`, not in a
  prompt that installs it every run.
- If the project has a `sandbox/Dockerfile`, pin `@zenera/cli` and `@zenera/rag`
  in it to the version of `zen` in hand. Read that version with `zen --version`
  and write it into the `npm install -g` line, so the CLI an agent runs inside
  the container is the same one that built it. An unpinned name drifts away from
  the host on the next image build; a stale pin is a mismatch nothing reports.

Never delete an **extra** without saying so. Report it, say why the
specification does not cover it, and leave it unless I tell you to remove it.

Do not invent a value the specification does not state - a model id, a limit, a
retry count, a file path. That is an entry in `SPECIFICATION-FEEDBACK.md`, not a
guess.

## 4. Every setup step is a script

Anything the project needs done before it can run - building an index, fetching
a document, generating a file, warming the sandbox image - is a shell script,
not a paragraph of instructions for a human.

- One step per file, under `scripts/`, named after the step:
  `scripts/build-schema-index.sh`, `scripts/fetch-api-docs.sh`.
- `scripts/_setup.sh` is the **only** entry point - the leading underscore is
  what separates the runner from the steps it runs. It runs the steps in the
  order they depend on each other and is the single command that initialises the
  project. `zen init` writes it; adding a step is adding `scripts/<name>.sh` and
  its name to the `STEPS` list at the top of it. Consolidate any setup script
  that lives elsewhere into this shape, including one left at the project root.
- Every script starts `set -eu`, works from any working directory
  (`cd "$(dirname "$0")/.."` first), needs no arguments, and exits non-zero on
  failure so `scripts/_setup.sh` stops rather than continuing on a broken step.
- **Re-entrancy is required.** Running `scripts/_setup.sh` a second time must be
  safe. A step whose output is present and newer than its inputs prints that it
  is up to date and exits **3**, which is how the runner tells `skipped` from
  `ok`; otherwise it redoes the work idempotently, writing
  to a temporary path and moving it into place so an interrupted run never leaves
  a half-built artefact behind. `scripts/_setup.sh --force` redoes everything,
  and reaches each step as `$FORCE=1`.
- **It must be watchable.** `scripts/_setup.sh` tees each step's output to
  `.tmp/logs/setup-<step>.log`, prints a heartbeat line while a long step runs,
  and finishes with one line per step: `ok`, `skipped`, or `failed`.
- **Everything transient goes under `.tmp/`** - logs, scratch files, downloads,
  test output, and the temporary path a step writes to before moving its
  artefact into place. Nothing else in the tree is a scratch directory, and
  `.tmp/` is git-ignored: add it to `.gitignore` if it is not there already.
  Deleting `.tmp/` must leave the project runnable and `scripts/_setup.sh`
  re-runnable.
- Steps that need credentials run on the host, not in the sandbox. Read keys
  from the environment or `.env`; never inline one into a script.
- Anything the sandbox always needs belongs in `sandbox/Dockerfile`, not in a
  setup script that installs it again on every run.

## 5. Write `SPECIFICATION-FEEDBACK.md`

Create or update `SPECIFICATION-FEEDBACK.md` at the project root whenever
anything in the
specification is unclear, contradictory, impossible, or wrong. If there is
nothing to raise, say so in the chat and do not create the file.

**It is a questionnaire, and answering it must take one gesture.** Every
question carries two to four written-out answers, each with a `[ ]` box in its
heading. The reader marks the box of the one they want - `[x]` - and deletes the
others, then sends `/spec-apply-feedback`, which folds what survived into
`SPECIFICATION.md`. Either gesture alone is enough, and the file says so in
every question.

Two rules that come before everything else in this section:

- **No markdown tables anywhere in this file.** A table is unreadable the moment
  a pane is narrow or a cell wraps, and this is a file people read in a side
  panel. Every list is a list.
- **Never write a question the reader has to do work to answer.** No paragraph
  ending in "is that what you meant?", nothing that requires reading the
  implementation, and no answer phrased as a decision still to be made. If you
  cannot write two answers a reader could pick between, you have not understood
  the problem well enough to ask about it yet.

The file opens with one short paragraph: how many questions are open, and how to
answer them - put an `x` in the box of the answer you want, delete the answers
you do not want, or replace them all with a sentence of your own, then send
`/spec-apply-feedback`. Then a contents list, one line per question: its
number as an anchor link, the question in under ten words, and what is built in
the meantime. Then the questions, grouped under these headings, omitting any
heading with no questions. The file is scanned before it is read, so keep the
emoji on every heading:

```markdown
# Feedback on SPECIFICATION.md

## 🛑 Blocking - cannot implement without an answer

## ❓ Ambiguous - implemented one way, confirm the choice

## ⚡ Contradictions

## ✏️ Errors and typos

## ➕ Out of scope - implemented but unspecified

## ✅ Answered - folded into the specification
```

`✅` is written by `/spec-apply-feedback`, not by you. Leave what is there
alone except to strike an entry this pass has actually implemented, and say in
the chat which ones you closed.

### The shape of one question

Each question is its own `###` heading - the emoji of its section, `Q` and a
number, then the question itself, ending in a question mark. Under it, in this
order:

- **Where it comes from** - the specification text quoted as a blockquote,
  introduced by a link to the exact line,
  `[SPECIFICATION.md#L66](SPECIFICATION.md#L66)`, plus the section name. Link
  every line you quote; a reader must reach it in one click. For a question
  about something the specification does not say at all, link the section it
  would belong to and say that it is silent there.
- **Why it is a problem** - two or three sentences on what goes wrong, in terms
  of behaviour: what an agent does, what a run produces, what breaks. Not
  "unclear" or "ambiguous", which describe the sentence rather than the damage.
- **Built in the meantime** - what the implementation does now, and the one fact
  that made it the default. Or "Nothing - blocked."
- **To answer** - the same sentence on every question, word for word: put an `x`
  in one box below and delete the other answers, either one is enough.

Then two to four answers, each its own `####` heading of the form
`#### [ ] A. <the answer in one line, as the reader would say it>`. The one that
is implemented comes first and is marked `_(built)_`, so the file reads as "this
is what happens if you change nothing"; mark one `_(recommended)_` where it is
better for a reason the reader can check. Under each answer heading:

- **What it changes** - one or two sentences on the consequence of choosing it:
  what the system would then do differently, and what it costs.
- **The specification text**, in a fenced block, introduced by where it goes -
  "replace line 66", "add after line 21", "delete lines 30-32". Written in the
  specification's own voice and format so it can be pasted without editing.

Every answer carries its own box and its own text. They are alternatives that
will be read alone, so nothing may be shared between them and nothing may refer
to a sibling ("as above", "same as A"). Where an answer needs a value only the
reader has, put a `<placeholder>` in the block and say in **What it changes**
what to substitute.

Two rules on the answers themselves:

- **An answer is a real alternative**, not a restatement of the question or a
  hedge. "Decide later" is not an answer; "leave it unspecified, and the
  reviewer keeps using whatever the default agent uses" is.
- **Never write only one answer.** A question with nothing to choose between is
  not a question. Even an `✏️` typo has two: the correction, and leaving it as
  written with a line saying what stays wrong.

Under `➕` the two answers are fixed: keep it, whose block is the specification
text that would cover what was built, and remove it, whose **What it changes**
says what removing it would cost and which files would go.

### One question, written out

Copy this shape exactly - the outer fence is four backticks only so the example
can contain its own:

````markdown
### ❓ Q4. Do the three agents share one memory, or keep their own?

**Where it comes from** - [SPECIFICATION.md#L14](SPECIFICATION.md#L14), _Common
memory strategies_:

> use memory to save plans of answering what was delegated to what

**Why it is a problem** - the specification says what each agent writes and
never says who may read it. Memory is one graph with an audience on every node,
so this decides whether the orchestrator can plan from what a specialist
resolved last week, or re-derives it every time.

**Built in the meantime** - one shared slice: `memory: true` on all three, so
anything one agent writes, another can recall. Chosen because nothing in the
specification separates them.

**To answer** - put an `x` in one box below and delete the other answers. Either
one is enough.

#### [ ] A. All three agents share one memory _(built)_

**What it changes** - a lookup is paid for once for the whole system, and every
agent's recall competes with every other agent's notes for the same few slots.

Add under _Common memory strategies_, after line 17:

```markdown
All three agents read and write one shared memory: whatever one of them
discovers is recallable by the others.
```

#### [ ] B. Each agent keeps its own memory

**What it changes** - recall gets sharper and cheaper because an agent only ever
sees its own kind of note, and the same lookup is repeated by whoever did not do
it first.

Add under _Common memory strategies_, after line 17:

```markdown
Each agent reads and writes only its own memory. A finding one agent needs from
another travels as part of the hand-off, not through the store.
```
````

Use no emoji except the one on each heading. Keep the prose short. Do not
editorialise about the specification's quality, do not restate the runtime, and
do not copy a whole section in.

Append to the existing file rather than rewriting it, keeping the numbering and
the contents list in step. Numbers are never reused: a struck question's number
retires with it.

Read the feedback diff from §0 before writing: a question the human answered
since the last pass is work to close, not a question to ask again. If a question
has a box marked `[x]`, or one answer left under it, and no `✅` entry, the
reader answered it and never ran `/spec-apply-feedback` - implement that
answer, fold its text into `SPECIFICATION.md` yourself, and say so in the chat.

## 6. Run `scripts/_setup.sh` and watch it finish

After `zen check` passes, run `scripts/_setup.sh` yourself. A pass is not done
until it has run to completion in this session.

It is slow - an embedding index is minutes, not seconds - so start it in the
background and follow the logs instead of waiting blind:

- Tail `.tmp/logs/setup-*.log` and check the output artefact is still growing.
- **Wait in a loop, never in one long sleep.** Sleep at most 30 seconds at a
  time, then check the log and say what it shows, and repeat until the step
  finishes. A single long block makes the run unwatchable and hides a failure
  that happened in the first ten seconds.
- Report progress as you go: which step is running, how long it has been going,
  what the last log line said.
- Do not kill a quiet step. Confirm the process is dead or the log and the
  output have both stopped growing before calling it stuck.
- On failure, read that step's log, fix the cause, and run `scripts/_setup.sh`
  again - re-running is the fix path, not a reset. If the same step fails twice
  for the same reason, stop and raise it in `SPECIFICATION-FEEDBACK.md`.
- Prove re-entrancy: once it has succeeded, run `scripts/_setup.sh` once more and
  check that every step reports `skipped` rather than rebuilding.

## 7. Verify and report

Run `zen check` again and fix whatever it names rather than working around it.
It validates structure and says nothing about the prose, so work §9 of the
copilot instructions as a checklist afterwards and report each group pass or
fail. Then report in the chat:

- what changed, file by file, and which specification item each change closes
- every prompt or skill line that served no specification item, and what became
  of it - corrected, or reported and left alone
- the outcome of every `scripts/_setup.sh` step, and what each one produced
- what is still open, with a pointer to its `SPECIFICATION-FEEDBACK.md` entry
- anything you found that the specification does not cover at all

## 8. Record the pass

Last, and only once §6 and §7 have actually passed. Write
`.spec-sync/history/<stamp>.md` in the format the `zen-spec-sync` skill gives -
including `Still open`, which is the only place the next pass learns that an
unchanged specification line is not yet implemented - and then:

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh commit
```

In that order, never the other way. Moving the baseline before the pass has
finished records a specification as applied that was not: the next pass diffs
against it, sees nothing to do, and the work is never done by anybody. A pass
that fails with the baseline unmoved costs one repeat.

A pass that changed nothing still writes a history file and still commits. Say
in the chat which history file you wrote and that the baseline moved.

Do not report a specification item as done unless the file that implements it
exists, `zen check` passes, and `scripts/_setup.sh` completed every step it owns.
