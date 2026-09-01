---
name: zen-cli
description: How to drive this project from the terminal with `zen` — running it, validating it, credentials, the sandbox, run reports, and the `faker` and `rag` modules.
---

# The `zen` command line

`zen` runs agent projects from a terminal. Everything here operates on a project
directory, resolved from the working directory, or by name from the registry
`zen init` wrote to, or explicitly with `--project <name|dir>`. Every command
takes `--json` and prints a machine-readable answer instead of a rendered one.

**stdout is the answer, stderr is the narration.** Exit codes: `0` ok, `1`
failed, `2` usage, `3` invalid project, `4` no usable credential, `5` sandbox.

## The commands

```
zen init     [dir] [--name <name>] [--model <ref>] [--force]
zen list     [--sessions] [--prune]
zen run      [project] [prompt] [options]
zen open     [project] [--editor <cmd>] [--wait]
zen key      <ls|add|use|check|rm|show|env> [ref] [options]
zen models   [--project <name|dir>]
zen check    [name|dir] [--project <name|dir>] [--no-sandbox] [--strict] [--quiet]
zen inspect  [run] [--session <id>] [--open] [--rebuild] [--serve [port]]
zen sandbox  [status|up|pull|clean|disk] [options]
zen version

zen faker    <serve|build|cache> [spec...]
zen rag      schema <index|search|show|stats> [spec...]
```

## Read the reference before answering

The full reference lives next to this file, one document per part of the command
line. **Read the one that covers the question before answering it** — do not
guess a flag, and do not read them all.

| The question is about                                               | Read                                    |
| ------------------------------------------------------------------- | --------------------------------------- |
| Global flags, `--json`, exit codes, environment, where files live   | [frame.md](./references/frame.md)       |
| Creating, finding or opening a project                              | [projects.md](./references/projects.md) |
| Running: the TUI, one-shot answers, sessions, workspaces, overrides | [run.md](./references/run.md)           |
| Validating: `zen check`, `zen models`, what they can and cannot see | [check.md](./references/check.md)       |
| API keys, providers, the keyring, "no credential" errors            | [keys.md](./references/keys.md)         |
| The container shell commands run in, images, `persist`              | [sandbox.md](./references/sandbox.md)   |
| Run reports, trajectories, what a session directory holds           | [inspect.md](./references/inspect.md)   |
| `zen faker` — a mock API from an OpenAPI/Swagger document           | [faker.md](./references/faker.md)       |
| `zen rag` — searching an OpenAPI/Swagger document as a graph        | [rag.md](./references/rag.md)           |

## The short version

```
zen init                              scaffold a project here, pick a model
zen check                             validate everything before spending a turn
zen run                               the TUI
zen run "what changed?"               one answer, this directory as the workspace
zen inspect --open                    what the model was actually given
zen key ls --check                    which credentials still work
```

Run `zen check` after any edit to `agents.yaml`, a prompt or a skill: it reads
the project the way a run does, reports everything wrong at once, and calls no
model. It is the cheapest possible test.

When behaviour is wrong and the prompt looks right, open the run report. It
shows what the model was actually given, which is rarely what you assumed.

Flags always beat the file: the repository states intent, the invocation
overrides it. Failure messages name the offending key or file — a load error
names the exact path, as in `agents.yaml: agents[1].skills.discovery — …` — so
read it rather than guessing. The loader is strict on purpose, and an unknown
key is an error rather than a value quietly ignored.
