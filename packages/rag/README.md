# @zenera/rag

**A corpus, indexed and searched by meaning — an OpenAPI description as a
graph, a pile of markdown as quotable passages — for agents that have to work
with something they have not read.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). It ships no
> binary of its own: installing it adds a `rag` **subcommand** to
> [`zen`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## Two subjects

A subject is a kind of corpus with its own index format, its own verbs and its
own flags — not a variation on one command, because what `list` means to an API
description is not what it means to a folder of notes.

| Subject          | The corpus                | The answer                                     |
| ---------------- | ------------------------- | ---------------------------------------------- |
| `zen rag schema` | openapi/swagger documents | the connected piece of the API that matched    |
| `zen rag docs`   | markdown and plain text   | the passages that matched, quoted with numbers |

Both are built the same way — [LanceDB](https://lancedb.com) for hybrid vector

- full-text retrieval, a manifest that records which embedder made the vectors,
  and exact commands beside the ranking ones that need no credential at all.

## Schema — an API description as a graph

A large specification does not fit in a prompt, and the parts of it that answer
a question are scattered: the field is on a schema, the schema is on a request
body, the request body belongs to one operation out of three hundred. Vector
search finds the field. Only a graph gets from there to the call.

So this keeps both — a [graphology](https://graphology.github.io) graph for
structure and a [LanceDB](https://lancedb.com) table for hybrid vector +
full-text retrieval — and answers with the connected piece of the API that
matched, rendered as a tree, a Mermaid diagram, TypeScript declarations or a
standalone OpenAPI document.

## Install

Node.js 24+. Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/rag
zen key add openai          # the keyring `zen` already uses
```

## Use

Index once, then ask:

```sh
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history"
zen rag schema search --input-property "password reset token" --format ts
zen rag schema search --interactive
zen rag schema stats                  # what is in the index, and what built it
zen rag schema show Type:Invoice      # a named node, with no search in between
```

Search ranks, which means it returns the top of a list — useful when the
question is vague, and no use at all when the question is whether something
exists. For that there is exact matching, which needs no embedder, no
credential and no network:

```sh
zen rag schema list methods --path "*/users*"   # every route under /users
zen rag schema list types --name "*Password*"   # every schema so named
zen rag schema grep password                    # every literal occurrence
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema trace city                       # which calls can reach the field
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
```

Patterns are globs by default and regular expressions under `--regex`, on
`list` as well as `grep`, which is the only way to say "one of these prefixes":

```sh
zen rag schema list methods --regex --path "^/(users|teams)/"
zen rag schema grep status --path "/invoices/*" --kind property
```

`grep` takes the same `--name` and `--path` constraints `list` takes, so a
common word can be narrowed to one corner of the API instead of being read out
of every document at once.

When an index holds more than one document, `--show-source` names the one each
row came from — `[source: billing_api_v2]` — on `list`, `grep`, `search` and
`show` alike, so the document does not have to be recovered from `--json`.

`list` and `grep` report `found` as the true total even when `--limit` cuts the
printed rows, so a shortened answer still tells you how much there is. Nothing
matching exits 0 — an empty answer is an answer, and here it is a trustworthy
one: if `grep` finds nothing, the word is not in the description.

Finding a field is half the job; the other half is which call can reach it, and
that is a walk up the `$ref`s rather than a match on anything. `trace` does it:

```sh
zen rag schema trace city
```

```
Property:Address.city
    GET /users/{userId}  getUser  output  PublicUserProfile.address → Address.city
```

No search can be relied on for that — `search` stitches its seeds into one
connected piece, but only between the nodes that ranked and only within
`--max-hops`, and `getUser` and `city` share no word for either of them to rank
on. `--direction` keeps just the calls that accept it or return it,
`--kind` narrows what a bare pattern may start from, `--routes` and `--limit`
cut the printed rows without lying about `found`, and `--ids-only` pipes the
operations onward. A node nothing carries says so, which is worth knowing: it
means no request in this document will ever carry it.

Non-interactive search is a machine interface: every field is a flag, the whole
query can arrive as one JSON object, the `--json` output keeps the same
structure from run to run, no terminal is required, and an empty result exits 0.

```sh
zen rag schema search --query - --format ts <<'JSON'
{
  "input_properties": ["password reset token"],
  "method_type": "read_write",
  "exclude_ids": ["Type:PublicUserProfile"],
  "limit": 3
}
JSON
```

## Docs — markdown as quotable passages

The other subject. Point it at files, directories or globs; `.md`, `.markdown`,
`.txt` and `.text` are read, hidden directories and `node_modules` are not.

```sh
zen rag docs index --embedding openai:text-embedding-3-small ./docs
zen rag docs search "how are rate limits counted"
```

The answer is the documents themselves — the passages that matched, quoted
verbatim with their line numbers, and a marker wherever something between two
of them was left out:

```
## nsx_4.2.0/api/routing.md — 9 of 148 lines

  5 | ## Rate limits
  7 | Requests are counted per tenant and rejected past the limit.
... 12 lines omitted (Retries, Backoff) ...
 24 | | route | limit | window |
 25 | | --- | --- | --- |
 27 | | /api/users | 250 | 1m |
```

Nobody finds the paragraph they want on the first ask, so **narrowing is the
interface**, not an afterthought. The second call is the same question inside
one part of the tree:

```sh
zen rag docs search --file "nsx_4.2.*/api/**" "rate limit for the users route"
zen rag docs search --section "Rate limits" --kind table "requests per minute"
zen rag docs search --mode text "X-RateLimit-Remaining"   # exact wording only
zen rag docs search --interactive                          # narrow by typing
```

`--file` is a glob when it has `*` or `?` and a substring otherwise, matched
against the document's **name**, which is its path relative to the common root
of everything indexed. That is what keeps
two releases of the same file apart. `--section` takes a heading title, and
covers whatever nests inside it. `--kind` takes `paragraph`, `list`, `table`,
`table_row`, `code`, `frontmatter` or `html`, for when the answer is a table
and not the prose around it. `-B/-A` widen each passage, `--max-lines` caps the
whole answer, `--exclude-id` moves on from what was already seen.

Tables are indexed twice over: once as a descriptor carrying the caption and
the column names, and once per row, with the header row travelling alongside so
the columns are still named wherever a row lands. A row too wide to be one
chunk is cut into column groups, with the key column repeated in each.

And beside all that, the exact half — no embedder, no credential, no network:

```sh
zen rag docs list files                      # every document, and what it holds
zen rag docs list sections --file "api/**"   # every heading, with its line span
zen rag docs list tables                     # every table, with its columns
zen rag docs grep "Retry-After"              # every matching line, and its section
zen rag docs show api/routing.md --section "Rate limits"
zen rag docs show api/routing.md --lines 40-80
```

`grep` reports `found` as the true total even when `--limit` cuts the rows, so
unlike a search it can answer whether a string appears at all.

## Which index

Every reading command takes `-d, --dir`. Without one, `$ZEN_SCHEMA_DB` or
`$ZEN_DOCS_DB` is used if it is set; without that, the nearest index to the
working directory is found and named on stderr as it is used.

Nearest means what it says: this directory, then a short way down into it, then
up a level and again, stopping at your home directory. What is looked for is a
`manifest.json` — an index is self-describing, so nothing here searches for a
directory called `schema-db`, and an index called anything else is found just
the same. `schema-db` is only the name a new one is given.

Two indexes the same distance away is a question, not a tie to break, and it is
refused: the wrong index does not fail, it answers confidently about a
different API. Name one with `--dir`, or set the environment variable.

The search is scoped by kind, so a `docs` index and a `schema` index can sit in
the same tree without either shadowing the other.

## Commands

```
zen rag schema index <spec...>   Read the documents and write a searchable index.
zen rag schema search            Ask it something. --interactive for a prompt.
zen rag schema list <what>       Every method, type or property. No ranking.
zen rag schema grep <pattern>    Every literal match across the whole index.
zen rag schema trace <what>      Up from a field to the calls that carry it.
zen rag schema show [id...]      Print named nodes, with no search in between.
zen rag schema stats             What is in an index, and what built it.
```

Search terms are one flag each — `--all`, `--method`, `--type`, `--input-type`,
`--output-type`, `--property`, `--input-property`, `--output-property` — shaped
by `--direction`, `--method-type`, `--limit`, `--max-hops`, `--max-nodes`,
`--source` and the four `--exclude-*` filters, and rendered by `--format text | mermaid |
mermaid-flowchart | ts | openapi`. `zen help rag` prints the full table.

`list` and `grep` share `--name`, `--path`, `--regex`, `--case-sensitive`,
`--source`, `--show-source` and `--limit`; `grep` adds `--kind` and
`--ids-only`. A pattern with `*` or `?` in it is a glob matched against the
whole name; a plain word is a substring, so `--name password` finds
`ResetPasswordPayload` rather than nothing; under `--regex` it is a regular
expression either way. `--path` selects on the route an operation sits on, and
on the route a parameter's operation sits on — a schema belongs to no one
route, so `--path` never selects one. `show` takes ids, or `--method` and
`--type` by name, or `--source` for a whole document, and `--exact` to print
only what was named instead of its neighbourhood.

```sh
# Everything that mentions a token, rendered as TypeScript.
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

And for documents:

```
zen rag docs index <path...>     Read the documents and write a searchable index.
zen rag docs search [text]       Ask it something. --interactive for a prompt.
zen rag docs list <what>         Every document, section or table. No ranking.
zen rag docs grep <pattern>      Every matching line, with the section it sits in.
zen rag docs show <file>         A document, a section of one, or a line range.
zen rag docs stats               What is in an index, and what built it.
```

Search takes the question as a bare phrase, narrowed by `--file`,
`--exclude-file`, `--section`, `--kind` and `--mode`, shaped by `--limit`,
`-B/--before`, `-A/--after` and `--max-lines`, and moved along by
`--exclude-id`. `list` and `grep` share `--file`, `--section`, `--regex`,
`--case-sensitive` and `--limit`.

## From an agent

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { SchemaIndex, schemaTools } from '@zenera/rag';

const index = await SchemaIndex.open(
    './schema-db',
    createEmbedder('openai:text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: schemaTools(index) });
```

Six tools in the group `schema`, selectable as `schema:*`:

| Tool                       | For                                                     |
| -------------------------- | ------------------------------------------------------- |
| `search_api`               | the connected piece of the API that matches an intent   |
| `describe_types`           | named schemas as declarations that compile on their own |
| `find_types_with_property` | which types have a field of this name — no search       |
| `list_api`                 | the shape of the API: methods, types or fields          |
| `grep_api`                 | every literal occurrence of a string — no search        |
| `trace_api`                | the operations that carry a given field or schema       |

Only the first of those ranks anything. The rest are exact, because a model
told "no results" by a vector search has learned nothing: a ranking returns the
top of a list, so an empty answer and an absent thing look identical.
`find_types_with_property` is the one for the repair loop — when `tsc` says
`'password' does not exist in type 'PublicUserProfile'`, the model does not
need the word explained again, it needs the list of types that have one.
`grep_api` is the same instinct widened to the whole description, and
`trace_api` is the step after both: a field is of no use until the call that
carries it is known.

Documents come with four, in the group `docs`, selectable as `docs:*`:

```ts
import { docs } from '@zenera/rag';

const index = await docs.DocsIndex.open('./docs-db', embedder);
const project = await loadProject('./my-project', { tools: docs.docsTools(index) });
```

| Tool          | For                                                          |
| ------------- | ------------------------------------------------------------ |
| `search_docs` | the passages that match, quoted with their line numbers      |
| `list_docs`   | the documents, their headings, or their tables — no search   |
| `grep_docs`   | every matching line, counted in full — no search             |
| `read_docs`   | a section or a line range, verbatim and with nothing omitted |

Same division, same reason. `search_docs` is the way in when the question is
vague; `grep_docs` is how "it is not in here" can actually be concluded. Every
answer carries line numbers and `read_docs` takes them, which is the loop the
subject exists for: find the passage, read around it, then edit the file the
passage came from.

## What an index is

```
schema-db/
├── README.md         what this index holds — a live progress report while it builds
├── manifest.json     written last — its absence means "not indexed"
├── graph.json        topology and light attributes, read whole
├── schemas.json      the raw schemas, read the first time one is needed in full
├── operations.json   likewise, for the OpenAPI subset
├── sources/          the documents themselves, bundled, exactly as indexed
└── lance/            one table: a row per node, one text column, one vector
```

The manifest records which embedder made the vectors, and a search with a
different one is refused rather than answered with noise.

A document index is the same idea with a different middle:

```
docs-db/
├── README.md         what this index holds — a live progress report while it builds
├── manifest.json     written last — its absence means "not indexed"
├── outline.json      every heading and table, with the lines they cover
├── sources/          the documents themselves, verbatim — where the quotes come from
└── lance/            one table: a row per chunk, two texts, one vector
```

There the copies are not a record but the answer: a search returns line ranges
and the lines are read back out of `sources/`, so what is quoted is the document
rather than a reconstruction of it.

Indexing a large document is minutes of silence, so the directory says what is
happening to it. `README.md` appears first as a progress report — the documents,
the embedder, the step, how many entities have been embedded of how many, and
how long it has been going — rewritten at most every five seconds, and replaced
on completion by a description of what the index turned out to hold. A build
that dies leaves it saying so. While one runs, `.lock` names the process; a
second build of the same directory is refused, unless the lock is stale.

**An index is one portable thing.** Nothing in it names a path outside itself:
a document is known by a short name taken from its filename, and the document
itself is copied into `sources/` as it was indexed — bundled, so every external
`$ref` is already resolved and the copy stands alone. The directory can be moved,
committed or shipped whole and still says what it is made of. This matters
because a project's `assets/` is mounted at `/assets` inside an agent's sandbox,
so an index built here is read under a name this machine never sees. `--no-sources`
leaves the copies out, for an index that will never travel.

The copies are a record, not an input: rebuilding reads the files you name, not
the ones in `sources/`. A **document** index has no `--no-sources`, because
there the copies are what every quoted line is read from.

## Notes

- Documents are **bundled, not dereferenced**: `#/components/schemas/User` is
  an edge and `User` is a node id. Swagger 2.0, OpenAPI 3.0 and 3.1 are
  converted to 2020-12 on the way in, `discriminator` included — it is what
  turns a `oneOf` into a TypeScript tagged union the compiler can narrow.
- A **query parameter is a property**, like any field in a body. Nobody should
  have to know in advance which one `page_size` is.
- Every type carries a **direction** — `input`, `output` or `both` — worked out
  by propagating from the operations through composition, so a type used on both
  sides is honestly both rather than whichever side was read last.
- Filters reaching the store are **closed enums only**. Exclusion lists are
  applied in JavaScript afterwards, so nothing a model wrote ever reaches a SQL
  predicate.
- A document chunk knows **exactly which lines** of the original it stands for,
  headings and table headers included. That is what makes an answer quotable,
  and what lets the next question be phrased in line numbers.
- Plain text is read as paragraphs and given **no invented headings**: a `.txt`
  file has one section, which is the document.

## The rest of the family

| Package                                                                                         | What it is                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md)     | `zen` — agent projects on the command line              |
| [`@zenera/neo`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md)     | the runtime — agents, models, tools, skills, memory     |
| [`@zenera/faker`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/faker/README.md) | `zen faker` — a mock API from the same kind of document |

## License

[MIT](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE).
