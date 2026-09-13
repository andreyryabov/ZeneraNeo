---
mode: agent
description: Review the project against the checklist before committing.
---

Review this project the way a maintainer would, then report. Read
`agents.yaml`, every `agents/*instructions.md`, every file under
`agents/prompts/` and the skill descriptions under `agents/skills/` before
saying anything.

**Run `zen check` first.** It owns everything decidable — schema, names,
handoff edges, tool selectors, skill bindings, credentials, the sandbox image.
Report what it says and do not re-verify by hand what it already checked.
Nothing below matters if it fails.

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
- **Paths.** Work the checklist in §2.5 over `agents/*instructions.md`,
  `agents/prompts/*.md` and `agents/skills/*/SKILL.md`. Every absolute path must
  be under `/workspace`, `/assets`, `/skills` or `/memory`; nothing may name a
  project file the agent cannot open, and nothing may assume the workspace is
  this directory.
- **Memory.** If any agent has `memory:`, `diff` `agents/memory-instructions.md`
  against the `zen-memory` skill's `references/memory-instructions.md`. Never
  eyeball it - it drifts by trailing whitespace inside tables. Anything this
  project decides for itself belongs in a second topic file, not in the copy.
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
- **Specification.** Where a `SPECIFICATION.md` exists: `.spec-sync/` is
  committed, its baseline names the newest history entry, and the newest entry's
  "Still open" is honest.

Report as a list of findings, each naming the file and the line, ordered by how
much it will cost to leave. Say plainly if you find nothing worth changing.
Do not edit anything unless I ask.
