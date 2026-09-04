# API search — `zen rag`

```
zen rag schema <index|search|list|grep|show|stats> [spec...]
```

Provided by `@zenera/rag` — `npm i -g @zenera/rag` if `zen rag` says it is not
installed.

Reads an OpenAPI/Swagger document as a **graph** — operations, schemas and the
fields inside them, joined by the `$ref`s between them — and makes it
searchable. The answer to a search is not a list of matches but the connected
piece of the API that matched: the operations, the schemas they carry and the
fields inside them, printed as text, a diagram, or TypeScript that compiles.

It exists because a large specification does not fit in a context window and
grepping it returns fragments that name types nobody printed.

## `index`

```
zen rag schema index <spec...> [--embedding <ref>] [-o <dir>] [--batch <n>]
```

| Flag                | Default       | Meaning                                                      |
| ------------------- | ------------- | ------------------------------------------------------------ |
| `--embedding <ref>` | —             | Which embedder makes the vectors. Omit it to see the choices |
| `-o`, `--out <dir>` | `./schema-db` | Where the index goes; `$ZEN_SCHEMA_DB` if set                |
| `--batch <n>`       | `96`          | Texts per embedding request, and how often progress prints   |
| `--no-sources`      | —             | Keep no copy of the documents in the index                   |
| `--quiet`           | —             | No narration                                                 |

```
zen rag schema index openapi.yaml --embedding openai:text-embedding-3-small
```

Unlike the faker, `$ref`s are **bundled, not dereferenced**: component names are
the node ids and the cycles between them are the edges. `discriminator` is kept —
it is what turns a `oneOf` into a tagged union a compiler can narrow.

What lands in `<out>`:

```
manifest.json     written last; its presence means the index is complete
graph.json        the nodes and edges
schemas.json      the schemas, read lazily
operations.json   the operations, read lazily
lance/            the vector and full-text indexes
```

The manifest records the embedding ref **and** the embedder's own id, so a
search with a different model is refused rather than quietly returning nonsense.

## Which index gets read

Every reading command takes `-d`, `--dir`. Without one:

1. `$ZEN_SCHEMA_DB`, if it is set.
2. Otherwise the **nearest index** to the working directory — here, then a
   short way down, then up a level and again, stopping at your home directory.
   The one used is named on stderr.
3. Otherwise `./schema-db`, so the error names the directory you expected.

What is looked for is a `manifest.json`, not a directory called `schema-db`, so
an index called anything else is found the same way. Two the same distance away
is refused rather than guessed at — name one with `-d`, or set `ZEN_SCHEMA_DB`
once and stop typing it.

## `search`

```
zen rag schema search [terms…] [filters…]
```

Every argument is validated before an embedder is constructed, so a typo is a
usage error rather than a credential error.

**Bare words are the query, not a subcommand.** `zen rag schema search list
methods` searches for the phrase _"list methods"_ and returns ranked guesses;
`zen rag schema list methods` is the listing. `search` is also the only read
command that embeds, so it is the only slow one.

### Terms — repeatable, and the field is the point

| Term                    | Searches                                 |
| ----------------------- | ---------------------------------------- |
| `<text>`                | Everything, the same as `--all`          |
| `--all <q>`             | Everything, unfiltered                   |
| `--method <q>`          | Operations                               |
| `--type <q>`            | Schemas, on the side `--direction` names |
| `--input-type <q>`      | Schemas a call accepts                   |
| `--output-type <q>`     | Schemas a call returns                   |
| `--property <q>`        | Fields and parameters, per `--direction` |
| `--input-property <q>`  | Fields and parameters a call accepts     |
| `--output-property <q>` | Fields a call returns                    |
| `--query <json\|->`     | A whole query object; `-` reads stdin    |

Putting the intent in the field that matches what is wanted is what makes the
search good. A request field belongs in `--input-property`, a response field in
`--output-property`; `--all` cannot filter and is the weakest of them.

### Filters and shape

| Flag                        | Default     | Meaning                                                 |
| --------------------------- | ----------- | ------------------------------------------------------- |
| `-d`, `--dir <dir>`         | found       | Which index — see "Which index gets read"               |
| `--embedding <ref>`         | the index's | Must be the one the index was built with                |
| `--direction <d>`           | `any`       | `input`, `output` or `any`                              |
| `--method-type <t>`         | `any`       | `read_only`, `read_write` or `any`                      |
| `--exclude-id <id>`         | —           | Drop a node. Repeatable                                 |
| `--exclude-method <name>`   | —           | Drop an operation by name. Repeatable                   |
| `--exclude-type <name>`     | —           | Drop a schema by name. Repeatable                       |
| `--exclude-property <name>` | —           | Drop a field by name. Repeatable                        |
| `--limit <n>`               | `5`         | Seeds kept per term                                     |
| `--max-hops <n>`            | `3`         | How far apart two hits may be                           |
| `--max-nodes <n>`           | `200`       | Nodes per result                                        |
| `--format <f>`              | `text`      | `text`, `mermaid`, `mermaid-flowchart`, `ts`, `openapi` |
| `--show-source`             | —           | Tag each operation and schema with its document         |
| `--no-docs`                 | —           | Leave the descriptions out                              |
| `--interactive`             | —           | Prompt, search, refine. Needs a terminal                |
| `--quiet`                   | —           | No narration                                            |

