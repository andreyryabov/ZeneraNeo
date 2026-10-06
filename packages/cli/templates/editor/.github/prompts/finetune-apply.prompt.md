---
description: Apply a batch of improvement requests from the tuning loop to the project's prose - merge them into patterns, edit prompts, skills and policy files, and record what was done with each. Run by `zen meta finetune`; the last line names the apply directory.
---

The tuning loop has collected improvement requests from several cases and
wants them applied **together**. The last line of this prompt names the apply
directory. Load the `zen-instructions` skill before you edit anything under
`agents/`, `zen-memory` when any request is from a run with memory, and
`zen-code-python` when any request touches an agent that writes or runs code.

## What you are given

- `<apply dir>/inputs.json` - the requests: each has `id` (`<case>@<phase>-<attempt>`),
  `case`, `phase` (`nomem` or `mem`), `summary`, `improvements` (each with `id`,
  `kind`, `file`, `change`, `why`, `expect`) and `file`, the feedback it came from.
  The analysis behind each is `analysis.md` beside that file - read it when an
  improvement is unclear.
- Every earlier `finetune/applies/*/decisions.json` and `changes.md` - what
  was already tried. Do not re-apply a rule an earlier apply added and a later
  run showed did not work; change it instead.
- `<apply dir>/check.log`, if it exists: your previous attempt left the project
  failing `zen check`, and the edit was undone. Read it first.

## What to do

1. **Merge before editing.** Group the improvements by the behaviour they fix.
   Several cases asking for the same thing in different words is one rule.
   Two that contradict each other: decide, and say why.
2. **Generalise.** Every rule must hold for queries no case asked. Never write
   a case's answer, its ids or its data into the prose - if a request only
   makes sense for its one case, reject it.
3. **Edit** prompts under `agents/prompts/`, skills under `agents/skills/`,
   `agents/instructions.md` and `agents/<topic>-policy-instructions.md`
   (create the policy file when the rule belongs to one capability). Requests
   from runs **with memory** change only the memory policy -
   `agents/memory-policy-instructions.md` - or the memory paragraph a request
   names.
4. **Never edit** `agents.yaml`, `agents/memory-instructions.md`,
   `agents/tools-instructions.md`, `agents/fork-instructions.md` or
   `agents/files-instructions.md`, nor anything outside `agents/`. A request
   that needs one of those is **structural**: record it, do not apply it.
5. **Check**: `zen check --no-models --no-sandbox` must pass when you finish.

## What to write

- `<apply dir>/changes.md` - read by a person deciding whether to trust this
  apply, so leave nothing out. One section per file you touched:

    ```markdown
    ## agents/prompts/default.md

    **Answers:** plan-day@nomem-1 i1, long-list-3@nomem-1 i1 (merged)

    **The pattern:** what the cases did wrong, in one paragraph, with the node
    ids from their analyses - not a case's answer.

    **Before:** the sentence or section as it was, quoted (or "new section").

    **After:** the text as it is now, quoted.

    **Why it generalises:** which queries beyond these cases it changes, and
    which it must not.

    **Expect:** what the next run's graph should show if it worked.
    ```

    Then a section **Not applied**: every rejected or structural improvement, with
    why.

- `<apply dir>/decisions.json` - a decision for **every** improvement of every
  request, nothing skipped:

```json
{
    "plan-day@nomem-1": {
        "i1": { "decision": "applied", "note": "agents/prompts/default.md - planning section" },
        "i2": { "decision": "merged", "note": "same rule as long-list-3@nomem-1 i1" }
    },
    "long-list-3@nomem-1": {
        "i1": { "decision": "applied", "note": "agents/pagination-policy-instructions.md" },
        "i2": { "decision": "structural", "note": "needs a tool in agents.yaml" },
        "i3": { "decision": "rejected", "note": "only true for this case's data" }
    }
}
```

`decision` is one of `applied`, `merged`, `rejected`, `structural`. The note is
one line a person reads in the case's FEEDBACK.md.

Your answer is a short summary: how many rules, which files, and anything
structural the user must decide.
