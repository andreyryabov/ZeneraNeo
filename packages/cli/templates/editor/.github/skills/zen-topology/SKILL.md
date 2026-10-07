---
name: zen-topology
description: 'Use when designing, reviewing or auditing how a Zenera project divides work between agents - whether to hand off, fork one branch to delegate, fan out several branches, or keep the work in one conversation; which fork `context` to pick; what each choice costs in tokens, prompt cache and elapsed time; and how to read a recorded run for topology mistakes (missed fan-out, a forked sequence, an early or looping hand-off, a delegation that cost more than it saved). Load before adding or changing `handoffs:` or `fork:` in agents.yaml, before writing a prompt line that says when to delegate, and before grading Delegation or Forking in a run audit.'
---

# Agent topology

Work moves between agents in exactly two ways, and both are tools the model
calls: a **hand-off** (`transfer_to_<name>`) gives the conversation away, a
**fork** (`fork`) sends work out and gets answers back. Everything else is one
agent working in its own conversation. Both are opt-in per agent in
`agents.yaml` - `handoffs:` and `fork:`, described key by key in §8.

Whether a second agent should exist at all is copilot-instructions §6.1 - this
skill starts once it does. The rules an agent reads at run time about forking
are zen's own `agents/fork-instructions.md`; this skill is for whoever designs
the project or judges a run against it, and never repeats that file's prose.

## 1. The four shapes

| Shape          | Control                      | The other side sees                      | Comes back                    | Use it when                                                                 |
| -------------- | ---------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| Keep it here   | stays                        | -                                        | -                             | steps depend on each other, one call does it, or you want to steer the work |
| Hand-off       | moves, and **stays moved**   | the whole transcript                     | nothing, unless it hands back | another agent should own the conversation from now on                       |
| Fork, 1 branch | returns to the forking agent | what `context` gives it + its assignment | that branch's answer only     | you want an answer from someone better suited, or to keep noise out         |
| Fork, N        | returns to the forking agent | the same, per branch                     | N answers in one tool result  | N independent parts of one task, done at the same time                      |

## 2. What a hand-off carries

When the model calls `transfer_to_<name>`, the kernel records a `handoff` node
(`from`, `to`, the optional `reason` argument), switches the current agent,
appends a fresh `system_prompt` for the target, and rebuilds the tool list for
it - its own tools, its hand-offs, its memory and skill tools, its `fork`.

- **The target sees the entire transcript**, every tool call and result the
  previous agent made included. The runtime can collapse the outgoing agent's
  turns with a hand-off policy, but `zen` sets none, so nothing is summarised.
  Do not write a prompt that assumes the target starts clean.
- Only the newest system prompt is sent. The previous agent's role and house
  rules are gone from the request; its words are not.
- The target's `description:` is the whole of what the caller reads when
  deciding, so it is a routing condition, not a title.
- **Auto-recall fires again** for the target, with its own memory mask, against
  the last user input - not against the `reason`.
- Preloaded skills are applied for the target; the outgoing agent's skill tools
  are not the target's.
- **Nothing hands control back.** The target answers every later turn until it
  hands off itself, which is why `zen check` warns `handoff.one-way` on any edge
  with no path home.
- A memory commit is due from the agent that did the work, **before** its
  hand-off. The target holds only the transcript of it - see **zen-memory**.

## 3. What a fork carries

The model calls `fork` with `branches: [{name, instructions, agent?}]` and one
`context` for the whole call. The agent must declare `fork:`; `fork.agents`
reaches the model as an `enum`, and `fork.maxBranches` caps the array.

**What a branch starts from:**

| `context`           | The branch begins with                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| `inherit` (default) | the parent's visible history up to the fork call, then its assignment       |
| `compact`           | the same minus every `tool_call`, `tool_result` and `memory_recall`         |
| `none`              | nothing: its agent's system prompt, then its instructions as a user message |

Under `inherit` and `compact` the assignment arrives as the result of the
inherited `fork` call, opening `You are branch "<name>" of the fork above`,
naming its siblings. Skills another agent loaded are dropped from an inherited
prefix, so a branch never reads instructions for tools it does not hold.

