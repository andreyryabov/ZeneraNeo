<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/imgs/banner-neo-dark.svg">
  <img src="docs/imgs/banner-neo-light.svg" alt="ZENERA NEO" width="720">
</picture>

[![CI](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![OpenAI · Anthropic · Gemini · OpenRouter · vLLM](https://img.shields.io/badge/models-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Gemini%20%C2%B7%20OpenRouter%20%C2%B7%20vLLM-8957e5.svg)](#the-library-underneath)

</div>

# ZeneraNeo

**Build specialist agents. Share them. Run them from the command line.**

Not one assistant that is vaguely good at everything - a team built for the work
you actually keep doing, under a name you can type:

```sh
zen run accountant "Q3 - match the receipts drawer to the ledger, then update the return"
zen run accountant "this MSA against our playbook - redlines, and what I must not sign"
zen run analyst    "why churn doubled in the EU accounts - the exports are in this folder"
zen run analyst    "what changed in EU battery regulation this year, with sources"
zen run devops     "this week's advisories - which of them actually reach our code"
zen run devops     "the 03:12 outage - timeline, contributing factors, owners"
```

Three agents there, six things asked of them: an agent you have built is not a
script with one job, it is a specialist you keep going back to. And it is work
that comes back - every quarter, every sprint, every deal - which is exactly the
work nobody has shipped you a product for.

Once the agent exists it is a command: it works on the files you are standing
in, runs real commands in a container, searches the web when it has to, and
records every token it spent doing it.

You build one by **writing down what it should do**. `SPECIFICATION.md` is the
first file `zen init` writes: what the system is for, which specialists it
needs, what each of them may reach for, and what _done_ means. Everything else
in the folder implements that, and `zen check` fails the project when the two
drift apart - so the document stays true instead of becoming a story about the
code.

And because the whole thing is a folder - Markdown and YAML, no application to
build, no glue code to maintain - you can **commit it, review it in a pull
request, and hand it to somebody else**. One `zen init <dir>` on a project that
arrived by clone registers it without touching a thing, and it is their command
now too. It runs the same everywhere, on whichever models they prefer, and it
never carries your keys with it.

---

## Quickstart

Four commands, from nothing to an answer:

```sh
npm i -g @zenera/cli         # every vendor SDK comes with it
zen key add openai           # asks for the key without showing it; stored in ~/.zenera
zen init my-project          # a specification, and the project that implements it
zen run my-project "introduce yourself"
```

The name works from anywhere after that - `zen run my-project "..."` in any
directory, and that directory is what it works on. `zen run` with a prompt
answers once and exits, printing to standard output so it can be piped into
anything else; with nothing to say it opens a full-screen terminal interface - a
TUI - instead.

Then `zen open my-project` to open it in your editor, edit `SPECIFICATION.md`
to say what you actually want built, and send `/sync-with-spec` in the editor's
chat.

Sent a project by someone else? `zen init <dir>` on a folder that is already a
project registers it without touching anything in it, and from then on its name
is a command here too.

> **This is an open-source side project for experimentation and chore work.**
> It is **not** the official Zenera AI Platform, and it carries no support or
> stability promises. Use it to try ideas, to automate your own drudgery, and to
> see how a multi-agent runtime is put together.

The rest of this page is the same thing, slowly.

---

## 1 · Install

Node.js 24+. One command - the OpenAI, Anthropic, Google and OpenRouter SDKs
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
`npm i -g ./packages/cli` - the symlink is what keeps your local library edits
visible to the CLI.

</details>

Extra capabilities are separate packages that add **subcommands** to `zen`
rather than binaries of their own - see
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
is saved in your shell history and is captured in CI logs - so piping it in and
the hidden prompt are the only two ways.

Vertex AI is the one that takes more than a secret - a service-account JSON
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
    SPECIFICATION.md             what this is for - the intent
    INSTRUCTIONS.md              house rules, prepended to every agent
    agents.yaml                  who exists, what they may reach for
    agents/
        prompts/<name>.md        each agent's own brief
        skills/<name>/           knowledge loaded on demand, not always-on
    assets/                      reference material, read-only at /assets
    sandbox/Dockerfile           the container commands run in
    scripts/_setup.sh            the one command that initialises the project
    sessions/                    one workspace, memory and trajectory each
        <id>/
            workspace/           what the agents can read and write
            runs/<id>/           input, output, state, report.html, meta
```

Everything above the `sessions/` line is the system; everything below it is what
happened when it ran. Nothing here is tied to the machine it was written on,
which is the point of the CLI: **it makes agentic systems shareable the way
repositories are shareable.**

`zen init` also writes `.vscode/` and a `.github/` tree - a standing brief that
explains this runtime to whatever coding agent you have open in that folder,
plus the prompts and skills it needs to do the work described next.

`zen open` launches the editor you already use, and refreshes those files on the
way in so they are never stale. It picks the first of: `--editor`,
`$ZENERA_EDITOR`, the editor this terminal belongs to, `$VISUAL` or `$EDITOR`,
then VS Code, Cursor, VS Code Insiders, Windsurf, Zed, Sublime Text or IntelliJ

- found on `PATH` or installed - and finally the platform's own opener.

## 4 · Say what it should do

`SPECIFICATION.md` is the intent; everything around it is the implementation.
Where the two disagree the specification wins, so a change to what the system
does starts there and not in `agents.yaml`.

The one `zen init` writes is not a heading list - it is a true specification of
the project that was just scaffolded, so you can read it against the files next
to it before replacing a word:

```markdown
## Agents

One agent, `default`, which is the entry point and the whole system. It has
nobody to hand work to, because there is no second job to hand on.

## Done means

- The change asked for is in the workspace, or the question is answered from
  what is actually in it.
- Everything the agent claims a command did, that command actually did - it was
  run, and its output was read.
- The reply names what changed, file by file, and says what it deliberately did
  not do.
```

Rewrite it as what you are building. Concretely, in the window `zen open` just
gave you:

1. **Edit `SPECIFICATION.md`** - what the system is for, which agents exist,
   what each may reach for, and what _done_ means.
2. **Open the chat panel and send `/sync-with-spec`.**
3. **Read `SPECIFICATION-FEEDBACK.md`.** Answer its questions by editing
   `SPECIFICATION.md` - not by editing prompts - and send `/sync-with-spec`
   again.

That prompt - installed by `zen init` - reads the specification and every file
that implements it, builds the difference in both directions, changes the
smallest thing that closes each gap, and writes `SPECIFICATION-FEEDBACK.md` for
everything it could not do without guessing. Read that file first: it is the
shortest description of what your specification does not yet say.

<details>
<summary>The chat commands <code>zen init</code> installs</summary>

They are prompt files under `.github/prompts/`, which VS Code and its forks
offer as chat slash-commands. Both `zen init` and `zen open` write them fresh,
so they never go stale - and edits to them do not survive.

| In chat           | Does                                                        |
| ----------------- | ----------------------------------------------------------- |
| `/sync-with-spec` | Makes every file match `SPECIFICATION.md`, both directions. |
| `/review-project` | Reads the project as a reviewer would, and reports.         |
| `/new-agent`      | Adds an agent - prompt, wiring and hand-offs.               |
| `/new-skill`      | Adds a skill under `agents/skills/`.                        |

In an editor that does not support prompt files, paste the contents of
`.github/prompts/sync-with-spec.prompt.md` into its chat instead - it is only a
prompt.

</details>

```
edit SPECIFICATION.md → /sync-with-spec → zen check → scripts/_setup.sh
        ↑                                                        ↓
        └──────────────── read the report ←──────── zen run ─────┘
```

The turn that matters is the last one. When a run comes out wrong, the fix is
the sentence that was missing from the specification - after which the prompt
edit follows from it. Prompts patched directly drift away from the document that
is supposed to describe them, and a project whose specification is no longer
true is a project with no specification.

Full guide: [docs/specification.md](docs/specification.md).

## 5 · The wiring: `agents.yaml`

`/sync-with-spec` writes this file, but it is worth being able to read. An agent
is an instruction, a model, some tools, some skills, and who it may hand work
to:

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

| Key           | Is                                                                    |
| ------------- | --------------------------------------------------------------------- |
| `name`        | how everything else refers to this agent                              |
| `description` | what it is for - read by the _other_ agents when deciding to hand off |
| `system`      | its own brief, in prose, at `agents/prompts/<name>.md`                |
| `model`       | this agent's model; the top-level one otherwise                       |
| `tools`       | what it may reach for - `workspace:*`, `sandbox:*`, a named tool      |
| `handoffs`    | who it may pass the work to                                           |
| `skills`      | knowledge pulled in mid-run instead of carried in every prompt        |

It is validated strictly at load: an unknown tool, a handoff to nobody, a
missing prompt file - each fails immediately, naming the offending key, instead
of surfacing three turns into a run as a confused model.

`INSTRUCTIONS.md` is prepended to all of them, so it holds what is true
regardless of who is answering.

Full reference: [docs/agents-yaml.md](docs/agents-yaml.md) ·
[docs/projects.md](docs/projects.md).

### The self-improving loop

```
edit SPECIFICATION.md → /sync-with-spec → zen check → zen run
        ↑                                                  ↓
        └───── refine the spec <-──── zen inspect <-───────┘
```

You are not expected to hand-author any of it. Every step is a command, and
everything each one reads or writes is a plain file: the specification, the
findings `zen check` prints with a code, a location and a fix, the record
`zen inspect` renders of what the run actually did. So the loop does not need
you standing in it - hand the whole cycle to the agent in your editor and it
runs on the system it just built: test it, read the failure, change the sentence
in the specification that caused it, rebuild, run again. "Fix my project" is a
single instruction.

Tools, skills and agents are generated, run, inspected and corrected this way,
and the artefacts stay human-readable prose the whole way through - which is
what keeps the loop reviewable rather than opaque.

## 6 · Run them

```sh
zen run my-project                        # a full-screen terminal app, with nothing to say yet
zen run my-project "summarise this repo"  # answers once and exits; stdout is the answer
zen run my-project --session <id>         # continue a particular session
zen run my-project --read-only            # give the agent no way to write
echo "triage this" | zen run my-project --quiet | jq
```

The project is named here for clarity, but it rarely has to be: standing inside
the folder, plain `zen run` means the project you are in - `zen` walks up from
the working directory looking for `agents.yaml`. The first word is read as the
project when it names one and as the first word of the prompt when it does not,
and `--project <name|dir>` settles it either way.

A prompt on the command line asks nothing at all. It starts a **fresh session**
with the **directory you are standing in** as the workspace, writable - so

```sh
cd ~/code/some-repo
zen run my-project "find the dead exports and delete them"
```

is a complete instruction. `--session`, `--workspace` and `--read-only` override
that; the full-screen interface, where there is someone to ask, still asks.

A **session** is a context that persists: one workspace, one memory, one
accumulating trajectory. It continues itself - there is no `resume`, because its
state is what it is. A **run** is one prompt in, one answer out inside a
session, recorded in full whether or not you were watching.

## 7 · See what it did

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

From a sentence to a working two-agent system, without hand-writing the wiring.

```sh
zen init repo-notes && cd repo-notes
```

Open `SPECIFICATION.md` and replace it with what you want. This is the whole
input - no YAML, no prompt files:

```markdown
# Specification

## Purpose

Read a codebase and leave a short written note about it in the workspace.

## Agents

Two. `reader` explores the workspace and forms a picture of it; it cannot
write. When it has one, it hands to `writer`, which is the only agent that
creates a file, and the only thing it creates is `NOTES.md`.

## Tools and boundaries

`reader` may read, list and search the workspace and nothing else. `writer` may
write to it. Neither runs shell commands: this job is reading and writing
files, and a shell is a capability nothing here needs.

## Done means

`NOTES.md` exists in the workspace, under 40 lines, and says what the project
is, how it is laid out, and how it is built and tested. The reply says where
the file was put and stops.

## Out of scope

Changing any file other than `NOTES.md`. Memory, retrieval, and a sandbox.
```

Then, in your editor:

```
/sync-with-spec
```

It writes `agents.yaml` with the two agents, `agents/prompts/reader.md` and
`agents/prompts/writer.md`, narrows `reader`'s tools to the three it is allowed,
drops `sandbox:*` from the scaffolded agent because the specification puts it
out of scope, and reports what it did. Anything it could not settle - should
`NOTES.md` be overwritten if it exists? - is a question in
`SPECIFICATION-FEEDBACK.md` rather than a decision it made for you.

The wiring it produces is the file you would have written by hand:

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

Check it, then point it at a real directory:

```sh
zen check                                  # every file it names, validated
scripts/_setup.sh                          # nothing to build, in this one
cd ~/code/some-repo
zen run repo-notes "summarise this repo"   # this directory is the workspace
zen inspect --project repo-notes --open    # what it actually did
```

The workspace is the directory you are standing in, so the second-to-last
command is a complete instruction: no configuration, no paths, nothing to
remember. Add `--read-only` and the writer's file tools are simply not there.

Read the report. Whatever it got wrong, fix it in `SPECIFICATION.md` and run
`/sync-with-spec` again.

---

## Going further

Four things a project can have that the scaffolded one deliberately does not.
Each starts the same way - say it in `SPECIFICATION.md`, then let
`/sync-with-spec` do the wiring.

| Guide                                                  | For                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [Specification-driven projects](docs/specification.md) | The loop in full: writing a spec an agent can implement, the feedback file, setup scripts          |
| [Giving agents knowledge](docs/knowledge.md)           | A document index over manuals, runbooks or notes - searchable, greppable, quoted with line numbers |
| [Giving agents an integration](docs/integrations.md)   | An OpenAPI description as a searchable graph, and a mock server for it before the real one exists  |
| [Giving agents memory](docs/memory.md)                 | Carrying what was learned from one session to the next, as a graph rather than a transcript        |

---

## The CLI

| Command   | Does                                                                  |
| --------- | --------------------------------------------------------------------- |
| `init`    | Creates a project here, or in `<dir>`, and registers it.              |
| `list`    | Every known project: sessions, last run, whether one is live.         |
| `run`     | Runs the project - the TUI on a terminal, a single answer otherwise.  |
| `open`    | Opens a project in your editor.                                       |
| `key`     | The credential keyring - add, check, switch, remove.                  |
| `models`  | What this machine can use - list, search, test, pick.                 |
| `check`   | Validates `agents.yaml` and every file it names, and asks the models. |
| `inspect` | Opens or rebuilds a run's `report.html`.                              |
| `memory`  | What the agents remember, and getting rid of it.                      |
| `sandbox` | Checks and prepares the container that command-line tools run in.     |
| `cache`   | What work has been kept, and getting rid of it.                       |
| `version` | CLI, library and Node versions.                                       |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable. `zen help <command>` prints the flags of
one command.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command - so `zen run … | jq` is a supported way to use it, not an accident.

### Commands from other packages

A capability that is not for everybody ships as its own package and **adds a
subcommand to `zen`** rather than a second binary - one thing on your path, one
keyring, one name to remember. `zen --help` lists them whether or not they are
installed, and tells you what to run if not; nothing is imported until you type
the command, so an uninstalled one costs nothing and an installed one costs
nothing until it is used.

| Command | Package         | Does                                                      |
| ------- | --------------- | --------------------------------------------------------- |
| `faker` | `@zenera/faker` | A mock API from an openapi/swagger document.              |
| `rag`   | `@zenera/rag`   | Retrieval over a corpus: index it, then ask it something. |

**`zen faker`** - serve a specification as a working mock. The first time a
route is called, a model writes a Python generator for it, which is tested
against the response schema in a container and then cached; every later request
is just that file, no tokens.

```sh
npm i -g @zenera/faker
zen faker serve api/openapi.yaml --port 8787
curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", … }
```

**`zen rag`** - index a corpus, then ask it for the part that answers a
question. Two subjects: an API description, as a graph plus vectors, so the
answer is a field, the schema it is on and the operation that returns it; and a
pile of markdown, so the answer is the passage, quoted with its line numbers.

```sh
npm i -g @zenera/rag
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history" --format ts

zen rag docs index ./handbook --embedding openai:text-embedding-3-small
zen rag docs search "how does failover work when the primary is unreachable"
```

Wiring either one into a project: [docs/knowledge.md](docs/knowledge.md) ·
[docs/integrations.md](docs/integrations.md).

Details: [packages/faker/README.md](packages/faker/README.md) ·
[packages/rag/README.md](packages/rag/README.md).

### Concepts

- **Specification** - `SPECIFICATION.md`: what the system is for, who exists,
  what each may reach for, and how a finished job is recognised. The intent,
  which the rest of the folder implements.
- **Project** - a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `agents.yaml` is what makes it
  one, so moving or cloning the directory loses nothing.
- **Session** - a context that persists: one workspace, one memory, one store
  for large files, and a record of everything that happened, added to as it
  goes. Resumable.
- **Run** - one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** - the directory the agents may read and write. Defaults to the
  session's own empty folder; pointing it anywhere else is confirmed explicitly.
- **Sandbox** - a Podman container per session, with the workspace mounted at
  `/workspace`. Prepared on the first command an agent runs; `zen sandbox up`
  does it ahead of time.
- **Keyring** - `~/.zenera/neo`, readable only by you. Keys are copied into the
  environment just before a run, so an environment variable you set yourself
  always wins and a project checked out on a machine without `zen` still runs.

---

## What people build with it

Half a page of specification turns into a system, and the system becomes a name
on your command line. None of these ship with the CLI - each is a folder
somebody wrote once, and could send you.

| Project        | The team inside it                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **accountant** | A bookkeeper that reads and classifies every receipt, statement, invoice and agreement in the folder; a reconciler that holds each against a ledger line or a playbook position and lists what has no pair; a preparer that fills the return or drafts the redlines; a checker that refuses anything no document substantiates. |
| **analyst**    | A planner that splits the question into branches; researchers that run in parallel over your files and the web; a statistician that writes and runs Python in the sandbox; an editor that joins it into one answer where every claim carries its source.                                                                        |
| **devops**     | A gatherer that pulls advisories, logs, alerts and deploys into one picture; a tracer that works out whether a vulnerable path is reachable at all, or which change actually broke it; an engineer that plans the fix, applies it a step at a time, and stops the moment a check fails.                                         |

The common thread is the recurring, specific work that is too particular for a
product and too tedious to keep doing by hand - triage, review, intake,
reconciliation - shaped to your case rather than to a vendor's defaults.

## What is different about it

Most tools give you one agent, or a framework and an empty file. This is a
factory: it designs the system for you, then keeps it honest.

- **You state the problem; a meta-agent designs the system.** Specialists,
  prompts, tool grants, hand-offs, where it fans out - all of it drawn from what
  you wrote, and checked before it ever runs.
- **A self-improving loop, not a one-off build.** Build, run, read the record,
  change what was wrong, run again - and the system can drive that loop on
  itself. Failures come back as findings with a cause and a fix, so the next
  version is written rather than debugged.
- **It watches itself work.** Every run is recorded against the architecture it
  declared - the agent nobody called, the skill that never fired, where the
  tokens went. Nothing to instrument, nothing to sign up for.
- **Customisable all the way down.** Live in the specification and never look
  lower. Or set the model, tools and memory of a single agent. Or take the
  kernel itself and manage the trajectory turn by turn. No layer is sealed.
- **Your documents, searchable.** Hybrid retrieval over your files and your API
  descriptions, plus a memory that is a graph rather than a bucket of rows - so
  what an agent learned in March is still there in September.
- **Integrations it writes itself.** No MCP server to find, no connector to wait
  for. If it has to reach your ERP, your database or a twenty-year-old SOAP
  endpoint, it writes the call and runs it in a sandbox.

---

## The library underneath

The CLI is a shell over `@zenera/neo` - agents, models, tools, skills, memory and
a running record of everything that happened, with OpenAI, Anthropic,
Google/Vertex, OpenRouter and any OpenAI-compatible endpoint - vLLM, Ollama, a
gateway of your own - behind one interface. Use it directly when you want the
runtime inside your own application rather than on a terminal.

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

| Directory        | Published as    | What it is                                                             |
| ---------------- | --------------- | ---------------------------------------------------------------------- |
| `packages/cli`   | `@zenera/cli`   | `zen`, the command line: projects, sessions, credentials, a TUI        |
| `packages/neo`   | `@zenera/neo`   | the library - agents, models, tools, skills, memory, trajectory        |
| `packages/faker` | `@zenera/faker` | `zen faker` - a mock API from an openapi/swagger document              |
| `packages/rag`   | `@zenera/rag`   | `zen rag` - an API description or a pile of documents, made searchable |

Each has its own README: [cli](packages/cli/README.md) ·
[neo](packages/neo/README.md) · [faker](packages/faker/README.md) ·
[rag](packages/rag/README.md).

---

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
