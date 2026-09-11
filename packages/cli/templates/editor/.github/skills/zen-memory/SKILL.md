---
name: zen-memory
description: How agent memory is organised and how to configure it in `agents.yaml` - the `memory:` block, per-agent `access`/`sees`/`writes`/`autoRecall`, the four `memory_*` tools, kinds and relations, how recall ranks and stitches a subgraph, and how to design a memory strategy for a project. Includes the usage rules every memory-enabled project must carry in its `INSTRUCTIONS.md` (references/memory-house-rules.md), what to commit and what never to, how to keep a working file under `/memory` and re-run it later, and how to put memory in front of a `zen rag schema` or `zen rag docs` index so a search that already succeeded once is not paid for again.
---

# Memory

Memory is what an agent knows that nobody wrote down for it. A skill is
authored, reviewed and versioned; a memory is **produced by a run** and read by
the runs that follow. Both are knowledge, and they are not interchangeable -
anything authoritative belongs in a skill, where a human owns it.

It is a **graph**, not a list of rows. A node is one thing worth keeping - a
request, a plan, a fact, a script, a call that was made - and an edge says how
one led to another. That shape is the point: a script an agent wrote is useless
without the request that asked for it and the endpoint it calls, and a store
that can only return a ranked list leaves the joining to the model, every time.

It lives with the **project**, not the session. A memory that died with the
session would be a cache.

## Turning it on

Two keys, and the second one is what actually enables anything.

```yaml
memory: # where the graph lives, and what vectorises it
    dir: memory
    embedding: main

agents:
    - name: auditor
      memory: true # this agent gets the tools and auto-recall
```

That is the whole feature working the obvious way: the agent can search, load
and commit, and it recalls automatically before answering new user input.

The top-level block is optional - an agent that says `memory: true` gets the
defaults without one. A project that mentions memory nowhere opens no store and
creates no directory.

### `memory:` - the graph itself

| Field       | Type          | Default         | Meaning                             |
| ----------- | ------------- | --------------- | ----------------------------------- |
| `dir`       | path          | `memory`        | Relative to the project root        |
| `embedding` | embedding ref | the top-level   | The vectoriser recall searches with |
| `kinds`     | name[]        | the seven below | **Replaces** the node vocabulary    |
| `relations` | name[]        | the four below  | **Replaces** the edge vocabulary    |

**Set `embedding`.** Without one, recall falls back to term overlap: it finds a
memory phrased the way the query happened to be phrased and misses the rest,
which is the failure mode that makes people conclude memory does not work. The
width is learned from the first response rather than declared, and changing the
model afterwards is **refused** rather than silently mixing two vector spaces -
so choose it before the graph has anything in it.

```yaml
embeddings:
    main: openai:text-embedding-3-small
memory:
    embedding: main
```

`zen memory stats` says `embedding none - recall falls back to term overlap`
when this was skipped, and a vector count below the node count means some nodes
were committed before an embedder existed.

### `agents[].memory` - who may see and write what

```yaml
agents:
    - name: auditor
      memory:
          access: read-write
          sees: [audit]
          writes: [audit]
          autoRecall: { limit: 3 }
```

| Field        | Type                       | Default         | Meaning                                      |
| ------------ | -------------------------- | --------------- | -------------------------------------------- |
| `access`     | `read`/`read-write`/`full` | `read-write`    | Which of the four tools this agent gets      |
| `sees`       | name[]                     | `[]`            | Private slices it may read, on top of `*`    |
| `writes`     | name[]                     | `[*]`           | Labels it may commit under                   |
| `autoRecall` | boolean or `{ limit }`     | `true`, limit 5 | Recall before a turn that follows user input |

`memory: true` is shorthand for all four defaults.

## The four tools

They are **not** listed in an agent's `tools:`. They are derived from the
binding and appear when it exists, so `access` is the only thing that decides
which of them the model is offered:

| Level        | Tools                           |
| ------------ | ------------------------------- |
| `read`       | `memory_search`, `memory_load`  |
| `read-write` | the above, plus `memory_commit` |
| `full`       | the above, plus `memory_forget` |

