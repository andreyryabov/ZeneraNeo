---
description: Fine-tune this project against a training set in two stages - first with no memory, fixing the instructions; then with memory, making the same work cheaper - a batch at a time, each batch mixing new cases with rechecks of earlier and difficult ones, until every case is used and no difficult case is open.
---

Tune this project against real queries. Nothing here touches model weights: what
changes is the prose the project is made of - the agent prompts, the skills and
the house rules under `agents/` - and the evidence is the trajectories the
queries produce.

**Load the `zen-finetune` skill before anything else**, and load `zen-inspect`
before you grade, and `zen-instructions` before you write a policy file. This
prompt is the order of
the work; the skill is how each step is done, and it holds the rules that are
easy to get wrong.

This prompt is **reentrant**. Tuning is long and gets interrupted - a run dies, a
session ends, I stop you mid-batch. Every step leaves its result on disk under
`.finetune/`, so a second invocation does not start over: it reads that state,
works out where the work stopped, says so, and carries on from there unless I
tell you otherwise.

## Words used here

Use these words, and only these, in everything you write - findings, README,
reports to me. Two words for one thing is how a reader loses the thread.

| Word                 | Means                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **case**             | one query from the training set, with its rubric if it has one                                |
| **dataset**          | every case in the training set, `.finetune/dataset.json` - never cut down                     |
| **limit**            | how many cases this tuning uses - the whole dataset, unless I gave a smaller number           |
| **selection**        | those cases, chosen evenly by class, `.finetune/selection.json`                               |
| **batch**            | the cases worked on together until they all pass: new ones plus rechecks - see below          |
| **batch size**       | how many new cases each batch takes from the selection                                        |
| **recheck cases**    | cases from earlier batches, run again - difficult ones first                                  |
| **run**              | one execution of a batch. The first is run 1; after fixes, the same cases again are run 2     |
| **passed**           | a batch whose latest run got every case right AND whose cost review found nothing left to cut |
| **concurrency**      | how many cases execute at the same time inside a run - `min(batchSize, 16)`, halved on OOM    |
| **stage 1**          | runs with **no memory**: fix the instructions                                                 |
| **stage 2**          | runs **with memory**: make the same work cheaper                                              |
| **trajectory**       | what one case did in one run - its graph                                                      |
| **difficult case**   | a case that caused real trouble - listed in `.finetune/difficult.json`, retested until fixed  |
| **last good memory** | everything the passed stage-1 runs committed, merged; always whole on disk                    |

Run directories are `.finetune/runs/stage<1|2>-batch<NN>-run<N>/` -
`stage1-batch03-run2` is stage 1, batch 3, the second run. Each holds a `batch/`
folder: that is `zen run batch`'s own output for that run, named by the command,
not by this method.

## What a batch is

The selection is not run all at once. After one big run there is too much to
read, and after one big edit nobody can say which change helped. So it is
worked a **batch** at a time, and each batch is decided when it is needed:

```
next batch = up to batchSize new cases     (not used yet, classes taking turns)
           + up to recheck earlier cases   (open difficult first, then fixed
                                            difficult, then a random draw)
```

Then the batch is worked until it passes:

1. **Run 1** - run the batch's cases.
2. **Grade** every trajectory - first is it right, then **what did it cost**:
   llm calls, missed forks, discovery it did not need.
3. **Fix** what the grading found: wrong answers first, then cost. Prompts,
   skills, house rules.
4. **Run 2** - the _same_ cases again, to confirm the fix. Same questions, one
   thing changed: this is the only fair test the method has.
5. Repeat 2-4. The batch has **passed** on the first run where every case is
   right **and** the cost review finds nothing more worth changing. At most 4
   runs per batch.

A batch whose run 1 is all correct has **not** passed: that is exactly when the
cost work starts. Being right is the entry ticket; the tuning is making it cheap.

The recheck cases are there to fail - a rule written for batch 3 is read on every
query, and the case it breaks is usually in batch 1.

### Difficult cases, and why the number of batches is not fixed

Some cases cause most of the trouble. Put each on the difficult list the moment
grading shows it - `difficult.mjs add` - and it keeps coming back:

