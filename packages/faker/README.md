# zenera-faker

A mock HTTP server for swagger/OpenAPI documents. Point it at one or more specs
and it serves them; the response bodies are written, once, by a model.

It ships no binary of its own: installing it adds `faker` to
[`zen`](https://www.npmjs.com/package/zenera-cli), which is also where the
credentials already are.

```sh
zen faker serve api/openapi.yaml --port 8787
curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", ... }
```

## How a body is produced

The first time an operation is called, the faker asks a model to write a
**Python generator** for it — one file, taking a JSON input path and a JSON
output path. That file is then run against synthetic probes and judged twice:
against the operation's response schema, and against the echo rule, which says
that where a path or query parameter shares a name with a property in the
response, the response has to carry the value that was asked for.
`GET /users/12324` answering with somebody else's id validates perfectly and is
still wrong.

If it fails, the diagnostics go back to the model and it tries again, up to
`--attempts`. If it passes, the file is cached and every later request is just
`podman exec python3 gen.py in.json out.json` — no model, no tokens.

Generators run in a container with **no network**, on an image baked once with
`faker`, `exrex`, `jsonschema` and `python-dateutil`.

## Commands

```
zen faker serve <spec...>    Serve them. Generators are written on demand.
zen faker build <spec...>    Write every generator now and exit.
zen faker cache ls | clear   What has been generated, or throw it away.
```

`zen mock` is the same command under a shorter noun.

Useful options: `--port`, `--host` (loopback by default), `--model`, `--seed`
(same request, same answer), `--rebuild`, `--attempts`, `--cache <dir>`.

`GET /__faker/routes` lists what is being served; `GET /__faker/health` is a
health check.

## Credentials

The keyring is `zen`'s, so there is nothing new to configure:

```sh
zen key add openai
zen key ls
```

Environment variables still win over the keyring, exactly as they do for `zen`.

## Requirements

Node >= 24 and podman. The first start builds one image; every start after that
reuses it.
