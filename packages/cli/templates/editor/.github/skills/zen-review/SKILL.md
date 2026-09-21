---
name: zen-review
description: Checking a project before committing - the four mechanical checks `/project-review` makes before any judgement (`zen check`, the §2.5 path sweep, the memory house-rules copy, the spec-sync record), what each one owns, what their exit codes mean, which findings hand off to `zen-instructions`, and what deliberately has no check because no tool can make it. Load before running `/project-review`, before saying a project is ready, and whenever a review finding needs verifying rather than restating.
---

# Reviewing a project

A review of an agent project is two jobs wearing one name. One half is
decidable - a schema is valid or it is not, a path resolves or it does not, a
copy matches its reference or it does not - and a human doing it by hand gets it
wrong in the same three places every time. The other half is judgement: whether
an agent has one job, whether a description routes, whether a number is in the
wrong file.

This skill owns the first half, so the prompt can be all of the second.

## The one command

From the project root, or anywhere at all:

```sh
.github/skills/zen-review/scripts/review.sh
```

It runs four checks in the order a reviewer needs them and prints a summary:

| Step        | Runs                                       | Owns                                         |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| `zen check` | the CLI                                    | everything decidable about the configuration |
| `paths`     | `zen-review/scripts/check-paths.sh`        | paths a running agent cannot open - §2.5     |
| `memory`    | `zen-memory/scripts/check-instructions.sh` | the house-rules copy, byte for byte - §5.3   |
| `spec-sync` | `zen-spec-sync/scripts/snapshot.sh status` | whether the record of the last pass is sound |

Every step runs even when an earlier one fails, because a review that stops at
the first problem is one somebody has to run four times. The exit code is `1` if
any step wants attention and `0` if none does. `review.sh fast` passes
`--no-models --no-sandbox` to `zen check`, which is the right call while
iterating and the wrong one before committing - a key that authenticates says
nothing about the model id it is spent on.

Nothing below matters while `zen check` fails. Report what it said and fix that
first.

## The two scripts this skill ships

### `check-paths.sh` - the §2.5 sweep

A running agent's whole world is four paths: `/workspace`, `/assets`, `/skills`
and `/memory`. Every path-shaped token in `agents/*instructions.md`,
`agents/prompts/*.md` and a skill's markdown is read by a model as an
instruction to open something, so anything outside those four is an instruction
to open a file that is not there.

```sh
.github/skills/zen-review/scripts/check-paths.sh        # each candidate, with file and line
.github/skills/zen-review/scripts/check-paths.sh raw    # the tokens alone, unfiltered
```

It exits `1` whenever it prints a candidate, because the list is meant to be
emptied or explained rather than skimmed. It strips urls before tokenising, skips
a handful of English constructions that contain a slash, and leaves
`agents/memory-instructions.md` out entirely - that file is worked examples by
design, and `check-instructions.sh` is the check it actually needs.

Everything it does print is either noise the script has not learned yet or a
real finding. There is no third case. A candidate that is genuinely noise is a
one-line addition to `NOISE` in the script - **upstream**, see below, not in the
copy sitting in this project.

`raw` is the sweep with nothing filtered, for when you suspect the filter.

### `check-instructions.sh` - the memory house rules

Lives in the `zen-memory` skill, because it is about memory and it is read at
the moment that skill is:

```sh
.github/skills/zen-memory/scripts/check-instructions.sh        # the verdict
.github/skills/zen-memory/scripts/check-instructions.sh diff   # and every differing line
.github/skills/zen-memory/scripts/check-instructions.sh fix    # copy the reference over
```

`agents/memory-instructions.md` must be a byte-identical copy of the `zen-memory`
skill's `references/memory-instructions.md`, and the reference is rewritten by
every `zen init` and `zen open`, so the copy goes stale without anyone touching
it. It drifts by **trailing whitespace inside tables**, which is invisible on
screen - this is the check no one should be asked to make by eye. When the
difference is whitespace alone the script says so, because that is the usual
cause and the least believable finding.

`fix` is the one-line `cp` and nothing else. Project policy belongs in
`agents/memory-policy-instructions.md`, which filename order puts directly after
the copy - see the `zen-memory` skill.

## Findings that are not yours to fix in place

`zen check` reports `rules.stale`, `memory.uninstructed`, `fork.uninstructed`,
`rules.requires.unknown` or `rules.unreached` against a file under `agents/`, and
the obvious repair - open it and edit it - is wrong for three of those files.
`tools-instructions.md`, `memory-instructions.md` and `fork-instructions.md` are
`zen`'s copies: `zen check --fix` replaces them, so an edit made inside one is
gone at the next fix, `init` or `open`.

**Load `zen-instructions` before acting on any of those findings**, and before
judging a house rule at all. It owns which documents belong to whom, where a
project's own rules on the same subject go instead, what `requires:` does, and
what filename order decides. A review that fixes one of ours in place has
undone itself by the next `zen open` and left nothing behind to say so.

## What has no check, on purpose

Not because it would be hard, but because the answer would be wrong:

- **Whether an agent has one job.** Read the prompt.
- **Whether a description routes.** Two overlapping descriptions both parse.
- **Whether a fact belongs in a skill.** A threshold in a prompt is valid YAML.
- **Whether a tool grant is justified.** `zen check` confirms the selector
  resolves, never that the agent needs it.
- **Whether the newest spec-sync history entry is honest.** A pass can claim
  anything; only reading the diff says whether it did it.

That list is `/project-review`, and §9 of the copilot instructions is the long
form. Run the script first so the prompt is spent on this.

## Where these scripts live, and why edits to them vanish

`zen init` and `zen open` rewrite the whole `.github/` tree from the version of
`zen` in hand. These scripts arrive with it, so a change made to the copy in a
project is gone at the next `open`. A filter that should hold for every project
belongs in the distribution - `packages/cli/templates/editor/.github/skills/` in
the @zenera/neo repository - and reaches this project the next time the tree is
written.

Do not confuse these with a project's own scripts. `agents/skills/<name>/scripts/`
is run by **the project's agents**, inside the sandbox, at
`/skills/<name>/scripts/…`. `.github/skills/<name>/scripts/` is run by **the
editor's assistant**, on the host, at a workspace path. The two have different
readers and neither can see the other.
