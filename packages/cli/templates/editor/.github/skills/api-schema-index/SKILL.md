---
name: api-schema-index
description: What a schema index is, how it finds the right call inside a large OpenAPI/Swagger document, and how to build and query one with `zen rag schema` (or `npx @zenera/cli`) — searching it by meaning, listing and grepping it exactly, and giving it to an agent as tools.
---

# The schema index

A schema index is an OpenAPI/Swagger description turned into something that can
be **asked a question**. It is built once, on disk, and answered from without a
model: `zen rag schema index` writes it, and five commands read it.

It exists because a real specification does not fit in a context window, and
grepping it does not help. The parts that answer "how do I reset a password?"
are scattered on purpose: the field is on a schema, the schema is a request
body, the request body belongs to one operation out of three hundred, and the
word "password" appears in forty places that are not the one you want.

## The commands

```
zen rag schema <index|search|list|grep|show|stats> [spec...]
```

| Command  | Answers                                | Embedder? | Typical |
| -------- | -------------------------------------- | --------- | ------- |
| `index`  | builds the thing                       | yes       | minutes |
| `search` | _what is this API's way to do X?_      | **yes**   | seconds |
| `list`   | _what methods/types/fields are there?_ | no        | instant |
| `grep`   | _does the string X appear anywhere?_   | no        | instant |
| `show`   | _print exactly these things_           | no        | instant |
| `stats`  | _what is in this index?_               | no        | instant |

Only `search` ranks, and only `search` costs a network round trip — it embeds
the query before it can compare anything. The other four read `graph.json` off
the disk and answer in milliseconds, so reach for `search` when the question is
vague and for `list`/`grep` when it is precise. If a search feels slow, it is
that one embedding call, not the index: near-zero CPU for several seconds is
the tell.

> **`search` takes bare words as the query, not as a subcommand.**
> `zen rag schema search list methods` does not list anything — it runs a
> semantic search for the phrase _"list methods"_ and returns ten ranked
> guesses. The listing command is `zen rag schema list methods`.

## Why it is a graph and not a search box

Two structures, kept together, because neither answers alone:

| Structure                            | Answers                            |
| ------------------------------------ | ---------------------------------- |
| A vector + full-text index (LanceDB) | _where is `password` in this API?_ |
| A graph (graphology)                 | _what is `password` connected to?_ |

Finding the field is retrieval. Getting from the field to `POST
/auth/reset-password` and the exact shape of its body is traversal. So a search
does both: it seeds on the vector hits, walks the graph outward from them, and
answers with **the connected piece of the API that matched** — the operations,
the schemas they carry and the fields inside them — rather than a ranked list of
fragments naming types nobody printed.

## What is in one

Three kinds of node, joined by the `$ref`s between them. Documents are
**bundled, not dereferenced**: `#/components/schemas/User` stays an edge and
`User` is a node id.

| Kind       | Id                           | Is                                |
| ---------- | ---------------------------- | --------------------------------- |
| `method`   | `Method:resetUserPassword`   | an operation                      |
| `type`     | `Type:ResetPasswordPayload`  | a schema                          |
| `property` | `Type:User.email` (a field)  | a field on a schema               |
| `property` | `Method:listUsers#page_size` | a query/path/header **parameter** |

A parameter is a property like any other, deliberately. Nobody should have to
know in advance whether `page_size` lives in a query string or a body — that is
the thing they came here to find out.

Every node carries a **direction** — `input`, `output` or `both` — propagated
from the operations down through composition, so a DTO used on both sides is
honestly both rather than whichever side was read last. That is what makes
"a field in a **response**" a filter and not a hope.

`discriminator` is kept: it is what turns a `oneOf` into a tagged union a
TypeScript compiler can narrow.

```
schema-db/
├── manifest.json     written LAST — its absence means "not indexed"
├── graph.json        topology, read whole
├── schemas.json      the raw schemas, read on first hydrate
├── operations.json   likewise
└── lance/            one row per node: one text column, one vector
```

`manifest.json` records **which embedder made the vectors**, so a search with a
different model is refused rather than answered with noise.

## Installing

