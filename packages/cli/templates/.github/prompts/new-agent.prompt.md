---
mode: agent
description: Add an agent to agents.yaml, with its prompt, tools and handoffs.
---

Add an agent to this project. Ask for the one sentence that states its job
before writing anything; if I have already given it, do not ask again.

First, argue against it. An agent is worth adding only when one of these is
true, and you should say which:

- it needs a **different model tier** from every existing agent
- it needs a **different tool set**, and the difference is a permission
- its instructions **contradict** an existing agent's rather than extend them
- it is a **parallel branch** target for a `fork:`

If none holds, propose the smaller change instead — a skill, a prompt line, a
tool grant — and stop. Adding an agent to solve a prompt problem is the failure
mode this project cares most about.

If it is warranted:

1. Pick a name matching `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`. It reaches the model as
   `transfer_to_<name>`, so the name is part of the routing surface.
2. Write `agents/prompts/<name>.md`: one sentence of identity, a short procedure
   or three to five rules, then what it must **not** do — especially the
   neighbouring agent's job. Second person, imperative, failure paths stated.
   No frontmatter, no meta-talk about the runtime.
3. Add the `agents.yaml` entry. `description:` is written **for the model** — it
   is the whole of what a sibling sees when deciding to hand off. Grant the
   narrowest `tools:` the job needs.
4. Wire the handoffs in both directions only if both directions are real.
   Specialists handing back to a router is ping-pong; prefer terminating.
5. Add a one-line comment above the entry saying why this agent exists — its
   job or its tier, not what the keys mean.

Then run `zen check` and report what it said. If it fails, fix the file it
named rather than working around it.
