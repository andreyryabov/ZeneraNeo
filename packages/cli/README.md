# zenera-cli

**`zen` — agentic projects you can run, share and commit, written for you by the
coding agent you already have open.**

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
npm i -g zenera-cli openai              # or @anthropic-ai/sdk, @google/genai
```

Or without installing anything:

```sh
npx zenera-cli --help
```

## Quickstart

```sh
zen key add openai < key.txt    # credentials, never in the project
zen init my-project             # scaffolds the project + a brief for your coding agent
cd "$(zen go my-project)"
zen run                         # a TUI on a terminal, one shot when piped
zen check                       # validate the project and every file it names
zen inspect                     # open the last run's report.html
```

Then open the folder in your editor and tell your coding agent what the system
should do. It writes the agents; `zen run` runs them; `zen inspect` shows you
every request, tool call and token it spent.

## The idea

An **agentic project is a folder**. Prompts, agent wiring, skills and tool
selections are files — Markdown and YAML — not code buried inside an
application. That folder can be committed, copied to another machine, reviewed
in a pull request, and handed to someone else who runs it with one command.
Credentials live in `$HOME`, so the project never contains a secret.

```
my-project/
    zenera.json                  the project's own name
    AGENTS.md                    house rules, prepended to every agent
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
| `go`      | Prints a project's directory, for the shell to `cd` to.                  |
| `open`    | Opens a project in your editor.                                          |
| `key`     | The credential keyring — add, check, switch, remove.                     |
| `run`     | Runs the project — the TUI on a terminal, one shot otherwise.            |
| `inspect` | Opens or rebuilds a run's `report.html`.                                 |
| `models`  | Resolves providers and models and validates the config, calling nothing. |
| `sandbox` | Checks and prepares the container that command-line tools run in.        |
| `version` | CLI, library and Node versions.                                          |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command — so `zen run … | jq` is a supported way to use it, not an accident.

The binary is installed under three names: `zen`, `zn` and `zenera`.

## Concepts

- **Project** — a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `zenera.json` travels with it,
  so moving or cloning it loses nothing.
- **Session** — a context that persists: one workspace, one memory, one blob
  store, one accumulating trajectory. Resumable.
- **Run** — one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** — the directory the agents may read and write. Defaults to the
  session's own empty folder; pointing it anywhere else is confirmed explicitly.
- **Keyring** — `~/.zenera/neo`, mode `0700`. Keys are materialised into the
  environment just before a run, so a real env var always wins and a project
  checked out on a machine without `zen` still runs.

## The library underneath

This is a shell over
[`zenera-neo`](https://www.npmjs.com/package/zenera-neo) — agents, models,
tools, skills, memory and an append-only trajectory. Use it directly when you
want the runtime inside your own application rather than on a terminal.

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