- **Open difficult cases come first** in every later batch's rechecks, until
  fixed.
- **Fixed ones stay ahead of the random draw**, because what was hard once
  breaks again first.
- **When the selection is used up**, a batch is made of open difficult cases
  only. So the tuning takes as many batches as it needs: at least
  limit ÷ batchSize, plus however many the difficult cases take.
- **Stuck is reported, not looped.** A case still open after `maxRetries`
  batches since it was added (default 3) is `stuck` - the model's ceiling or a
  bad rubric - and stops being picked.

A stage is over when **every case in the selection has been used and no
difficult case is open**.

### The last good memory

Every time a stage-1 batch passes, `memory.mjs checkpoint` folds what that run's
cases committed into `.finetune/memory/`, building each new graph beside the old
one and switching only when it is complete. `next.mjs` will not let the next
batch be built until that is done. So whenever the tuning stops - finished, or
killed mid-run - `memory.mjs path` names a whole graph holding everything the
passed batches learned, ready for stage 2 or to promote into `memory/`.

## The two stages

Run in order, never interleaved. Say which stage you are in at the top of every
report.

**Stage 1 - no memory.** Every run starts from an empty memory, so a right answer
is the instructions' doing and not something remembered. Here you tune agent
prompts, `agents/instructions.md` and the project's skills - creating or
updating them. The runs still _write_ memory, each into its own throwaway graph,
and what they write is graded too: commits must be durable, generalisable facts,
not cached live readings. Stage 1 optimises **correctness** first, then the cost
of getting there - fewer llm calls, then better fan-out with forks, then fewer
things discovered that could have been known.

**Stage 2 - with memory.** Only once stage 1 is done. The prompts, skills and
house rules are frozen; every case gets its own copy of the last good memory,
and the only file you edit is `agents/memory-policy-instructions.md`. Stage 2
replays **the stage-1 batches in the same order** - `batch.mjs next --stage 2`
copies them - so each is compared against the same cases, then adds batches for
its own difficult cases. It optimises **memory use and memory correctness**, and
the expected result is a dramatic drop in tokens and wall clock with no verdict
changed.

Do not start stage 2 while stage 1 is not done. Memory will hide the defect, and
it will come back the day the graph is rebuilt.

## The README

`.finetune/README.md` is the page I read to know what is going on. **You write
it**, by hand, for a person who has never seen this project - not a log dump.
Start from `.github/skills/zen-finetune/references/readme-template.md`.

- **Before the first run**, write it whole: what is being tuned and why, the
  dataset by class, the limit and how the cases were chosen, what a batch is,
  the two stages, the settings - and a mermaid **map** from the dataset to the
  final check, with the minimum number of batches of each stage drawn ahead.
- **After every step** - a run finishing, a run graded, edits applied, a batch
  passing, a stage ending - patch it: "Where we are", the map (move nodes between
  the `done` / `now` / `ahead` / `failed` classes, update their labels, add a
  node when a batch beyond the minimum is built), the batch's row, "Difficult
  cases", a log entry, "Results so far" when a batch passes, and "Next".

The map is the first thing I look at: it must always show exactly one `now` node,
everything behind it as done, and everything ahead of it as ahead, with a line
saying what is left - unused cases and open difficult ones. Link me to the README
in your reports instead of re-typing it.

## Where you are - work this out before anything else

Do this every time this prompt runs, including the first:

```sh
.github/skills/zen-finetune/scripts/next.mjs
.github/skills/zen-finetune/scripts/batch.mjs      # progress: used, left, difficult
```

`next.mjs` reads the whole `.finetune/` tree and prints the next step. Do not
re-derive the state from an `ls`. Map what it says onto this prompt:

