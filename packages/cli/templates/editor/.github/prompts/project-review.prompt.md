---
description: Review the project against the checklist before committing.
---

Review this project the way a maintainer would, then report. Read
`agents.yaml`, every `agents/*instructions.md`, every file under
`agents/prompts/` and the skill descriptions under `agents/skills/` before
saying anything.

**Run the mechanical checks first, and report what they say:**

```sh
.github/skills/zen-review/scripts/review.sh
```

That is `zen check`, the §2.5 path sweep, the memory house-rules copy and the
spec-sync record, in the order they matter. Load the `zen-review` skill for what
each one owns and how to read its output. Do not re-verify by hand anything it
already decided, and do not go further while `zen check` fails - nothing below
matters until it passes.

**Then list the capabilities this project turns on** — a `memory:` block, a
`zen rag` index, a sandbox, a `SPECIFICATION.md` — and load the editor skill
for each before judging it. The obligations live in the skill, not in
`agents.yaml`, and `zen check` reports none of them. A capability that is
already configured and already passing is exactly the case that looks finished
and is not.

Everything that follows is what no tool can see:

- **One job each.** Can you state every agent's job in one sentence? If not,
  say which agent and what the two jobs are.
- **Prompts.** Second person, imperative, failure paths stated, no hedging, no
  politeness padding, no meta-talk about the runtime. Nothing in the house rules
  that is true of only one agent, and nothing in `agents/instructions.md` that
  belongs in a `<topic>-instructions.md` of its own because it only applies when
  one capability is on.
- **Facts.** Any number, threshold, fee or date living in a prompt is in the
  wrong file. Name it and say which skill it belongs in.
- **Paths.** For each candidate `check-paths.sh` printed: is it a path the
  agent cannot open, or noise? Say which, and for a real one say what it should
  have been. Judge the rest of the §2.5 checklist yourself — that no instruction
  assumes the workspace is this directory, that every `/assets/…` and
  `/skills/<name>/…` names a committed file, and that the agent holding the
  prompt has the tool the path implies.
- **Memory.** Anything this project decides for itself belongs in
  `agents/memory-policy-instructions.md`, not in the copy — and it should say
  something. Audiences that exist because an agent would be _misled_ by the
  other slice, not merely because it does not need it.
- **Skill descriptions.** Each one a condition, not a title; no two overlapping.
  Every skill a folder with a `SKILL.md`, and a skill that ships a script writes
  its `/skills/<name>/…` path.
- **Tools.** Every grant justified by the agent's job; nothing mutating held by
  an agent that only reads; every granted tool mentioned by the prompt. An agent
  with no `skills:` key indexes the whole catalog - check that every agent can
  actually follow the skills it is offered.
- **Sandbox.** `persist: true` unless a throwaway rootfs is wanted on purpose.
  What the work always needs is in the image, not installed by a prompt on every
  run.
- **Control flow.** Whichever this project uses. A handoff moves the
  conversation and must have a path back; a fork returns by itself and condenses
  to one result, so whatever the caller needs must be in the branch's answer.
  Wanting one lookup and spending the conversation on it is a fork, not a
  handoff. No router that answers.
- **Models.** Each agent on the cheapest tier that is right, not the safest.
- **Cache.** Nothing volatile - dates, ids, counts - in the stable prefix.
- **Secrets.** No key inlined anywhere; `.env` ignored, `sessions/` ignored.
- **Specification.** Where a `SPECIFICATION.md` exists, `review.sh` reported the
  record's mode. Judge the rest: the newest history entry's "Still open" is
  honest, its baseline names that entry, and `.spec-sync/` is committed.

Report as a list of findings, each naming the file and the line, ordered by how
much it will cost to leave. Say plainly if you find nothing worth changing.
Do not edit anything unless I ask.
