---
description: Apply a batch of improvement requests from the tuning loop to the project's prose - merge them into patterns, edit prompts, skills and policy files, and record what was done with each. Run by `zen meta finetune`; the last line names the apply directory.
---

The tuning loop has collected improvement requests from several cases and
wants them applied **together**. The last line of this prompt names the apply
directory.

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

## Load the skills

A request says what a run did wrong; the rules for fixing it live in the editor
skills, not in the request. Read `inputs.json`, then run:

```sh
grep -nE '^\s*(memory|sandbox|handoffs|fork):|docs:|schema:' agents.yaml
grep -rlE 'zen rag (docs|schema)|run_command' agents/
```

Now load, before the first edit, every skill whose condition holds:

- `zen-instructions` - always.
- `zen-memory` - a `memory:` line above, or any request from a `mem` run.
- `zen-rag-docs` - `docs:` or `zen rag docs` above, or any improvement about
  finding something in documents.
- `zen-rag-schema` - `schema:` or `zen rag schema` above, or any improvement
  about finding an API call, a field or a type.
- `zen-topology` - `handoffs:` or `fork:` above, or any improvement about
  delegating, handing off, forking or which agent does what.
- `zen-code-python` - `run_command` above, or any improvement touching an agent
  that writes or runs code.
- `zen-sandbox` - any improvement about the container, installing packages, or
  a command that failed for want of a tool.

An improvement that already sounds right is not a reason to skip its skill -
the skill is how you find out whether it is.

## What to do

1. **Merge before editing.** Group the improvements by the behaviour they fix.
   Several cases asking for the same thing in different words is one rule.
   Two that contradict each other: decide, and say why.
2. **Hold each against its skill.** An improvement's `change` is one analyst's
   guess at the fix. A change that breaks a skill's rule - shell `grep` over an
   index, a paraphrase of a copied house rule, a one-off inline script, a
   handoff with no way back - is rewritten to what the skill prescribes, or
   rejected naming the rule. When the skill already states the rule, the agent
   never saw it: fix how the skill is reached (its description, a load line in
   the prompt), not a second copy of the rule. Prefer the smallest edit in the
   file that owns the rule over the wording the request proposed.
3. **Generalise.** Write each rule for a class of queries, not for a case -
   it must hold for queries no case asked. Never write a case's answer, ids,
   names, numbers or data into the prose, nor an example lifted from a case's
   query. Keep a specific only when the rule cannot be stated without it - a
   tool, a command, a file path of this project. Before you save, check every
   sentence you added: a noun, number or quoted phrase that comes from a case -
   its query, its data or its answer, as its request or analysis quotes them -
   and appears nowhere else in the project is overfit - replace it with the
   class it belongs to, or drop the rule. A request that
   only makes sense for its one case is rejected.
4. **Edit** prompts under `agents/prompts/`, skills under `agents/skills/`,
   `agents/instructions.md` and `agents/<topic>-policy-instructions.md`
   (create the policy file when the rule belongs to one capability). Requests
   from runs **with memory** change only the memory policy -
   `agents/memory-policy-instructions.md` - or the memory paragraph a request
   names.
5. **Never edit** `agents.yaml`, `agents/memory-instructions.md`,
   `agents/tools-instructions.md`, `agents/fork-instructions.md` or
   `agents/files-instructions.md`, nor anything outside `agents/`. A request
   that needs one of those is **structural**: record it, do not apply it.
6. **Check**: `zen check --no-models --no-sandbox` must pass when you finish.

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

    **Checked against:** the skill and rule it was held to, or "no skill
    covers this".

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