| What `next.mjs` says                                          | Go to                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `first: patch .finetune/README.md ...`                        | patch the README, then act on the next line                                       |
| `note: limit N of T cases ...`                                | unless I asked for a cut: section 2, raise the limit and re-select, then carry on |
| `build .finetune/dataset.json ...`                            | section 0, then 1                                                                 |
| `write .finetune/config.json ...`                             | section 2                                                                         |
| `choose the cases: select.mjs ...`                            | section 2                                                                         |
| `write .finetune/README.md: the plan ...`                     | section 2, the README step                                                        |
| `build batch 1: batch.mjs next ...`                           | section 3                                                                         |
| `... the run never finished ...`                              | the run is **void** - see below, then re-run                                      |
| `... not graded yet - report.mjs ... oom ...`                 | section 4                                                                         |
| `... void - out of memory at concurrency C: set ...`          | do exactly that - halve it, re-run the cases                                      |
| `... void - ... the floor ...`                                | stop and tell me - the only machine stop                                          |
| `... says PASSED but has no "## Cost review" ...`             | section 4, the cost review                                                        |
| `... graded, nothing applied ...`                             | section 5                                                                         |
| `edits applied - confirm them: copy ... cases.json ...`       | section 6                                                                         |
| `... says PASSED but applied edits ...`                       | section 6 - confirm them with another run                                         |
| `batch N has had 4 runs - stop tuning it ...`                 | section 6, the run cap                                                            |
| `batch N passed - keep what it learned first: memory.mjs ...` | section 6, the checkpoint                                                         |
| `batch N passed (...) - build batch N+1: batch.mjs next ...`  | section 3 for the new batch                                                       |
| `stage 1 is done ...`                                         | section 6's exit check, then section 7                                            |
| `stage 2 is done ... run the final check ...`                 | section 8                                                                         |
| `done - ...`                                                  | nothing left to tune - report and stop                                            |

Read the latest run's `findings.md` for the verdict and its `changes.md` for what
was already applied. Two things `next.mjs` cannot see, so check them by hand:

- **Uncommitted edits under `agents/` with no `changes.md` to explain them.** An
  apply was interrupted part-way. Read `git status --short agents/` and the diff,
  finish writing `changes.md` from what is actually on disk, then re-run - do not
  layer new edits on top of edits you have not recorded.
- **`zen check` before you resume anything.** A project left broken mid-edit
  fails every case identically and looks like a catastrophic regression.

A run whose `batch/` never got a `batch.json` produced no evidence. Move it aside
rather than grading or deleting it - `mv .finetune/runs/<run>/batch
.finetune/runs/<run>/batch.partial` - and re-run from the same `cases.json`.

A run `report.mjs oom` calls void (any exit 137) is out of memory. Write
`## VOID` in its `findings.md`, halve `concurrency` in `.finetune/config.json` -
never below 4 - and run a copy of its `cases.json` as the next run. A void run is
not graded and does not count toward the run cap. Void at concurrency 4 means
the machine cannot run the batch: stop and tell me.

Resuming never re-selects and never rebuilds a batch. `batchSize`, `recheck` and
`seed` in `.finetune/config.json` are frozen once batch 1 has run. Every later
run of a batch re-uses **run 1's `cases.json`, copied** - never rebuilt, because
the rechecks depend on the difficult list, which moves. `findings.md`,
`changes.md`, `difficult.json` and the README are the record; read them rather
than remembering.

Then tell me, in three lines before you do any work: which stage and batch you
are resuming at and the limit as `limit N of T cases`, which step, and what you
are about to run - and then **keep going**. If I named a stage, a batch or a run,
do that instead of what the state says.

### Run to the end

Once started, run the whole tuning - stage 1, stage 2, the final check - **without
stopping to ask**. Between runs, between batches and **between stages**, report
and carry on. `next.mjs` printing `done - ...` is the only normal end.

Stop and wait for me only when:

- **The machine cannot run the batch** - it ran out of memory at concurrency 4.
- **I asked you to pause** - after each batch, after a stage, or anywhere else.

Everything that used to be a question is now a note that does not stop the work:

- **A structural finding** - the fix needs `agents.yaml`. Do not edit it; write
  the finding under "Open problems" in the README, put the cases it blocks on the
  difficult list, and carry on. It is in the final report.
- **Stage 1 is done.** Post the three exit criteria in section 6 and every
  `stuck` case as a short note, patch the README, and start stage 2 at once.
