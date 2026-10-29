# Agent API environments - `zen gym`

```
zen gym <serve|build|cache|model> [spec...]
```

Provided by `@zenera/gym` - `npm i -g @zenera/gym` if
`zen gym` says it is not installed.

Serves a mock API from one or more OpenAPI/Swagger documents, backed by a
**stateful world**. For each operation an agent writes a **TypeScript handler**
(the mechanics: which collection, which filter, what a write changes), judged
before it is cached. Content comes from a second agent that fills the world on
first read, following an optional **story** (`--story world.md`). Lists and
gets agree, writes are seen by later reads, and several `zen gym` processes
given the same story share one world. No container engine is needed.

## Subcommands

| Command           | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `serve <spec...>` | Serve the documents. Handlers are written on demand        |
| `build <spec...>` | Write every handler now and exit                           |
| `cache ls\|clear` | What has been generated, or throw it away                  |
| `model [ref]`     | Show or set the model; `--clear` forgets the stored choice |

```
zen gym serve openapi.yaml
zen gym serve mail.yaml --story world.md --port 8787
zen gym serve calendar.yaml --story world.md --port 8788   # same world as above
zen gym serve api/*.yaml --port 9000 --seed 7
zen gym build openapi.yaml --concurrency 8
zen gym cache clear
```

`build` is the one to run in CI or before a demo: it pays for every handler up
front and exits non-zero, with a table, if any could not be written. Content is
still made lazily, on first read.

## Options

| Flag                | Default             | Meaning                                     |
| ------------------- | ------------------- | ------------------------------------------- |
| `--port <n>`        | `8787`              | Port to listen on                           |
| `--host <h>`        | `127.0.0.1`         | Anything else is reachable off-machine      |
| `--model <ref>`     | recommended         | Which model writes handlers and content     |
| `--story <path>`    | -                   | Story file, folder, or `zen rag docs` index |
| `--state <file>`    | one per story       | The world's SQLite file                     |
| `--reset`           | -                   | Start from an empty world                   |
| `--cache <dir>`     | `~/.zenera/neo/gym` | Handlers, worlds, reports                   |
| `--seed <n>`        | -                   | Same request, same randomness               |
| `--attempts <n>`    | `5`                 | Failed tests per handler before giving up   |
| `--concurrency <n>` | `4`                 | Handlers written at once                    |
| `--timeout <s>`     | `30`                | Seconds a handler may run, agent time aside |
| `--max-body <n>`    | 1 MB                | Largest request body accepted, in bytes     |
| `--rebuild`         | -                   | Ignore what is cached and write it again    |
| `--no-cache`        | -                   | Do not record what is written               |
| `--quiet`           | -                   | No narration                                |

Credentials come from the `zen` keyring - see [keys.md](keys.md).
Model selection: `--model`, `ZENERA_GYM_MODEL`, `~/.zenera/neo/gym.json`,
then the best model the available keys support. It must call tools; for OpenAI
reasoning models use the Responses API, `openai/responses:<id>`.

## Serving

Binds the loopback address by default. On start it prints a table per document,
the model, the story and the world file in use.

| Endpoint        | Answers                   |
| --------------- | ------------------------- |
| `/__gym/routes` | Every route it will serve |
| `/__gym/health` | Whether it is up          |

Response headers:

| Header            | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `x-gym-operation` | The `operationId` that answered                       |
| `x-gym-cache`     | `hit`, `miss` or `regenerated` - the handler's origin |

Gym provides simulation, not task scoring, rewards, or a training loop.

Incoming headers are filtered: `authorization`, `cookie` and anything matching
`key|token|secret|password|credential` never reach a handler.

`--seed` makes each request's seed a hash of the seed, the operation and the
parameters. Content comes from the world, which persists, so the same request
answers the same way across restarts as long as the world is kept.

## What "correct" means here

A handler is judged by `test_handler` on synthetic probes, in a throwaway copy
of the world with schema-sampled content: the body validates against the
response schema, **and** it obeys the **echo rule** - a value given in the path
comes back in the answer. `GET /users/12324` must return `user_id: 12324`. A body
can validate perfectly and still be about the wrong entity, which is exactly the
mock that wastes an afternoon.

Query parameters are deliberately not enforced: `?source=realtime`, `?page_size`
and `?cursor` are controls, and their names collide with unrelated response
fields.

Paged operations are also walked: the cursor must advance and end.

## The cache, the world, the reports

Handlers live in the machine's shared cache, `~/.zenera/neo/cache/gym-generator/`,
keyed by the operation's shape - not by the story, since a handler holds no
content - so the same spec served from two directories is written once, and a
spec edit produces a new key rather than a stale answer. A handler an agent gave
up on is remembered for the life of the process; a _transient_ failure - a 429,
a dropped socket - is not.

Worlds live in `<cache>/worlds/`, one SQLite file per story. `cache clear`
does not touch them; `serve --reset` empties one.

Every agent run leaves an HTML report in `<cache>/reports/`; failed builds
leave a markdown report in `<cache>/builds/`.

`zen gym cache ls` lists what has been written. `zen gym cache clear`
removes the handlers.

`zen cache ls --kind gym-generator` reaches the same entries from the other
side, along with everything else this machine has cached.

## Documents it accepts

Swagger 2 and OpenAPI 3.0/3.1, JSON or YAML, `$ref`s resolved. Several documents
can be served at once. OpenAPI 3.0 constructs are translated to JSON Schema
2020-12 on the way in (`nullable`, boolean `exclusiveMinimum`, Draft-4 array
`items`), and a `pattern` written as a JavaScript regex literal (`/^[a-z]+$/`)
is unwrapped rather than being treated as an unsatisfiable string.