| Tool            | Does                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `memory_search` | Ranks, then stitches. Returns an outline of a subgraph and a legend of ids |
| `memory_load`   | Reads whole nodes by id. **The only call that counts as use**              |
| `memory_commit` | Writes a subgraph - nodes and the edges between them - in one transaction  |
| `memory_forget` | Removes nodes, their vectors and their file bytes together                 |

Search and load are split on purpose. Search hands back context the model never
asked for; counting that as use would poison recency ranking. Commit is one
call because a remembered thing is a subgraph, and building it with three calls
leaves the graph half-formed when the model stops early.

The system prompt already explains all of this to the agent - how to read a
recollection, when committing is worthwhile, why correction is a new node. That
text is **derived from `access`**, so an agent that cannot write is never told
how to. Do not restate it in a prompt; state project-specific policy instead.

## How it is organised

### The vocabulary

Seven kinds and four relations, both closed sets, offered to the model as enums.
That is what keeps a graph built by a language model still queryable a month
later.

| Kind         | Is                                                             |
| ------------ | -------------------------------------------------------------- |
| `task`       | a request that started a piece of work                         |
| `plan`       | an approach that worked, worth reusing on a similar request    |
| `fact`       | a durable truth about the environment or the domain            |
| `snippet`    | a short piece of code or configuration, too small to be a file |
| `file`       | an artifact kept whole under `/memory` and re-runnable         |
| `operation`  | an external call that was made - an endpoint, command or query |
| `preference` | a standing instruction from the user that applies to every run |

| Relation     | Reads as                                                  | Effect on recall                |
| ------------ | --------------------------------------------------------- | ------------------------------- |
| `PRODUCED`   | the source led to the target being made (task → artifact) | spine - pulled in first         |
| `CALLS`      | the source invokes the target                             | spine                           |
| `SUPERSEDES` | the source replaces the target; the target is stale       | spine, and **hides** the target |
| `INFORMED`   | the source was context the target was built from          | background - dropped first      |

Override the vocabularies only if the defaults genuinely do not fit the domain.
A wider vocabulary is a vaguer one, and a kind nothing else understands is a
kind no other agent can search for. `kinds` **replaces** the built-in set, with
one exception: `preference` is always available, because the engine itself reads
that kind to build the system prompt.

### Every node

| Field                    | Why it matters                                              |
| ------------------------ | ----------------------------------------------------------- |
| `text`                   | the only thing ranked, and the only thing embedded          |
| `kind`                   | filters a search, and decides how it renders                |
| `audience`               | who may see it. `['*']` is everyone; denied by default      |
| `createdAt`              | provenance, and what `newer_than` filters on                |
| `lastUsedAt`, `useCount` | bumped by `memory_load` alone - the input to recency        |
| `revision`               | optimistic concurrency, via `expected_revision` on a commit |
| `file`                   | the remembered bytes, if any                                |

### How recall actually works

1. **Rank.** The query is embedded and compared against node texts. Anything
   scoring below a fixed floor of `0.15` is noise and is dropped. Superseded
   nodes are excluded, and so are `preference` nodes unless asked for by kind.
2. **Order by recency, but do not admit by it.** Relevance alone clears the
   threshold; decay by `lastUsedAt` only breaks the tie afterwards. Memory that
   keeps proving useful surfaces ahead of memory written once and never read -
   without anything ageing out of reach however well it matches.
3. **Stitch.** Breadth-first from every seed at once, ignoring edge direction,
   because a memory is as often reached from the artifact back to the request as
   the other way.
4. **Spend the budget in tiers**: seeds, then the spine (`PRODUCED`, `CALLS`,
   `SUPERSEDES`), then `INFORMED` context. A tight budget therefore degrades by
   dropping background rather than by truncating the answer.

Defaults: 5 seeds, 2 hops, 25 nodes. `memory_search` takes `limit`, `max_hops`,
`max_nodes`, `kinds` and `newer_than` to move them.

What comes back is a `<memory-recollection>` block: an indented outline where
the indentation _is_ the graph, each line reading `score kind id` or
`→relation kind id`, with each node's text under it **clipped to 160
characters**. That clip is a design constraint on how you write a node - see
below.