- **A stage-2 finding that is really a stage-1 one.** Note it under "Open
  problems", finish stage 2, and list it in the final report.

When a batch passes, post a short note - batch, runs it took, cases right, llm
calls and tokens first run to last, what changed, what is left - patch the
README, and build the next batch straight away. Never end your turn with
"proposed next step" or "ready to proceed upon your confirmation"; take the step.

## 0. Before the first run

Name the training set. If I have not given you one, ask - a specification
section, a file of examples, a transcript, a CSV. Fewer than about eight queries
is a debugging session, not a tuning loop; say so and read the runs singly
instead.

Then run the mechanical checks and report what they say:

```sh
zen check
.github/skills/zen-review/scripts/check-paths.sh
```

A project that does not load fails every case for one reason. Do not start until
`zen check` passes.

## 1. Dataset - all of it

Build `.finetune/dataset.json` if it is not there, and read it if it is. **Read
the whole training set and write every case into it** - no limit, no sampling,
no "the first twenty". The dataset is the record of what the project is meant to
handle; the limit is applied later, when cases are selected, and only there.

Read the source yourself and write the structure out - do not write a parser.
Rubrics are copied **verbatim**, one entry per bullet. Classify only the
distinctions the source already makes, and rate complexity by the trajectory the
query demands, not by the length of the sentence. Keep ids stable across
re-extractions. Report the count per class when you are done.

## 2. Settings, selection, README

**Settings.** You now know the dataset size. Set the limit, propose the batch
size, recheck and concurrency, say what each costs, and write them to
`.finetune/config.json` - every script reads its defaults from there:

```json
{
    "datasetSize": 64,
    "limit": 64,
    "batchSize": 8,
    "recheck": 3,
    "concurrency": 8,
    "seed": 1,
    "maxRetries": 3
}
```

- **limit** - **equal to `datasetSize`**: every case in the dataset is tuned
  against. Write a smaller number only when I gave you one. Never cut it on your
  own to save cost or time - a limit below the dataset silently drops cases the
  project is meant to handle.
- **batchSize** - new cases per batch. Small enough that you will actually read
  every trajectory; 6-10 is the usable range. **Not the same as concurrency.**
- **recheck** - earlier cases re-run in each batch. 2-4. Zero means no
  regression guard and no retesting of difficult cases.
- **concurrency** - cases running at once: `min(batchSize, 16)`. Do not size it
  any other way. On an out-of-memory run (exit 137) halve it, never below 4, and
  re-run the same cases. The only setting that changes mid-way.
- **maxRetries** - batches a difficult case gets after it is added before it is
  `stuck`. 3.

**Selection.** Choose the cases:

```sh
.github/skills/zen-finetune/scripts/select.mjs -o .finetune/selection.json
```

It takes the limit from the **whole** dataset, evenly by class - one case from
each class in turn, rotating through complexity levels inside a class,
rubric-bearing cases first - and that order is the order batches take new cases
in. It prints chosen-versus-available per class; report that table to me. A
class with fewer cases than its share gives all it has.

**README.** Write `.finetune/README.md` now, before anything runs - see "The
README" above.

## 3. Build and run a batch

```sh
RUN=.finetune/runs/stage1-batch01-run1
C=$(node -p 'require("./.finetune/config.json").concurrency')
.github/skills/zen-finetune/scripts/batch.mjs next -o "$RUN/cases.json"
zen run batch --input "$RUN/cases.json" \
    --batch-dir "$RUN/batch" --memory .finetune/empty --concurrency "$C"
```

`--concurrency` is always the value in `.finetune/config.json` - read it fresh
for every run, since an out-of-memory run halves it.

`batch.mjs next` prints which cases are new and which are rechecks - put that in
the README's batch row. Then patch the README: the map's `now` node, the row, a
log line.

Every stage-1 run has no memory. A graph with content lets a run succeed by
recall instead of by instruction. `.finetune/empty` is never created - naming a
directory that does not exist is what gives each case an empty memory.

Never hand-write a `cases.json`, and never re-select mid-way. Build a batch once,
for its run 1, with `batch.mjs next`; every later run of that batch gets a
**copy** of run 1's file, which is what makes run 2 comparable to run 1.

