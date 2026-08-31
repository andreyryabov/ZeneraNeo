# zenera-rag

**An OpenAPI description, indexed as a graph and searched by meaning — for
agents that have to call an API they have not read.**

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). A `zen`
> subcommand rather than a binary of its own.

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

## Use

```sh
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history"
zen rag schema search --input-property "password reset token" --format ts
zen rag schema search --interactive
```

Non-interactive search is a machine interface: every field is a flag, the whole
query can arrive as one JSON object, `--json` is a stable shape, no terminal is
required, and an empty result exits 0.

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

## From an agent

```ts
import { SchemaIndex, schemaTools } from 'zenera-rag';

const index = await SchemaIndex.open('./schema-db', project.embedder());
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
├── schemas.json      the raw schemas, read on first hydrate
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
  by propagating from the operations through composition, so a shared DTO is
  honestly both rather than whichever side was read last.
- Filters reaching the store are **closed enums only**. Exclusion lists are
  applied in JavaScript afterwards, so nothing a model wrote ever reaches a SQL
  predicate.

## License

[MIT](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE).
