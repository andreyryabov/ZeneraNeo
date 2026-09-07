# Memory — `zen memory`

```
zen memory [stats|ls|show|export|forget] [args] [options]
```

Alias: `mem`.

The memory graph from outside the agents. It exists to answer the question
memory always eventually raises: **why did it recall that?**

Only projects that enable memory have one, and the commands say so rather than
inventing an empty graph. Turning it on is the `memory:` block in `agents.yaml`.

## Subcommands

| Command                   | What it does                                |
| ------------------------- | ------------------------------------------- |
| `zen memory stats`        | Size, vocabulary, whether it is embedded    |
| `zen memory ls`           | Nodes, newest first. Changes nothing        |
| `zen memory show <id>`    | One node in full, with what it links to     |
| `zen memory export [f]`   | The whole graph as one HTML page            |
| `zen memory forget <id…>` | Remove nodes, their vectors and their files |

| Flag                    | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `--project <name\|dir>` | Which project. Inferred from the directory   |
| `--kind <name>`         | Only this kind of node                       |
| `--audience <name>`     | Only nodes committed under this label        |
| `--files`               | Only nodes that remember a file              |
| `--stale`               | Only nodes something has superseded          |
| `--limit <n>`           | Rows to list. Default 30                     |
| `--out <file>`          | Where `export` writes. Default `memory.html` |
| `--open`                | Open the exported page                       |
| `--yes`                 | Do not ask before removing                   |

## It reads unmasked, on purpose

Memory is masked per agent: a node's `audience` decides who can see it. Recall
is masked, ranked and truncated as well, so what an agent gets is never the
whole picture.

This command ignores all of that. When the mask is the thing that is wrong, the
part that was hidden is exactly the part you need — and this is a person at a
terminal in the project directory, not an agent inside a run.

It also contacts no model. The store is opened without an embedder, so
inspection is free and works offline; the price is that `ls` filters by text
rather than by meaning.

## `export` is the one to reach for

```sh
zen memory export --open
```

One self-contained HTML file, three panes:

- **left** — every node, with a search box and filters for kind, audience,
  files, superseded and unlinked
- **middle** — the graph as a Mermaid diagram, coloured by kind, with pan,
  zoom, and a hop-focus selector for following one node's neighbourhood
- **right** — whatever you clicked, in full: the text, the metadata, the links,
  and **the remembered file's actual content** — rendered as an image when it is
  one, and as text otherwise

Clicking a node in either the list or the diagram selects it in both. Above 300
drawn nodes the diagram asks you to narrow it with the filters, because a
Mermaid graph that large is not a picture of anything.

It is a single file with no server behind it, so it attaches to a bug report.
The only network it does is fetching Mermaid; without that it degrades to a
working list and detail view.

## Forgetting

```sh
zen memory forget 01M1YPN0C8QRQS5BCZ03ABQ1G0
```

Asks first, unless `--yes`, and refuses outright when there is no terminal to
ask at. A node, its vector row and its remembered file bytes go together —
there is one implementation of that, shared with the agent-facing tool, so the
three cannot drift apart.

**Forgetting is rarely the right correction.** The agents' own way to fix a
wrong memory is to commit the corrected node and supersede the old one, which
keeps the record of having been wrong. `zen memory ls --stale` lists what has
been superseded that way. Use `forget` for what should never have been stored —
a secret, a mistake, a pile of noise — not for what merely became untrue.

## Reading `stats`

```
nodes       7
edges       6
superseded  1
files       1 · 640 B
embedding   none — recall falls back to term overlap
vectors     —
```

`embedding none` is worth noticing: without an embedder, recall matches on
shared terms rather than on meaning, which works but is much blunter. Set
`memory.embedding` in `agents.yaml` to change it.

A vector count lower than the node count means some nodes were committed while
no embedder was configured, and they will only ever be found by term overlap
until they are re-embedded.
