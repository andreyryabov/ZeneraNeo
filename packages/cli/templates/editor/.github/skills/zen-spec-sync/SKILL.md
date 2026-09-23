---
name: zen-spec-sync
description: Running `/spec-sync-project` as an incremental pass - the committed `.spec-sync` baseline of what the last pass applied, how to scope a pass from the specification and feedback diffs and from what moved in the project itself, the five checks a narrow pass may never skip, which skills a pass must load before editing (`zen-instructions` for any house rule it touches), the iteration history format, and why the baseline is written last. Load before every `/spec-sync-project`, including the first one on a project that has no baseline yet.
---

# Syncing a project with its specification, one change at a time

`SPECIFICATION.md` is the intent and the files are the implementation, so
bringing the two together is a pass over the whole project. Done from nothing
every time, that pass re-reads every prompt, re-derives every decision the last
one already made, and re-raises questions someone has already answered.

A pass is worth repeating cheaply, so it keeps a record of **what it applied**.
The next pass diffs the specification against that record and works the
difference. What it must not do is confuse a narrow diff with a narrow
obligation: the record scopes what you _read and edit_, never what you _verify_.

## What this owns

Everything is committed. `.spec-sync/` is a record, not scratch - `.tmp/` is
scratch.

```
.spec-sync/
├── baseline/
│   ├── SPECIFICATION.md              the spec the last completed pass applied
│   ├── SPECIFICATION-FEEDBACK.md     the questions it had open, if any
│   ├── agents.yaml                   the wiring it left behind
│   ├── agents/                       and every instruction, prompt and skill
│   ├── applied.txt                   the history entry this baseline belongs to
│   └── manifest.txt                  sha256 of every file above
└── history/
    └── 2026-09-13T104500Z.md         one file per pass, never edited after
```

The baseline mirrors the paths it records, so `baseline/agents/skills/x/SKILL.md`
is that skill as the last completed pass left it. Both sides are there on
purpose: the specification and the feedback say what was **asked for**, the
wiring and the `agents/` tree say what was **built**, and a pass has to know
which of the two moved.

The baseline is **not a copy of the current specification**. It is the
specification as the last completed pass left it, which is what makes the
difference between the two mean "work nobody has done yet".

`zen init` creates `baseline/` and `history/` empty, and git does not carry an
empty directory, so **the presence of `.spec-sync/` proves nothing**. The
manifest is the signal: no `manifest.txt` means no pass has ever completed.

## Deciding the size of the pass

