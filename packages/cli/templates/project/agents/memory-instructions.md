# Memory

This project has a memory: a graph of what earlier runs worked out, kept with
the project rather than with the session, and shared with every other agent that
can see it. It is reached **only** through the `memory_*` tools - `memory_search`
to find, `memory_load` to read.

Not every agent may write to it. Read what follows against the tools you
actually have: if `memory_commit` is not among them, everything under
[Updating it](#updating-it) is not yours to do, and if `memory_forget` is not
among them, neither is [Forgetting](#forgetting).

It exists to make the next run cheaper. Work that cost something - a long
investigation, a fan-out of searches, a build, an invocation found by trial -
should be paid for once. A recollection is a cache hit: check it, do not
rebuild it.

## What belongs in it

One question decides both what to keep and how far to trust it:

**Can the next run get this itself, cheaply and current?**

| When the answer is                                                                    | Keep                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| one read, one call, one command away                                                  | the way to get it - the route, the call, the script, the invocation |
| assembled from several sources, with a judgement on top                               | what you concluded, and a pointer to every source it came from      |
| out of something that cannot change - a released spec, a pinned or versioned document | the finding itself, whole, in a file that names where it came from  |
| a reading of the moment - an API response, a query result, what a script printed      | the call that produces it, never the reading                        |

Remember the **route** when the answer is cheap, the **answer** when the route
is expensive, and never a value that is stale by the next run.

## How it is organised

A node is one thing worth keeping. It carries a `kind`, a `text` - the only
thing searched - and optionally a remembered file. An edge says how one node led
to another.

The two halves do different jobs, and the split is the same every time: the
**text is how the node is found** - what it is, what it establishes, where it
came from - and the **file is what the node holds**. Only the text is searched,
and only its first 160 characters are ever shown, so content written into it is
both unfindable and in the way. Once something is worth committing at all, the
usual shape is therefore a short description and a file behind it.

A node with no file is for what fits on **one line** - a path and a line range,
a command, a standing instruction, a single stated fact. If what you are keeping
runs past a line or two, it is content, and content goes in the file.

| Kind         | Is                                                                                   |
| ------------ | ------------------------------------------------------------------------------------ |
| `task`       | the request that started a piece of work                                             |
| `plan`       | an approach that worked and would work again                                         |
| `fact`       | a durable truth about this codebase, API or environment                              |
| `snippet`    | a few lines of code or configuration                                                 |
| `file`       | an artifact kept whole - a script to re-run, an answer or passage too big for a text |
| `operation`  | an external call that was made - endpoint, command, query. The call, not its answer  |
| `preference` | a standing instruction from the user                                                 |

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

Relation is what decides where the clipping falls. Everything reached across
`PRODUCED`, `CALLS` or `SUPERSEDES` is the work itself; everything reached
across `INFORMED` is context, and context is what a short recollection drops
first - so the answer degrades by losing its background rather than by being cut
in half. Attach with `INFORMED` what **explains** a node, never what the next run
needs in order to **use** it: the endpoint a script calls, or the request that
produced it, belongs on the spine, where it is still there when the budget is
tight.

`INFORMED` also reads in a direction - from the background to the work it fed,
so a `fact` informs an answer and never the other way round. Written backwards
it still traverses, and still renders; it just says the answer was context for
its own source.

## Reading it

`memory_search` hands back an outline of a subgraph with each node's text cut to
160 characters. `memory_load` is what reads a node whole, by id - load anything
you are going to rely on.

### The shape of a recollection

A recollection arrives in a `<memory-recollection>` block, and it is a subgraph
rather than a ranked list - the links are as much of the answer as the nodes. It
is an outline, and the indentation is the graph.

A line at the left margin reads `score kind id` and is something the search
matched; a root the walk reached rather than matched carries `--` where the
score would be. A line indented under it reads `<arrow>relation kind id` and is
a neighbour: `→produced` means the line above produced this one, `←informed`
means this one informed the line above. A neighbour the search matched in its
own right carries its score too, after the arrow.

Under each header, indented further, is that node's text. A `file` node carries
one line more, above the text: the path under `/memory` to open or run, its
size, and how often it has been read.

A line beginning `+` is a link to an id already shown above, for an edge the
outline could not nest. It never points forward, so resolving one only ever
means looking back up the block.

Text is clipped at 160 characters - copy an id into `memory_load` to read a node
whole. `memory_search` finds ids; it does not return contents.

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

A memory is a record, not an authority - but checking one is not the same as
redoing it. Every node names where its content came from, so confirm the
recollection there: the named lines still say what the node says, the route
still resolves, the command still exists. Work it out from nothing only when
that check fails, when the source is one that changes under you, or when being
wrong is expensive. A check that costs what the original investigation cost is
not a check - it is the investigation again, and the memory bought nothing.

## Searching it

Search **before** paying for anything: an investigation, an index query, a
build, a long command. The point is not to find a pointer - it is to arrive at
the answer without buying it twice.

One `memory_load` is not cheaper than re-reading the single file a node names.
It is far cheaper than redoing what produced that node: several documents read
in sequence, a fan-out of searches, a delegated lookup, a long run. Price a
recollection against what it **saves**, never against one read.

Phrase the query as the question you are actually asking, in the words a person
would use - node texts are written to be found that way. Narrow with `kinds`,
`newer_than`, `limit`, `max_hops` and `max_nodes` when a recollection comes back
broad rather than wrong.

Recalling nothing is not proof of anything: work it out normally, then commit
the result so the next run does not repeat it.

## Updating it

Commit when **the next run would otherwise have to work this out again** and
working it out cost more than a `memory_load` will. The measure is what the
answer COST, not what kind of thing it is: one cheap tool call away, do not;
five reads, a fan-out and a judgement, commit the judgement and not only the
five paths.

| Worth committing                                                  | Not worth committing                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| The route through the codebase to a recurring question            | A verbatim copy of one living file, which a read gives current      |
| What a schema or docs search resolved to, and what you made of it | The ranked guesses it returned on the way there                     |
| The call or command sequence that turned out to be necessary      | A single tool call that answers in milliseconds                     |
| The exact invocation that finally worked, with its directory      | The request restated, or notes on progress                          |
| A working script or request body, committed whole                 | What running it printed - a reading, which the script gives current |
| An interface that behaved differently from its documentation      | What a call returned, which the call gives current                  |
| The passage itself, when its source cannot change under you       | A passage quoted out of something that can                          |
| A proven absence - looked here and here, it is not there          | Anything not actually verified                                      |

A search over a schema or a documentation index costs a round trip and comes
back ranked, so it is the thing most worth not paying for twice. Commit what it
**resolved to** - the operation and its shape, or the document, heading and line
range - **and what you concluded from reading it**. The pointers alone make the
next run repeat the reading; the conclusion alone cannot be checked. Both, in
one subgraph, and the next run answers at once and verifies cheaply.

When the index is over something pinned - a released spec, a versioned reference
tree - go one further and carry the passage itself in a `file` node, headed with
the documents and line ranges it was taken from. The pointer says where to look
and the conclusion says what it meant, but only the passage saves the next run
from opening the sources to find out what they actually said.

Then the rules for writing it down:

**Commit the whole subgraph in one call.** A script with no record of what asked
for it, or a fact with nothing that acts on it, is a memory nobody can use. Refs
resolve only within a single `memory_commit`, so a subgraph split across calls
arrives without its links.

**Do not re-commit what a search already returned.** A node that says what one
already in memory says is folded into it, and its existing id comes back under
your ref - so the links you asked for still land, on the memory that was already
there.

**Say where the content came from.** This is what lets an incomplete
recollection be continued instead of believed:

| The node holds                  | Name                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A fact about this codebase      | the file and the line range it was read from - `src/models/factory.ts:120-168`                                                |
| Anything spanning several files | every one of them, each with its range, in the order they are read                                                            |
| An API route or a behaviour     | the document and operation id, or the request sent and the status that came back                                              |
| Something a document states     | document, heading and line range, next to what it states - the pointer is how the passage is checked, not a substitute for it |
| Something a command established | the exact command, its arguments, and the directory it ran in                                                                 |
| A plan                          | the steps, and where each step's target lives                                                                                 |
| A negative result               | where you looked, so the search is not repeated                                                                               |

**Write the text as the question.** Not the way the system that produced it
names things, and with the identifying facts first - only the first 160
characters appear in a recollection.

| Instead of        | Write                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `fix for the 409` | `A duplicate customer email returns 409, not 422 - retry is wrong (src/billing.ts:88-104)` |
| `retry.ts`        | `Where retries are configured: one policy for all adapters, src/models/factory.ts:40-96`   |

**Put the content in a file, not in the text.** This is the usual shape, not a
special case: a script, a config, a query, a request body, a rendered table of
findings, a passage worth keeping whole, an answer that took several sources to
assemble - all of it is a `file` node split in two. The `text` describes the
content and says where it came from; the file holds the content itself, whole
and exactly as it was - the entire block, not a summary of it. Content in a file
costs nothing until a `memory_load` asks for it, and comes back at
`/memory/<id>.<ext>` to be read or run. Commit a node with no file only when the
whole of what you know is one line long.

**Name the sources inside the file as well as in the text.** The two halves
arrive separately - a recollection shows the text, and only a later
`memory_load` opens the file - so a file read on its own is an assertion with
nothing behind it. Open it with a header naming every document, heading and line
range the content came from, and when it was taken, then the content verbatim:

```markdown
<!-- reference-docs-1.4/overview.html.md:112-160 and
     reference-docs-1.4/architecture.html.md:38-91
     pinned 1.4 reference tree, read 2026-04-09 -->

...the passages, whole and unedited...
```

Use whatever comment form the file's own format takes. A header costs two lines
and is the difference between a copy that can be re-checked against its source
and one that can only be believed.

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

**Commit what produces the answer, not the material it was made from.** This is
about what to keep, not what form to keep it in - whatever survives the test
still goes in a file. A file the project holds: the pointer, never a copy - a
copy goes stale silently and looks exactly as authoritative when it is wrong. An
external call: the `operation` - route, auth, the parameters that mattered, the
status a case returns - never the body that came back. A script: the file and
the invocation that worked, never its output. What a run ESTABLISHED belongs in
the node's text - that it works, what it was run against, the verdict that was
the point; the rows it emitted do not.

Two things fall outside that. An answer you assembled from several sources is a
copy of none of them and exists nowhere in the project, so commit it, with a
pointer node per source `INFORMED`ing it. And a source that cannot change under
you (a released specification, a pinned dependency, a versioned reference tree)
does not go stale silently, so the finding may be kept whole.

When it is kept whole, keep it as a `file` node rather than as a longer `text`:
the text says what the passage establishes and names the documents it came from,
the file carries the whole block behind its provenance header. Say in the text
which kind of source it was, so a later run can see why a copy was allowed. A
pointer alone, with nothing of what the source said, makes the next run open all
of it again - which is the reading the memory was supposed to buy.

A body or a result set may still be worth keeping as a SPECIMEN - a shape to
write against, a case to reproduce. Commit it as a `file` node whose text says
what was asked, when, and that it is what came back then, never what the data
is. Keep credentials and personal data out of the store: it outlives the
session and every later run can read it.

**Correct by superseding, never by editing.** Commit the new node and link it to
the old one with `SUPERSEDES`. Recall then stops serving the wrong answer
without destroying the record of why it changed.

**Ask whether it will still be true next month.** Memory has no expiry and no
reviewer. A durable fact about this project survives; a fact about this
afternoon's state is how a graph becomes confidently wrong.

### Preferences

A `preference` is a standing instruction from the user, and it is not recalled
like everything else: every preference you can see is rendered into a
`<memory-preferences>` block at the start of every later run, each with its id.
They apply unless that run's request contradicts them.

So commit one only when the user's own words generalise - "always", "from now
on", "I prefer", "never". A single request being fulfilled is not a standing
instruction, and one committed by mistake is in every future prompt until
something supersedes it.

To change one, commit the replacement and link it to the id shown in that block
with `SUPERSEDES`.

### Forgetting

Forget only what is wrong and has no successor. A superseded memory is already
hidden from recall and should stay for the history, so `memory_forget` is for
what should never have been written, not for what has been replaced.
