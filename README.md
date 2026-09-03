# ZeneraNeo

**Multi-agent systems as folders you can commit, share and run — written for you
by the coding agent you already have open.**

[![CI](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![OpenAI · Anthropic · Gemini · OpenRouter](https://img.shields.io/badge/models-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Gemini%20%C2%B7%20OpenRouter-8957e5.svg)](#the-library-underneath)

`zen` is a command line for building and running multi-agent systems. An
**agentic project is a folder**: prompts, agent wiring, skills and tool
selections are Markdown and YAML files, not code buried inside an application.
Commit it, review it in a pull request, hand it to a colleague — it runs the
same everywhere, and it never carries your keys with it.

> **This is an open-source side project for experimentation and chore work.**
> It is **not** the official Zenera AI Platform, and it carries no support or
> stability promises. Use it to try ideas, to automate your own drudgery, and to
> see how a multi-agent runtime is put together.

---

## Quickstart

Four commands, from nothing to an answer:

```sh
npm i -g @zenera/cli         # every vendor SDK comes with it
zen key add openai           # asks for the key without showing it; stored in ~/.zenera
zen init my-project          # scaffolds a project and registers it
cd my-project && zen run "introduce yourself"
```

`zen run` with a prompt answers once and exits, printing the answer to standard
output so it can be piped into anything else. `zen run` with nothing to say
opens a full-screen terminal interface — a TUI — instead.

The rest of this page is the same thing, slowly.

---

## 1 · Install

Node.js 24+. One command — the OpenAI, Anthropic, Google and OpenRouter SDKs
all ship with the CLI, so any provider works out of the box.

```sh
npm i -g @zenera/cli
```

Or try it without installing anything: `npx @zenera/cli --help`.

The binary is installed under three names: `zen`, `zn` and `zenera`.

<details>
<summary>From a clone of this repository</summary>

```sh
git clone https://github.com/andreyryabov/ZeneraNeo.git && cd ZeneraNeo
npm i && npm run cli:link       # builds both packages, puts `zen` on your PATH
```

`npm run cli:unlink` removes it again. Use the link rather than
`npm i -g ./packages/cli` — the symlink is what keeps your local library edits
visible to the CLI.

</details>

Extra capabilities are separate packages that add **subcommands** to `zen`
rather than binaries of their own — see
[commands from other packages](#commands-from-other-packages).

## 2 · Add a credential

Keys live in `~/.zenera/neo`, in a folder only you can read, and never in the
project. Just before a run they are copied into the environment the agents see,
so an environment variable you set yourself always wins, and a project checked
out on a machine without `zen` still runs.

```sh
zen key add openai              # or: anthropic, google, vertex, openrouter
zen key ls --check              # what is stored, and whether it still works
```

It asks for the key without showing what you type. In a script, pipe it in
instead: `zen key add openai < key.txt`. The secret is never given as an
argument, because a command line is visible to anyone listing running processes,
is saved in your shell history and is captured in CI logs — so piping it in and
the hidden prompt are the only two ways.

Vertex AI is the one that takes more than a secret — a service-account JSON
file, and a `--location` worth setting. For that, for which key a given model
reference uses, and for keeping several keys per provider, see
[credentials](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/cli/README.md#credentials).

## 3 · Create a project

```sh
zen init my-project             # scaffolds the project and registers it
zen open my-project             # opens it in your editor
```

`zen init` picks a model from a credential this machine can actually reach
(override with `--model`), writes the scaffold, and records the directory so
`zen list` and `zen open` can find it by name:

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

Nothing here is tied to the machine it was written on, which is the point of the
CLI: **it makes agentic systems shareable the way repositories are shareable.**

## 4 · Write the agents

The whole system is `agents.yaml`. An agent is an instruction, a model, some
tools, some skills, and who it may hand work to:

```yaml
default: intake
model: anthropic:claude-sonnet-4-5
skills: agents/skills

agents:
    - name: intake
      description: Takes the first message and routes the case.
      system: agents/prompts/intake.md
      tools: [policy_lookup]
      handoffs: [adjuster]

    - name: adjuster
      description: Weighs the written policy against the case and explains the outcome.
      system: agents/prompts/adjuster.md
      model: openai:gpt-5.4
      tools: [workspace:*, sandbox:*]
      skills:
          discovery: index # the model loads what the case needs
          preload: [house_style] # always on, from turn one
```

It is validated strictly at load: an unknown tool, a handoff to nobody, a
missing prompt file — each fails immediately, naming the offending key, instead
of surfacing three turns into a run as a confused model.

`agents/prompts/intake.md` is that agent's brief, in prose.
`agents/skills/<name>/SKILL.md` is knowledge it can pull in mid-run instead of
carrying in every prompt. `INSTRUCTIONS.md` is prepended to all of them.

Full reference: [docs/agents-yaml.md](docs/agents-yaml.md) ·
[docs/projects.md](docs/projects.md).

### You are not expected to hand-author this

`zen init` also writes `.github/copilot-instructions.md` — a standing brief that
explains this runtime to whatever coding agent you have open in that folder.
From then on the loop is:

1. You describe the job in prose.
2. A coding agent writes the agents, prompts, skills and tool declarations.
3. `zen run` executes them; every turn, tool call and token is recorded.
4. The report and the trajectory are read back — by you, or by an agent — and
   the project is edited again.

`zen check` is written to be read by a model as much as by a person: every
finding carries a code, a location and the fix for it, so "fix my project" is a
single instruction. Tools, skills and agents are generated, run, inspected and
corrected by AI. **AI creates AI, in a loop, verified by AI.** The artefacts
stay human-readable prose the whole way through, which is what keeps the loop
reviewable rather than opaque.

## 5 · Run them

```sh
zen run my-project                        # a full-screen terminal app, with nothing to say yet
zen run my-project "summarise this repo"  # answers once and exits; stdout is the answer
zen run my-project --session <id>         # continue a particular session
zen run my-project --read-only            # give the agent no way to write
echo "triage this" | zen run my-project --quiet | jq
```

The project is named here for clarity, but it rarely has to be: standing inside
the folder, plain `zen run` means the project you are in — `zen` walks up from
the working directory looking for `agents.yaml`. The first word is read as the
project when it names one and as the first word of the prompt when it does not,
and `--project <name|dir>` settles it either way.

A prompt on the command line asks nothing at all. It starts a **fresh session**
with the **directory you are standing in** as the workspace, writable — so

```sh
cd ~/code/some-repo
zen run my-project "find the dead exports and delete them"
```

is a complete instruction. `--session`, `--workspace` and `--read-only` override
that; the full-screen interface, where there is someone to ask, still asks.

A **session** is a context that persists: one workspace, one memory, one
accumulating trajectory. It continues itself — there is no `resume`, because its
state is what it is. A **run** is one prompt in, one answer out inside a
session, recorded in full whether or not you were watching.

## 6 · See what it did

```sh
zen check my-project                      # validate the project and every file it names
zen check my-project --no-models          # …without spending a token asking each model
zen inspect --project my-project --open   # the last run's report.html
zen list --sessions                       # every project, its sessions and last run
```

Named for clarity again: drop the name and each of these reads the project you
are standing in. `check` takes a bare name or directory, so an
unregistered checkout can be validated before it is ever run. `list` is the one
command that is about all of them at once.

Every run writes a self-contained `report.html`: the agent graph, every request,
every tool call, every token.

---

## A worked example

A two-agent system that reads a repository and writes a note about it. Nothing
below is generated — it is the whole system, in three files.

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

The workspace is the directory you are standing in, so the second command is a
complete instruction: no configuration, no paths, nothing to remember. Add
`--read-only` and the writer's file tools are simply not there.

---

## The CLI

| Command   | Does                                                                  |
| --------- | --------------------------------------------------------------------- |
| `init`    | Creates a project here, or in `<dir>`, and registers it.              |
| `list`    | Every known project: sessions, last run, whether one is live.         |
| `run`     | Runs the project — the TUI on a terminal, a single answer otherwise.  |
| `open`    | Opens a project in your editor.                                       |
| `key`     | The credential keyring — add, check, switch, remove.                  |
| `check`   | Validates `agents.yaml` and every file it names, and asks the models. |
| `inspect` | Opens or rebuilds a run's `report.html`.                              |
| `sandbox` | Checks and prepares the container that command-line tools run in.     |
| `version` | CLI, library and Node versions.                                       |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable. `zen help <command>` prints the flags of
one command.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command — so `zen run … | jq` is a supported way to use it, not an accident.

### Commands from other packages

A capability that is not for everybody ships as its own package and **adds a
subcommand to `zen`** rather than a second binary — one thing on your path, one
keyring, one name to remember. `zen --help` lists them whether or not they are
installed, and tells you what to run if not; nothing is imported until you type
the command, so an uninstalled one costs nothing and an installed one costs
nothing until it is used.

| Command | Package         | Does                                           |
| ------- | --------------- | ---------------------------------------------- |
| `faker` | `@zenera/faker` | A mock API from an openapi/swagger document.   |
| `rag`   | `@zenera/rag`   | Search an openapi/swagger document as a graph. |

**`zen faker`** — serve a specification as a working mock. The first time a
route is called, a model writes a Python generator for it, which is tested
against the response schema in a container and then cached; every later request
is just that file, no tokens.

```sh
npm i -g @zenera/faker
zen faker serve api/openapi.yaml --port 8787
curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", … }
```

**`zen rag`** — index an API description as a graph plus vectors, then ask it
for the connected piece that answers a question: the field, the schema it is
on, and the operation that returns it.

```sh
npm i -g @zenera/rag
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history" --format ts
```

Details: [packages/faker/README.md](packages/faker/README.md) ·
[packages/rag/README.md](packages/rag/README.md).

### Concepts

- **Project** — a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `agents.yaml` is what makes it
  one, so moving or cloning the directory loses nothing.
- **Session** — a context that persists: one workspace, one memory, one store
  for large files, and a record of everything that happened, added to as it
  goes. Resumable.
- **Run** — one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** — the directory the agents may read and write. Defaults to the
  session's own empty folder; pointing it anywhere else is confirmed explicitly.
- **Sandbox** — a Podman container per session, with the workspace mounted at
  `/workspace`. Prepared on the first command an agent runs; `zen sandbox up`
  does it ahead of time.
- **Keyring** — `~/.zenera/neo`, readable only by you. Keys are copied into the
  environment just before a run, so an environment variable you set yourself
  always wins and a project checked out on a machine without `zen` still runs.

---

## What people build with it

- **Deep research agents** — a planner that forks into parallel branches, each
  with its own tools and skills, joined back into one report.
- **Coding agents shaped to your case** — file tools scoped to a workspace, a
  container sandbox for commands, and house rules that are actually yours rather
  than a vendor's defaults.
- **Custom agentic systems for daily work** — triage, review, intake,
  reconciliation: the recurring chores that are too specific for a product and
  too tedious to keep doing by hand.

## What is different about it

- **The project is the artefact.** Not a script that happens to call a model —
  a directory with sessions and recorded runs, safe to commit.
- **Nothing is hidden.** No orchestration layer, no framework magic: an agent is
  an instruction, a model, tools, skills, who it may hand the work to, and how
  it splits into parallel branches. That is the list.
- **Everything is recorded.** Every run writes its input, output, state and a
  self-contained `report.html` — the graph, every request, every token.
- **Two runtime dependencies.** The library needs `yaml` and `zod`. The vendor
  SDKs are optional peer dependencies, installed and loaded only when you
  actually talk to that vendor — the CLI ships all four so that `zen` works out
  of the box.

---

## The library underneath

The CLI is a shell over `@zenera/neo` — agents, models, tools, skills, memory and
a running record of everything that happened, with OpenAI, Anthropic,
Google/Vertex and OpenRouter behind one interface. Use it directly when you want
the runtime inside your own application rather than on a terminal.

```ts
import { loadProject } from '@zenera/neo';

const project = await loadProject('./my-project', { tools: [lookupPolicy] });

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // stream events: thinking, text, tool calls, handoffs, usage
}
```

The library has its own README:
[packages/neo/README.md](packages/neo/README.md).

## Packages

| Directory        | Published as    | What it is                                                      |
| ---------------- | --------------- | --------------------------------------------------------------- |
| `packages/cli`   | `@zenera/cli`   | `zen`, the command line: projects, sessions, credentials, a TUI |
| `packages/neo`   | `@zenera/neo`   | the library — agents, models, tools, skills, memory, trajectory |
| `packages/faker` | `@zenera/faker` | `zen faker` — a mock API from an openapi/swagger document       |
| `packages/rag`   | `@zenera/rag`   | `zen rag` — an API description as a searchable graph            |

Each has its own README: [cli](packages/cli/README.md) ·
[neo](packages/neo/README.md) · [faker](packages/faker/README.md) ·
[rag](packages/rag/README.md).

---

Early days and moving fast — issues, questions and pull requests are welcome.
[MIT](LICENSE).