### On disk

```
<project>/memory/
├── manifest.json   written LAST - a half-written memory reads as empty
├── graph.json      nodes and edges, parsed whole on open
├── vectors.f32     raw little-endian float32, a quarter the size of JSON
├── vectors.json    the ids those vectors belong to
├── files/          remembered bytes, one per node that has any
└── .lock           held while a run is writing; a dead pid's lock is stale
```

It is project state, not source, and it is not committed. The directory is
mounted **read-only** at `/memory` in the agent's namespace.

## Designing a memory strategy

### The test for what to remember

**Would the next run otherwise have to work this out again?** That is the whole
question. A script that ran, an interface that behaved differently from its
documentation, a call sequence that turned out to be necessary - yes. The
request restated, progress notes, anything unverified, anything a search already
returned - no.

The second test is **would it still be true next month**. Memory has no expiry
and no reviewer. A fact about the environment survives; a fact about today's
data does not, and committing one is how a graph becomes confidently wrong.

### Write the text for the question, not for the answer

Recall ranks a node's `text` against **the user's next message**, because that
is what auto-recall embeds. So the text has to be phrased the way somebody will
ask for it, not the way the system that produced it names it.

| Instead of                        | Write                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `POST /v2/subs/{id}:cancel - 204` | `Cancelling a subscription: POST /v2/subs/{id}:cancel, 204, no body`            |
| `fix for the 409`                 | `A duplicate customer email returns 409, not 422 - retry is wrong`              |
| `script.py`                       | `Weekly invoice reconciliation script - reads billing CSV, writes a diff table` |

Front-load the identifying facts: the first 160 characters are what appears in
a recollection, and everything after that costs a `memory_load` to see.

### The shape of a good commit

One call, several nodes, and the edges that explain them:

```
task      "reconcile invoices against the ledger for a month"
  PRODUCED → file      the script that did it
  INFORMED ← fact      "ledger exports use minor units; invoices use decimals"
file
  CALLS    → operation "GET /v2/invoices?created[gte]= - cursor paging"
```

Committed separately, a later run finds a script with no idea why it exists, or
a fact with nothing that acts on it. Committed together, one hit on any of them
brings the rest.

**Never edit a memory to correct it.** Commit the new one and link it to the old
with `SUPERSEDES`. Recall follows the edge forward and hides what it points at,
so the wrong answer stops being served without being destroyed - and the reason
a thing changed is often the useful part. `zen memory ls --stale` is the list of
corrections that have happened.

A new node whose text is a near-duplicate (cosine ≥ 0.97) of one already there
is **folded into it**, and the existing id comes back under the model's ref, so
the links still land on the memory that was already present.

### Audiences: one graph, masked - not one graph each

Every node carries an `audience`; `sees` is the set an agent reads. `*` is the
public slice and is always included, so a binding can only ever **widen** what
an agent sees, never hide the common ground. An invisible node is
indistinguishable from a missing one, deliberately, so a mask cannot be probed
by id.

Decide audiences before you decide agents. The useful question is not "which
agent wrote this" but "which agent would be misled by this":

| Situation                                         | Configuration                             |
| ------------------------------------------------- | ----------------------------------------- |
| Everything is common ground                       | `memory: true` everywhere. Do this first  |
| A specialist accumulates jargon nobody else needs | `sees: [x]`, `writes: [x]` on that agent  |
| A reviewer should read a slice but not add to it  | `sees: [x]`, `writes: []`, `access: read` |
| A summariser should never write at all            | `access: read`                            |
| One curator may delete                            | `access: full` on exactly one agent       |

When `writes` names exactly one label, the tool schema omits the field and
applies it - there is nothing to choose and nothing for the model to get wrong.
Neither `sees` nor `writes` is ever a tool parameter: an agent that could name
its own audience could read another agent's slice just by asking.

Keep `access: full` rare. Forgetting is almost never the right correction, and a
model that can delete will occasionally tidy.

### Auto-recall

