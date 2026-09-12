# Giving agents memory

Memory is what an agent keeps when the session ends. Without it every run starts
from nothing: the same investigation is done twice, the script that worked last
week is written again, and a correction the user made on Tuesday is gone by
Thursday.

It is a **graph**, not a list. A node is one thing worth keeping - a task, a
plan, a fact, a snippet, a file, an API call, a preference - and an edge says
how one led to another. Recall returns the connected piece, so an agent that
finds the right answer also gets the reasoning that produced it and the script
that ran it.

It lives with the project, not the session. A memory that died with the session
would be a cache.

## Memory is not a corpus

The distinction is worth being firm about, because the two get confused and the
wrong one is expensive.

| Use                                                     | For                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Memory**                                              | What the agents learned by working: what was tried, what it cost, what the answer turned out to be, what the user asked for |
| **A document index** ([knowledge.md](knowledge.md))     | Prose that already exists and does not change per run                                                                       |
| **A schema index** ([integrations.md](integrations.md)) | An API description                                                                                                          |
| **`assets/`**                                           | Anything an agent should read the same way every time                                                                       |
| **`agents/*instructions.md`**                           | What is always true, for everybody                                                                                          |

If a fact is in a manual, index the manual. Memory is for what is not written
down anywhere yet.

## Turning it on

```yaml
memory:
    dir: memory
    embedding: main

agents:
    - name: auditor
      memory: true
```

That is the whole feature. The agent can search, load and commit, and it recalls
automatically before answering new user input. The block is optional - an agent
saying `memory: true` gets the defaults without one, and a project that mentions
memory nowhere opens no store and creates no directory.

**Give it an embedding.** Without one, recall falls back to term overlap, which
finds a memory phrased the way the query was and misses the rest. The width is
learned from the first response, and changing the model afterwards is refused
rather than silently mixing two vector spaces.

The store is a directory in the project (`memory/` by default). `zen init`
git-ignores its vectors, because they are derived and large; the graph itself is
worth committing if the team shares one.

## What gets remembered

Kinds are `task`, `plan`, `fact`, `snippet`, `file`, `operation`, `preference`;
relations are `PRODUCED`, `INFORMED`, `CALLS`, `SUPERSEDES`. Both are closed
sets offered to the model as enums, which is what keeps a graph built by a
language model queryable a month later. Widen them only if the domain genuinely
does not fit - a wider vocabulary is a vaguer one.

Two kinds do something the others do not.

**Files.** An agent that writes a working script can keep it. The file is copied
under a generated id and mounted read-only at `/memory`, so a later run executes
it directly:

```
run_command  python3 /memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

The graph holds the provenance around it - what asked for it, what plan it came
from, what it called - and that subgraph is what comes back on recall.

**Preferences.** A memory of kind `preference` is a standing instruction from
the user: "always report findings as a table", "use ISO dates". These are not
recalled by similarity, because they are not _about_ the request in front of the
agent - an instruction on how to report sits nowhere near a question about
gateway rules in embedding space, and a search would never surface it. So they
are listed rather than ranked, and rendered into the system prompt with their
ids, in the cached prefix, costing once per run rather than once per turn.

**Correction is a new node, not an edit.** A memory that turns out to be wrong
is superseded by one that is right, joined by a `SUPERSEDES` edge, and recall
follows the edge forward. The old node stays, because the reason a thing changed
is often the useful part.

## Who sees what

```yaml
agents:
    - name: auditor
      memory:
          access: read-write
          sees: [audit]
          writes: [audit]
          autoRecall: { limit: 3 }
```

`access` decides the tools and nothing else does: `read` gets `memory_search`
and `memory_load`, `read-write` adds `memory_commit`, `full` adds
`memory_forget`. These four are never named in `tools:` - the binding is what
grants them.

**One memory, masked - not one memory each.** Every node carries an audience,
and `sees` is the set an agent reads. `*` is the public slice and is always
included, so a binding can only widen what an agent sees, never hide the common
ground. `writes` is the other half: an agent that reads a private slice need not
be able to add to it.

**Auto-recall is on by default**, because an agent that has to remember to go
looking mostly does not. It costs one embedding call on turns that follow new
user input, and nothing on the rest. `autoRecall: false` keeps the tools and
leaves the agent to decide when to search.

## Looking at it

Recall is masked, ranked and truncated by design, so what an agent sees is never
the whole picture - and when the picture is what is wrong, you need the part
that was hidden. `zen memory` reads the graph **unmasked**, locally, without
contacting a model:

```sh
zen memory stats            # size, vocabulary, whether it is embedded
zen memory ls --files       # nodes, newest first
zen memory show <id>        # one node in full, with what it links to
zen memory export --open    # the whole graph as one self-contained HTML page
zen memory forget <id...>   # remove nodes, their vectors and their files
```

`export` is the one to reach for: node list on the left, graph in the middle,
whatever you clicked on the right, file contents and all.

`forget` is for what should never have been written down - it removes the node,
its vector and its file bytes together. A memory that is merely out of date
should be superseded instead.

## Say it in the specification

Memory changes what the system is, so it belongs in `SPECIFICATION.md`: that
agents remember between sessions, what kind of thing is worth keeping, who may
read whose, and what must never be written down. The scaffolded specification
lists memory under **Out of scope** for exactly this reason - moving it out of
that list is the change, and `/sync-with-spec` does the wiring. See
[specification.md](specification.md).

## Further

- [agents-yaml.md](agents-yaml.md#memory) - the full `memory:` and
  `agents[].memory` reference
- Your editor has a `zen-memory` skill installed by `zen init`, with the
  commit-worthiness rules and the recall shapes.