`zen rag` ships in `@zenera/rag`, a sibling of the CLI. It has no binary of its
own — installing it adds the `rag` subcommand to `zen`, which is also where the
credentials already live.

```sh
npm i -g @zenera/cli @zenera/rag       # then: zen rag schema …
```

For a one-off, without installing anything, **both** packages must be in the
same temporary install or `zen` will report `rag` as not installed:

```sh
npx --package @zenera/cli --package @zenera/rag -- zen rag schema index openapi.yaml --embedding openai:text-embedding-3-small
```

Every example below is spelled `zen …`; prefix it with that `npx` form if you
have not installed globally.

## Building an index

```
zen rag schema index <spec...> [--embedding <ref>] [-o <dir>] [--batch <n>]
```

| Flag                | Default       | Meaning                                                      |
| ------------------- | ------------- | ------------------------------------------------------------ |
| `--embedding <ref>` | —             | Which embedder makes the vectors. Omit it to see the choices |
| `-o`, `--out <dir>` | `./schema-db` | Where the index goes                                         |
| `--batch <n>`       | `96`          | Texts per embedding request, and how often progress prints   |
| `--quiet`           | —             | No narration                                                 |

```sh
zen rag schema index openapi.yaml --embedding openai:text-embedding-3-small
zen rag schema index specs/*.yaml --embedding google:gemini-embedding-001 -o .index/api
```

Several documents can go into one index; they share a graph, which is usually
what you want when an API is split across files. Swagger 2.0 and OpenAPI
3.0/3.1, JSON or YAML, are all converted to JSON Schema 2020-12 on the way in.

This is the one command here that spends money and time: it embeds every
operation, schema and field. It prints a per-document table (paths, operations,
schemas, fields) and a progress line per batch, and **stdout is the output
directory and nothing else** — so `DIR=$(zen rag schema index …)` works.

The embedding reference names a provider first: `openai:text-embedding-3-small`,
not a bare model id. Credentials come from the `zen` keyring (`zen key ls`), and
a real environment variable always wins.

Rebuild the index when the specification changes. Nothing watches it, and a
stale index is a confident wrong answer.

## Searching it

```
zen rag schema search [terms…] [filters…]
```

### The field is the point

A query is not one string. It is a handful of **fields**, and the field a phrase
arrives in decides the filter it runs under — `--output-property "invoice total"`
means _kind=property, on the response side_, and none of that has to be said
twice.

| Term                    | Searches                                          |
| ----------------------- | ------------------------------------------------- |
| `<text>`                | Everything — the same as `--all`                  |
| `--all <q>`             | Everything, unfiltered                            |
| `--method <q>`          | Operations                                        |
| `--type <q>`            | Schemas, on the side `--direction` names          |
| `--input-type <q>`      | Schemas a call accepts                            |
| `--output-type <q>`     | Schemas a call returns                            |
| `--property <q>`        | Fields and parameters, per `--direction`          |
| `--input-property <q>`  | Fields, parameters and body fields a call accepts |
| `--output-property <q>` | Fields a call returns                             |
| `--query <json\|->`     | A whole query object; `-` reads stdin             |

Every term is repeatable. **`--all` is the weakest of them** — it cannot filter,
so put the intent where it belongs: a request field in `--input-property`, a
response field in `--output-property`, an action in `--method`.

### Shaping the answer

| Flag                        | Default       | Meaning                                                 |
| --------------------------- | ------------- | ------------------------------------------------------- |
| `-d`, `--dir <dir>`         | `./schema-db` | Which index                                             |
| `--embedding <ref>`         | the index's   | Must be the one the index was built with                |
| `--direction <d>`           | `any`         | `input`, `output` or `any`                              |
| `--method-type <t>`         | `any`         | `read_only` (GET/HEAD/OPTIONS) or `read_write`          |
| `--exclude-id <id>`         | —             | Drop a node. Repeatable                                 |
| `--exclude-method <name>`   | —             | Drop an operation by name. Repeatable                   |
| `--exclude-type <name>`     | —             | Drop a schema by name. Repeatable                       |
| `--exclude-property <name>` | —             | Drop a field by name. Repeatable                        |
| `--limit <n>`               | `5`           | Seeds kept per term                                     |
| `--max-hops <n>`            | `3`           | How far apart two hits may be and still join            |
| `--max-nodes <n>`           | `200`         | Nodes per result                                        |
| `--format <f>`              | `text`        | `text`, `mermaid`, `mermaid-flowchart`, `ts`, `openapi` |
| `--no-docs`                 | —             | Leave the descriptions out                              |
| `--interactive`             | —             | Prompt, search, refine. Needs a terminal                |
| `--quiet`                   | —             | No narration                                            |