On by default, because an agent that has to remember to go looking mostly does
not. It fires **after new user input and after a hand-off** - not before every
call, because recalling on every turn costs tokens and defeats prompt caching
for a marginal gain. A turn following a tool result does not re-recall.

| Setting          | For                                                                      |
| ---------------- | ------------------------------------------------------------------------ |
| `true` (default) | Almost everything                                                        |
| `{ limit: 2 }`   | A cheap model, or a graph big enough that five seeds is a page           |
| `{ limit: 8 }`   | A research agent where breadth beats prompt size                         |
| `false`          | An agent that should decide for itself when to look - it keeps the tools |

`autoRecall: false` is right for a tool-driven agent whose first turn is
mechanical, and for anything where the user's message is a payload rather than a
question.

### Preferences

A `preference` node is a standing instruction - "always report findings as a
table", "use ISO dates". These are **not recalled by similarity**, because they
are not about the request in front of the agent: an instruction on how to report
is nowhere near a question about gateway rules in embedding space, and a search
would never surface it.

So they are listed rather than ranked, and rendered into the system prompt with
their ids:

```
<memory-preferences>
- report findings as a table with a severity column [01JD9Q7X8N2K4M6P8R0T2V4W6Y]
</memory-preferences>
```

They land in the cached prefix, so they cost once per run rather than once per
turn, and the id is what lets a model replace one with `SUPERSEDES` instead of
quietly ignoring it. They are left out of ordinary recall on purpose - they are
in the prompt already.

Commit one only when the user's own words generalise: "always", "from now on",
"I prefer", "never". A single request being fulfilled is not a standing
instruction, and a graph full of false preferences is a system prompt nobody
wrote.

## Remembering files, and running them again

The workspace is disposable - it may be a container about to be discarded - so a
reference to a path in it dangles the moment the run ends. `memory_commit` takes
a `file` argument on a node instead, and copies the **bytes** out:

```json
{
    "nodes": [
        {
            "ref": "s",
            "kind": "file",
            "text": "Invoice reconciliation script - reads the billing CSV, writes a diff table",
            "file": "reconcile.py"
        },
        { "ref": "t", "kind": "task", "text": "reconcile invoices against the ledger for March" }
    ],
    "edges": [{ "from": "t", "to": "s", "relation": "PRODUCED" }]
}
```

The path is the one the **file tools** use, resolved the same way. The copy
lands at `<project>/memory/files/<id>.<ext>` and appears to the agent as:

```
/memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

| Rule      | Value                                                            |
| --------- | ---------------------------------------------------------------- |
| Size cap  | 2 MiB. Over it, keep the artifact and commit a `snippet` instead |
| Inlined   | under 32 KiB - `memory_load` returns the contents                |
| Larger    | `memory_load` returns the path; open or run it                   |
| Mount     | `/memory`, **read-only**                                         |
| Extension | preserved, because it decides how the file runs and renders      |

Reusing one is the point of keeping it:

```
run_command  python3 /memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

Which means the file has to be **self-contained**. A script that reads
`../data/latest.csv` or imports from the workspace will not run next week; one
that takes its inputs as arguments will. If it needs a credential, it should
read it from the environment and say so in the node text.

Nothing writes to `/memory` through the file tools, so every file under it has a
node explaining what it is and the graph cannot acquire orphans. To change a
remembered file: copy it into the workspace, edit it there, commit the new one
and link it with `SUPERSEDES` to the old.

| Commit as | When                                                                      |
| --------- | ------------------------------------------------------------------------- |
| `file`    | It is runnable, or it is the artifact itself: a script, a config, a query |
| `snippet` | It is a few lines that only make sense read: a request body, a fragment   |
| `fact`    | It is a sentence. A file containing one sentence is a fact in a costume   |

## Memory in front of a `zen rag` index

This is the highest-value thing memory does in a project that has an index, and
it is entirely a matter of **what you commit**.

### The division of labour

