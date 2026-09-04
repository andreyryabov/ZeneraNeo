# @zenera/faker

**A mock HTTP server for swagger/OpenAPI documents. Point it at a spec and it
serves it — the response bodies are written, once, by a model.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). It ships no
> binary of its own: installing it adds a `faker` **subcommand** to
> [`zen`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## Install

Node.js 24+ and [podman](https://podman.io). Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/faker
zen key add openai          # the keyring `zen` already uses
```

The first start builds one image; every start after that reuses it. `zen --help`
lists `faker` whether or not it is installed, and says what to run if not.

## Use

```sh
zen faker serve api/openapi.yaml --port 8787
curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", ... }
```

More than one document at a time is fine, and the same request answers the same
way every time when you pin a seed:

```sh
zen faker serve specs/*.yaml --seed 42
```

Warm it up before a demo or a test run, so no request pays for a model turn:

```sh
zen faker build api/openapi.yaml     # write every generator now and exit
zen faker cache ls                   # what has been generated
zen faker cache clear                # throw it away
```

`zen mock` is the same command under a shorter noun.

## How a body is produced

The first time an operation is called, the faker asks a model to write a
**Python generator** for it — one file, taking a JSON input path and a JSON
output path. That file is then run against sample requests it makes up, and
judged twice: against the operation's response schema, and against the echo
rule, which says that where a path or query parameter shares a name with a
property in the response, the response has to carry the value that was asked
for. `GET /users/12324` answering with somebody else's id validates perfectly
and is still wrong.

If it fails, the diagnostics go back to the model and it tries again, up to
`--attempts`. If it passes, the file is cached under `~/.zenera/neo/faker` and
every later request is just `podman exec python3 gen.py in.json out.json` — no
model, no tokens.

Generators run in a container with **no network**, on an image baked once with
`faker`, `exrex`, `jsonschema` and `python-dateutil`.

## Pages that end

A list endpoint is the one place a mock can hang a real client. Given
`?cursor=abc`, the honest-looking answer is a body that validates, echoes
nothing it shouldn't, and hands back `abc` again — so the client asks for the
same page forever.

The faker reads the document for this. Where an operation has a paging
parameter (`cursor`, `page`, `offset`, `page_token`, …) and a response property
that carries the next one (`next`, `next_cursor`, `has_more`, …), three things
happen, all in the operation's own names:

- the model is told to fabricate **three pages** in total, to build the token
  out of the paging parameter rather than the seed, and to end the list — null,
  absent, or `has_more: false` where the schema leaves no other room;
- the generator is then **walked**: the faker calls it with no cursor, follows
  the token it gets back, and rejects the file if the token repeats, cycles, or
  never runs out. The diagnostics say which, and the model gets another go;
- at request time a token identical to the one just sent is **cut** — nulled or
  dropped, whichever the schema allows — and the request line says so. Nothing
  is invented in its place; a generator written before this rule existed is
  still on disk, and a cache is not rebuilt because a rule changed.

Only paginated operations are affected. Their cache keys changed once, so they
are written again on first use; everything else keeps the key it had.
`GET /__faker/routes` reports the shape that was recognised, per operation.

Plenty of documents describe the envelope and never write down the parameter
that reads it back. The first two steps cannot help there — nothing static can
see a parameter that is not declared — but the cut still applies: it takes the
paging parameter from the request itself, since a client only sends `?cursor=X`
because a body handed it X.

## Commands

```
zen faker serve <spec...>    Serve them. Generators are written on demand.
zen faker build <spec...>    Write every generator now and exit.
zen faker cache ls | clear   What has been generated, or throw it away.
```

Useful options: `--port`, `--host` (reachable only from this machine by
default), `--model`, `--seed` (same request, same answer), `--rebuild`,
`--attempts`, `--concurrency`, `--timeout`, `--cache <dir>`, `--quiet`.
`zen help faker` prints the full table.

`GET /__faker/routes` lists what is being served; `GET /__faker/health` is a
health check.

## Credentials

The keyring is `zen`'s, so there is nothing new to configure:

```sh
zen key add openai
zen key ls --check
```

Environment variables still win over the keyring, exactly as they do for `zen`.

## The rest of the family

| Package                                                                                     | What it is                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`@zenera/cli`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md) | `zen` — agent projects on the command line           |
| [`@zenera/neo`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md) | the runtime — agents, models, tools, skills, memory  |
| [`@zenera/rag`](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/rag/README.md) | `zen rag` — an API description as a searchable graph |

## License

[MIT](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE).
