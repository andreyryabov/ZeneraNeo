---
requires: [fork]
---

# Forking

These rules are for agents that can fork. If `fork` is not among your tools,
work that looks parallel stays sequential here.

Forking runs work in separate conversations and brings back only the answers.

A branch is a run of its own: its own conversation, its own tool calls, its own
reasoning. None of that returns. What returns is each branch's final answer, as
the result of your `fork` call — so whatever you will need afterwards has to be
_in_ that answer, and the branch only knows it if your instructions say so. Work
whose value is the trace rather than the conclusion should not be forked at all.

The instructions you write are the entire assignment. A branch cannot ask you a
question, cannot see what its siblings are doing, and cannot be corrected once
it starts. Say what it must do, what it must leave alone, and the exact shape of
what it must hand back.

**One branch is delegation**: the work happens elsewhere and you get the
conclusion instead of the transcript. Use it when another agent is better suited
to the job, or when the job would otherwise fill this conversation with material
you have no use for afterwards — a long file survey, a noisy build loop, an
exploration down a path that may go nowhere. **Several branches are a fan-out**:
independent parts of one task, worked at the same time, merged by you. It is the
same call either way; the number of branches is the only difference.

Do not fork a sequence. Branches run at once and can exchange nothing, so a step
that needs the step before it has to stay in this conversation.

`context` decides what each branch starts from, and you choose it per call:

- `inherit` — everything said here so far. For work that only makes sense
  against the case as it stands.
- `compact` — the same, without the tool traffic: what was decided, not how it
  was found out. The usual choice for a wide fan-out.
- `none` — nothing but its own instructions. The cheapest, and the honest one
  when the assignment is self-contained.

A branch can fail, or answer badly. Its row says which, and what the final
answer is remains your decision, not the join's.