**What comes back:** one tool result, holding each branch's final answer and
status in declared order, never completion order. The branch's own steps are
kept inside the `join` node for audit and are never shown to the parent. A
failed branch is a row with `status: error`, not a failed run.

**What outlives the branch:** files it wrote (branches share the workspace with
the parent and each other) and anything it committed to memory. Nothing else.

**Depth:** a branch may fork again while under the run's `maxForkDepth` (2 by
default). At the cap the `fork` tool is withdrawn and so is
`agents/fork-instructions.md`.

## 4. What it costs - tokens, cache, time

A provider caches the longest **repeated prefix** of a request - tool schemas,
system prompt, then messages - and bills a cached token below an uncached one.
The runtime keeps that prefix still: house rules first, the role file second,
the tool array fixed for the agent's life, preloads at the head, auto-recall
only at the start of a turn. So the question for every shape is: **are the
first bytes the same as a request the provider has already seen?**

| Shape                        | Tokens sent                                             | Prompt cache                                                                                       | Elapsed              |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| Keep it here                 | the transcript, growing every call                      | hits on all of it but the newest tail                                                              | the sum of the steps |
| Hand-off                     | the whole transcript, on every call the target makes    | **misses on the target's first call** - new system prompt and tools, so nothing after them matches | serial               |
| Hand-off back                | the same                                                | the original agent's prefix up to its hand-off may still hit, within the provider's cache lifetime | serial               |
| Fork, `inherit`, same agent  | per branch: the parent's history + brief + its own work | the inherited prefix is byte-identical up to the fork call, so it can hit                          | the slowest branch   |
| Fork, `inherit`, other agent | the same                                                | misses: a different system prompt, so the whole history is paid uncached, once per branch          | the slowest branch   |
| Fork, `compact`              | less history: decisions without tool traffic            | same agent: hits only up to the first dropped tool call; other agent: misses                       | the slowest branch   |
| Fork, `none`                 | its agent's prompt + instructions + its own work        | nothing to share with the parent; same-agent branches share the system prompt with each other      | the slowest branch   |
| The parent after a join      | two messages more: the call and one result              | unchanged - declared order makes the join deterministic                                            | -                    |

What follows from the table:

- **A fan-out buys time, not tokens.** N branches together usually send more
  than doing the N parts in series, because every branch pays its own start.
  The saving is the elapsed time of all but the slowest branch, and the
  parent's context staying N answers long instead of N transcripts.
- **A one-branch fork costs a whole conversation's start** to save the caller
  some context. Worth it for a long, noisy job with a short verdict; a loss for
  one read, one search or one command.
- **Agents passing the conversation back and forth pay a cache miss on every
  switch**, plus a recall each time, on a transcript that only grows.
- **`inherit` versus `compact` is a trade, not a rule.** `compact` sends less;
  `inherit` on the same agent can be served from cache. When most of the
  history is tool traffic, `compact` wins; when it is mostly decided
  conversation, `inherit` on the same agent can be cheaper. On a different
  agent there is no cache to win, so the smaller prefix wins.
- **Cached tokens are not shown in the run graph.** `zen inspect`'s `tokens`
  row and each `llm` node's `in` count cached tokens as input. Reason about the
  cache from the structure above; never report a hit or a miss as measured.

## 5. Choosing - in this order

Ask each question of the piece of work in front of you and stop at the first
yes.

1. **Does any part need another part's result?** Keep that sequence here. A
   branch cannot see its siblings, cannot ask, and cannot be steered.
2. **Is it one call, or one call that takes a list?** Keep it here. Pass the
   list.
3. **Should another agent answer the user from now on** - over several turns,
   on its own model or tools? Hand off, and make sure a path leads back.
4. **Do you want an answer and then carry on?** Fork one branch on the agent
   that suits the job. Never a hand-off: that spends the conversation to get
   the answer.
5. **Are there N independent parts?** Fork N branches - one per item, or one
   per trade, each on the agent that fits.

