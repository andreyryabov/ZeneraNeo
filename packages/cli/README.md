# zenera-cli

**`zen` — put a team of AI agents to work on your problem, in one command.**

Describe the job in plain language and you get back a working multi-agent
system: specialists that reason, read and write files, run real commands, look
things up when they need to, and hand work to each other until the job is done.
No framework to learn, no application to build, no glue code to maintain.

The system is a folder — so it is yours. Commit it, review it, improve it, send
it to a colleague, or start from one someone else already built and make it your
own. It runs the same everywhere, on whichever models you prefer, and it never
carries your keys with it.

[![npm](https://img.shields.io/npm/v/zenera-cli.svg)](https://www.npmjs.com/package/zenera-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). This is an
> open-source side project for experimentation and chore work — **not** the
> official Zenera AI Platform. It carries no support or stability promises.

## Install

Node.js 24+. Install the CLI together with at least one vendor SDK — they are
**optional peer dependencies**, so you only pay for the ones you use.

```sh
npm i -g zenera-cli openai
#                or @anthropic-ai/sdk, @google/genai, @openrouter/sdk — any mix of them
```

Or without installing anything:

```sh
npx zenera-cli --help
```

## Quickstart

Four commands, from nothing to an answer:

```sh
npm i -g zenera-cli openai   # the CLI, plus one vendor SDK
zen key add openai           # prompts with the echo off; stored in ~/.zenera
zen init my-project          # scaffolds a project and registers it
cd my-project && zen run "introduce yourself"
```

Then the rest of the loop:

```sh
zen run                         # nothing to say yet — a TUI on a terminal
zen check                       # validate the project and every file it names
zen inspect                     # open the last run's report.html
zen list --sessions             # every project, its sessions and last run
echo "triage this" | zen run --quiet | jq
```

Or ask a question from wherever you are and get an answer back:

```sh
cd ~/code/some-repo
zen run my-project "summarise this repo and write NOTES.md"
```

A prompt on the command line asks nothing: a fresh session, the directory you
are standing in as the workspace, writable. `--session`, `--workspace` and
`--read-only` override that.

Then open the folder in your editor and tell your coding agent what the system
should do. It writes the agents; `zen run` runs them; `zen inspect` shows you
every request, tool call and token it spent.

## A worked example

A two-agent system that reads a repository and writes a note about it — the
whole thing, in three files.

```sh
zen init repo-notes && cd repo-notes
```

`agents.yaml` — who exists, and what each may reach for:

```yaml
default: reader
model: openai:gpt-5.4-mini

agents:
    - name: reader
      description: Reads the workspace and summarises what is in it.
      system: agents/prompts/reader.md
      tools: [workspace:read_file, workspace:list_dir, workspace:find_files]
      handoffs: [writer]

    - name: writer
      description: Turns a summary into a file on disk.
      system: agents/prompts/writer.md
      tools: [workspace:*]
```

`agents/prompts/reader.md`:

```markdown
You explore a codebase and describe it plainly: what it is, how it is laid out,
how it is built and tested. Read before you conclude. When you have a picture,
hand off to `writer`.
```

`agents/prompts/writer.md`:

```markdown
You write the summary you were handed to `NOTES.md`, in Markdown, under 40
lines. Then say where you put it and stop.
```

Check it, then point it at a real directory:

```sh
zen check                                  # every file it names, validated
cd ~/code/some-repo
zen run repo-notes "summarise this repo"   # this directory is the workspace
zen inspect --project repo-notes --open    # what it actually did
```

## The idea

An **agentic project is a folder**. Prompts, agent wiring, skills and tool
selections are files — Markdown and YAML — not code buried inside an
application. That folder can be committed, copied to another machine, reviewed
in a pull request, and handed to someone else who runs it with one command.
Credentials live in `$HOME`, so the project never contains a secret.

```
my-project/
    INSTRUCTIONS.md              house rules, prepended to every agent
    agents.yaml                  who exists, what they may reach for
    agents/
        prompts/<name>.md        each agent's own brief
        skills/<name>/           knowledge loaded on demand, not always-on
    sessions/                    one workspace, memory and trajectory each
        <id>/
            workspace/           what the agents can read and write
            runs/<id>/           input, output, state, report.html, meta
```

`zen init` also writes `.github/copilot-instructions.md` — a standing brief that
explains this runtime to whatever coding agent you have open in that folder, so
you are not expected to hand-author `agents.yaml`.

## Commands

| Command   | Does                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `init`    | Creates a project here, or in `<dir>`, and registers it.                 |
| `list`    | Every known project: sessions, last run, whether one is live.            |
| `open`    | Opens a project in your editor.                                          |
| `key`     | The credential keyring — add, check, switch, remove.                     |
| `run`     | Runs the project — the TUI on a terminal, one shot otherwise.            |
| `inspect` | Opens or rebuilds a run's `report.html`.                                 |
| `models`  | Resolves providers and models and validates the config, calling nothing. |
| `sandbox` | Checks and prepares the container that command-line tools run in.        |
| `version` | CLI, library and Node versions.                                          |

Commands can also come from a package installed alongside this one, so a new
capability is a subcommand rather than a new binary to remember — one thing on
your path, one keyring, one name. `zen --help` lists them whether or not they
are installed and says what to run if not; nothing is imported until you type
the command, so an uninstalled one costs nothing and an installed one costs
nothing until it is used.

| Command | Package        | Does                                           |
| ------- | -------------- | ---------------------------------------------- |
| `faker` | `zenera-faker` | A mock API from an openapi/swagger document.   |
| `rag`   | `zenera-rag`   | Search an openapi/swagger document as a graph. |

```sh
npm i -g zenera-faker
zen faker serve api/openapi.yaml --port 8787   # a working mock, bodies written by a model

npm i -g zenera-rag
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history" --format ts
```

They use this keyring and these credentials, so there is nothing new to
configure. Details:
[zenera-faker](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/faker/README.md)
·
[zenera-rag](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/rag/README.md).

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command — so `zen run … | jq` is a supported way to use it, not an accident.

The binary is installed under three names: `zen`, `zn` and `zenera`.

## Concepts

- **Project** — a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `agents.yaml` is what makes it
  one, so moving or cloning the directory loses nothing.
- **Session** — a context that persists: one workspace, one memory, one blob
  store, one accumulating trajectory. Resumable.
- **Run** — one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** — the directory the agents may read and write. A prompt given on
  the command line uses the current directory; the TUI offers the session's own
  empty folder and confirms anything outside it.
- **Keyring** — `~/.zenera/neo`, mode `0700`. Keys are materialised into the
  environment just before a run, so a real env var always wins and a project
  checked out on a machine without `zen` still runs.

## The library underneath

This is a shell over
[`zenera-neo`](https://www.npmjs.com/package/zenera-neo) — agents, models,
tools, skills, memory and an append-only trajectory. Use it directly when you
want the runtime inside your own application rather than on a terminal:
[its README](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md).

## Documentation

Full specification:
[packages/cli/DESIGN.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/DESIGN.md).
Also
[DESIGN.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/DESIGN.md) ·
[docs/projects.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/projects.md)
·
[docs/agents-yaml.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/agents-yaml.md).

## License

Early days and moving fast — issues, questions and pull requests are welcome.
[MIT](LICENSE).
