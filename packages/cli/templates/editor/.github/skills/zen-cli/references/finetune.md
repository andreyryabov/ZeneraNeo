# `zen meta finetune` - tuning the project, one case at a time

Trains the project's prose - prompts, skills, house rules - on every case of
its dataset (`zen meta dataset`). Nothing here touches model weights.

```sh
zen meta finetune start [-N 4] [-M 4] [--tries 4] [--mem-tries 3] [--merge-every 3] [--seed 1] \
    [--class <c>] [--id <glob>] [--rubric yes|no] [--limit <n>] [--more <n>] [--force]
zen meta finetune [status]
zen meta finetune stop
zen meta finetune session <case>
```

## What one case goes through

```
without memory, up to --tries times:
    zen run (empty memory)  ->  /analyze  ->  done? go on : park until the next apply
with memory, up to --mem-tries times, from the memory the passing run wrote:
    zen run  ->  /analyze  ->  done? completed : park until the next apply
tries used up  ->  difficult
```

- **N workers**, each training one case at a time. Cases come in the dataset's
  own order: classes taking turns, cases with a rubric first, then seeded
  random. Cases added to the dataset are picked up as it goes.
- **A parked case gives its worker back**, so another case runs while it waits
  for an apply; once woken, it takes a worker before any new case does.
- **Applies are batched.** Parked cases' improvement requests are applied
  together by `/finetune-apply` once **M** cases are parked, or once nothing is
  running and no case is left to start. No run starts during an apply; runs in flight finish
  first. `zen check` must pass afterwards, or the edit is undone and tried once
  more; a second failure stops the tuning. Each apply gets its own
  `applies/<NNN>/APPLY.md`: every request and improvement, what was decided for
  each, the apply agent's account of what it changed and why, every file
  changed with its diff, and the `zen check` result.
- **No run shares a memory.** Every try runs on its own private directory:
  empty without memory, a copy of the case's passing memory with it. A case
  whose with-memory run passes keeps a copy in `memories/submitted/`; every
  `--merge-every` kept memories are merged, with the last merge, into
  `memories/merged/mNN/` - numbered, never rewritten, each listing the cases it
  holds. Whatever is left is merged when the tuning ends.
- **Each case keeps one analyze session**, so every analysis of it remembers
  the earlier tries. `session <case>` prints the command to resume it.
- **Stop and resume freely.** `stop` (or Ctrl-C once) lets the steps in flight
  finish, then exits; Ctrl-C twice kills them. `start` again carries on: every
  step's result is on disk, and nothing finished is repeated.
- **`--limit` and `--more` are for one start**, never kept in `loop.json`.
  `--limit <n>` cuts the order to its first n cases: once those have a result,
  that start ends. `--more <n>` begins at most n cases not begun before - cases
  part-way or failed still carry on - so `start --more 4` again takes the next
  four.
- `start` refuses a dataset that has drifted from its sources - run `/dataset`
  first, or pass `--force`.

## What it leaves

```
finetune/
    STATUS.md            the whole tuning: summary (spend per phase, tuning and memory
                         effect), workers, queue, applies, cases - generated
    loop.json            the settings; flags on start update it
    events.jsonl         every step, in order
    cases/<id>/
        FEEDBACK.md      that case: rubric, latest analysis, decisions, history, metrics
                         of every try and how they moved - generated
        r<rev>/session   its analyze session
        r<rev>/result.json            completed or difficult, once it ends
        r<rev>/<NN>-<nomem|mem>/      one try: request.json, run.json, memory/,
                                      feedback.json, analysis.md, run.log, analyze.log
    applies/<NNN>/       APPLY.md (generated), inputs.json, apply.log, check.log, changes.md,
                         decisions.json, diff.patch
    memories/            submissions.jsonl, merges.jsonl, submitted/<case>@r<rev>/, merged/mNN/
    systems/             systems.jsonl + a copy of agents.yaml and agents/ per version
```

Open `STATUS.md` first; every row links to the detail behind it. Its Summary
says whether the tuning is working: the fixes, as a case's first try without
memory against its passing one, and memory, as the passing try without memory
against the passing try with it - tokens, calls, tool errors and time, totalled
over the same cases. A case's `FEEDBACK.md` has the same metrics per try and per
model, each try against the one before it in its phase.
