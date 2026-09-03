# @zenera/rag

**An OpenAPI description, indexed as a graph and searched by meaning — for
agents that have to call an API they have not read.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). It ships no
> binary of its own: installing it adds a `rag` **subcommand** to
> [`zen`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## Why

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

## Commands

```
zen rag schema index <spec...>   Read the documents and write a searchable index.
zen rag schema search            Ask it something. --interactive for a prompt.
zen rag schema show <id...>      Print named nodes, with no search in between.
zen rag schema stats             What is in an index, and what built it.
```

Search terms are one flag each — `--all`, `--method`, `--type`, `--input-type`,
`--output-type`, `--property`, `--input-property`, `--output-property` — shaped
by `--direction`, `--method-type`, `--limit`, `--max-hops`, `--max-nodes` and
the four `--exclude-*` filters, and rendered by `--format text | mermaid |
mermaid-flowchart | ts | openapi`. `zen help rag` prints the full table.

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

Four tools in the group `schema`, selectable as `schema:*`:

| Tool                       | For                                                     |
| -------------------------- | ------------------------------------------------------- |
| `search_api`               | the connected piece of the API that matches an intent   |
| `describe_types`           | named schemas as declarations that compile on their own |
| `find_types_with_property` | which types have a field of this name — no search       |
| `list_methods`             | the shape of the API, by path                           |

`find_types_with_property` is the one for the repair loop: when `tsc` says
`'password' does not exist in type 'PublicUserProfile'`, the model does not
need the word explained again, it needs the list of types that have one.

## What an index is

```
schema-db/
├── manifest.json     written last — its absence means "not indexed"
├── graph.json        topology and light attributes, read whole
├── schemas.json      the raw schemas, read the first time one is needed in full
├── operations.json   likewise, for the OpenAPI subset
└── lance/            one table: a row per node, one text column, one vector
```

The manifest records which embedder made the vectors, and a search with a
different one is refused rather than answered with noise.

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

## The rest of the family

| Package                                                                                         | What it is                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md)     | `zen` — agent projects on the command line              |
| [`@zenera/neo`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md)     | the runtime — agents, models, tools, skills, memory     |
| [`@zenera/faker`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/faker/README.md) | `zen faker` — a mock API from the same kind of document |

## License

[MIT](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE).