Run this first, from the project root:

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh status
```

It prints one `mode:` line, the `applied:` stamp the baseline belongs to, and a
`changed:` line per file that differs - specification, feedback, `agents.yaml`
or anything under `agents/`:

| Mode          | Means                                      | Do                                                                                    |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `full`        | no manifest - no pass has ever completed   | the whole prompt as written, then write the first baseline                            |
| `incremental` | a baseline is there and the files differ   | scope from the four inputs below                                                      |
| `tampered`    | a baseline file does not match its own sha | treat as `full`, and say in the chat which file and that the baseline was not trusted |

`tampered` is either a baseline edited by hand or a pass that died between
copying the files and writing the manifest. Both mean the record is not
evidence. Do not rewrite `manifest.txt` to make the message go away - that
asserts a pass happened that did not.

`snapshot.sh diff` then prints the unified diffs, and is where the pass
actually starts.

## The four scope inputs

An incremental pass is scoped by the union of these. Write the union down before
editing anything, and report it in the chat as the pass's scope.

1. **The `SPECIFICATION.md` diff.** The primary input: added, changed and
   deleted requirements. A deleted requirement is work too - what implemented it
   is now an **extra**, to be reported under `➕` rather than quietly deleted.
2. **The `SPECIFICATION-FEEDBACK.md` diff.** The file is a questionnaire the
   human answers by ticking one answer's `[ ]` box or deleting the answers they
   do not want. A question that has moved under `✅ Answered` was folded into the
   specification by `/spec-apply-feedback`, and its **Still to implement**
   line is the work. A question with a box marked `[x]`, or one answer left
   under it, and no `✅` entry was answered and never folded in - implement it,
   put its text into `SPECIFICATION.md`, and say so. A new question someone else
   raised is work too. Close what this pass resolves rather than re-raising it.
3. **What the last pass left open.** The `Still open` section of the entry named
   by `applied:`, in `.spec-sync/history/`. A specification line that has not
   changed since the baseline is **not therefore implemented**: the baseline
   records what the pass applied, and a pass can complete with items open. This
   is the only place that says which.
4. **The implementation diff.** `agents.yaml` and every file under `agents/` -
   instructions, prompts and skills. This side is what was built rather than
   what was asked for, so it never narrows a pass: it says what moved under you
   since the last one. An agent, tool grant, handoff, model, house rule, prompt
   or skill edited outside a pass **widens** the pass to everything that names
   what changed, and the edit is itself an item - either the specification
   covers it, and you say which line, or it does not, and it is an **extra**
   reported under `➕`.

## The five checks a narrow pass may never skip

However small the diff:

1. **`zen check` passes.** Run it before the first edit and again after the
   last.
2. **`scripts/_setup.sh` has run to completion in this session, and re-runs
   clean.** A one-line specification change can still break a setup step, and a
   pass that did not run it does not know. `skipped` is only a pass if the
   artefact really is usable: for every index the project builds, check
   `zen rag <subject> ready --dir <dir>` agrees. A step that tests for a
   committed `manifest.json` skips on a fresh clone whose git-ignored `lance/`
   vectors are missing, and the project cannot search.
3. **§9 of the copilot instructions, worked as a checklist**, group by group.
4. **The capability obligations in §0.1.** For every capability the project has
   turned on, load that capability's skill and re-check what it requires - in
   particular that `agents/memory-instructions.md` is still byte-identical to
   `.github/skills/zen-memory/references/memory-instructions.md`. `zen init` and
   `zen open` rewrite the reference, so this drifts without anybody editing the
   project.
5. **`zen-instructions` is loaded before any house rule is touched.** A pass
   whose scope reaches `agents/*instructions.md` - and input 4 puts it there
   whenever one of them moved - has to know that `tools-instructions.md`,
   `files-instructions.md`, `memory-instructions.md` and `fork-instructions.md`
   are `zen`'s and are replaced by `zen check --fix`. A pass that writes a
   requirement into one of them has implemented nothing: the next `open` reverts
   it, the history entry claims it, and the baseline records it as applied.
   Specification-driven rules go in a topic file of the project's own beside it.

A narrow diff narrows reading and editing. It does not narrow verification.

## What else an incremental pass still owes

The reverse pass of §2 - reading each line and naming the specification item it
serves - runs over every file this pass touched, plus every file the
implementation diff named. It is the only pass that finds a line contradicting
another file, and an edit made this session, or made by hand since the last
pass, is exactly where a new contradiction comes from.

## The history entry

One file per pass, `.spec-sync/history/<stamp>.md`, where the stamp is UTC and
filename-safe: `date -u +%Y-%m-%dT%H%M%SZ`. Never edit a file that is already
there; a pass that did nothing still writes one saying so.

These headings, in this order, because the next pass reads them:

```markdown
# Sync pass 2026-09-13T104500Z

- **Mode** - incremental
- **Spec sha** - 3f9a… (`shasum -a 256 SPECIFICATION.md`)

## Scope

What drove the pass: the diff hunks, the feedback entries, what the last pass
left open. `full` if it was a full pass.

## Changed

One row per file changed, and the specification item it closes.

## Feedback

Entries opened and entries closed, by number.

## Still open

Every specification item this pass did **not** close, with its
`SPECIFICATION-FEEDBACK.md` anchor. Empty means empty - this is what the next
pass trusts.

## Checks

`zen check`, each `scripts/_setup.sh` step, and the §9 groups: pass or fail.
```

## Write the baseline last

The one rule that must not be got wrong.

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh commit
```

runs **after** `zen check` passes, **after** `scripts/_setup.sh` has completed,
and **after** the history file is on disk. It takes the newest entry in
`.spec-sync/history/` - the stamps sort chronologically by name - records it in
`applied.txt`, and writes `manifest.txt` last of all. It refuses to run when
there is no history file, and when the newest one is the entry `applied.txt`
already names: that means this pass wrote no entry of its own.

A pass that moves the baseline early and then fails records a specification as
applied that was never applied - and the next pass diffs against it, sees
nothing, and skips the work for good. Failing with the baseline unmoved costs
one repeated pass; failing with it moved costs a requirement that is never
implemented and that nothing will report. Say in the chat which history file was
written and that the baseline moved.

## The first pass on a project that has no baseline

`mode: full`, so run the prompt as written, end to end. Then write the history
file and commit the baseline exactly as any other pass does - a project only
becomes incremental by having completed one full pass.
