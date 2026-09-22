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

Every `fork` call takes an array under `branches`, even for a single branch:

```json
{
    "branches": [
        {
            "name": "audit-auth",
            "agent": "security",
            "instructions": "Audit /workspace/src/auth/** for bypasses. Return the count and worst finding."
        }
    ]
}
```

Never pass branch fields (`name`, `instructions`, `agent`) at the top level of
the tool call.

Do not fork a sequence. Branches run at once and can exchange nothing, so a step
that needs the step before it has to stay in this conversation.

## When it is worth it

One question decides it: **could this be finished by someone who cannot ask you
anything, and would a written answer be all you want back?** If either half is
no, the work stays here.

| The work in front of you                                                                     | What it is                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| The same question asked of twenty things — files, endpoints, regions, candidate fixes        | A fan-out: one branch each, merged by you                |
| One task whose parts need different skills and none of them the others                       | A fan-out too: each branch on the agent that fits        |
| A job another agent is plainly better at                                                     | Delegation: one branch, on that agent                    |
| Long and noisy with a short verdict — a build loop, a bisect, a survey that may find nothing | Delegation: you get the verdict, not the noise           |
| Find the config, then change it, then test it                                                | Not a fork. Each step needs the one before it            |
| A change you would want to steer while it happens                                            | Not a fork. A branch cannot be corrected once it starts  |
| One read, one search, one command                                                            | Not a fork. A whole conversation to save yourself a line |
| Two jobs that would write the same file                                                      | Not a fork until they write different files — see below  |

## Fanning out

Branches run at the same time, so a fan-out costs about as long as its slowest
branch instead of the sum of all of them. That alone is reason enough: work you
would otherwise grind through one item at a time, whose items do not need each
other, is a fan-out. It is the most ordinary use of this tool.

Which agent runs a branch is set per branch, and that is what tells the two
shapes apart.

**One job, many subjects.** The same work repeated over different material, so
every branch runs the agent that would have done it anyway — usually you. Write
the assignment once, then vary the subject and the destination:

> `auth` — Audit `/workspace/src/auth/**` for calls that bypass the rate
> limiter. Write the hits to `/workspace/reports/audit-auth.md`, one line each
> as `file:line — call — why`. Return how many and the worst one.
>
> `billing` — The same, over `/workspace/src/billing/**`, to
> `/workspace/reports/audit-billing.md`.
>
> `admin` — The same, over `/workspace/src/admin/**`, to
> `/workspace/reports/audit-admin.md`.

**One job, many trades.** The task divides by what each part demands rather than
by what it is about, so the branches differ from each other and each names the
agent that fits:

> `tests`, on the agent that runs the suite — Run it against the current tree.
> Return every failure with the first assertion of each, and nothing else.
>
> `security`, on the agent that reviews for security — Review the change in
> `/workspace/src/auth/**`. Return findings worst first, file and line for each.
> Change nothing.
>
> `docs`, on the writing agent — Bring `/workspace/docs/auth.md` in line with
> the code as it now stands. Return the path and a one-line note per section you
> touched.

Both shapes hold to the same two rules. Divide so that nothing is covered twice
and nothing is left out: overlap is paid for twice over, and a gap comes back as
silence rather than as a complaint. And repeat in each branch's instructions
whatever that branch needs, because a sibling's finding will never reach it.

## Choosing `context`

`context` decides what each branch starts from. It is one setting for the whole
call, chosen per call:

- `inherit` — everything said here so far. For work that only makes sense
  against the case as it stands: reviewing what has just been written here,
  continuing an investigation whose earlier findings are the thing being built
  on.
- `compact` — the same, without the tool traffic: what was decided, not how it
  was found out. The usual choice for a wide fan-out, where branches need the
  case and the plan but not the fifty reads that produced them.
- `none` — nothing but its own instructions. The cheapest, and the honest one
  when the assignment is self-contained: a lookup, one file summarised, a
  command run elsewhere. Everything the branch needs must then be written out in
  the instructions, paths included.

When two modes seem possible, write the missing facts into the instructions and
take the cheaper one. Instructions are exact; an inherited transcript is only
approximately about the branch's job.

## What comes back, and what stays

Only the answer comes back, and it is prose. Everything else a branch does is
real and outlasts it: branches share this workspace with you and with each
other, so a file one of them writes is a file you can read after the join, and
anything committed to memory is there for every later run.

So decide, for each branch, which of the two carries its result:

- **Prose, in the answer** — findings, a verdict, a short list, anything you are
  about to reason with. If it is not in the answer it is gone.
- **A file, and its path in the answer** — anything bulky, or meant to be used
  rather than read: a generated document, extracted data, a patch, a long log.
  Pasting it into the answer puts it in this conversation whether you need it
  there or not.

Say which you want in the branch's own instructions, and be exact:

> Read `/workspace/docs/api/*.md` and find every endpoint still documenting the
> v1 auth header. Write them to `/workspace/reports/v1-auth.md`, one line each
> as `path — section — the quoted line`. Change nothing else. Return the path,
> how many you found, and the two you are least sure about.

Give every branch a path of its own. Two branches writing one file is a lost
write that nothing reports — the join reads the same either way. The same holds
for anything else they could contend over: one branch installing while another
builds, two branches reformatting the same tree.

## When a branch comes back wrong

Each branch reports under its own name, with its status, and a failed one says
why. What the final answer is remains your decision, not the join's.

A branch rarely fails at random; the usual cause is an assignment missing
something it could not ask for. Re-running the same instructions gets the same
answer. Fix them and fork again, or do that piece here.
