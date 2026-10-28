# Agent API environments - `zen gym`

```
zen gym <serve|build|cache|model> [spec...]
```

Provided by `@zenera/gym` - `npm i -g @zenera/gym` if
`zen gym` says it is not installed.

Serves a mock API from one or more OpenAPI/Swagger documents. For each
operation a **model writes a Python generator**, which is self-tested inside a
container and cached on disk. Answers are therefore schema-correct and
plausible, not `"string"` repeated.

## Subcommands

| Command           | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `serve <spec...>` | Serve the documents. Generators are written on demand      |
| `build <spec...>` | Write every generator now and exit                         |
| `cache ls\|clear` | What has been generated, or throw it away                  |
| `model [ref]`     | Show or set the model; `--clear` forgets the stored choice |

```
zen gym serve openapi.yaml
zen gym serve api/*.yaml --port 9000 --seed 7
zen gym build openapi.yaml --concurrency 8
zen gym cache clear
```

`build` is the one to run in CI or before a demo: it pays for every generator up
front and exits non-zero, with a table, if any could not be written.

## Options

| Flag                | Default             | Meaning                                         |
| ------------------- | ------------------- | ----------------------------------------------- |
| `--port <n>`        | `8787`              | Port to listen on                               |
| `--host <h>`        | `127.0.0.1`         | Anything else is reachable off-machine          |
| `--model <ref>`     | project default     | Which model writes the generators               |
| `--image <ref>`     | a baked image       | Skip the baked image and use this one           |
| `--cache <dir>`     | `~/.zenera/neo/gym` | Where generators live                           |
| `--seed <n>`        | -                   | Answer the same request the same way every time |
| `--attempts <n>`    | `3`                 | Tries per generator before giving up            |
| `--concurrency <n>` | `4`                 | Generators written at once                      |
| `--timeout <s>`     | `30`                | Seconds one generator may take                  |
| `--max-body <n>`    | 1 MB                | Largest request body accepted, in bytes         |
| `--rebuild`         | -                   | Ignore what is cached and write it again        |
| `--no-cache`        | -                   | Do not record what is written                   |
| `--quiet`           | -                   | No narration                                    |

Credentials come from the `zen` keyring - see [keys.md](keys.md).
Model selection: `--model`, `ZENERA_GYM_MODEL`, `~/.zenera/neo/gym.json`,
then the best model the available keys support.

## Serving

Binds the loopback address by default. On start it prints a table per document:
paths, methods, and how many operations have a response schema and therefore get
a generator.

| Endpoint        | Answers                   |
| --------------- | ------------------------- |
| `/__gym/routes` | Every route it will serve |
| `/__gym/health` | Whether it is up          |

Response headers:

| Header            | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `x-gym-operation` | The `operationId` that answered                       |
| `x-gym-cache`     | `hit` or `miss` - whether this call cost a model turn |

Gym provides simulation, not task scoring, rewards, or a training loop.

Incoming headers are filtered: `authorization`, `cookie` and anything matching
`key|token|secret|password|credential` never reach a generator.

`--seed` makes each request's seed a hash of the seed, the operation and the
parameters, so the same request answers identically across restarts - which is
what makes a mock usable in a test.

## What "correct" means here

A generator is judged on two synthetic probes: the body validates against the
response schema, **and** it obeys the **echo rule** - a value given in the path
comes back in the answer. `GET /users/12324` must return `user_id: 12324`. A body
can validate perfectly and still be about the wrong entity, which is exactly the
mock that wastes an afternoon.

Query parameters are deliberately not enforced: `?source=realtime`, `?page_size`
and `?cursor` are controls, and their names collide with unrelated response
fields.

Probes are synthetic on purpose - real request bodies never reach a prompt.

## The cache

Generators live in the machine's shared cache, `~/.zenera/neo/cache/gym-generator/`,
keyed by the operation's shape - so the same spec served from two directories is
written once, and a spec edit produces a new key rather than a stale answer. A
generator that a model gave up on is remembered for the life of the process, so
a hopeless operation is not re-asked on every request; a _transient_ failure - a
429, a dropped socket - is not, because it is about this minute rather than this
operation.

`~/.zenera/neo/gym/` is the container's workspace, and scratch: a cache hit is
copied into it, because the container can only run what is under its mount.

`zen gym cache ls` lists what has been generated. `zen gym cache clear`
removes the generators, the workspace and the container together. They have to
go together: the container's name is a hash of its configuration, so deleting
the workspace alone would leave a stopped container bind-mounted onto a
directory that no longer exists, and every generator would fail with
`python3: can't open file '/workspace/generators/…/gen.py'`.

`zen cache ls --kind gym-generator` reaches the same entries from the other
side, along with everything else this machine has cached.

## Documents it accepts

Swagger 2 and OpenAPI 3.0/3.1, JSON or YAML, `$ref`s resolved. Several documents
can be served at once. OpenAPI 3.0 constructs are translated to JSON Schema
2020-12 on the way in (`nullable`, boolean `exclusiveMinimum`, Draft-4 array
`items`), and a `pattern` written as a JavaScript regex literal (`/^[a-z]+$/`)
is unwrapped rather than being treated as an unsatisfiable string.
