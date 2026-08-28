# ZeneraNeo

**Multi-agent systems as folders you can commit, share and run — written for you
by the coding agent you already have open.**

[![CI](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/andreyryabov/ZeneraNeo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![OpenAI · Anthropic · Gemini · OpenRouter](https://img.shields.io/badge/models-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Gemini%20%C2%B7%20OpenRouter-8957e5.svg)](#the-library)

An agent runtime for Node.js 24+ (ESM), and a command line over it.

> **This is an open-source side project for experimentation and chore work.**
> It is **not** the official Zenera AI Platform, and it carries no support or
> stability promises. Use it to try ideas, to automate your own drudgery, and to
> see how a multi-agent runtime is put together.

Two pieces:

| Directory      | Published as | What it is                                                      |
| -------------- | ------------ | --------------------------------------------------------------- |
| `packages/neo` | `zenera-neo` | the library — agents, models, tools, skills, memory, trajectory |
| `packages/cli` | `zenera-cli` | `zen`, the command line: projects, sessions, credentials, a TUI |

## Quickstart

```sh
git clone https://github.com/andreyryabov/ZeneraNeo.git && cd ZeneraNeo
npm i && npm run cli:link       # builds both packages, puts `zen` on your PATH

zen key add openai < key.txt    # or: anthropic, vertex, google, openrouter
zen init my-project             # scaffolds v1 + a brief for your coding agent
cd "$(zen go my-project)"
zen run                         # a TUI on a terminal, one shot when piped
```

Then open the folder in your editor and tell your coding agent what the system
should do. It writes the agents; `zen run` runs them; `zen inspect` shows you
every request, tool call and token it spent.

---

## The idea

An **agentic project is a folder**. Prompts, agent wiring, skills and tool
selections are files — Markdown and YAML — not code buried inside an
application. That folder can be committed, copied to another machine, reviewed
in a pull request, and handed to someone else who runs it with one command.
Nothing about it is tied to the machine it was written on: credentials live in
`$HOME`, so the project never contains a secret.

That is the point of the CLI: **it makes agentic systems shareable the way
repositories are shareable.**

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

The whole system is that `agents.yaml`:

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

### AI writes the AI

You are not expected to hand-author `agents.yaml`. `zen init` scaffolds the
project **and** writes `.github/copilot-instructions.md` — a standing brief that
explains this runtime to whatever coding agent you have open in that folder.
From then on the loop is:

1. You describe the job in prose.
2. A coding agent writes the agents, prompts, skills and tool declarations.
3. `zen run` executes them; every turn, tool call and token is recorded.
4. The report and the trajectory are read back — by you, or by an agent — and
   the project is edited again.

Tools, skills and agents are generated, run, inspected and corrected by AI.
**AI creates AI, in a loop, verified by AI.** The artefacts stay human-readable
prose the whole way through, which is what keeps the loop reviewable rather than
opaque.

### What people build with it

- **Deep research agents** — a planner that forks into parallel branches, each
  with its own tools and skills, joined back into one report.
- **Coding agents shaped to your case** — file tools scoped to a workspace, a
  container sandbox for commands, and house rules that are actually yours rather
  than a vendor's defaults.
- **Custom agentic systems for daily work** — triage, review, intake,
  reconciliation: the recurring chores that are too specific for a product and
  too tedious to keep doing by hand.

### What is different about it

- **The project is the artefact.** Not a script that happens to call a model —
  a directory with sessions and recorded runs, safe to commit.
- **Nothing is hidden.** No orchestration layer, no framework magic: an agent is
  an instruction, a model, tools, skills, handoffs and fork. That is the list.
- **Everything is recorded.** Every run writes its input, output, state and a
  self-contained `report.html` — the graph, every request, every token.
- **Two runtime dependencies.** `yaml` and `zod`. The vendor SDKs are optional
  peers, loaded only when you actually talk to that vendor.

---

## The CLI

```sh
npm i                # in this repo
npm run cli:link     # build + npm link → `zen` on your PATH
```

```sh
zen key add openai < key.txt   # credentials, never in the project
zen init my-project            # scaffold the project and register it
cd "$(zen go my-project)"
zen run                        # TUI on a terminal
zen run "summarise this repo"  # one shot; stdout is the answer
zen check                      # validate the project and every file it names
zen inspect                    # open the last run's report.html
```

### Commands

| Command   | Does                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `init`    | Creates a project here, or in `<dir>`, and registers it.                 |
| `list`    | Every known project: sessions, last run, whether one is live.            |
| `go`      | Prints a project's directory, for the shell to `cd` to.                  |
| `open`    | Opens a project in your editor.                                          |
| `key`     | The credential keyring — add, check, switch, remove.                     |
| `run`     | Runs the project — the TUI on a terminal, one shot otherwise.            |
| `check`   | Validates `agents.yaml` and every file it names, and reports in full.    |
| `inspect` | Opens or rebuilds a run's `report.html`.                                 |
| `models`  | Resolves providers and models and validates the config, calling nothing. |
| `sandbox` | Checks and prepares the container that command-line tools run in.        |
| `version` | CLI, library and Node versions.                                          |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`. Exit codes: `0`
ok, `1` the run failed, `2` bad invocation, `3` invalid project, `4` no usable
credential, `5` sandbox unavailable.

### Concepts

- **Project** — a named directory holding a complete agent definition and the
  sessions that ran against it. Self-describing: `agents.yaml` is what makes it
  one, so moving or cloning the directory loses nothing.
- **Session** — a context that persists: one workspace, one memory, one blob
  store, one accumulating trajectory. Resumable.
- **Run** — one prompt in, one answer out, inside a session. Recorded in full,
  whether or not you were watching.
- **Workspace** — the directory the agents may read and write. Defaults to the
  session's own empty folder; pointing it anywhere else is confirmed explicitly.
- **Keyring** — `~/.zenera/neo`, mode `0700`. Keys are materialised into the
  environment just before a run, so a real env var always wins and a project
  checked out on a machine without `zen` still runs.

`stdout` is the answer, `stderr` is the narration, and `--json` is on every
command — so `zen run … | jq` is a supported way to use it, not an accident.

Full specification: [packages/cli/DESIGN.md](packages/cli/DESIGN.md).

---

## The library

`zenera-neo` is the runtime the CLI is a shell over, and it is usable on its own.

```sh
npm i zenera-neo openai
npm i zenera-neo @anthropic-ai/sdk
npm i zenera-neo @google/genai
```

Runtime dependencies are `yaml` and `zod` and nothing else; the three vendor
SDKs are **optional peer dependencies**, not loaded until a client for that
vendor is first built, so an OpenAI-only application never pays for the others.

```ts
import { loadProject } from 'zenera-neo';

const project = await loadProject('./my-project', { tools: [lookupPolicy] });

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // stream events: thinking, text, tool calls, handoffs, usage
}
```

What it gives you:

- **Agents** — an instruction, a model, tools, skills, plus handoffs and fork.
  There is no hidden orchestration layer.
- **Models** — OpenAI, Anthropic, Google/Vertex and OpenRouter behind one
  interface, each through its own SDK, plus any OpenAI-compatible endpoint.
  Named providers and model aliases resolve from config or from the host.
- **Tools** — plain typed functions, selectable per agent by name, group or
  wildcard. Workspace file tools and a Podman sandbox ship with the library.
- **Skills** — instruction bundles discovered and loaded on demand instead of
  permanently occupying the prompt, optionally owning their own tools.
- **Memory** — pluggable `MemoryStore`s, with scopes deciding what is private to
  an agent and what is shared.
- **Trajectory** — an append-only log of everything that happened. Provider
  messages are a projection of it, and compaction _covers_ nodes rather than
  deleting them, so the audit trail survives context pressure.
- **Inspection** — `renderReportHtml` turns any run into one self-contained HTML
  file: the graph, every request, every token.

Reference: [DESIGN.md](DESIGN.md), [docs/projects.md](docs/projects.md),
[docs/agents-yaml.md](docs/agents-yaml.md), and `examples/` for eight worked
demos, from a single agent to a project loaded entirely from a folder.

---

Early days and moving fast — issues, questions and pull requests are welcome.
[MIT](LICENSE).