Then pick `context`, cheapest first:

1. `none`, when everything the branch needs can be written into its
   instructions - paths included. Write it in and take `none`.
2. `compact`, when it needs the plan and the decisions but not how they were
   found, or when the branch runs a **different** agent.
3. `inherit`, when it must see the work as it stands - reviewing what was just
   written, continuing an investigation - and preferably on the **same** agent.

## 6. Where each rule goes

| Rule                                                              | Goes in                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| who may hand off to whom; who may fork, to which agents, how wide | `agents.yaml` - `handoffs:`, `fork: { agents, maxBranches }` (§8) |
| what a hand-off target is for                                     | `agents.yaml` - the target's `description:`, as a condition       |
| **when** to fork or hand off, in this domain's terms              | the deciding agent's prompt                                       |
| which `context` this work wants                                   | the deciding agent's prompt                                       |
| what a branch must return, and in which file                      | the forking agent's prompt, so it writes it into `instructions`   |
| which hand-off ends a specialist's turn                           | the specialist's prompt                                           |
| a forking policy for the whole project                            | `agents/fork-<topic>-instructions.md` - load **zen-instructions** |

The domain-terms line is the one most often missing, and without it a weaker
model works through a list serially and never calls `fork`: _"When the request
covers more than one region, fork one branch per region with `context: none`,
and tell each branch to return the region, the total and the top three
findings."_

Never edit `agents/fork-instructions.md` - it is zen's copy, `zen check --fix`
replaces it, and an edit there is reported as `rules.stale`.

## 7. Reading a run for topology

Where the topology shows in `zen inspect graph` (load **zen-inspect** for the
format):

- `%% agent <last> · started as <first>` - a hand-off happened.
- `@<agent>` on a node - the first node that agent owns.
- `handoff <from> to <to>` - open it for `reason`.
- `fork (<context> context) <branch>, <branch>` - the mode it chose.
- the branch subgraphs, one marked `slowest`, and `join <branch>=ok, ...`.
- `%% branches` - which join waited for which branches, with status.
- `%% tools` - `fork xN` and how many research calls ran around it.

| The graph shows                                                                     | Finding                                           | Fix goes in                                               | Next run should show                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| research calls in series, none using an earlier result, `fork` in the agent's tools | missed fan-out                                    | the agent's prompt: the domain trigger of §6              | one `fork` with a branch per item            |
| the same, `fork` not in the agent's tools                                           | missed fan-out                                    | `agents.yaml`: `fork:` on that agent                      | the same                                     |
| a branch's instructions name a sibling's result, or read a file a sibling writes    | a sequence was forked                             | the forking agent's prompt                                | those steps in the trunk                     |
| a one-branch fork whose branch made one or two calls                                | delegation that cost more than it saved           | the forking agent's prompt                                | the call made in the trunk                   |
| after the join, the parent repeats calls a branch already made                      | the branch was not told what to return            | the forking agent's prompt: what each branch must return  | no repeat after the join                     |
| a branch not `ok`                                                                   | an assignment missing a fact it could not ask for | the forking agent's prompt                                | that branch `ok`                             |
| `slowest` far behind its siblings                                                   | an uneven division                                | the forking agent's prompt: split that part               | branch durations close together              |
| two branches with the same calls on the same subjects                               | overlap, paid for twice                           | the forking agent's prompt: divide by subject             | disjoint subjects                            |
| a wide fan-out to **another** agent with `inherit` and a long history               | the history paid uncached, once per branch        | the forking agent's prompt: `compact` or `none`           | `fork (compact context)` or `(none context)` |
| a `handoff` before the agent's own part was done                                    | an early hand-off                                 | the outgoing agent's prompt                               | its own calls, then the hand-off             |
| `handoff` A to B, then B to A, then A to B                                          | a loop - two prompts claim the same job           | both prompts, so one owns it                              | one hand-off, or none                        |
| a hand-off for one question, then the target writes the final answer                | wanted an answer, spent the conversation          | the outgoing agent's prompt, and `fork:` in `agents.yaml` | a one-branch `fork` to that agent            |
| a specialist exists in `agents.yaml`, and the agent did that job inline             | the prompt never said when to delegate            | the deciding agent's prompt                               | a `fork` or `handoff` to the specialist      |

