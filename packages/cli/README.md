# @zenera/cli

**`zen` — put a team of AI agents to work on your problem, in one command.**

Describe the job in plain language and you get back a working multi-agent
system: specialists that reason, read and write files, run real commands, look
things up when they need to, and hand work to each other until the job is done.
No framework to learn, no application to build, no glue code to maintain.

The system is a folder — so it is yours. Commit it, review it, improve it, send
it to a colleague, or start from one someone else already built and make it your
own. It runs the same everywhere, on whichever models you prefer, and it never
carries your keys with it.

[![npm](https://img.shields.io/npm/v/@zenera/cli.svg)](https://www.npmjs.com/package/@zenera/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). This is an
> open-source side project for experimentation and chore work — **not** the
> official Zenera AI Platform. It carries no support or stability promises.

## Install

Node.js 24+. One command — the OpenAI, Anthropic, Google and OpenRouter SDKs
all ship with the CLI, so any provider works out of the box.

```sh
npm i -g @zenera/cli
```

Or without installing anything:

```sh
npx @zenera/cli --help
```

## Quickstart

Four commands, from nothing to an answer:

```sh
npm i -g @zenera/cli         # every vendor SDK comes with it
zen key add openai           # asks for the key without showing it; stored in ~/.zenera
zen init my-project          # scaffolds a project and registers it
cd my-project && zen run "introduce yourself"
```

Then the rest of the loop:

```sh
zen run                         # nothing to say yet — a full-screen terminal app (a TUI)
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

| Command   | Does                                                                 |
| --------- | -------------------------------------------------------------------- |
| `init`    | Creates a project here, or in `<dir>`, and registers it.             |
| `list`    | Every known project: sessions, last run, whether one is live.        |
| `open`    | Opens a project in your editor.                                      |
| `key`     | The credential keyring — add, check, switch, remove.                 |
| `models`  | What this machine can use — list, search, test, pick.                |
| `run`     | Runs the project — the TUI on a terminal, a single answer otherwise. |
| `inspect` | Opens or rebuilds a run's `report.html`.                             |
| `check`   | Validates the project and every file it names, and asks the models.  |
| `sandbox` | Checks and prepares the container that command-line tools run in.    |
| `version` | CLI, library and Node versions.                                      |

Commands can also come from a package installed alongside this one, so a new
capability is a subcommand rather than a new binary to remember — one thing on
your path, one keyring, one name. `zen --help` lists them whether or not they
are installed and says what to run if not; nothing is imported until you type
the command, so an uninstalled one costs nothing and an installed one costs
nothing until it is used.

| Command | Package         | Does                                           |
| ------- | --------------- | ---------------------------------------------- |
| `faker` | `@zenera/faker` | A mock API from an openapi/swagger document.   |
| `rag`   | `@zenera/rag`   | Search an openapi/swagger document as a graph. |

```sh
npm i -g @zenera/faker
zen faker serve api/openapi.yaml --port 8787   # a working mock, bodies written by a model

npm i -g @zenera/rag
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history" --format ts
```

They use this keyring and these credentials, so there is nothing new to
configure. Details:
[@zenera/faker](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/faker/README.md)
·
[@zenera/rag](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/rag/README.md).

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command — so `zen run … | jq` is a supported way to use it, not an accident.

The binary is installed under three names: `zen`, `zn` and `zenera`.

## Credentials

One keyring serves every provider, and a key goes in the same way whatever it
is for:

```sh
zen key add <provider>              # asks for the key without showing it
zen key add <provider> < key.txt    # or pipe it in
```

The value is never given as an argument — a command line is visible to anyone
listing running processes, is saved in your shell history and is captured in CI
logs — so piping it in and the hidden prompt are the only two ways. Entries live
in `~/.zenera/neo/keys.json`, in a file only you can read, and are copied into
the environment just before a run, so an environment variable you set yourself
always wins and a project checked out on a machine without `zen` still runs.

| Provider     | The value is                          | Exported as                      |
| ------------ | ------------------------------------- | -------------------------------- |
| `openai`     | a secret                              | `OPENAI_API_KEY`                 |
| `anthropic`  | a secret                              | `ANTHROPIC_API_KEY`              |
| `google`     | a secret — AI Studio                  | `GEMINI_API_KEY`                 |
| `vertex`     | a path to a service-account JSON file | `GOOGLE_APPLICATION_CREDENTIALS` |
| `openrouter` | a secret                              | `OPENROUTER_API_KEY`             |
| `exa`        | a secret — for the search tool        | `EXA_API_KEY`                    |

`zen key add` verifies the credential against the provider before it finishes,
but stores it either way: a key that cannot be checked right now — offline,
behind a proxy — is not a key that is wrong. `--no-check` skips the call.

### Which key a model uses

A model reference is `[provider[/api]:]model`, and the first segment names a
**provider, not a vendor**. So `vertex:gemini-3.5-flash` and
`google:gemini-3.5-flash` are the same model reached through two different
services, needing two different credentials — and a bare `gpt-5.4-mini` goes to
the default provider, `openai`. `zen check` resolves every reference in a
project against what is stored, says which credential each one needs, and spends
a few tokens asking each of them to answer — the only way to catch a model id
this account is not served. `--no-models` stops before the asking.

### Which models you can use

`zen check` answers _does my project work_. `zen models` answers _what can I
use_, needs no project, and asks the providers themselves:

```sh
zen models                                  # who has a credential, and what is cached
zen models openai                           # everything OpenAI serves this account
zen models search haiku --tools --free      # narrow it
zen models show openrouter:anthropic/claude-haiku-4.5
zen models test vertex:gemini-embedding-001 # one real call, one verdict
zen models pick --embedding                 # the first ref that answers, on stdout
```

Listings are cached for a day in `~/.zenera/neo/catalog`. When a provider cannot
be asked the last listing is used and said to be stale; only if there was never
one does a short built-in list stand in.

`test` distinguishes three failures, because they want three different actions.
A **refused** model means the credential was rejected. A **blocked** one means
the credential was accepted and the account then said no — an API switched off,
an empty balance, a model this key was never granted — and the fix comes with
it:

```
$ zen models test vertex:gemini-embedding-001
vertex:gemini-embedding-001  blocked  Vertex AI API has not been used in project my-proj …
vertex:gemini-embedding-001: gcloud services enable aiplatform.googleapis.com --project my-proj
error 1 of 1 did not answer
        find one that does: zen models pick --embedding
```

`pick` tries a short list of candidates one at a time and stops at the first
that works, printing the bare ref on stdout — so recovering from the above is
one substitution, whether a person or an agent is doing it:

```sh
zen rag schema index --embedding "$(zen models pick --embedding)" ./specs/*.yaml
```

### Vertex AI

Vertex takes two kinds of credential, and you never say which you are giving:
if the value is a path to a file that exists it is a service-account key, and
otherwise it is treated as an API key. The name you choose for the entry has no
say in it — `vertex/express` is simply an entry called `express`, exactly as
`vertex/prod` is one called `prod`, and either name can hold either kind.

The usual one is a **service-account JSON file** — give its path, not its
contents. Run the command with nothing piped and it asks:

```sh
zen key add vertex --location us-central1
# Paste the key, or a path to the file: /Users/you/keys/vertex-sa.json
```

The prompt is read by `zen`, not by your shell, so give a full path there — `~`
is not expanded. In a script, pipe the path in instead:

```sh
echo ~/keys/vertex-sa.json | zen key add vertex --location us-central1
```

The file is copied into `~/.zenera/neo/keys/`, where only you can read it, so
moving or cleaning up the original later cannot break it.

- `--location <region>` is worth setting. It must be `global` or a **concrete
  region**; multi-region names like `us` are rejected with a 404. `global`
  routes across regions and pays about ten seconds of cold start on the first
  request each process makes — a region answers in about two.
- `--project <id>` is only needed when the `project_id` inside the file is not
  the project you want.

The alternative is an **express-mode API key** — a single secret, stored under
`VERTEX_API_KEY`. It is the Vertex console's way of handing out access without a
service account, and it needs neither a project nor a region, so `--project` and
`--location` mean nothing there and are not stored.

### Gemini, three ways

The same Gemini models are reachable through three different credentials, and
which one you hold decides the prefix a model reference needs.

**AI Studio** — one key and nothing else to configure, the shortest way to a
working `gemini-3.5-flash`:

```sh
zen key add google                # asks for the key without showing it
zen check                         # google:gemini-3.5-flash now resolves
```

**Vertex, service account** — what production usually runs on. Give the path
and a region, because the file says which project it belongs to but never which
region to call:

```sh
echo ~/keys/vertex-sa.json | zen key add vertex --location us-central1
```

Add `--project` only when the `project_id` inside the file is not the one you
want to bill:

```sh
echo ~/keys/vertex-sa.json \
  | zen key add vertex --project other-project --location europe-west4
```

**Vertex, express mode** — paste the key at the prompt; no flags apply:

```sh
zen key add vertex
```

Holding several at once is the ordinary case. Name them and switch:

```sh
echo ~/keys/prod-sa.json | zen key add vertex/prod --location us-central1
echo ~/keys/dev-sa.json  | zen key add vertex/dev  --location global
zen key add vertex/express       # the express key, same provider

zen key use vertex/dev           # which one the next run uses
zen key ls --check               # all three, and whether they still work
zen key show vertex/prod         # masked; --reveal prints the path
```

`google` and `vertex` can both be configured — they are separate entries for
separate services, and the reference picks:

```sh
zen run --model google:gemini-3.5-flash "summarise this repo"
zen run --model vertex:gemini-3.5-flash "summarise this repo"
```

If you have already run `gcloud auth application-default login`, that login is
itself a usable credential: `zen key ls` shows it as `adc`, marked `~` because
it came from outside the keyring, and Vertex works with nothing stored at all.
Anything already set in `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_API_KEY` or
`GEMINI_API_KEY` is listed the same way and wins over the keyring, so it is
always visible which credential a run will actually use.

### More than one key per provider

Entries are named, so a provider can hold several and one of them is active:

```sh
zen key add openai/work         # a second entry
zen key use openai/work         # which one runs use
zen key ls --check              # everything stored, and whether it still works
zen key show vertex/default     # masked — --reveal prints the secret
zen key env openai              # shell exports, for other tools
zen key rm openai/work
```

`zen key ls` marks the active entry with `*`, and anything it found outside the
keyring — in your environment, or in a `gcloud` login — with `~`, so it is always
clear where a working provider actually comes from.

## Concepts

- **Project** — a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `agents.yaml` is what makes it
  one, so moving or cloning the directory loses nothing.
- **Session** — a context that persists: one workspace, one memory, one store
  for large files, and a record of everything that happened, added to as it
  goes. Resumable.
- **Run** — one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** — the directory the agents may read and write. A prompt given on
  the command line uses the current directory; the TUI offers the session's own
  empty folder and confirms anything outside it.
- **Keyring** — `~/.zenera/neo`, readable only by you. Keys are copied into the
  environment just before a run, so an environment variable you set yourself
  always wins and a project checked out on a machine without `zen` still runs.

## The library underneath

This is a shell over
[`@zenera/neo`](https://www.npmjs.com/package/@zenera/neo) — agents, models,
tools, skills, memory and a running record of everything that happened. Use it
directly when you want the runtime inside your own application rather than on a
terminal:
[its README](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md).

## Documentation

[docs/projects.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/projects.md)
— the folder a project is ·
[docs/agents-yaml.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/agents-yaml.md)
— every key in the configuration file.

## License

Early days and moving fast — issues, questions and pull requests are welcome.
[MIT](LICENSE).