|                 | A schema/docs index                                             | Memory                            |
| --------------- | --------------------------------------------------------------- | --------------------------------- |
| Holds           | the API or the documents, completely                            | what earlier runs worked out      |
| Authority       | the source of truth                                             | a record, never a substitute      |
| Completeness    | exact and countable                                             | a ranked, masked slice            |
| Freshness       | as fresh as the last `index`                                    | as stale as it was allowed to get |
| Cost of a query | one embedding round trip (`search`), or nothing (`list`/`grep`) | already in the prompt             |

So: **never copy index content into memory.** A schema pasted into a node goes
stale silently and the index already answers in milliseconds; a documentation
passage quoted into a node outlives the release it was true for and will look
exactly as authoritative when it is wrong.

What memory should hold is the **route** - the resolution, not the source:

| Commit                                                                            | Kind               | Because                                                                           |
| --------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| The endpoint that turned out to be the answer, and its shape                      | `operation`        | A `search_api` costs a round trip and returns five ranked guesses; this names one |
| The sequence of calls that was necessary                                          | `plan`             | No ranking finds an ordering. It is not in the document                           |
| Where the answer lives in the docs - document name, heading, line range           | `fact`             | `zen rag docs show` reads it back verbatim and current                            |
| A convention the index cannot state - auth, casing, base path, the error envelope | `fact`             | It is not in the graph, and it is wrong to re-derive it every run                 |
| Where the index itself is                                                         | `fact`             | `-d` or `$ZEN_SCHEMA_DB`. An agent cannot guess a path                            |
| A working request body, or a script that drives the API                           | `snippet` / `file` | The thing you would otherwise write again                                         |
| That a search returned nothing, and `grep` confirmed absence                      | `fact`             | Proving a negative twice is pure waste                                            |

### Why it makes search cheaper

Auto-recall fires **before the model's first tool call of the turn**. So the
recollection arrives before the decision to search is made - and a recalled
`operation` node naming `POST /v2/subs/{id}:cancel` removes the search
entirely, rather than making it faster. When the recollection is only close, it
still narrows: the model reaches for `list_api --name` or `grep_api` instead of
`search_api`, which are local, exact, and cost nothing.

Phrase these nodes accordingly. The next question will arrive as _"how do I
cancel someone's subscription?"_, not as `cancelSubscription`, so the node text
must contain the human phrasing **and** the identifiers. Put the question first
and the answer second.

### Keeping it honest against re-indexing

An index is rebuilt when the source changes; memory is not. Two habits keep the
two from drifting:

1. **Name the version in the node text** - "Billing API v2", "acme\_4.1.0 docs".
   A recollection about a version the project no longer uses is then visibly
   about the wrong thing rather than invisibly wrong.
2. **Supersede after a re-index.** When a route changes, commit the new
   `operation` node with `SUPERSEDES` pointing at the old one. `zen memory ls
--kind operation` is the review list.

And state the rule in the project's own skill for the index: **verify against
the index before acting on a recalled route.** Recall is a shortcut past the
search, not past the truth. One `list_api --name` or `zen rag docs show` is
cheap and settles it.

### The project skill is where this is written down

An index used by a project needs a skill in that project describing it - see
`zen-rag-schema` and `zen-rag-docs`. Memory policy belongs in the same skill,
because it is the same subject:

```md
- Recalled routes are a shortcut, not authority. Confirm with `list_api --name`
  before writing a call against one.
- After solving something the index made you work for, commit it: the
  `operation` you ended on, linked to the `task` that asked and any `fact` you
  had to discover. Phrase the text as the question, not as the operation id.
- Never commit schema text or documentation passages. Commit the pointer -
  document, heading, line range - and read it back with `zen rag docs show`.
```

## The house rules

**Every project that enables memory carries `references/memory-house-rules.md`
in its own `INSTRUCTIONS.md`** - copied whole and verbatim, as part of turning
memory on. That file is how the agent is told to use the store: read and search
it only through the tools, never through `/memory` itself, and what a node must
carry to still be worth having. Project-specific policy goes underneath it.

When the reference changes, re-paste it rather than hand-patching the copies.

## Inspecting and repairing it

```
zen memory [stats|ls|show|export|forget] [args] [options]
```

