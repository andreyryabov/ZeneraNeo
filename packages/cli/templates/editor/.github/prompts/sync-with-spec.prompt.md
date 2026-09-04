---
description: Bring the project into compliance with SPECIFICATION.md, and record every open question in SPECIFICATION-FEEDBACK.md.
---

Make this project match `SPECIFICATION.md`. The specification is the intent;
the files are the implementation. Where they disagree, the specification wins —
except where it is ambiguous, contradictory or impossible, which is what
`SPECIFICATION-FEEDBACK.md` is for.

## 1. Read before changing anything

Read, in this order, and do not edit until all of it is read:

1. `SPECIFICATION.md` — what the system is meant to be.
2. `agents.yaml` — providers, models, embeddings, agents, tools, handoffs,
   skills, sandbox.
3. `INSTRUCTIONS.md` and every file under `agents/prompts/`.
4. Every `agents/skills/*/SKILL.md`, plus what each skill folder ships.
5. `assets/`, `sandbox/Dockerfile` and every script under `scripts/`, starting
   with `scripts/_setup.sh`.
6. `SPECIFICATION-FEEDBACK.md`, if it exists — do not re-raise something already
   open there.

Run `zen check` first and record what it said. A project that does not load is
the first thing to fix.

## 2. Build the difference

Produce a difference list before touching a file. For every item in the
specification, decide which of these it is:

- **present and correct** — leave it alone
- **missing** — the specification asks for it and nothing implements it
- **divergent** — implemented, but not as specified
- **extra** — implemented, and the specification does not ask for it
- **unclear** — the specification does not say enough to implement it

Check at least: the model and embedding ids and which agent uses which; that
every agent named in the specification exists with that job and no second job;
handoff edges and fork permissions; the tools each agent holds; every skill the
specification implies; and every setup step, index or asset it depends on.

Then build the difference the other way, because the list above can only find
what the specification asked for and nothing implements. Read `INSTRUCTIONS.md`,
each `agents/prompts/*.md` and each `SKILL.md` **line by line**, and for every
line name the specification item it serves. A line serving none is an **extra** —
the category covers a single sentence in a prompt, not only a whole file. Three
things to look for while reading, none of which the forward pass can see:

- **A line that contradicts another file.** One prompt against another, a prompt
  against `INSTRUCTIONS.md`, or a prompt against `agents.yaml` — an instruction
  to use a tool the agent does not hold, to hand to an agent that is not in its
  `handoffs:`, or to load a skill outside its `allow:`.
- **A line that asks for something the system already supplies.** A question put
  to the user about a value that arrives from the environment, a file or an
  earlier step is unanswerable, and the answer would be discarded.
- **A line the agent cannot carry out** — naming a path it cannot reach, a tool
  it was not granted, or an agent it cannot transfer to.

These are bugs whatever the specification says: fix them in place and report each
one. An extra that is merely unspecified is reported under `➕`, not removed.

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

Do not invent a value the specification does not state — a model id, a limit, a
retry count, a file path. That is an entry in `SPECIFICATION-FEEDBACK.md`, not a
guess.

## 4. Every setup step is a script

Anything the project needs done before it can run — building an index, fetching
a document, generating a file, warming the sandbox image — is a shell script,
not a paragraph of instructions for a human.

- One step per file, under `scripts/`, named after the step:
  `scripts/build-schema-index.sh`, `scripts/fetch-api-docs.sh`.
- `scripts/_setup.sh` is the **only** entry point — the leading underscore is
  what separates the runner from the steps it runs. It runs the steps in the
  order they depend on each other and is the single command that initialises the
  project. Consolidate any setup script that lives elsewhere into this shape,
  including one left at the project root.
- Every script starts `set -eu`, works from any working directory
  (`cd "$(dirname "$0")/.."` first), needs no arguments, and exits non-zero on
  failure so `scripts/_setup.sh` stops rather than continuing on a broken step.
- **Re-entrancy is required.** Running `scripts/_setup.sh` a second time must be
  safe. A step whose output is present and newer than its inputs prints that it
  is up to date and returns 0; otherwise it redoes the work idempotently, writing
  to a temporary path and moving it into place so an interrupted run never leaves
  a half-built artefact behind. `scripts/_setup.sh --force` redoes everything.
- **It must be watchable.** `scripts/_setup.sh` tees each step's output to
  `.tmp/logs/setup-<step>.log`, prints a heartbeat line while a long step runs,
  and finishes with one line per step: `ok`, `skipped`, or `failed`.
- **Everything transient goes under `.tmp/`** — logs, scratch files, downloads,
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

Group entries under these headings, and omit a heading that has no entries.
The file is scanned before it is read, so keep the emoji on every heading:

```markdown
# Feedback on SPECIFICATION.md

## 🛑 Blocking — cannot implement without an answer

## ❓ Ambiguous — implemented one way, confirm the choice

## ⚡ Contradictions

## ✏️ Errors and typos

## ➕ Out of scope — implemented but unspecified
```

Each entry is one bullet, opening with the emoji of the heading it sits under,
then four parts in this order:

- **What the specification says**, quoted, with the section it is in.
- **Why it cannot be implemented as written** — the specific gap, not "unclear".
- **What was done in the meantime**, or "nothing — blocked".
- **The question**, phrased so a one-line answer unblocks it.

Use no other emoji anywhere in the file — one per entry is what makes them
scannable. Keep entries factual and short. Do not editorialise about the
specification's quality, do not restate the runtime, and do not copy the whole
section in.
Append to the existing file rather than rewriting it; strike an entry only when
this pass has actually resolved it, and say in the chat which ones you closed.

## 6. Run `scripts/_setup.sh` and watch it finish

After `zen check` passes, run `scripts/_setup.sh` yourself. A pass is not done
until it has run to completion in this session.

It is slow — an embedding index is minutes, not seconds — so start it in the
background and follow the logs instead of waiting blind:

- Tail `.tmp/logs/setup-*.log` and check the output artefact is still growing.
- Report progress as you go: which step is running, how long it has been going,
  what the last log line said.
- Do not kill a quiet step. Confirm the process is dead or the log and the
  output have both stopped growing before calling it stuck.
- On failure, read that step's log, fix the cause, and run `scripts/_setup.sh`
  again — re-running is the fix path, not a reset. If the same step fails twice
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
  of it — corrected, or reported and left alone
- the outcome of every `scripts/_setup.sh` step, and what each one produced
- what is still open, with a pointer to its `SPECIFICATION-FEEDBACK.md` entry
- anything you found that the specification does not cover at all

Do not report a specification item as done unless the file that implements it
exists, `zen check` passes, and `scripts/_setup.sh` completed every step it owns.
