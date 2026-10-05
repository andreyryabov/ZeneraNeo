---
description: Analyze one recorded run of this project - its health, what it wasted, and what to change in the instructions. Name the run (directory or id) after the command, or get the most recent one.
---

Load the **zen-analyze-run** skill and follow it to analyze one run of this
project. Everything about how to analyze it is in the skill.

## Which run

The last line of this prompt may name the run - a run directory or a run id.
If it does, use it. Words after it like `case=<id> ... feedback=<file>` mean
the tuning loop sent you: follow section 7 of the skill and write that file.

If it does not, list this project's most recent runs, newest first:

```sh
zen list --runs --json --limit 500 \
  | jq -r --arg p "$PWD/" '[.[] | select(.dir | startswith($p))][:5][]
      | "\(.id)  \(.agent // "-")  \(.error // .stopReason // "-")  \(.dir)"'
```

- If there are none, stop and say this project has no runs yet.
- If you can ask the user a question, show that list and ask which run to
  analyze, with the newest as the default.
- If you cannot ask, take the newest. Say which run you picked, and that it was
  picked as the most recent, at the top of the report.

Then give the run to the skill.