## 4. Stage 1: grade

`report.mjs oom` first - a run with any exit 137 is void, is not graded, and its
tokens are compared to nothing. Then read the graphs before the numbers. Grade
every case against all eight criteria in the skill: rubric compliance,
optimality, memory hygiene, fork, delegation, tools and skills, grounding,
failure handling. **Cite a node id for every finding.** A finding you cannot
point at in the graph did not happen.

Grade in this order, because they are not equally urgent:

1. **The recheck cases.** A recheck that passed before and fails now means a
   rule written since broke it, and that outranks every other failure in the
   run - nothing else is worth grading until it is resolved.
2. **Correctness of the new cases.** Rubric compliance gates everything.
3. **The cost of getting there** - as soon as correctness holds, and in the same
   run. llm calls first - read straight off the graph header - then fan-out, then
   discovery the run should not have needed because something authoritative
   could have told it.

**The cost review is not optional.** Every `findings.md` of a run where all cases
are right has a `## Cost review` section - `next.mjs` refuses a `PASSED` without
one. It contains:

- the llm calls per case, the batch's median, and every case above 1.5x the
  median with the reason it cost that much, citing nodes;
- **repeated work** - the same call with the same arguments twice, a loop, a
  search made as four calls that could have been one: the pattern, or `none`;
- **missed forks** - independent calls or sub-tasks run one after another: the
  pattern, or `none`;
- **unneeded discovery** - listing, probing or reading to learn something a
  prompt or skill could simply have stated: the pattern, or `none`.

`none` needs the evidence for it - the trajectory you checked, not the absence
of a look. A case averaging 40+ llm calls almost never has `none` on all three.

Grade the memory each case _wrote_ as seriously as the answer it gave. Read
`<id>/memory/` across the run: every commit should be an operation, a pointer,
a shape or a rule that is still true next week. A cached live reading poisons
every future run, and committing nothing after learning something durable throws
the run away. Commit policy is fixed here, in stage 1, while the cause is still
attributable - not in stage 2.

Write `$RUN/findings.md`: the verdict heading first - `PROGRESS`, `NO CHANGE`,
`REGRESSION`, `MIXED`, `CORRECT`, `PASSED` or `VOID` - the `memory:` and
`machine:` lines as printed, and the `report.mjs compare` table with the recheck
cases marked; then the cost review; then the per-case grading. The title names
the run and says `NO MEMORY` or `WITH MEMORY`. Then patch the README.

`CORRECT` means every case is right but the cost review found something worth
changing - apply it and run again. `PASSED` means every case is right **and** the
cost review found nothing worth changing, so this run applies no edits. It is
load-bearing: `next.mjs` reads it to move on, and refuses it on a run with a
`changes.md` or without a cost review. Never write it on a run that merely
improved, and never on a run you are about to edit after.

**Then update the difficult list** - mechanically, every graded run:

```sh
D=.github/skills/zen-finetune/scripts/difficult.mjs
$D add <id> --why wrong     --run <run> --note "<what goes wrong>"  # wrong after a run that tried to fix it
$D add <id> --why regressed --run <run>                              # a recheck case that failed
$D add <id> --why flaky     --run <run>                              # right before, wrong now, no rule aimed at it
$D add <id> --why costly    --run <run>                              # over 2x the median llm calls in a passing run
$D fix <id> --run <run>                                              # a difficult case right, in a PASSED run
$D                                                                   # the list
```

A case wrong on run 1 is not difficult yet - that is what the batch is for. It
is difficult when it is **still** wrong after a run that tried to fix it.

## 5. Stage 1: generalise, then apply

If a recheck case failed, stop here and revert or narrow the rule that broke it.
Find it in the earlier batches' `changes.md`, undo or qualify it, record the
over-reach, and go straight to the next run. Adding a rule on top of a rule that
over-reached is how a tuning ends with prose nobody can unpick.

