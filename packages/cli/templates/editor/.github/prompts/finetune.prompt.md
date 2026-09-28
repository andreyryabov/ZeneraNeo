---
description: Fine-tune this project against a training set in two stages - first without memory, tuning the prose; then with memory, tuning recall for speed.
---

Tune this project against real queries. Nothing here touches model weights: the
parameters are the agent prompts, the skills and the house rules under `agents/`,
and the evidence is the trajectories the queries produce.

**Load the `zen-finetune` skill before anything else**, and load `zen-inspect`
before you grade, `zen-instructions` before you write a policy file, and
`zen-sandbox-capacity` if a batch dies at 137 or 124. This prompt is the order of
the work; the skill is how each step is done, and it holds the rules that are
easy to get wrong.

## The two stages

This is two stages, run in order, never interleaved. Say which stage you are in
at the top of every report.

**Stage 1 - without memory.** Every batch runs against an empty memory, so every
run starts from nothing and the result is attributable to the prose. Here you
tune agent prompts, `agents/instructions.md`, and the project's skills - creating
or updating them. The runs still _write_ memory, into their own throwaway graphs,
and what they write is graded too: the commits have to be generalisable, durable
facts, not cached live readings. Stage 1 optimises **correctness**.

**Stage 2 - with memory.** Only once stage 1 is stable and well behaved. The
prompts, skills and house rules are now frozen; the merged memory from the last
good cold batch is shared read-only across the same cases, and the only file you
edit is `agents/memory-policy-instructions.md`. Stage 2 optimises **memory use
and memory correctness**, and the expected result is a dramatic drop in tokens
and wall clock through reuse, with no verdict changed.

Do not start stage 2 while any sample still fails cold. Memory will hide the
defect and it will come back the day the graph is rebuilt.

## 0. Before the first round

Name the training set. If I have not given you one, ask - a specification
section, a file of examples, a transcript, a CSV. Fewer than about eight queries
is a debugging session, not a tuning loop; say so and read the runs singly
instead.

Then run the mechanical checks and report what they say:

```sh
zen check
.github/skills/zen-review/scripts/check-paths.sh
```

A project that does not load fails every item for one reason. Do not start a
round until `zen check` passes.

## 1. Dataset

Build `.finetune/dataset.json` if it is not there, and read it if it is. Read the
source yourself and write the structure out - do not write a parser. Rubrics are
copied **verbatim**, one entry per bullet. Classify only the distinctions the
source already makes, and rate complexity by the trajectory the query demands,
not by the length of the sentence. Keep ids stable across re-extractions.

## 2. Stage 1: sample, preflight, run cold

```sh
.github/skills/zen-finetune/scripts/sample.sh -n 16 --seed 1 -o .finetune/rounds/r1/cases.json
.github/skills/zen-sandbox-capacity/scripts/preflight_sandbox.sh --concurrency 8
zen run batch --input .finetune/rounds/r1/cases.json \
    --batch-dir .finetune/rounds/r1/batch --memory .finetune/empty --concurrency 8
```

Every stage-1 round is cold and every round re-uses the first round's
`cases.json`. A warm graph lets a run succeed by recall instead of by
instruction, and a re-sampled batch means a moved score has two causes and you
cannot tell which.

## 3. Stage 1: grade

`collect.sh oom` first - a round with any exit 137 is void, is not graded, and
its tokens are compared to nothing. Then read the graphs before the numbers.
Grade every item against all eight criteria in the skill: rubric compliance,
optimality, memory hygiene, fork, delegation, tools and skills, grounding,
failure handling. **Cite a node id for every finding.** A finding you cannot
point at in the graph did not happen.

Grade the memory each item _wrote_ as seriously as the answer it gave. Read
`<id>/memory/` across the batch: every commit should be an operation, a pointer,
a shape or a rule that is still true next week. A cached live reading poisons
every future run, and committing nothing after learning something durable throws
the round away. Commit policy is fixed here, cold, while the cause is still
attributable - not in stage 2.

Write `.finetune/rounds/rN/findings.md`: the verdict block first - `PROGRESS`,
`NO CHANGE`, `REGRESSION`, `MIXED` or `VOID`, the `memory:` and `machine:` lines
as printed, and the `compare` table - then the per-sample grading. The heading
says `COLD` or `WARM`.

## 4. Stage 1: generalise, then apply

Collect every finding into one table before writing a word of instruction. The
unit of change is a pattern across findings, not a finding: three items missing
the same beat is a rule, one item is a note in `findings.md`. Write the rule one
level up from the sample that produced it - a rule that names the dataset's own
endpoints makes the eval pass and the product fail. Prefer mechanical wording,
and remember that a prohibition with a self-judged exemption is a permission.

Route each rule by what kind of thing it is: one agent's behaviour to its prompt,
a fact or a procedure to a skill - update an existing one or create a new one, a
standing rule to `agents/instructions.md`, a rule about one capability to a new
`agents/<topic>-policy-instructions.md`.

You may edit prompts, skills, house rules and new policy files. You may not edit
`agents/memory-instructions.md`, `agents/fork-instructions.md`,
`agents/tools-instructions.md` or `agents/files-instructions.md` - `zen check
--fix` overwrites them. You may not change a rubric to make a run pass. Tell me
before you change `agents.yaml`; that finding is structural.

Record every edit and the finding numbers behind it in
`.finetune/rounds/rN/changes.md`, then run `zen check` again.

## 5. Stage 1: loop, and leave the stage

Re-run the same cases into a new round directory and compare per sample and on
the aggregate. The verdict column decides, not the token column. A sample that
passed and now fails is the most valuable result in the round and is almost
always the new instruction. If the instruction files grew by a third and the
score moved by one sample, revert and say so.

Report to me after each round and wait: the verdict block, what you changed, and
what you propose to change next. Stop when a round produces no generalisable
pattern - that is the remaining failure being the model's rather than the prose's.

Stage 1 ends when, on one cold round, **every sample holds** and **what the runs
wrote to memory is worth keeping**. Tell me both before proposing stage 2.

## 6. Stage 2: memory

Freeze the prompts, the skills and the house rules. Merge the last good cold
round's memory into one graph, read `zen memory stats`, and run the same cases
shared and `--memory-read-only`. Compare against the cold round the memory came
from.

The target is reuse: recall should replace the discovery the cold runs repeated
every time, so the warm batch is dramatically cheaper in tokens, calls and wall
clock with no verdict changed. A warm round that costs about the same, or more,
means memory was carried and not used - that is a recall-timing finding, not a
reason for more memory. A warm round that is much cheaper still needs one
trajectory opened to confirm the saving is recall replacing _discovery_ and not
recall replacing a _live reading_.

In stage 2 the only file you edit is `agents/memory-policy-instructions.md`. Keep
the merged graph fixed for the whole stage; re-merging between rounds changes the
memory and the prose at once. If a finding cannot be written as a recall rule, it
is a stage-1 finding that escaped - tell me, and we re-open stage 1.

Stage 2 ends when no verdict regressed, the saving is obvious next to the noise
floor, and every large saving is explained.

Commit `dataset.json`, `cases.json`, `findings.md` and `changes.md`. Add
`.finetune/rounds/*/batch/` and `.finetune/empty/` to `.gitignore` - the batch
directories are large and may hold live API responses.
