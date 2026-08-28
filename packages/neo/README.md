# zenera-neo

**A multi-agent runtime for Node.js: agents, models, tools, skills, memory and
an append-only trajectory.**

[![npm](https://img.shields.io/npm/v/zenera-neo.svg)](https://www.npmjs.com/package/zenera-neo)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

> Part of [ZeneraNeo](https://github.com/andreyryabov/ZeneraNeo). This is an
> open-source side project for experimentation and chore work — **not** the
> official Zenera AI Platform. It carries no support or stability promises.

## Install

Node.js 24+, ESM only. Runtime dependencies are `yaml` and `zod` and nothing
else; the four vendor SDKs are **optional peer dependencies**, not loaded until
a client for that vendor is first built, so an OpenAI-only application never
pays for the others.

```sh
npm i zenera-neo openai
npm i zenera-neo @anthropic-ai/sdk
npm i zenera-neo @google/genai
npm i zenera-neo @openrouter/sdk
```

## Use

An agentic project is a folder — prompts, agent wiring, skills and tool
selections are Markdown and YAML files, not code buried inside an application.
Load one and run it:

```ts
import { loadProject } from 'zenera-neo';

const project = await loadProject('./my-project', { tools: [lookupPolicy] });

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // stream events: thinking, text, tool calls, handoffs, usage
}
```

The whole system is an `agents.yaml`:

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

## What it gives you

- **Agents** — an instruction, a model, tools, skills, plus handoffs and fork.
  There is no hidden orchestration layer.
- **Models** — OpenAI, Anthropic and Google/Vertex behind one interface, with
  named providers and model aliases resolved from config or from the host.
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

## Entry points

| Specifier                    | Contents                                  |
| ---------------------------- | ----------------------------------------- |
| `zenera-neo`                 | agents, models, tools, kernel, inspection |
| `zenera-neo/project`         | loading a project folder                  |
| `zenera-neo/skill-providers` | skill discovery and loading               |
| `zenera-neo/memory-stores`   | `MemoryStore` implementations             |
| `zenera-neo/payload-stores`  | payload persistence                       |

## Documentation

[DESIGN.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/DESIGN.md) ·
[docs/projects.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/projects.md) ·
[docs/agents-yaml.md](https://github.com/andreyryabov/ZeneraNeo/blob/main/docs/agents-yaml.md)
· and
[`examples/`](https://github.com/andreyryabov/ZeneraNeo/tree/main/examples) for
eight worked demos, from a single agent to a project loaded entirely from a
folder.

There is also `zen`, a command line over this runtime, in the same repository.

## License

Early days and moving fast — issues, questions and pull requests are welcome.
[MIT](LICENSE).
