---
mode: agent
description: Review the project against the checklist before committing.
---

Review this project the way a maintainer would, then report. Read
`agents.yaml`, `INSTRUCTIONS.md`, every file under `agents/prompts/` and the
skill descriptions under `agents/skills/` before saying anything.

Work the checklist in §9 of the copilot instructions. In particular:

- **Loads.** Run `zen check`. Nothing else in this review matters if it fails.
- **One job each.** Can you state every agent's job in one sentence? If not,
  say which agent and what the two jobs are.
- **Prompts.** Second person, imperative, failure paths stated, no hedging, no
  politeness padding, no meta-talk about the runtime. Nothing in
  `INSTRUCTIONS.md` that is true of only one agent.
- **Facts.** Any number, threshold, fee or date living in a prompt is in the
  wrong file. Name it and say which skill it belongs in.
- **Skill descriptions.** Each one a condition, not a title; no two overlapping.
- **Tools.** Every grant justified by the agent's job; nothing mutating held by
  an agent that only reads; every granted tool mentioned by the prompt.
- **Routing.** Handoff targets have descriptions written for the model. No
  ping-pong edges. No router that answers.
- **Models.** Each agent on the cheapest tier that is right, not the safest.
- **Cache.** Nothing volatile — dates, ids, counts — in the stable prefix.
- **Secrets.** No key inlined anywhere; `.env` ignored, `sessions/` ignored.

Report as a list of findings, each naming the file and the line, ordered by how
much it will cost to leave. Say plainly if you find nothing worth changing.
Do not edit anything unless I ask.