`zen memory export --open` is the one to reach for: one self-contained HTML
page with every node, the graph as a diagram, and the remembered file's actual
content in the detail pane. It reads **unmasked** - when the mask is what is
wrong, the hidden part is exactly the part you need - and it contacts no model,
so inspection is free and offline.

| Question                                 | Command                          |
| ---------------------------------------- | -------------------------------- |
| Is memory even on, and is it embedded?   | `zen memory stats`               |
| What has this project learned?           | `zen memory export --open`       |
| What is in one private slice?            | `zen memory ls --audience audit` |
| What has been corrected?                 | `zen memory ls --stale`          |
| What files are being kept?               | `zen memory ls --files`          |
| Why was that recalled?                   | `zen memory show <id>`           |
| That should never have been written down | `zen memory forget <id>`         |

`zen inspect` answers the other half: a run report shows the recollection block
exactly as the model received it, which is how you tell "memory had nothing"
apart from "memory had it and the model ignored it".

## A worked configuration

```yaml
embeddings:
    main: openai:text-embedding-3-small

memory:
    dir: memory
    embedding: main

agents:
    - name: triage # front door: reads everything, writes the common ground
      memory: true

    - name: api-worker # does the work; keeps its own routes and scripts
      memory:
          access: read-write
          sees: [api]
          writes: [api]
          autoRecall: { limit: 8 }

    - name: reporter # formats the answer; must not invent memories
      memory:
          access: read
          autoRecall: false

    - name: curator # the only thing that may delete
      memory:
          access: full
          sees: [api]
```

## Review checklist

- [ ] `INSTRUCTIONS.md` carries the block from `references/memory-house-rules.md`,
      verbatim and current.
- [ ] `memory.embedding` is set, and was set before the graph had content.
- [ ] Every agent that should learn has a `memory:` binding - the top-level
      block alone enables nothing.
- [ ] `access: full` appears at most once.
- [ ] `sees`/`writes` exist because an agent would be **misled** by the other
      slice, not merely because it does not need it.
- [ ] `autoRecall: false` on any agent whose user message is a payload.
- [ ] Nothing authoritative is expected to live here - that is a skill's job.
- [ ] The project's index skill says to verify a recalled route.
- [ ] `zen memory export --open` after a week of use, to see what it actually
      learned rather than what you hoped.

## When it goes wrong

| Symptom                                           | Cause                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The `memory_*` tools are missing                  | No `memory:` on the agent. They come from the binding, never from `tools:`                                 |
| `zen memory` says the project has none            | Neither a `memory:` block nor an agent binding - nothing is opened and no directory is made                |
| Recall finds a memory only when reworded          | No embedder. `zen memory stats` says `embedding none`                                                      |
| Recall finds nothing after changing the embedder  | Refused rather than mixed - a manifest records the model. Re-embed or change it back                       |
| Vectors fewer than nodes                          | Some nodes were committed with no embedder; they are only reachable by term overlap                        |
| The graph fills with restated requests            | The commit rule is not in a prompt or skill. State the "would a later run redo this" test                  |
| An agent greps `/memory` or reads `graph.json`    | The house-rules block is missing from `INSTRUCTIONS.md` - the system prompt never forbids it               |
| A recalled fact cannot be checked or continued    | Nodes were committed with no provenance. The block's "say where it came from" rule is what prevents it     |
| A wrong memory keeps coming back                  | It was edited instead of superseded, or superseded in the wrong direction - the **new** node is the source |
| An agent cannot see a node you can                | Its `audience` is not in that agent's `sees`. Invisible and missing are the same thing, on purpose         |
| "this agent cannot remember files"                | The agent has no workspace, so a path cannot be resolved. Commit without `file`                            |
| A remembered file will not run                    | It is not self-contained - it referenced the workspace it was written in                                   |
| Recollections are large and unhelpful             | `autoRecall.limit` is too high, or node texts describe answers rather than questions                       |
| The model recalls a route the API no longer has   | Nothing re-checks memory against a rebuilt index. Supersede, and require verification                      |
| A second run of the same project refuses to start | The directory lock. A lock whose process is gone is stale and is taken over                                |