```sh
zen rag schema search --method "reset a user password" --format ts
zen rag schema search --output-property "invoice total" --direction output
zen rag schema search --input-property "page size" --method-type read_only
```

`--format ts` emits TypeScript closed over its own `$ref`s: everything named is
also declared, so the output compiles on its own. `--format openapi` emits a
standalone document holding just the matched slice — the one to hand to a code
generator or a mock server. The Mermaid formats are for looking at.

### Turning one search into a session

The exclusions are the mechanism: pass back the ids you have already been shown
and you are shown something else instead of the same thing again.

```sh
zen rag schema search --all "subscription" --exclude-type Subscription --exclude-id Method:listSubscriptions
```

### As a machine interface

Non-interactive search is a tool, not an afterthought. Every field is a flag,
the whole query can arrive as one JSON object, `--json` is a stable shape, no
terminal is needed, and **an empty result exits 0** — a caller must never have
to tell "nothing matched" from "the index is missing" by parsing stderr.

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

The JSON field names are the flag names with underscores and plurals:
`all`, `methods`, `types`, `input_types`, `output_types`, `properties`,
`input_properties`, `output_properties`, `direction`, `method_type`,
`exclude_ids`, `exclude_methods`, `exclude_types`, `exclude_properties`,
`limit`, `max_hops`, `max_nodes`. An **unknown key is an error**, because a
silently ignored `output_propertys` looks exactly like a search that found
nothing. Flags win over `--query` when both name the same field.

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

## Reading it without searching

None of these need an embedder or a credential — they are plain reads of the
graph on disk.

```sh
zen rag schema show Type:Invoice Method:listInvoices --format ts
zen rag schema stats
```

`show` prints named nodes with no retrieval in between; `stats` says what is in
an index and what built it — counts by kind, the embedding model, the documents
it came from. `stats` is the fastest way to answer "is this index the one I
think it is?".

### Which one to reach for

| The question                                     | The command                              |
| ------------------------------------------------ | ---------------------------------------- |
| "how do I reset a password with this API?"       | `search --method "reset a password"`     |
| "what does the create-user request look like?"   | `search --input-type "create user"`      |
| "what operations exist under /users?"            | `list methods --path "*/users*"`         |
| "how many operations are there at all?"          | `list methods` (or `--json` for `found`) |
| "is there a field called `mfa_secret` anywhere?" | `grep mfa_secret`                        |
| "which schemas mention tenancy?"                 | `grep tenancy --kind type`               |
| "give me `GetUser` as OpenAPI"                   | `show --method GetUser --format openapi` |
| "is this index the right one?"                   | `stats`                                  |

The rule: **a question about meaning is a `search`; a question about presence,
count or spelling is a `list` or a `grep`.** Search cannot answer the second
kind, because a ranking always returns its best guesses whether or not any of
them are right.

### Exact matching, when the question is whether something exists

Search **ranks**. A ranking returns the top of a list, which means it can never
tell you that something is absent — "no results" and "not there" look the same.
When that is the actual question, do not search:

```
zen rag schema list <methods|types|properties> [-d <dir>] [filters…]
zen rag schema grep <pattern> [-d <dir>] [filters…]
```

| Flag                | For    | Meaning                                        |
| ------------------- | ------ | ---------------------------------------------- |
| `--name <p>`        | `list` | Match the name. Repeatable                     |
| `--path <p>`        | `list` | Match the route (methods). Repeatable          |
| `--method-type <t>` | `list` | `read_only`, `read_write` or `any`             |
| `--direction <d>`   | `list` | `input`, `output` or `any`                     |
| `--regex`           | `grep` | Read the pattern as a regular expression       |
| `--case-sensitive`  | `grep` | Stop ignoring case                             |
| `--kind <k>`        | `grep` | `method`, `type` or `property`. Repeatable     |
| `--ids-only`        | `grep` | Bare ids, one per line, for piping             |
| `--source <name>`   | both   | Only one document, as `stats` names it         |
| `--limit <n>`       | both   | Print at most n; `found` still counts them all |
| `--json`            | both   | `{found, truncated, rows}` / `…, matches}`     |
| `--quiet`           | both   | No narration                                   |

