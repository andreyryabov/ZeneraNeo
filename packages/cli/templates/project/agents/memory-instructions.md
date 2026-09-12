# Memory

This project has a memory: a graph of what earlier runs worked out, kept with
the project rather than with the session. It is reached **only** through the
`memory_*` tools - `memory_search` to find, `memory_load` to read,
`memory_commit` to write.

## How it is organised

A node is one thing worth keeping. It carries a `kind`, a `text` - the only
thing searched - and optionally a remembered file. An edge says how one node led
to another.

| Kind         | Is                                                        |
| ------------ | --------------------------------------------------------- |
| `task`       | the request that started a piece of work                  |
| `plan`       | an approach that worked and would work again              |
| `fact`       | a durable truth about this codebase, API or environment   |
| `snippet`    | a few lines of code or configuration                      |
| `file`       | an artifact kept whole and re-runnable                    |
| `operation`  | an external call that was made - endpoint, command, query |
| `preference` | a standing instruction from the user                      |

| Relation     | Reads as                                            |
| ------------ | --------------------------------------------------- |
| `PRODUCED`   | the source led to the target being made             |
| `CALLS`      | the source invokes the target                       |
| `SUPERSEDES` | the source replaces the target; the target is stale |
| `INFORMED`   | the source was context the target was built from    |

So a remembered piece of work is a subgraph, not a row:

```
task       the request that started this
  PRODUCED → file | snippet | operation     what came out of it
  INFORMED ← fact                            what had to be known first
file
  CALLS    → operation                       what it calls
```

What you are shown is ranked, masked and clipped. **Assume a recollection is
part of the answer, never all of it.**

## Reading it

`memory_search` hands back an outline of a subgraph with each node's text cut to
160 characters. `memory_load` is what reads a node whole, by id - load anything
you are going to rely on.

A remembered file appears at `/memory/<id>.<ext>`. Open it or run it, but arrive
at that path through `memory_load`, never by looking around in the directory.

**Never read the store directly.** `/memory` holds `graph.json`, `vectors.f32`,
`vectors.json` and `manifest.json` - its internal format. Do not open, list,
grep, `cat` or `find` them, and do not point a shell command at that directory:

- it is ranked by **meaning**, so substring matching misses the hits;
- `graph.json` is every node ever committed, as one line;
- a raw read bypasses the audience mask and serves **superseded** nodes -
  corrections that were withdrawn - as if they were current;
- it records no use, so the ranking that decides what gets recalled next decays;
- another run may be writing, and the manifest is written last.

A memory is a record, not an authority. Every node names where its content came
from; follow that pointer and re-read the source before acting on anything you
would not want to be wrong about.

## Searching it

Search **before** paying for anything: an investigation, an index query, a
build, a long command. One `memory_load` is cheaper than working the same thing
out twice; it is not cheaper than re-reading the file it points at.

Phrase the query as the question you are actually asking, in the words a person
would use - node texts are written to be found that way. Narrow with `kinds`,
`newer_than`, `limit`, `max_hops` and `max_nodes` when a recollection comes back
broad rather than wrong.

Recalling nothing is not proof of anything: work it out normally, then commit
the result so the next run does not repeat it.

## Updating it

Commit when **the next run would otherwise have to work this out again** and
working it out cost more than a `memory_load` will. If the answer is one cheap
tool call away, do not.

| Worth committing                                             | Not worth committing                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| The route through the codebase to a recurring question       | The content of a file, which a read gives current              |
| What a schema or docs search resolved to                     | The ranked guesses it returned on the way there                |
| The call or command sequence that turned out to be necessary | A single tool call that answers in milliseconds                |
| The exact invocation that finally worked, with its directory | The request restated, or notes on progress                     |
| A working script or request body, committed whole            | Anything not actually verified                                 |
| An interface that behaved differently from its documentation | Anything true only of today's data                             |
| A proven absence - looked here and here, it is not there     | Schema, index or documentation text, which goes stale silently |

A search over a schema or a documentation index costs a round trip and comes
back ranked, so it is the thing most worth not paying for twice. Commit what it
**resolved to** - the operation and its shape, or the document, heading and line
range - and read the content itself back from the index when you need it.

Then the rules for writing it down:

**Commit the whole subgraph in one call.** A script with no record of what asked
for it, or a fact with nothing that acts on it, is a memory nobody can use.

**Say where the content came from.** This is what lets an incomplete
recollection be continued instead of believed:

| The node holds                  | Name                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------- |
| A fact about this codebase      | the file and the line range it was read from - `src/models/factory.ts:120-168`   |
| Anything spanning several files | every one of them, each with its range, in the order they are read               |
| An API route or a behaviour     | the document and operation id, or the request sent and the status that came back |
| Something a document states     | document, heading and line range - never the passage itself                      |
| Something a command established | the exact command, its arguments, and the directory it ran in                    |
| A plan                          | the steps, and where each step's target lives                                    |
| A negative result               | where you looked, so the search is not repeated                                  |

**Write the text as the question.** Not the way the system that produced it
names things, and with the identifying facts first - only the first 160
characters appear in a recollection.

| Instead of        | Write                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `fix for the 409` | `A duplicate customer email returns 409, not 422 - retry is wrong (src/billing.ts:88-104)` |
| `retry.ts`        | `Where retries are configured: one policy for all adapters, src/models/factory.ts:40-96`   |

**Prefer a remembered file.** When what is worth keeping is content - a script,
a config, a query, a request body, a rendered table of findings - commit it as a
`file` node and split the two halves: the `text` describes the content and says
where it came from, the file holds the content itself, whole and exactly as it
was. Only the text is searched, and only its first 160 characters are shown, so
content pasted into it is unfindable and in the way; content in a file costs
nothing until a `memory_load` asks for it, and comes back at
`/memory/<id>.<ext>` to be read or run.

Make the file self-contained - it will be opened in a different workspace, so it
takes its inputs as arguments and reads credentials from the environment - and
say so in the text. **Give it a configurable output path.** `/memory` is
read-only: a script that writes beside itself fails, while one that takes
`--out` writes into the workspace and is reusable unchanged. Use a `snippet`
only for the few lines that are read rather than run.

A remembered script runs from where it is - the mount is readable, so
`python3 /memory/<id>.py` or `node /memory/<id>.js` needs no copy first:

```
python3 /memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py --out ./report.csv
```

**Read it before running it.** It is code an earlier run wrote, recalled by
similarity: `memory_load` returns its contents, or its path when it is large, in
which case read the file. Confirm it is the thing you want, and that its
arguments are what you think, before executing anything.

**Never commit a copy of something the project already holds.** A source file, a
schema, a documentation passage: commit the pointer. A copy goes stale silently
and looks exactly as authoritative when it is wrong.

**Correct by superseding, never by editing.** Commit the new node and link it to
the old one with `SUPERSEDES`. Recall then stops serving the wrong answer
without destroying the record of why it changed.

**Ask whether it will still be true next month.** Memory has no expiry and no
reviewer. A durable fact about this project survives; a fact about this
afternoon's state is how a graph becomes confidently wrong.