Otherwise: collect every finding into one table before writing a word of
instruction - wrong answers and cost findings alike. A cost pattern is a rule
just as a correctness pattern is: "these three cases each listed the directory
to find a file the skill could name" becomes a line in that skill; "these ran
four independent lookups in sequence" becomes a fan-out rule in the prompt. The
unit of change is a pattern across findings, not a finding: three cases missing
the same beat is a rule, one case is a note in `findings.md`. The three do not
have to be in this batch - grep the earlier runs' findings before calling
something an anecdote. For a difficult case, read its notes (`difficult.mjs`)
and every earlier `findings.md` that names it first: the rules already tried and
failed are the most useful thing you know about it. Write the rule one level up
from the case that produced it; a rule that names the dataset's own endpoints
makes the eval pass and the product fail. Prefer mechanical wording, and
remember that a prohibition with a self-judged exemption is a permission.

Route each rule by what kind of thing it is: one agent's behaviour to its prompt,
a fact or a procedure to a skill - update an existing one or create a new one, a
standing rule to `agents/instructions.md`, a rule about one capability to a new
`agents/<topic>-policy-instructions.md`.

You may edit prompts, skills, house rules and new policy files. You may not edit
`agents/memory-instructions.md`, `agents/fork-instructions.md`,
`agents/tools-instructions.md` or `agents/files-instructions.md` - `zen check
--fix` overwrites them. You may not change a rubric to make a run pass. Do not
change `agents.yaml`: a finding that needs it is structural - record it as an
open problem and carry on.

Record every edit and the finding numbers behind it in `$RUN/changes.md`, then
run `zen check` and patch the README.

## 6. Stage 1: confirm, pass, build the next batch

An edit is a guess until the same cases have run against it. Run the same batch
again as the next run - a copy of run 1's cases, new prose, still no memory:

```sh
PREV=.finetune/runs/stage1-batch01-run1
RUN=.finetune/runs/stage1-batch01-run2
mkdir -p "$RUN" && cp "$PREV/cases.json" "$RUN/cases.json"
C=$(node -p 'require("./.finetune/config.json").concurrency')
zen run batch --input "$RUN/cases.json" \
    --batch-dir "$RUN/batch" --memory .finetune/empty --concurrency "$C"
.github/skills/zen-finetune/scripts/report.mjs -d "$RUN/batch" -p "$PREV/batch" compare
```

Same queries, same machine, same memory, exactly one thing changed. The verdict
column decides first: a cost edit that makes any case wrong is reverted, whatever
it saved. Then the cost columns: a cost edit that did not cut llm calls or tokens
in the cases it was aimed at by more than the noise floor is reverted too - prose
that does not pay is a cost on every future run. Read the recheck cases first,
then the cases the rule was written for, then the ones it was not about. Cost
growth concentrated in the cases the rule touches is its price; growth spread
evenly across all of them is prose leaking into every agent, and that is a
regression even when every case still passes. If the instruction files grew by a
third and one case moved, revert and say so.

Then grade this run exactly as in section 4, cost review and difficult list
included. If every case is right and the cost review finds nothing more worth
changing, write `PASSED`, then **keep what the batch learned**, before anything
else:

```sh
.github/skills/zen-finetune/scripts/memory.mjs checkpoint stage1-batch01-run2
```

Then patch the README (the batch turns `done` on the map, the next one `now`) and
build the next batch as `next.mjs` says - section 3. If the review finds more, it
is `CORRECT`: back to section 5.

A batch gets **at most 4 runs**. After run 4, stop tuning it: revert whatever
run 4 did not confirm, add every case still wrong to the difficult list, and
write `PASSED` on run 4. If a case is still wrong, the map shows the batch
`failed`, not `done` - the case comes back first in the next batches.

**Never compare two different batches.** They hold different cases, so the
difference between them is the cases and not the prose. Compare run to run
within one batch, or a stage-2 batch against the stage-1 batch it replays.

Stage 1 is done when **every case in the selection has been used and no
difficult case is open** - `next.mjs` says so - **the last batches' recheck
cases still pass**, and **what the runs wrote to memory is worth keeping**. Post
all three and every `stuck` case as a short note, patch the README, and go
straight on to stage 2 - do not wait for me.

## 7. Stage 2: with memory