```sh
zen rag schema list methods                      # all of them, sorted by route
zen rag schema list methods --path "*/users*"    # every route under /users
zen rag schema list methods --method-type read_only
zen rag schema list types --name "*Password*"    # every schema so named
zen rag schema list types --direction output     # everything a call can return
zen rag schema list properties --name password   # every field so named
zen rag schema grep password                     # every literal occurrence
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema grep password --kind type --ids-only
```

`list` walks one kind of node and matches its structured fields; `grep` matches
the text of every node in the index — the same text the search was built from,
so the two agree on what the API says. A pattern with `*` or `?` is a glob
matched against the whole string; a plain word is a substring, so `--name
password` finds `ResetPasswordPayload` and `--name "Password*"` finds nothing.

Both report `found` as the true total even when `--limit` shortens what is
printed, so a cut answer never misreports how much there is. Nothing matching
exits 0 with empty stdout — and that emptiness is trustworthy, which is the
whole point of them.

`grep --ids-only` composes:

```sh
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

### Naming what you want in `show`

```sh
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
zen rag schema show --type "*Invoice*" --format ts
zen rag schema show --source billing-api --format openapi
```

Ids are one way in, but `--method` and `--type` take the names you already
have. A bare name means exactly that name; add `*` to take more than one.
`--exact` prints only what was named instead of the neighbourhood around it,
which with `--format openapi` gives a valid self-contained slice of the
specification — enough to generate a client or a mock payload from.

## Giving it to an agent

The same engine, as five tools in the group `schema`. An agent takes them all
with `schema:*` in its `tools:`.

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { SchemaIndex, schemaTools } from '@zenera/rag';

const index = await SchemaIndex.open(
    './schema-db',
    createEmbedder('openai:text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: schemaTools(index) });
```

| Tool                       | For                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `search_api`               | the search above, with the same fields                              |
| `describe_types`           | named schemas as TypeScript, closed over what they refer to         |
| `find_types_with_property` | every schema with a field of this name — exact lookup, no searching |
| `list_api`                 | methods, types or fields by name — complete, and counted in full    |
| `grep_api`                 | every literal occurrence of a string — the way to prove absence     |

Only `search_api` ranks; the other four are exact. `find_types_with_property`
is the one for the repair loop. When `tsc` says `'password' does not exist in
type 'PublicUserProfile'`, the model does not need the word explained again —
it needs the list of types that _do_ have one, and embedding the word will only
rank the guess it already made near the top. `grep_api` is the same instinct
widened: it is how a model checks that a search returning nothing really means
there is nothing.

Tell the agent in its prompt to search before it writes a call, and to put the
intent in the narrow field. A model left to itself puts everything in `all`.

## When it goes wrong

| Symptom                                          | Cause                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| "not installed"                                  | `@zenera/rag` is not resolvable — install it, or use the two-`--package` npx form   |
| Refused for a different embedding                | The index records the model that built it; re-index or pass the right `--embedding` |
| No manifest / not an index                       | A build that did not finish. `manifest.json` is written last on purpose             |
| `provider "openai": no api key`                  | `zen key ls` — the keyring, or a real environment variable                          |
| A usage error before any credential is asked for | Deliberate: everything about the invocation is checked first, so a typo is a typo   |
| Nothing matched                                  | Exit 0 with an empty answer. Try fewer words, or `--all` instead of a narrow field  |
| Answers about the wrong version of the API       | Nothing watches the document. Re-index after it changes                             |
| A search took ten seconds, using no CPU          | One embedding round trip, not the index. `list`/`grep` make none                    |
| `search <word> <word>` gave ranked nonsense      | Bare words after `search` are the QUERY, not a subcommand. You meant `list`/`grep`  |
