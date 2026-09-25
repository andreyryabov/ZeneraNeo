# Memory - `zen memory`

```
zen memory [stats|ls|grep|show|export|merge|forget] [args] [options]
```

Alias: `mem`.

The memory graph from outside the agents. It exists to answer the question
memory always eventually raises: **why did it recall that?**

Only projects that enable memory have one, and the commands say so rather than
inventing an empty graph. Turning it on is the `memory:` block in `agents.yaml`.

This document is the command. For how the graph is organised, how to configure
it, and how to decide what an agent should remember, read the `zen-memory`
skill.

## Subcommands

| Command                   | What it does                                |
| ------------------------- | ------------------------------------------- |
| `zen memory stats`        | Size, vocabulary, whether it is embedded    |
| `zen memory ls`           | Nodes, newest first. Changes nothing        |
| `zen memory grep <pat>`   | Every node containing it, with the lines    |
| `zen memory show <id>`    | One node in full, with what it links to     |
| `zen memory export [f]`   | The whole graph as one HTML page            |
| `zen memory merge <dir…>` | Fold other memories into this one           |
| `zen memory forget <id…>` | Remove nodes, their vectors and their files |

| Flag                          | Meaning                                        |
| ----------------------------- | ---------------------------------------------- |
| `--project <name\|dir>`       | Which project. Inferred from the directory     |
| `--dir <dir>`                 | Read this memory directory instead             |
| `--kind <name>`               | Only this kind of node                         |
| `--audience <name>`           | Only nodes committed under this label          |
| `--files`                     | Only nodes that remember a file                |
| `--stale`                     | Only nodes something has superseded            |
| `--all`                       | For `grep`: superseded nodes too, marked       |
| `--regex`                     | Read the `grep` pattern as a regex, per line   |
| `--case-sensitive`            | Match case exactly. Off by default             |
| `--in <text\|metadata\|file>` | Where `grep` looks. Repeatable. All by default |
| `--ids-only`                  | Print bare ids, for piping into `show`         |
| `--limit <n>`                 | Rows to list. Default 30                       |
| `--out <file>`                | Where `export` writes. Default `memory.html`   |
| `--open`                      | Open the exported page                         |
| `--dry-run`                   | Say what `merge` would do, and stop            |
| `--no-dedupe`                 | Keep memories `merge` would otherwise fold     |
| `--force`                     | Let `merge` pick a winner where copies differ  |
| `--yes`                       | Do not ask before removing or merging          |

## `grep` answers what recall cannot

Recall ranks, and a ranking returns the top of a list. It can say what is
closest; it can never say that nothing is there. `grep` reads every node
exactly - the text, the metadata, and the bytes of every remembered file - and
reports the lines it matched on:

```sh
zen memory grep 'staging.example.com'        everywhere that host is mentioned
zen memory grep 'API_KEY' --in file          only inside remembered files
zen memory grep '^def ' --regex --kind file  matched per line, as grep does
zen memory grep pandas --ids-only | xargs -n1 zen memory show
```

The count it prints is the true one even when `--limit` cut the list, and a
remembered file it could not read - too big, binary, missing - is named rather
than silently skipped, because a file that went unsearched must not pass for one
with no match.

Superseded nodes are left out unless you ask: `--all` includes them marked, and
`--stale` narrows to them alone.

It is also the one subcommand that does not take the directory lock, so it works
while a run is writing the memory, and against the read-only `/memory` mount
inside a sandbox.

## A graph that is not the project's

`--dir` opens a memory directory as it stands, and skips project resolution
entirely: there need be no `agents.yaml` anywhere above it. That is what to use
for a graph a run was pointed at with `zen run --memory <dir>`, and for a copy
taken out of a running session - though for reading a live memory, `grep` needs
no copy at all.

```
zen run --memory .tmp/mem "…"     remember into .tmp/mem for this run
zen memory --dir .tmp/mem stats   then read that graph, from anywhere
```

## It reads unmasked, on purpose

Memory is masked per agent: a node's `audience` decides who can see it. Recall
is masked, ranked and truncated as well, so what an agent gets is never the
whole picture.

This command ignores all of that. When the mask is the thing that is wrong, the
part that was hidden is exactly the part you need - and this is a person at a
terminal in the project directory, not an agent inside a run.

It also contacts no model. The store is opened without an embedder, so
inspection is free and works offline; the price is that `ls` filters by text
rather than by meaning.

## `export` is the one to reach for

```sh
zen memory export --open
```

One self-contained HTML file, three panes:

- **left** - every node, with a search box and filters for kind, audience,
  files, superseded and unlinked
- **middle** - the graph as a Mermaid diagram, coloured by kind, with pan,
  zoom, and a hop-focus selector for following one node's neighbourhood
- **right** - whatever you clicked, in full: the text, the metadata, the links,
  and **the remembered file's actual content** - rendered as an image when it is
  one, and as text otherwise

Clicking a node in either the list or the diagram selects it in both. Above 300
drawn nodes the diagram asks you to narrow it with the filters, because a
Mermaid graph that large is not a picture of anything.

It is a single file with no server behind it, so it attaches to a bug report.
The only network it does is fetching Mermaid; without that it degrades to a
working list and detail view.

## Merging

The lock is per directory, so two runs cannot warm the same memory at once.
They each warm their own, and `merge` puts the results back together:

```sh
zen memory merge .tmp/warmup-*/memory                    into the project’s
zen memory merge a/memory b/memory --dir merged/memory   into a named one
```

Sources are positional and the target is `--dir`, or the project you are in —
the same shape as everywhere else here. The shell expands the glob, so a
twelve-way fan-out is still one word. `merge` is the one subcommand that will
write a memory into existence: a target that is not there yet is created.

It is offline and contacts no model, which is why every side has to have been
embedded with the same model already. Node ids are kept, so the interesting
case is the same id on both sides:

- **Same revision, same content** — a shared ancestor, because the runs started
  from a copy of the same memory. Use counts and timestamps reconcile to the
  larger of the two, never the sum, so merging a source twice changes nothing.
- **Anything else** — a divergence. The whole merge is refused, nothing is
  written, and every conflicting id is listed with both revisions. `--force`
  takes the highest revision instead.

Memories that are not the same node but say the same thing fold together on the
same rule a commit uses for duplicates — near-identical by cosine, same kind,
same audience, never one that remembers a file. `--no-dedupe` turns that off.
Edges follow whatever their ends folded onto, and an edge whose ends both
landed on the same memory is dropped.

`--dry-run` reports all of it and writes nothing.

## Forgetting

```sh
zen memory forget 01M1YPN0C8QRQS5BCZ03ABQ1G0
```

Asks first, unless `--yes`, and refuses outright when there is no terminal to
ask at. A node, its vector row and its remembered file bytes go together -
there is one implementation of that, shared with the agent-facing tool, so the
three cannot drift apart.

**Forgetting is rarely the right correction.** The agents' own way to fix a
wrong memory is to commit the corrected node and supersede the old one, which
keeps the record of having been wrong. `zen memory ls --stale` lists what has
been superseded that way. Use `forget` for what should never have been stored -
a secret, a mistake, a pile of noise - not for what merely became untrue.

## Reading `stats`

```
nodes       7
edges       6
superseded  1
files       1 · 640 B
embedding   none - recall falls back to term overlap
vectors     -
```

`embedding none` is worth noticing: without an embedder, recall matches on
shared terms rather than on meaning, which works but is much blunter. Set
`memory.embedding` in `agents.yaml` to change it.

A vector count lower than the node count means some nodes were committed while
no embedder was configured, and they will only ever be found by term overlap
until they are re-embedded.