Freeze the prompts, the skills and the house rules. The memory stage 2 starts
from is already built: the last good memory, checkpointed from every passed
stage-1 run and from nothing else. Read `memory.mjs` and
`zen memory stats --dir "$(.github/skills/zen-finetune/scripts/memory.mjs path)"`.

Build each stage-2 batch with `batch.mjs next --stage 2 -o <run>/cases.json`: it
replays the stage-1 batches in order - batch N copies stage-1 batch N's cases -
and after the last one it builds batches of stage 2's own open difficult cases.
Run them with the same flags stage 1 used, except
`--memory "$(.github/skills/zen-finetune/scripts/memory.mjs path)"`. Each case
copies that graph, recalls from the copy and writes into the copy, so every case
starts from the same memory and the source is never touched. Stage 2 never
checkpoints - `memory.mjs` refuses a stage-2 run. Do not use
`--memory-read-only`: it removes the commit tool and changes the memory prose,
which makes a stage-2 run differ from its stage-1 baseline in two ways instead of
one.

Runs are `stage2-batch<NN>-run<N>`, they pass exactly as stage-1 runs do, and
each replayed batch is compared against **the stage-1 run that passed the same
batch** - `stage2-batch01-run1` against `stage1-batch01-run2`.

The target is reuse: recall should replace the discovery stage 1 repeated every
time, so the run is dramatically cheaper in tokens, calls and wall clock with no
verdict changed. A run that costs about the same, or more, means memory was
carried and not used - a recall-timing finding, not a reason for more memory. A
run that is much cheaper still needs one trajectory opened to confirm the saving
is recall replacing _discovery_ and not recall replacing a _live reading_. The
recheck cases are where that shows up first.

Grade what the cases committed as well as what they recalled. A node that
duplicates something the same run just recalled is waste, and a correction
committed without `SUPERSEDES` beside the stale node it contradicts is worse.

In stage 2 the only file you edit is `agents/memory-policy-instructions.md`. The
last good memory stays as it was for the whole stage: never merge a stage-2 run's
copies back in. A case memory makes worse goes on the difficult list with `--run`
naming the stage-2 run. If a finding cannot be written as a recall or re-commit
rule, it is a stage-1 finding that escaped - note it under "Open problems" in
the README, do not edit the prose, and finish stage 2.

Stage 2 is done when every stage-1 batch has been replayed and passed, no stage-2
difficult case is open, no verdict regressed, the saving is obvious next to the
noise floor, every large saving is explained, and nothing was committed that
memory already held.

## 8. The final check

When stage 2 is done, run the whole selection as one run - the last good memory,
the same flags, the same machine - into `.finetune/runs/final-check/`. It is the
only run that measures every case under the final prose at once. Grade it, and
write `findings.md` with the heading `VERIFIED` if no verdict regressed and the
saving holds. Change nothing. If something did regress, write it up as a finding
and under "Open problems" - which stage it belongs to and why. Patch the README
to its final state - every node `done` or `failed`, "Results so far" as the
summary of the whole tuning, and every `stuck` difficult case and open problem
listed with what was tried.

Then, and only then, report to me: the final summary, the open problems, and a
link to the README. That is the end of the tuning.

## If the tuning stops for good

Whenever it stops - finished, abandoned, or killed mid-run - the prose under
`agents/` is whatever the last confirmed run left, and the memory worth keeping
is `memory.mjs path`: every passed stage-1 batch's commits, whole on disk, never
the graph a half-finished merge was writing. If the project will ship with a
memory, that is the one to promote into `memory/` - read `zen-memory-warmup`
first.

## Housekeeping

Commit `dataset.json`, `config.json`, `selection.json`, `difficult.json`,
`README.md`, every `cases.json`, `findings.md` and `changes.md` - they are the
eval history, and they are what a resumed session reads to find its place. Write
each as its step ends rather than at the end of the batch, so an interruption
never costs more than the step it lands in. Add `.finetune/runs/*/batch/`,
`.finetune/memory/` and `.finetune/empty/` to `.gitignore` - `batch/` folders are
large and may hold live API responses, and the memory graphs are built from them.
