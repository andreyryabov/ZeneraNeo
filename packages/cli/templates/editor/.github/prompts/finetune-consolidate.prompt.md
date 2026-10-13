---
description: Shrink the project's prose after a run of tuning applies - merge duplicate rules, delete contradictions, move situational procedures into on-demand skills, split or merge skills - without changing what the agents are told to do. Run by `zen meta finetune`; the last line names the apply directory.
---

The tuning loop has applied several batches of fixes, one at a time. Each was
locally right; together they leave the same rule in two places, exceptions
stacked under general rules, and procedures every agent reads on every call
that only a few requests need. Your job is to make the prose **smaller with
the same meaning**. The last line of this prompt names the apply directory.

You may not add a rule. After you finish, the loop measures what the agents
read: if it did not shrink, or a case that passed before now fails, the whole
edit is undone.

## What you are given

- `<apply dir>/budget.json` - what the agents read, in bytes: `alwaysRead` per
  agent (house rules, its prompt, preloaded skills, the skill index lines),
  `skills` (each on-demand skill body), `visible` (skills each agent can see),
  the same at the start of the tuning (`start`), and the limits `skillCap` and
  `maxSkills`.
- `<apply dir>/growth.json` - per file: bytes at the start of the tuning and
  now, and the applies that changed it since the last consolidation. The
  files that grew most are where to start.
- `finetune/applies/*/changes.md` - why each rule was added. A rule's
  `Obligation` there is what must survive your edit.
- From your previous attempt, if it was undone - read these first:
  `check.log`, `budget.md` (it did not shrink), `guard.md` (it broke a case
  that passed before - the file names the case and its analysis).

Load `zen-instructions` before the first edit, and `zen-memory` if
`grep -n 'memory:' agents.yaml` prints anything.

## What to do

For each file in `growth.json`, largest growth first:

1. **List its obligations** - one sentence each, in your own words. Search
   every other file the same agents read for each one: house rules
   (`agents/instructions.md`, every `agents/*-instructions.md`), prompts,
   skills.
2. **Pick one move** per obligation:
    - `merge duplicates` - the same obligation in two places with the same
      audience: keep it in the owner, delete the rest.
    - `delete contradiction` - two sentences that cannot both be obeyed:
      keep the one the later `changes.md` chose, delete the other.
    - `narrow` - a general rule followed by its exceptions: rewrite the
      general rule so it needs none, and delete the exceptions.
    - `move and delete` - a rule in a file whose audience is wider than the
      agents it binds: move it to the narrowest owner.
    - `extract to skill` - a procedure or a set of facts only some kinds of
      request need: move it to `agents/skills/<name>/SKILL.md`, leave one
      line in the prompt naming the condition and the skill, and write a
      `description:` that says when to load it.
    - `split skill` - a skill over `skillCap`: split it by when each part is
      needed, each with its own description.
    - `merge skills` - two skills whose descriptions overlap, or an agent
      over `maxSkills`: merge them.
    - `keep` - it is already in the one right place, said once.
3. **Edit.** Delete the displaced copies in the same edit. Never weaken an
   obligation: what an agent must do stays what it must do.

Never edit `agents.yaml`, `agents/memory-instructions.md`,
`agents/tools-instructions.md`, `agents/fork-instructions.md` or
`agents/files-instructions.md`, nor anything outside `agents/`.

Then read each affected agent's prompt in the order it is assembled - house
rules first, then its prompt - and run `zen check --no-models --no-sandbox`.
It must pass.

## What to write

`<apply dir>/changes.md` - one section per file touched:

```markdown
## agents/prompts/default.md

**Move:** merge duplicates

**Obligation:** the sentence that must survive, and the agents it binds.

**Before:** the text as it was, quoted - every copy, with its file.

**After:** the text as it is now, quoted.

**Net:** bytes removed from what the agents always read, and moved to
on-demand skills.
```

Your answer is a short summary: the moves, the files, and the net change in
bytes.
