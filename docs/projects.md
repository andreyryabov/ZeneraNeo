# Creating a project

A project is a folder. It holds the same objects an author would otherwise
construct in TypeScript — agents, prompts, models, skills — serialised to files
that a non-programmer can edit. The loader introduces no runtime concept of its
own: everything it does is assembly.

See [agents-yaml.md](agents-yaml.md) for the configuration reference, and
`examples/project.ts` for a runnable version of everything below.

## Layout

```
my-project/
    INSTRUCTIONS.md                  house rules, prepended to every agent
    agents.yaml                      who exists, what they may reach for
    agents/
        prompts/
            intake.md                one agent's own brief
            adjuster.md
        skills/
            house_style/
                SKILL.md             a folder skill; siblings become resources
            refund_policy.md         a flat skill
```

Only `agents.yaml` is required, and only `agents:` is required inside it.

The config file is found by looking for these names, in order:

1. `agents.yaml`
2. `agents.yml`
3. `agents/agents.yaml`
4. `agents/agents.yml`

## Loading

```ts
import { loadProject } from '@zenera/neo';
import { tool } from '@zenera/neo';

const project = await loadProject('./my-project', {
    tools: [policyLookup, fileClaim],
});

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // ...
}
```

`loadProject` reads **every** file the project will ever need, up front. A
missing prompt, an unknown tool name, a hand-off to nobody, a `preload:` naming
a skill that is not in the catalog — all of these fail at load with the
offending key named (`agents.adjuster.handoffs: unknown agent "resolvr"`),
rather than surfacing three turns into a production run as a confused model.

### `ProjectOptions`

Config can _name_ things; it cannot _contain_ code. These options are the seam
where code re-enters the declarative system.

| Option      | Purpose                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `tools`     | Tool implementations by name. Resolves both `agents[].tools` and a skill's `tools:` header |
| `providers` | Provider specs, merged **over** `providers:` — how ops repoints a key without a commit     |
| `models`    | Aliases merged **over** `models:` — the host decides what `fast` means this week           |
| `registry`  | An existing `ModelRegistry` to populate instead of a fresh one; share it to share clients  |
| `memory`    | `MemoryStore[]` handed to the runner                                                       |
| `payloads`  | A `PayloadStore` handed to the runner                                                      |
| `skills`    | Extra `SkillProvider`s, appended to the one the project declares                           |

Host options always win. A repository describes intent; a deployment overrides
it, never the other way round.

## The loaded project

`AgentProject` is immutable, and therefore shareable. Load it once per process
and let every chat use the same instance — nothing per-conversation lives on
it. A conversation _is_ its `AgentState`; caller data reaches tools through
`RunOptions.context`. Two chats holding the object cannot observe each other.

There is a quieter payoff: because tool schemas are fixed at load and do not
change as skills activate, every chat on a shared project opens with a
byte-identical `[tool schemas][system prompt]` prefix. That is a provider cache
hit _across_ conversations, not merely within one.

| Member               | What it is                                               |
| -------------------- | -------------------------------------------------------- |
| `root`, `source`     | Resolved project directory, and the config file read     |
| `config`             | The parsed, validated `ProjectConfig`                    |
| `entry`              | Name of the agent a run starts on                        |
| `agents`, `registry` | The assembled agents                                     |
| `models`             | The `ModelRegistry`, with its memoized clients           |
| `skillProviders`     | The catalogs bound agents draw on                        |
| `runner(overrides?)` | The shared `AgentRunner`; pass overrides for a fresh one |
| `run(input, opts?)`  | Starts a run on `entry` with the shared runner           |

## Prompts

Each agent's instructions are assembled in a fixed order:

1. `INSTRUCTIONS.md`, if present — read **once** and shared by every agent, so
   the report says "one document, five prompts" instead of five identical blobs.
   The name is deliberately not `AGENTS.md`: that one is claimed by coding
   assistants, and these rules address _this project's_ agents.
2. The agent's own file: `system:` if given, otherwise
   `agents/prompts/<name>.md` if it exists.

Shared context before the specific job — which also puts the stable half of the
prompt in front, where a cache can reuse it. Both are optional; an agent with
neither simply has no instructions.

## Paths

Every path a project file names goes through one chokepoint. A project is data
someone else may have written, so `system: "../../.ssh/id_rsa"` is a load-time
error, not a prompt containing a private key.

- Paths are resolved against the **project root**, never `process.cwd()`, so a
  project loads identically from any working directory.
- Anything resolving outside the root is rejected.
- `file:///abs/path` is accepted and normalised; `file://host/...` is refused.

## Skills

The `skills:` key takes one directory or several. If it is absent and
`agents/skills` exists, that is used. Several directories become **one**
provider (id `project`), not several — a binding names exactly one catalog, and
"which folder is this skill in?" is not a question an agent author should have
to answer.

Two file layouts are discovered in the same scan:

```
<dir>/refund_policy.md          flat: frontmatter + body
<dir>/refund_policy/SKILL.md    folder: sibling files become `resources`
```

Frontmatter is a deliberately small subset of YAML — `key: value`, plus
`[a, b]` flow lists for `tags` and `tools`:

```markdown
---
name: refund_policy
description: When a refund is owed, and how much.
version: 2
tags: [billing, policy]
tools: [issue_refund]
---

The written policy follows...
```

Every key is optional. `name` defaults to the file or folder name and
`description` to the first non-empty line of the body, so the minimum viable
skill is a markdown file with no frontmatter at all.

`tools:` names are resolved against `ProjectOptions.tools`. Skill-owned tools
are declared to the model from turn one and gated at call time — they are never
appended mid-run, because a growing tools array destroys the provider's prompt
cache.

## Entry point

The agent a conversation starts on is chosen in this order:

1. Top-level `default: <name>`
2. An agent with `default: true`
3. The first agent declared

Prefer the first. Without it, file order is load-bearing.

## Validation

Beyond schema shape, the loader cross-references the config against what was
actually loaded:

- `models.<alias>.provider` names a declared provider or built-in kind. Provider
  _names_ are checkable without credentials, so a typo in an entry no agent uses
  is still caught — unlike the key it would need.
- `agents[].tools` names a tool passed in `ProjectOptions.tools`.
- `agents[].handoffs` names a real, different agent (self-hand-off is an error).
- `agents[].skills.provider` names a loaded provider.
- `agents[].skills.allow` / `.preload` name skills in that catalog.
- A `preload:` entry must also be in `allow:`, when `allow:` is given —
  otherwise the runner would activate it and then hide it from the index.

All of these are thrown, so the load stops at the first. To see every problem
at once, from a folder rather than from a host, run `zen check` — it walks the
same ground without stopping, and also reports what is not an error but is
probably not what was meant.
