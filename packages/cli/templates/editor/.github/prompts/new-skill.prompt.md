---
mode: agent
description: Add a skill under agents/skills, with a description that routes.
---

Add a skill to this project. A skill is curated instruction content — and
optionally tools — loaded on demand instead of sitting in every system prompt.
Reach for one whenever a rule applies only sometimes, or holds a fact that will
change without the prompt changing.

Ask what the skill must say and when it applies, if I have not already said.

1. Create `agents/skills/<name>/SKILL.md`. That is the only skill layout there
   is — a bare `agents/skills/<name>.md` fails `zen check` — and the folder is
   what lets the skill carry companions later: a rate table, an example letter,
   a schema, a script.
2. Write the `description`. This is the routing key and the only thing the model
   sees before deciding to load the skill, so write it as **the condition under
   which the skill is needed**, not as a title. `Water policy` is a title;
   `Escape of water from plumbing and tanks — and the freezing exclusion` is a
   condition. If two skills could both match a case, sharpen both until they
   cannot.
3. Write the body as instructions the model can act on: thresholds, exact
   wording, the boundaries of the rule, and what to do when the case falls
   outside it. Put the facts here rather than in a prompt — that is the point of
   the file.
4. Put anything the rule computes or looks up in a file beside `SKILL.md` and
   name it from the body by its absolute path — `python
/skills/<name>/scripts/calculate.py <id>`, not `scripts/calculate.py`. The
   folder is mounted read-only at `/skills/<name>/`, so the script writes
   nothing there; the agent needs `sandbox:*` to run it, and the interpreter has
   to be in the `sandbox:` image already.
5. Declare `tools:` in the frontmatter only for tools that must not run until
   this skill is active. They are advertised from turn 0 and refuse to execute
   while the skill is dormant, which is how gating happens without breaking the
   prompt cache.
6. Leave `name` out unless it must differ from the folder name, and leave
   `version`/`tags` out unless something uses them.

Do not `preload:` it unless every case genuinely needs it — a preloaded skill is
a longer prompt, paid for on every call. Bind it under `agents[].skills.allow`
if the agent's catalog is restricted.

Then run `zen check` and report what it said.