Price each finding honestly. A missed fan-out costs the elapsed time of every
branch but the slowest - not tokens, which a fork usually raises. A forked
sequence or an overlap costs the duplicated calls and their tokens. A
needless hand-off or one-branch fork costs one conversation's start, uncached.

To learn **why** the model chose the shape, ask the `llm` node that carries
`calls transfer_to_<name>` or `calls fork`, or the first call of a serial run -
load **zen-inspect-ask** for how to word it. First rule out the cheap causes:
`fork` not in that call's tools (depth cap, or no `fork:`),
`fork-instructions.md` not in its `system_prompt`, a specialist not in its
`enum`.

## 8. The keys in `agents.yaml`

Both keys are per agent, and both only make a tool available. When the model
uses it is the prompt's business (§6).

### `handoffs:`

```yaml
agents:
    - name: intake
      description: Takes the first message and routes the case to the right desk.
      handoffs: [billing, technical]
    - name: billing
      description: Answers invoice and refund questions from the written policy.
      handoffs: [intake] # the way home
    - name: technical
      description: Diagnoses faults from the logs and says what to do next.
      handoffs: [intake]
```

- A list of bare agent names. There is no object form and no per-edge
  configuration.
- Each name becomes one tool on this agent, `transfer_to_<name>`, described by
  the **target's** `description:`. With none, the model gets a generic sentence
  and `zen check` warns `agent.no-description`. Write it as a routing
  condition, not a title: _"Applies the written peril policies to a claim and
  explains the outcome"_, never _"The adjuster agent"_.
- `handoff.unknown` (an agent not declared) and `handoff.self` are load errors.
- `handoff.one-way` is a warning: an edge `A → B` with no path from B back to
  A. Indirect counts - `B → C → A` is a way home - so every edge must lie on a
  cycle. Without one, the first routed question is the last one routed.

### `fork:`

```yaml
agents:
    - name: trunk
      fork: true # any declared agent, any number of branches

    - name: sweep
      fork:
          agents: [sweep, prober] # who a branch may run - itself included
          maxBranches: 6

    - name: asker
      fork: { agents: [prober], maxBranches: 1 } # delegation, never a fan-out
```

| Written            | Means                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| absent, or `false` | no `fork` tool, and `agents/fork-instructions.md` never reaches this agent                                           |
| `true`, or `{}`    | the tool, any declared agent, no cap                                                                                 |
| `agents: [a, b]`   | a branch may run only these. The list is an `enum` on each branch's `agent` field, so another name cannot be decoded |
| `maxBranches: n`   | at most `n` branches per call. `1` allows delegation and refuses fan-out                                             |

- `agents` **may name the forking agent itself** - one role fanned out over
  many items is the common shape, and unlike `handoffs:` it is not an error.
- A branch that leaves `agent` out runs the forking agent - but only when the
  forking agent is in `agents`. When it is not, the model must name one.
- **A branch runs as its agent**: that agent's prompt, tools, memory binding,
  skills, hand-offs and its own `fork:`. A hand-off inside a branch moves the
  branch's conversation, never the parent's.
- Depth is not a key here. `maxForkDepth` (2 by default) is a run option; at
  the cap the `fork` tool is withdrawn, and `agents/fork-instructions.md` with
  it.
- Refused at load: `agents: []`, `maxBranches: 0`, and an `agents` entry not
  declared (`fork.unknown`).
- `fork.uninstructed` is an error: an agent can fork and
  `agents/fork-instructions.md` is missing or empty. `zen check --fix` writes it
  back. That file is zen's - an edit in it is reported as `rules.stale` and lost
  at the next `--fix`; project policy on forking goes in
  `agents/fork-<topic>-instructions.md` (load **zen-instructions**).