```
zen rag schema search --method "reset a user password" --format ts
zen rag schema search --output-property "invoice total" --direction output
echo '{"methods":["cancel a subscription"]}' | zen rag schema search --query -
```

The exclusions are what turn one search into a session: pass back the ids of
what you have already been shown to be shown something else instead of the same
thing again.

`--format ts` emits TypeScript closed over its own `$ref`s — everything named is
also declared, so the output compiles on its own.

### `--interactive`

A prompt that keeps the query between searches:

```
<text>                  search everything
all|method|type <text>  search one field
input-property <text>   also: output-property, property, input-type, output-type
direction <d>           input | output | any
method-type <t>         read_only | read_write | any
format <f>              text | mermaid | mermaid-flowchart | ts | openapi
show                    the query as it stands
reset                   forget it, exclusions included
quit
```

## `list` and `grep`

```
zen rag schema list <methods|types|properties> [-d <dir>] [--name <p>] [--path <p>]
zen rag schema grep <pattern> [-d <dir>] [--name <p>] [--path <p>] [--kind <k>]
```

Exact, and therefore complete. `search` ranks, so it can only hand back the top
of a list — it cannot tell you that something is _not_ there. These can: they
read `graph.json` directly, with no embedder, no credential and no network.

| Flag                | For    | Meaning                                      |
| ------------------- | ------ | -------------------------------------------- |
| `--name <p>`        | both   | Match the name. Repeatable                   |
| `--path <p>`        | both   | Match the route it sits on. Repeatable       |
| `--regex`           | both   | Read the patterns as regular expressions     |
| `--case-sensitive`  | both   | Stop ignoring case                           |
| `--source <name>`   | both   | Only nodes from one document                 |
| `--show-source`     | both   | Print which document each row came from      |
| `--method-type <t>` | `list` | `read_only`, `read_write` or `any`           |
| `--direction <d>`   | `list` | `input`, `output` or `any`                   |
| `--kind <k>`        | `grep` | `method`, `type` or `property`. Repeatable   |
| `--ids-only`        | `grep` | Just the ids, one per line, for piping       |
| `--limit <n>`       | both   | Rows to print. `found` still counts them all |
| `--quiet`           | both   | No narration                                 |

Under `--json`: `{found, truncated, rows}` from `list`, `{found, truncated,
matches}` from `grep`. `grep` takes **one** pattern — quote it if it has
spaces — and `list` **one** subject.

A pattern with `*` or `?` is a glob matched against the whole string; a plain
word is a substring. So `--name password` finds `ResetPasswordPayload`, and
`--name "Password*"` finds nothing, because nothing starts with it. `--regex`
makes it a regular expression instead — the only way to say "one of these". On
`list` it applies to every pattern; on `grep` it applies to the pattern, while
`--name` and `--path` stay globs-or-substrings:

```
zen rag schema list methods --regex --path "^/(users|teams)/"
```

`--path` selects on the route an operation sits on, and on the route a
parameter's operation sits on. A schema belongs to no one route, so `--path`
never selects one.

```
zen rag schema list methods --path "*/users*"
zen rag schema list types --name "*Password*"
zen rag schema grep password
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema grep status --path "/invoices/*" --kind property
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

No match exits 0 with nothing on stdout — that is the answer, and unlike an
empty search it is a reliable one. Under `--limit`, `found` is still the true
total, so a shortened answer never misreports how much there is.

## `show`

```
zen rag schema show [id...] [-d <dir>] [--format <f>] [--exact]
                    [--method <name>] [--type <name>] [--source <name>]
                    [--show-source] [--max-nodes <n>] [--no-docs] [--quiet]
```

Prints named nodes with no search in between. Needs no embedder and no
credential — it is a read of the graph.

Ids are one way in; `--method` and `--type` name things directly, which is
usually what you have. A bare name means exactly that name; add `*` to select
more than one. `--source <name>` takes a whole document, and `--show-source`
tags each node with the document it came from. `--exact` prints only what was
named instead of the neighbourhood around it — with `--format openapi` that is
a valid, self-contained slice of the specification. Without it the neighbours
are stitched in, up to `--max-nodes`.

`--source <name> --format openapi` with nothing else named prints the
**verbatim** document as it was indexed, unless the index was built
`--no-sources`, in which case it is rebuilt from the graph and says so.

A name that matches nothing is an **error**, not an empty answer: naming
something is a claim that it is there, and `list --name` is the command for
asking whether it is.

```
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
zen rag schema show --type "*Invoice*" --format ts
```

## `stats`

```
zen rag schema stats [-d <dir>]
```

What is in an index and what built it: counts by kind, the embedding model, the
documents it came from. Also needs no embedder.

## Giving it to an agent

`@zenera/rag/tools` exports the same search as tools an agent can call:

| Tool                       | For                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `search_api`               | The search above, with the same fields                              |
| `describe_types`           | Named schemas as TypeScript, closed over what they refer to         |
| `find_types_with_property` | Every schema with a field of this name — exact lookup, no searching |
| `list_api`                 | Methods, types or fields by name — complete, and counted in full    |
| `grep_api`                 | Every literal occurrence of a string — the way to prove absence     |

Only `search_api` ranks. Reach for the others whenever the question is whether
something exists, because a search that returns nothing and a thing that is not
there look exactly the same.

They share the group `schema`, so an agent takes them with `schema:*` in its
`tools:`.
