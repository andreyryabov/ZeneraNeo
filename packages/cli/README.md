<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/andreyryabov/ZeneraNeo/main/docs/imgs/banner-cli-dark.svg">
  <img src="https://raw.githubusercontent.com/andreyryabov/ZeneraNeo/main/docs/imgs/banner-cli-light.svg" alt="ZENERA CLI" width="720">
</picture>

[![npm](https://img.shields.io/npm/v/@zenera/cli.svg)](https://www.npmjs.com/package/@zenera/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/andreyryabov/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

</div>

# @zenera/cli

**`zen` - build specialist agents. Share them. Run them from the command line.**

`@zenera/cli` is the command-line package in the
[ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo) toolkit. It creates,
runs, tests and improves the specialized agent systems defined by a project.

Not one general assistant that is passable at everything - a team built for the
work you actually keep doing, under a name you can type:

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

Getting there is three beats:

1. **Describe it.** You write `SPECIFICATION.md` - what the system is for,
   which specialists it needs, what each may reach for, what _done_ means. The
   rest of the folder is built to implement it.
2. **Test it.** `zen check` validates the project and every file it names,
   `zen run` exercises it for real, `zen inspect` opens the record of what it
   actually did. When it comes out wrong you fix the specification, not the
   prompts, and go round again.
3. **Share it.** It is a folder - commit it, review it in a pull request, send
   it. One `zen init <dir>` on a project that arrived by clone registers it
   without touching a thing, and it is their command now too.

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). This is an
> open-source side project for experimentation and chore work - **not** the
> official Zenera AI Platform. It carries no support or stability promises.

## What you build

Half a page of specification turns into a system like one of these. Nothing here
ships with the CLI - each is a folder somebody wrote, and could send you.

| Project        | The team inside it                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **accountant** | A bookkeeper that reads and classifies every receipt, statement, invoice and agreement in the folder; a reconciler that holds each against a ledger line or a playbook position and lists what has no pair; a preparer that fills the return or drafts the redlines; a checker that refuses anything no document substantiates. |
| **analyst**    | A planner that splits the question into branches; researchers that run in parallel over your files and the web; a statistician that writes and runs Python in the sandbox; an editor that joins it into one answer where every claim carries its source.                                                                        |
| **devops**     | A gatherer that pulls advisories, logs, alerts and deploys into one picture; a tracer that works out whether a vulnerable path is reachable at all, or which change actually broke it; an engineer that plans the fix, applies it a step at a time, and stops the moment a check fails.                                         |

Build one, commit it, and it runs the same on anyone else's machine - on
whichever models they prefer, and without carrying your keys.

## What makes it different

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

## Install

Node.js 24+. One command - the OpenAI, Anthropic, Google and OpenRouter SDKs
all ship with the CLI, so any provider works out of the box.

```sh
npm i -g @zenera/cli
```

Or without installing anything:

```sh
npx @zenera/cli --help
```

## Quickstart

From nothing to a specialized agent system:

```sh
npm i -g @zenera/cli         # every vendor SDK comes with it
zen key add openai           # asks for the key without showing it; stored in ~/.zenera
zen init my-project          # scaffolds a project and registers it
zen open my-project          # open the specification and project in your editor
```

In the editor, describe the job in `SPECIFICATION.md`, then send this in the
agent chat:

```
/sync-with-spec
```

It creates the specialists, responsibilities, tool access and handoffs the job
needs. Back in the terminal, validate the generated system and run it against a
real workspace:

```sh
zen check my-project
cd ~/code/some-repo
zen run my-project "summarise this repo and write NOTES.md"
```

Then, day to day:

```sh
zen run my-project              # no prompt given: opens a full-screen terminal app (a TUI)
zen check my-project            # validate the project and every file it names
zen inspect                     # open the last run's report.html
zen list --sessions             # every project, its sessions and last run
echo "triage this" | zen run my-project --quiet | jq
```

Standing inside the project, the name is optional: a bare `zen run`, `zen check`
or `zen inspect` means the one you are in.

Giving a prompt on the command line skips every question: it starts a fresh
session and uses the current directory as the workspace, with write access.
`--session`, `--workspace` and `--read-only` override that.

To change what the system does, update `SPECIFICATION.md` and send
`/sync-with-spec` again. The next section explains that workflow in detail.

## You write the specification; a coding agent writes the system

`zen init` writes `SPECIFICATION.md` first, and everything else in the folder
implements it. Where the two disagree the specification wins, so a change to
what the system does starts there and not in `agents.yaml`.

The one `zen init` writes is not a heading list - it is a true specification of
the project just scaffolded, so you can read it against the files beside it
before changing a word:

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

### How you actually edit it

`SPECIFICATION.md` is ordinary Markdown, so any editor will do - but the loop is
meant to be driven from a coding agent's chat, and `zen init` installs the
prompts that make each step a single command:

```sh
zen open my-project      # or, standing in the folder: zen open
```

That launches the editor you already use: the one this terminal belongs to, or
`$ZENERA_EDITOR`, or the first of VS Code, Cursor, Windsurf, Zed, Sublime Text
or IntelliJ it can find. `--editor <cmd>` names one outright.

In the window that opens:

1. **Edit `SPECIFICATION.md`** - what the system is for, which agents exist,
   what each may reach for, and what _done_ means.
2. **Open the chat panel and send `/sync-with-spec`.** It reads the
   specification and every file implementing it, works out the difference in
   both directions, and changes the smallest thing that closes each gap.
3. **Read `SPECIFICATION-FEEDBACK.md`**, which it writes for anything it could
   not do without guessing. Answer its questions by editing `SPECIFICATION.md`
    - not by editing prompts - and send `/sync-with-spec` again.

Back in the terminal: `zen check`, then `zen run`.

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
prompt. Alongside them, `.github/copilot-instructions.md` is the standing brief
that explains this runtime to whatever agent is reading, and
`.github/skills/zen-cli/` is the CLI's own reference for it.

</details>

### The self-improving loop

```
edit SPECIFICATION.md → /sync-with-spec → zen check → zen run
        ↑                                                  ↓
        └───── refine the spec <-──── zen inspect <-───────┘
```

`zen inspect` makes the record visible: the run trace, timing and token
statistics, agent architecture, and memory used during the run.

![Run inspection: trace, agent architecture, and memory](https://raw.githubusercontent.com/andreyryabov/ZeneraNeo/main/docs/imgs/0910_480.gif)

Every step is a command, and everything each one reads or writes is a plain
file: the specification, the findings `zen check` prints with a code, a location
and a fix, the record `zen inspect` renders of what the run actually did. So the
loop does not need you standing in it. Hand the whole cycle to the agent in your
editor and it runs on the system it just built - test it, read the failure,
change the sentence in the specification that caused it, rebuild, run again.
"Fix my project" is one instruction. (The first time round, `scripts/_setup.sh`
prepares the container the tools run in.)

The last turn is the one that matters. When a run comes out wrong the fix is the
sentence that was missing from the specification, and the prompt edit follows
from that. Prompts patched directly drift away from the document meant to
describe them, and a project whose specification is no longer true is a project
with no specification.

Full guide:
[docs/specification.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/specification.md).

## A worked example

From a sentence to a working two-agent system, without hand-writing any wiring.

```sh
zen init repo-notes && cd repo-notes
zen open                      # opens this folder in your editor
```

Replace `SPECIFICATION.md` with what you want. This is the whole input - no
YAML, no prompt files:

```markdown
# Specification

## Purpose

Read a codebase and leave a short written note about it in the workspace.

## Agents

- `reader` - explores the workspace and forms a picture of it. May read files
  and list directories, and nothing else. Hands off to `writer`.
- `writer` - turns that picture into `NOTES.md`. May write to the workspace.

## Done means

- `NOTES.md` exists, is Markdown, and is under 40 lines.
- Every claim in it comes from a file that was actually read.
```

Send `/sync-with-spec` in the editor's chat. It writes `agents.yaml` - who
exists, and what each may reach for:

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
      handoffs: [reader] # a hand-off does not return by itself; give it a way back
```

- and one prompt file per agent.

<details>
<summary>The prompt files it writes</summary>

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

</details>

<details>
<summary>What each <code>agents.yaml</code> key means</summary>

| Key           | Is                                                                    |
| ------------- | --------------------------------------------------------------------- |
| `name`        | how everything else refers to this agent                              |
| `description` | what it is for - read by the _other_ agents when deciding to hand off |
| `system`      | its own brief, in prose, at `agents/prompts/<name>.md`                |
| `model`       | this agent's model; the top-level one otherwise                       |
| `tools`       | what it may reach for - `workspace:*`, `sandbox:*`, a named tool      |
| `handoffs`    | who it may pass the work to                                           |
| `skills`      | knowledge pulled in mid-run instead of carried in every prompt        |

The file is validated strictly at load: an unknown tool, a handoff to nobody, a
missing prompt file - each fails immediately, naming the offending key, rather
than surfacing three turns into a run as a confused model. Full reference:
[docs/agents-yaml.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/agents-yaml.md).

</details>

Check it, then point it at a real directory:

```sh
zen check                                  # every file it names, validated
cd ~/code/some-repo
zen run repo-notes "summarise this repo"   # this directory is the workspace
zen inspect --project repo-notes --open    # what it actually did
```

That is the end of it: `repo-notes` is now a command like any other, in any
directory, for as long as the folder exists. Commit the folder and whoever
clones it types `zen init repo-notes` once - a directory that is already a
project is registered, not rebuilt, and nothing in it is touched - and the name
is a command on their machine too.

## A project is a folder

Prompts, agent wiring, skills and tool selections are all files - Markdown and
YAML - rather than code buried inside an application. So the folder can be
committed, copied to another machine, reviewed in a pull request, and handed to
someone else who runs it with one command. Credentials live in `$HOME`, never in
the project, so there is no secret to strip before sharing it.

```
my-project/
    SPECIFICATION.md             what this is for - the intent
    agents.yaml                  who exists, what they may reach for
    agents/
        instructions.md          house rules, prepended to every agent
        <topic>-instructions.md  more of them, one subject at a time
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
which is the point of the CLI: it makes agentic systems shareable the way
repositories are shareable.

`zen init` also writes `.vscode/` and a `.github/` tree - a standing brief that
explains this runtime to whatever coding agent you open the folder with, plus
the prompts and skills it needs to keep the project matching its specification.

## Concepts

- **Project** - a named directory holding a complete agent definition and the
  sessions that have run against it. It is self-describing: `agents.yaml` is
  what makes a directory a project, so moving or cloning it loses nothing.
- **Session** - a context that persists across runs: one workspace, one memory,
  one store for large files, and a record of everything that happened, added to
  as it goes. Resumable.
- **Run** - one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** - the directory the agents may read and write. A prompt given on
  the command line uses the current directory; the TUI offers the session's own
  empty folder instead, and asks before using anything outside it.
- **Keyring** - `~/.zenera/neo`, readable only by you. See
  [Credentials](#credentials).
- **Cache** - `~/.zenera/neo/cache`, one place for work already done: vectors,
  parses, model listings, generated mocks. Shared by every project on the
  machine, and never emptied by anything but you. See [Cache](#cache--work-you-have-already-paid-for).

## Sandbox commands

Agents use an isolated container when a project grants them command-line tools.
`zen run` prepares it automatically before the first command, but these commands
make setup, diagnostics and cleanup explicit - useful on a new machine or when
you want to validate a project's execution environment before a run.

```sh
zen sandbox status                    # engine, project image and active containers
zen sandbox up                        # prepare the execution environment for this project
zen sandbox pull                      # pull or build this project's image only
zen sandbox status --project my-app   # inspect a named project from anywhere
zen sandbox disk                      # storage used by the engine and known projects
zen sandbox clean                     # remove containers created by zen
```

`status`, `up` and `pull` use the project in the current directory, or accept
`--project <name|dir>`. `--image <ref>` selects an image explicitly. `clean` and
`disk` are machine-wide operations, so use them when you mean to inspect or
remove resources beyond the current project.

## Commands

| Command   | Does                                                                 |
| --------- | -------------------------------------------------------------------- |
| `init`    | Creates a project here, or in `<dir>`, and registers it.             |
| `list`    | Every known project: sessions, last run, whether one is live.        |
| `open`    | Opens a project in your editor.                                      |
| `key`     | The credential keyring - add, check, switch, remove.                 |
| `models`  | What this machine can use - list, search, test, pick.                |
| `run`     | Runs the project - the TUI on a terminal, a single answer otherwise. |
| `inspect` | Opens or rebuilds a run's `report.html`.                             |
| `memory`  | What the agents remember - size, listing, one node, or a whole page. |
| `check`   | Validates the project and every file it names, and asks the models.  |
| `sandbox` | Checks and prepares the container that command-line tools run in.    |
| `cache`   | What work has been kept, and getting rid of it.                      |
| `version` | CLI, library and Node versions.                                      |

### Commands from other packages

A command can also come from a package installed alongside this one, so a new
capability arrives as a subcommand instead of another binary to remember: one
thing on your path, one keyring, one name. `zen --help` lists these whether or
not they are installed, and tells you what to install if not. Nothing is
imported until you type the command, so an uninstalled one costs you nothing and
an installed one costs nothing until it is used.

| Command | Package         | Does                                           |
| ------- | --------------- | ---------------------------------------------- |
| `faker` | `@zenera/faker` | A mock API from an openapi/swagger document.   |
| `rag`   | `@zenera/rag`   | Search an openapi/swagger document as a graph. |

**`zen faker`** turns an OpenAPI or Swagger description into a working mock
server. It generates behavior for each route, checks the result against the
response contract, and reuses the generated implementation on later requests.

```sh
npm i -g @zenera/faker
zen faker serve api/openapi.yaml --port 8787   # a working mock, bodies written by a model

curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", … }
```

**`zen rag`** adds advanced retrieval for the knowledge an agent needs to work
from: documentation and API schemas. Document indexes support semantic,
full-text and hybrid search with passages returned alongside their source lines.
Schema indexes add graph-aware retrieval across operations, types, fields,
requests and responses, so an answer can include the connected API context
rather than an isolated match.

```sh
npm i -g @zenera/rag
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history" --format ts

zen rag docs index ./handbook --embedding openai:text-embedding-3-small
zen rag docs search "how does failover work when the primary is unreachable"
```

Use [@zenera/rag](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/rag/README.md)
for its complete retrieval capabilities and examples. Details:
[@zenera/faker](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/faker/README.md)
·
[@zenera/rag](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/rag/README.md).

### Conventions

The binary is installed under three names: `zen`, `zn` and `zenera`.

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`.

`stdout` carries the answer and `stderr` carries the narration, and `--json`
works on every command - so `zen run … | jq` is a supported way to use this, not
an accident.

| Exit code | Meaning              |
| --------- | -------------------- |
| `0`       | ok                   |
| `1`       | the run failed       |
| `2`       | bad invocation       |
| `3`       | invalid project      |
| `4`       | no usable credential |
| `5`       | sandbox unavailable  |

## Credentials

One keyring serves every provider, and a key goes in the same way whatever it
is for:

```sh
zen key add <provider>              # asks for the key without showing it
zen key add <provider> < key.txt    # or pipe it in
```

The value is never passed as an argument. A command line is visible to anyone
listing running processes, is saved in your shell history and is captured in CI
logs - so the hidden prompt and piping it in are the only two ways.

Entries live in `~/.zenera/neo/keys.json`, in a file only you can read. They are
copied into the environment just before a run, which has two consequences worth
knowing: an environment variable you set yourself always wins, and a project
checked out on a machine without `zen` still runs.

| Provider     | The value is                          | Exported as                      |
| ------------ | ------------------------------------- | -------------------------------- |
| `openai`     | a secret                              | `OPENAI_API_KEY`                 |
| `anthropic`  | a secret                              | `ANTHROPIC_API_KEY`              |
| `google`     | a secret - AI Studio                  | `GEMINI_API_KEY`                 |
| `vertex`     | a path to a service-account JSON file | `GOOGLE_APPLICATION_CREDENTIALS` |
| `openrouter` | a secret                              | `OPENROUTER_API_KEY`             |
| `exa`        | a secret - for the search tool        | `EXA_API_KEY`                    |

`zen key add` verifies the credential against the provider before it finishes,
but stores it either way: a key that cannot be checked right now - offline,
behind a proxy - is not a key that is wrong. `--no-check` skips the call.

### Which key a model uses

A model reference is `[provider[/api]:]model`, and the first segment names a
**provider, not a vendor**. So `vertex:gemini-3.5-flash` and
`google:gemini-3.5-flash` are the same model reached through two different
services, needing two different credentials; a bare `gpt-5.4-mini` goes to the
default provider, `openai`.

`zen check` resolves every reference in a project against what is stored and
says which credential each one needs. It then spends a few tokens asking each
model to answer, which is the only way to catch a model id this account is not
served. `--no-models` stops before that.

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

Listings are cached for a day in `~/.zenera/neo/cache`. If a provider cannot be
reached, the last listing is used and marked stale; only when there has never
been one does a short built-in list stand in.

`zen models test` separates three kinds of failure, because each calls for a
different action:

- **refused** - the provider rejected the credential. Fix or replace the key.
- **blocked** - the credential was accepted and the account then said no: an API
  switched off, an empty balance, a model this key was never granted. The key is
  fine; the account needs changing, and the command that changes it is printed
  with the error.
- **unknown** - the question never arrived (offline, proxy, timeout). Nothing is
  wrong with the key; try again.

```
$ zen models test vertex:gemini-embedding-001
vertex:gemini-embedding-001  blocked  Vertex AI API has not been used in project my-proj …
vertex:gemini-embedding-001: gcloud services enable aiplatform.googleapis.com --project my-proj
error 1 of 1 did not answer
        find one that does: zen models pick --embedding
```

`zen models pick` tries a short list of candidates one at a time, stops at the
first that works, and prints the bare reference on stdout. So recovering from
the above is a single substitution, whether a person or an agent is doing it:

```sh
zen rag schema index --embedding "$(zen models pick --embedding)" ./specs/*.yaml
```

### Setting up each provider

The shape is the same everywhere - `zen key add <provider>`, then answer the
prompt. Open the one you need for its specifics.

<details>
<summary><strong>OpenAI</strong> - one secret, exported as <code>OPENAI_API_KEY</code></summary>

```sh
zen key add openai
```

`openai` is the default provider, so a reference with no prefix comes here:
`gpt-5.4-mini` and `openai:gpt-5.4-mini` are the same model.

</details>

<details>
<summary><strong>Anthropic</strong> - one secret, exported as <code>ANTHROPIC_API_KEY</code></summary>

```sh
zen key add anthropic
zen run --model anthropic:claude-sonnet-4-5 "summarise this repo"
```

</details>

<details>
<summary><strong>OpenRouter</strong> - one secret, exported as <code>OPENROUTER_API_KEY</code></summary>

One credential for many vendors' models. The model id keeps its own vendor
prefix, after the `openrouter:` one:

```sh
zen key add openrouter
zen models search haiku --tools --free
zen run --model openrouter:anthropic/claude-haiku-4.5 "summarise this repo"
```

</details>

<details>
<summary><strong>Google AI Studio</strong> - one secret, exported as <code>GEMINI_API_KEY</code></summary>

One key and nothing else to configure: the shortest way to a working Gemini
model.

```sh
zen key add google
zen check                         # google:gemini-3.5-flash now resolves
```

The same Gemini models are also served by Vertex AI, under a different
credential. Both can be configured at once - they are separate entries for
separate services, and the prefix on the model reference decides which is used:

```sh
zen run --model google:gemini-3.5-flash "summarise this repo"
zen run --model vertex:gemini-3.5-flash "summarise this repo"
```

</details>

<details>
<summary><strong>Vertex AI</strong> - a service-account file, or an express-mode key</summary>

Vertex accepts two kinds of credential, and you never declare which one you are
giving: if the value is a path to a file that exists it is treated as a
service-account key, otherwise as an API key. The name you give the entry has no
bearing on this - `vertex/express` is just an entry called `express`, exactly as
`vertex/prod` is one called `prod`, and either name can hold either kind.

**A service-account JSON file** is the usual one, and what production normally
runs on. Give its path, not its contents. Run the command with nothing piped and
it asks:

```sh
zen key add vertex --gcp-location us-central1
# Paste the key, or a path to the file: /Users/you/keys/vertex-sa.json
```

The prompt is read by `zen`, not by your shell, so give a full path there - `~`
is not expanded. In a script, pipe the path in instead:

```sh
echo ~/keys/vertex-sa.json | zen key add vertex --gcp-location us-central1
```

The file is copied into `~/.zenera/neo/keys/`, where only you can read it, so
moving or cleaning up the original later cannot break it.

- `--gcp-location <region>` is worth setting, because the file says which project
  it belongs to but never which region to call. It takes a concrete region, or
  one of the endpoints that route across regions: `us` and `eu` pool capacity
  while keeping processing inside that territory, and `global` takes whatever is
  free and promises no residency. `global` costs about ten seconds of cold start
  on the first request each process makes; a named region answers in about two.
- Which models a location serves varies per model and is not guessable. In one
  project, `gemini-embedding-2` answered at `us` but 404'd at `us-central1`,
  while `gemini-2.5-flash` did the opposite. New models often reach `global`,
  `us` and `eu` first. `zen models test vertex:<model>` is what settles it -
  `zen key add` only establishes that the credential itself works.
- `--gcp-project <id>` is only needed when the `project_id` inside the file is
  not the project you want to bill:

    ```sh
    echo ~/keys/vertex-sa.json \
      | zen key add vertex --gcp-project other-project --gcp-location europe-west4
    ```

**An express-mode API key** is the alternative: a single secret, stored under
`VERTEX_API_KEY`. It is the Vertex console's way of granting access without a
service account, and it needs neither a project nor a region, so `--gcp-project`
and `--gcp-location` mean nothing there and are not stored.

```sh
zen key add vertex               # paste the key at the prompt; no flags apply
```

**An existing `gcloud` login counts too.** If you have run
`gcloud auth application-default login`, Vertex works with nothing stored at
all: `zen key ls` shows that login as `adc`, marked `~` because it came from
outside the keyring. Anything already set in `GOOGLE_APPLICATION_CREDENTIALS`,
`VERTEX_API_KEY` or `GEMINI_API_KEY` is listed the same way and wins over the
keyring, so it is always visible which credential a run will actually use.

</details>

<details>
<summary><strong>Exa</strong> - one secret, exported as <code>EXA_API_KEY</code></summary>

Not a model provider: this is what backs the search tool an agent reaches for
when it has to look something up on the web.

```sh
zen key add exa
```

</details>

<details>
<summary><strong>More than one key for the same provider</strong></summary>

Entries are named, so a provider can hold several, one of which is active:

```sh
zen key add openai/work         # a second entry
zen key use openai/work         # the one that runs will use
zen key ls --check              # everything stored, and whether it still works
zen key show vertex/default     # masked - --reveal prints the secret
zen key env openai              # shell exports, for other tools
zen key rm openai/work
```

It is the same for Vertex, where holding several at once is the ordinary case:

```sh
echo ~/keys/prod-sa.json | zen key add vertex/prod --gcp-location us-central1
echo ~/keys/dev-sa.json  | zen key add vertex/dev  --gcp-location global
zen key add vertex/express      # the express key, same provider

zen key use vertex/dev          # which one the next run uses
```

`zen key ls` marks the active entry with `*`, and anything it found outside the
keyring - in your environment, or in a `gcloud` login - with `~`, so it is always
clear where a working provider actually comes from.

</details>

## Cache - work you have already paid for

Embedding a paragraph, parsing a document, asking a provider what it serves: all
of these are slow or costly, and all of them give the same answer every time. So
the answers are kept in `~/.zenera/neo/cache/<kind>/`, under a key built from
every input that produced them. Change any input and the key changes, so you get
a fresh answer rather than a stale one. That is why entries are never
invalidated: one that no longer matches anything is simply never read again.

```
zen cache ls                          # what is kept, by kind
zen cache ls --kind vectors           # and what is in one of them
zen cache prune --older-than 30d      # drop what has gone unread for a month
zen cache prune --max-size 2GB        # or keep it under a ceiling
zen cache clear --kind docs-parse     # throw one kind away
```

Age means when an entry was last _read_, not when it was written, so a vector
that a weekly rebuild keeps using never counts as old.

Nothing is ever evicted automatically. A store that quietly deletes things is
only noticed once it has deleted the wrong one, so every removal is something
you ask for. Nothing in the cache is precious either: every entry is work that
can be done again, and the only cost of deleting one is paying for it a second
time.

## The library underneath

This is a shell over
[`@zenera/neo`](https://www.npmjs.com/package/@zenera/neo) - agents, models,
tools, skills, memory and a running record of everything that happened. Use it
directly when you want the runtime inside your own application rather than on a
terminal:
[its README](https://github.com/andreyryabov/ZeneraNeo/blob/main/packages/neo/README.md).

## Documentation

- [docs/specification.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/specification.md)
    - writing the specification the project implements.
- [docs/projects.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/projects.md)
    - what the project folder contains, file by file.
- [docs/agents-yaml.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/agents-yaml.md)
    - every key in the configuration file.
- [docs/knowledge.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/knowledge.md)
    - building a searchable document index.
- [docs/integrations.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/integrations.md)
    - making an API description searchable and mockable.
- [docs/memory.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/memory.md)
    - what agents keep between sessions.

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
