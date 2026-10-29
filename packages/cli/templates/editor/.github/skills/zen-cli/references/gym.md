# Agent API environments - `zen gym`

```
zen gym <serve|build|cache|world|model> [spec...]
```

Provided by `@zenera/gym` - `npm i -g @zenera/gym` if
`zen gym` says it is not installed.

Serves a mock API from OpenAPI/Swagger documents, backed by a **stateful
world**. For each operation an agent writes a **TypeScript handler** (the
mechanics: which type, which filter, what a write changes), judged before it is
cached. Content comes from a second agent that fills the world on first read,
following an optional **story** (`--story`) and drawing on **reference
documents** (`--docs`). Lists and gets agree, writes are seen by later reads,
and several `zen gym` processes given the same story share one world. No
container engine is needed.

## Inputs

Each is a file, a directory or a quoted pattern, and each is repeatable.

| Input               | What it is                                                            | How agents get it           |
| ------------------- | --------------------------------------------------------------------- | --------------------------- |
| `spec…`, `--schema` | API documents: `.yaml`/`.yml`/`.json` declaring `swagger:`/`openapi:` | API graph and types         |
| `--story`           | the state of the world: people, what is happening, what is not        | quoted whole in prompts     |
| `--docs`            | reference material: knowledge base, guides, runbooks                  | searched (indexed at start) |

A directory given as `--schema` is walked and only real API documents are kept,
so a folder of mixed JSON — or an API index somebody built — works. A Markdown
file given as a schema is refused with a hint; so is an API document given as
`--story` or `--docs`. Quote globs (`--docs 'kb/*.md'`) so the shell leaves them
to gym.

## Subcommands

| Command               | What it does                                                    |
| --------------------- | --------------------------------------------------------------- |
| `serve [spec...]`     | Index everything, then serve. Handlers are written on first use |
| `build [spec...]`     | Index everything and write every handler, then exit             |
| `cache ls\|clear`     | Handlers, bindings and indexes; `clear` keeps worlds            |
| `world ls\|rm <name>` | List worlds, or delete one                                      |
| `model [ref]`         | Show or set the chat model; `--embedding <ref\|none\|clear>`    |

```
zen gym serve openapi.yaml
zen gym serve --schema specs/ --story world.md --docs kb/
zen gym serve specs/mail.yaml     --story world.md --port 8787
zen gym serve specs/calendar.yaml --story world.md --port 8788   # same world as above
zen gym serve api.yaml --world demo --reset                      # a named world, emptied
zen gym build --schema 'api/*.yaml' --story world.md --docs kb/ --concurrency 8
zen gym world ls
```

`build` is the one to run in CI or before a demo: it pays for every handler up
front and exits non-zero, with a table, if any could not be written. Content is
still made lazily, on first read.

## Options

| Flag                    | Default             | Meaning                                                  |
| ----------------------- | ------------------- | -------------------------------------------------------- |
| `--schema <path>`       | -                   | API documents, in addition to bare arguments             |
| `--story <path>`        | -                   | The state of the world                                   |
| `--docs <path>`         | -                   | Reference material                                       |
| `--world <name\|file>`  | one per story       | Which world; a name is under `<cache>/worlds/`           |
| `--reset`               | -                   | Start from an empty world                                |
| `--model <ref>`         | recommended         | Which model writes handlers and content                  |
| `--embedding <on\|ref>` | off (wording)       | Also search `--docs` by meaning; `on` = configured model |
| `--port <n>`            | `8787`              | Port to listen on                                        |
| `--host <h>`            | `127.0.0.1`         | Anything else is reachable off-machine                   |
| `--cache <dir>`         | `~/.zenera/neo/gym` | Handlers, worlds, indexes, reports                       |
| `--seed <n>`            | -                   | Same request, same randomness                            |
| `--attempts <n>`        | `5`                 | Failed tests per handler before giving up                |
| `--concurrency <n>`     | `4`                 | Handlers written at once                                 |
| `--timeout <s>`         | `30`                | Seconds a handler may run, agent time aside              |
| `--max-body <n>`        | 1 MB                | Largest request body accepted, in bytes                  |
| `--rebuild`             | -                   | Ignore what is cached and write it again                 |
| `--no-cache`            | -                   | Do not record what is written                            |
| `--quiet`               | -                   | No narration                                             |

Credentials come from the `zen` keyring - see [keys.md](keys.md).
Chat model: `--model`, `ZENERA_GYM_MODEL`, `zen gym model <ref>`, then the best
model the available keys support. It must call tools; for OpenAI reasoning
models use the Responses API, `openai/responses:<id>`. Embedding model: off by
default, so `--docs` are searched by wording (full-text). `--embedding <ref>`
searches by meaning too with that model; `--embedding on` takes
`ZENERA_GYM_EMBEDDING`, then `zen gym model --embedding <ref>`, then the first
provider with a key that offers one. Without the flag those settings do nothing.

## Serving

Binds the loopback address by default. On start it prints a table per document,
then the model, story, docs (and how they are searched) and the world file.

| Endpoint        | Answers                                      |
| --------------- | -------------------------------------------- |
| `/`             | Contents page, with a Run form per operation |
| `/__gym/routes` | Every route it will serve                    |
| `/__gym/health` | Whether it is up                             |

Response headers:

| Header            | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `x-gym-operation` | The `operationId` that answered                       |
| `x-gym-cache`     | `hit`, `miss` or `regenerated` - the handler's origin |

Gym provides simulation, not task scoring, rewards, or a training loop.

Incoming headers are filtered: `authorization`, `cookie` and anything matching
`key|token|secret|password|credential` never reach a handler.

## What "correct" means here

A handler is judged by `test_handler` on synthetic probes, in a throwaway copy
of the world with schema-sampled content: the body validates against the
response schema, **and** it obeys the **echo rule** - a value given in the path
comes back in the answer (`GET /users/12324` must return `user_id: 12324`).
Paged operations are walked: the cursor must advance and end. And every record
type the handler touches must live where earlier handlers put it.

## Bindings: where each type lives

Handlers name records by schema type (`ctx.lookup('Message', id)`). The first
handler to use a type binds it to a collection and id field; later handlers are
told the binding and held to it, so every operation on a resource reads the same
records. Bindings are add-only and machine-wide, keyed by the documents' types;
`cache clear` forgets them.

## The cache, the world, the reports

Handlers live in the machine's shared cache, `~/.zenera/neo/cache/gym-handler/`,
keyed by the operation's shape (descriptions and examples excluded) - not by the
story, since a handler holds no content. A cached handler whose bindings no
longer hold is rebuilt. Two processes needing the same handler build it once.

Worlds live in `<cache>/worlds/`. With a story and no `--world`, the world is
named after the story's content, so editing the story starts a new world (gym
says so). `cache clear` never touches worlds; `world rm` and `serve --reset` do.

The docs index lives in `<cache>/indexes/`, keyed by the docs' content and the
embedding model; a restart reuses it.

Every agent run leaves an HTML report in `<cache>/reports/`; failed builds
leave a markdown report in `<cache>/builds/`.

## Documents it accepts

Swagger 2 and OpenAPI 3.0/3.1, JSON or YAML, `$ref`s resolved. Several documents
can be served at once, as long as no two define the same route (two versions of
one API: serve them from two processes with the same `--world`). OpenAPI 3.0
constructs are translated to JSON Schema 2020-12 on the way in (`nullable`,
boolean `exclusiveMinimum`, Draft-4 array `items`), and a `pattern` written as a
JavaScript regex literal (`/^[a-z]+$/`) is unwrapped.
