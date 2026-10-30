---
name: zen-review
description: Checking a project before committing - the three mechanical checks `/project-review` makes before any judgement (`zen check`, the §2.5 path sweep, the spec-sync record), what each one owns, what their exit codes mean, which findings hand off to `zen-instructions`, and what deliberately has no check because no tool can make it. Load before running `/project-review`, before saying a project is ready, and whenever a review finding needs verifying rather than restating.
user-invocable: false
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

It runs three checks in the order a reviewer needs them and prints a summary:

| Step        | Runs                                       | Owns                                         |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| `zen check` | the CLI                                    | everything decidable about the configuration |
| `paths`     | `zen-review/scripts/check-paths.sh`        | paths a running agent cannot open - §2.5     |
| `spec-sync` | `zen-spec-sync/scripts/snapshot.sh status` | whether the record of the last pass is sound |

Every step runs even when an earlier one fails, because a review that stops at
the first problem is one somebody has to run three times. The exit code is `1` if
any step wants attention and `0` if none does. `review.sh fast` passes
`--no-models --no-sandbox` to `zen check`, which is the right call while
iterating and the wrong one before committing - a key that authenticates says
nothing about the model id it is spent on.

Nothing below matters while `zen check` fails. Report what it said and fix that
first.

## The script this skill ships

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
a handful of English constructions that contain a slash, and leaves the four
copies `zen` ships (`agents/{files,fork,memory,tools}-instructions.md`) out
entirely - they are worked examples by design, and `zen check` keeps them
byte-identical (`rules.stale`).

Everything it does print is either noise the script has not learned yet or a
real finding. There is no third case. A candidate that is genuinely noise is a
one-line addition to `NOISE` in the script - **upstream**, see below, not in the
copy sitting in this project.

`raw` is the sweep with nothing filtered, for when you suspect the filter.

## Findings that are not yours to fix in place

`zen check` reports `rules.stale`, `files.uninstructed`, `memory.uninstructed`,
`fork.uninstructed`, `rules.requires.unknown` or `rules.unreached` against a
file under `agents/`, and the obvious repair - open it and edit it - is wrong for
four of those files. `tools-instructions.md`, `files-instructions.md`,
`memory-instructions.md` and `fork-instructions.md` are `zen`'s copies:
`zen check --fix` replaces them, so an edit made inside one is gone at the next
fix, `init` or `open`.

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
