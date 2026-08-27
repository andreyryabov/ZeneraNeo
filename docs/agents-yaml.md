# `agents.yaml` reference

The one file a project must have. It says who exists, what they may reach for,
and which model answers for them.

The schema is **strict**: an unknown key is an error, not a value silently
ignored. Failures are reported as `agents.yaml: agents[1].skills.discovery — …`,
naming the path rather than dumping a JSON blob.

See [projects.md](projects.md) for the folder around this file.

## Skeleton

```yaml
version: 1
default: intake

providers: {} # named connections
provider: openai # which provider a bare model id belongs to
models: {} # named model configurations
model: fast # fallback for agents that do not pin their own
skills: agents/skills # one directory, or a list

agents:
    - name: intake
      # ...
```

Only `agents:` is required, and it must hold at least one entry.

## Names

`agents[].name`, and the keys of `providers:` and `models:`, must match:

```
^[a-z0-9]+(?:[-_][a-z0-9]+)*$
```

Lower-case words joined by `-` or `_`: `intake`, `order-triage`, `house_style`.
The restriction exists because these names reach the model as part of
`transfer_to_<name>` and reach the file system as skill directory names, and
they should be unambiguous in both.

## Top-level keys

| Key         | Type                   | Meaning                                                    |
| ----------- | ---------------------- | ---------------------------------------------------------- |
| `version`   | `1`                    | Schema version. Defaults to `1`                            |
| `default`   | name                   | Entry agent. Wins over any `default: true`                 |
| `providers` | map of name → provider | Named connections                                          |
| `provider`  | name                   | The provider a bare model id belongs to (otherwise openai) |
| `models`    | map of name → model    | Named model configurations                                 |
| `model`     | model ref              | Fallback for agents that do not pin their own              |
| `skills`    | string or string[]     | Skill directories, merged into one catalog                 |
| `sandbox`   | sandbox                | The container `run_command` and friends execute in         |
| `agents`    | agent[]                | At least one                                               |

---

## `providers:`

A provider is a **connection**, not a model: where requests go, and what
credentials sign them. Splitting it out is what lets one project hold two keys
for the same vendor — the key is declared once, under a name, and models point
at the name. One client is built per name and shared, so five agents on one key
open one connection pool.

```yaml
providers:
    openai-eu:
        baseURL: https://eu.api.openai.com/v1
        apiKey: ${OPENAI_API_KEY_EU}
    gemini:
        kind: google
        apiKey: ${GEMINI_API_KEY}
    vertex-eu:
        kind: vertex
        project: ${GOOGLE_CLOUD_PROJECT}
        location: europe-west4
    claude:
        kind: anthropic
        apiKey: ${ANTHROPIC_API_KEY}
```

### Fields

| Field        | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `kind`       | `openai` \| `google` \| `vertex` \| `anthropic` \| `openai-compatible`. Defaults to `openai` |
| `apiKey`     | Literal key or `${VAR}`. Wins over any env lookup                                            |
| `apiKeyEnv`  | Env var holding the key; defaults to the kind's conventional name                            |
| `baseURL`    | Literal url or `${VAR}`, for gateways and compatible endpoints                               |
| `baseURLEnv` | Env var holding the base url                                                                 |
| `project`    | **vertex only** — GCP project id                                                             |
| `location`   | **vertex only** — a region, or `global`                                                      |
| `headers`    | Sent on every request: gateway routing, attribution, api versions                            |
| `timeoutMs`  | Per-request timeout                                                                          |
| `maxRetries` | Retry count                                                                                  |

### Kinds and their defaults

| Kind                | Protocol / SDK      | Key env             | Base url env         | APIs                |
| ------------------- | ------------------- | ------------------- | -------------------- | ------------------- |
| `openai`            | OpenAI              | `OPENAI_API_KEY`    | `OPENAI_BASE_URL`    | `chat`, `responses` |
| `openai-compatible` | OpenAI              | `OPENAI_API_KEY`    | `OPENAI_BASE_URL`    | `chat`, `responses` |
| `google`            | `@google/genai`     | `GEMINI_API_KEY`    | `GEMINI_BASE_URL`    | one                 |
| `vertex`            | `@google/genai`     | `VERTEX_API_KEY`    | `VERTEX_BASE_URL`    | one                 |
| `anthropic`         | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | one                 |

`kind` selects a _protocol_, which picks the SDK and the adapter. Only the
OpenAI protocol speaks more than one API, so naming `api:` on a Gemini or Claude
model is an error rather than a field to ignore.

Each vendor's own SDK is used rather than its OpenAI-compatible endpoint,
because those endpoints are porting aids and drop exactly what this runtime is
built on: Google's loses thinking budgets, thought signatures and cached-content
accounting; Anthropic's loses cache accounting and extended thinking.
`openai-compatible` is the shim kind — vLLM, OpenRouter, a gateway — where the
OpenAI client is exactly right.

### Built-in names

`openai`, `google`, `vertex`, `anthropic` and `openai-compatible` are usable as
provider _names_ with no declaration at all. A `providers:` entry is only needed
when it says something the default does not — a second key, a region, a base
url. A project can have no `providers:` block and still name `vertex`.

`vertex` is the one kind that needs no key: the GenAI SDK resolves and refreshes
Application Default Credentials itself. It needs a project id, taken from
`project:`, then `GOOGLE_CLOUD_PROJECT`, then the `project_id` inside the
service-account key file named by `GOOGLE_APPLICATION_CREDENTIALS`.

### Environment references

`${VAR}` reads the environment; `${VAR:-fallback}` supplies a default. It
composes inside a longer value — `https://${GATEWAY}/v1` — which a whole-value
token could not, and no literal secret contains `${`, so there is no rule to
remember about which strings are magic.

Expansion is **lazy**: nothing is read until an agent actually reaches for that
provider. A repository may therefore declare a vendor a given deployment has no
key for, and still load.

---

## `models:`

Named model configurations. Each value is either a shorthand string or an
object.

```yaml
models:
    fast: openai/responses:gpt-5.4-mini
    careful:
        provider: openai
        api: responses
        model: gpt-5.4
        reasoningEffort: high
    grounded:
        provider: vertex-eu
        model: gemini-3-pro-preview
        thinkingLevel: high
    deliberate:
        provider: claude
        model: claude-sonnet-4-5
        maxTokens: 16000
```

### Shorthand

```
[provider[/api]:]model
```

`gpt-4o` · `openai:gpt-4o` · `openai/responses:o3` · `vertex:gemini-3.5-flash`

Only the **first** colon separates, so a fine-tuned id keeps its own — it just
has to name its provider: `openai:ft:gpt-4o:acme::a1b2`. The first segment is a
provider _name_, not a vendor. Anything the shorthand cannot express (keys, base
urls, reasoning knobs) needs the object form.

### Object fields

| Field                    | Applies to        | Meaning                                                                         |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| `model`                  | all               | **Required.** The vendor's model id                                             |
| `provider`               | all               | A `providers:` name, or a built-in kind                                         |
| `api`                    | openai            | `chat` or `responses`                                                           |
| `apiKey` / `apiKeyEnv`   | all               | One-off credentials; opts out of the shared client                              |
| `baseURL` / `baseURLEnv` | all               | Same                                                                            |
| `reasoningEffort`        | openai            | Free string — see note below                                                    |
| `reasoningSummary`       | openai            | `auto` \| `concise` \| `detailed`                                               |
| `store`                  | openai            | Whether the provider retains the response                                       |
| `maxTokens`              | anthropic, gemini | Output cap. Anthropic requires one (default 8192) and bills thinking against it |
| `thinkingBudgetTokens`   | anthropic         | Extended thinking budget                                                        |
| `thinkingBudget`         | gemini 2.5        | Token budget: `0` off, `-1` auto                                                |
| `thinkingLevel`          | gemini 3          | `minimal` \| `low` \| `medium` \| `high`                                        |
| `includeThoughts`        | gemini            | Return thought summaries (default `true`)                                       |

Knobs that do not apply to the chosen vendor are ignored rather than rejected —
vendor differences live in the provider, so there is nothing here to
discriminate on.

`reasoningEffort` is a plain string on purpose. The vendor's accepted set
changes faster than this schema would, and the request that carries a bad value
is the authority on rejecting it; an enum here would mean a config the API
accepts failing to load.

### Resolution order

A `model:` value anywhere is resolved as:

1. `ProjectOptions.models[ref]` — the host's alias table
2. `models[ref]` — this file's alias table
3. The shorthand parser

Results are memoized, so two agents naming `fast` share one model over one
client, and a bad ref raises its error once, at the agent that wrote it.

---

## `skills:`

```yaml
skills: agents/skills
# or
skills:
    - agents/skills
    - ../shared/skills
```

Directories are relative to the project root and may not escape it. Several
directories are merged into a single catalog with the provider id `project`.
If the key is absent and `agents/skills` exists, it is used.

---

## `sandbox:`

Where `run_command` runs. Command-line tools execute in a Linux container with
the session's workspace bind-mounted at `/workspace`; nothing else of the host
is reachable, and the container is the boundary rather than any inspection of
what the model wrote.

```yaml
sandbox:
    image: docker.io/library/python:3.13-slim
    cpus: 4
    memory: 4096
    network: bridge
    timeout: 300
    env: [HTTPS_PROXY, NO_PROXY]
```

| Field     | Type                   | Default                                       | Meaning                                             |
| --------- | ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| `image`   | string                 | `docker.io/library/python:3.14-slim-bookworm` | The base image commands run in                      |
| `cpus`    | number                 | the host's                                    | Fractional cores, as podman's `--cpus`              |
| `memory`  | integer, MiB           | the host's                                    | As podman's `--memory`                              |
| `network` | `bridge`/`none`/`host` | `bridge`                                      | `none` for a project that must not reach out        |
| `workdir` | absolute path          | `/workspace`                                  | Where the workspace is mounted, and the default cwd |
| `timeout` | integer, seconds       | `120`                                         | Per command, unless a call asks for less            |
| `user`    | string                 | the image's                                   | uid, name, or `uid:gid`                             |
| `persist` | boolean                | `false`                                       | Keep the container between sessions                 |
| `env`     | string[]               | none                                          | Host variables to forward, **by name**              |

`cpus` and `memory` do two jobs on macOS and Windows: they cap the container,
and they size the Podman virtual machine if the CLI has to create one. On
Linux there is no machine and they only cap the container.

### What survives, and what does not

The container is removed when the session closes, so anything installed into
its root filesystem is gone. Two directories are bind mounts and do survive:

| Inside        | On the host                                              |
| ------------- | -------------------------------------------------------- |
| `/workspace`  | the session's workspace                                  |
| `/home/agent` | `<session>/.data/sandbox/home`, and `$HOME` points at it |

`/workspace` is the same directory the file tools work in, and they are told so:
`read_file`, `apply_patch` and the rest accept `/workspace/src/a.ts` as well as
`src/a.ts`, and they answer with the mounted name — one vocabulary on both
sides. A path copied out of a compiler error, a `find` listing or a stack trace
can be handed straight to a file tool, and a path a file tool reported can be
handed straight to `run_command`, without the model having to translate either
way. Changing `workdir` moves both names together.

So `pip install --user`, `npm config`, `~/.cache` and anything else an agent
puts in its home directory are still there when the session is opened again,
and they travel with the session directory when it is copied. A `pip install`
into the system site-packages does not. `persist: true` keeps the whole
container instead — stopped, not running — at the cost of a rootfs that no
longer matches the config that made it.

Changing any field here changes the container's name, so a project that bumps
its image gets a new container rather than an old one quietly persisting with
the wrong contents.

### `env:` names, never values

A value in this file would be a secret in the repository, so only names are
accepted and the host's environment supplies the value. Names that read like a
credential — anything containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or
`CREDENTIAL` — are refused at load. The CLI materialises its keyring into its
own environment before loading a project, so forwarding one would hand every
model key to whatever the agent decided to run.

### `agents[].sandbox`

Agents share one container by default. They already share the workspace, and a
hand-off is meant to be continuous: whatever the first agent installed should
still be there when the second takes over.

An agent that needs a different image says so, and gets its own:

```yaml
sandbox:
    image: docker.io/library/debian:bookworm-slim

agents:
    - name: analyst
      tools: [sandbox:*]
      sandbox:
          image: docker.io/library/python:3.13-slim
    - name: writer
      tools: [sandbox:*] # shares the project's container
```

The fields are the same, merged over the top-level block. Two agents that
resolve to the same configuration still share one container.

---

## `agents:`

```yaml
agents:
    - name: intake
      description: Takes the first message, gets the claim reference, routes the case.
      system: agents/prompts/intake.md
      model: router
      tools: [policy_lookup]
      handoffs: [adjuster]

    - name: adjuster
      description: Applies the written peril policies to a claim and explains the outcome.
      model: balanced
      skills:
          discovery: index
          preload: [house_style]
```

| Field         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `name`        | **Required.** See [Names](#names)                                                                    |
| `description` | What a sibling agent's `transfer_to_<name>` tool tells the model. Write it for the model             |
| `system`      | Path to a markdown file, relative to the root. Defaults to `agents/prompts/<name>.md` if that exists |
| `model`       | A `models:` name or a shorthand. Falls back to the top-level `model:`                                |
| `tools`       | Tool selectors resolved against `ProjectOptions.tools` — code cannot live in yaml                    |
| `handoffs`    | Agent names this one may transfer to                                                                 |
| `skills`      | Skill binding; see below                                                                             |
| `fork`        | `true`, or a binding — opt-in to parallel branches; see below                                        |
| `sandbox`     | Overrides on the top-level `sandbox:`; see below                                                     |
| `default`     | `true` marks the entry point, if no top-level `default:`                                             |

`handoffs` takes bare strings by design, not objects. A hand-off carries no
configuration in this version, so there is nothing for an object form to hold,
and accepting one would mean accepting keys nothing honours.

### `agents[].tools`

An entry is a tool name, or a selector:

| Selector    | Selects                                                     |
| ----------- | ----------------------------------------------------------- |
| `read_file` | that one tool                                               |
| `group:*`   | every tool in a group — `workspace:*` is all the file tools |
| `'*'`       | everything the host passed to `loadProject`                 |
| `-<any>`    | removes what it matches from the selection so far           |

Quote a lone `'*'`: unquoted, YAML reads it as an alias and refuses the file.
`workspace:*` needs no quoting.

Selectors are applied in the order written, so subtraction reads as an
exception to the line above it:

```yaml
tools: [workspace:*, -delete_file, -move_file, policy_lookup]
```

Groups come from the tool, not from config: `workspaceTools()` tags its seven
with `workspace`, `sandboxTools()` tags its four with `sandbox`, and a host's
own tools can carry any `group` they like. The model never sees a group — it
gets the same flat list of names either way.

The same grammar resolves a skill's `tools:` frontmatter against the tools
registered on its provider.

The two groups the CLI registers:

| Group         | Tools                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `workspace:*` | `read_file`, `list_dir`, `find_files`, `write_file`, `apply_patch`, `move_file`, `delete_file` |
| `sandbox:*`   | `run_command`, `run_command_background`, `read_command_output`, `stop_command`                 |

Naming `sandbox:*` is what makes a project need a container engine. See
[`sandbox:`](#sandbox).

### `agents[].skills`

| Field             | Default           | Meaning                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------- |
| `provider`        | the sole provider | Which catalog to draw on                                      |
| `discovery`       | `index`           | `index` \| `search` \| `none`                                 |
| `allow`           | all               | Restricts the catalog this agent sees                         |
| `preload`         | —                 | Activated before the first call of every turn this agent owns |
| `maxIndexEntries` | —                 | Caps the rendered index                                       |

`discovery` controls how the agent finds out what exists:

- **`index`** — names and descriptions are rendered into the system prompt, so
  the model can see the catalog and pull what the case needs.
- **`search`** — no index; only a `skill_search` tool. For catalogs too large to
  render.
- **`none`** — preloads only.

`preload` is for content there is no case for the model to decline: house tone,
a formatting contract. Making it choose would be a wasted round trip. Preloaded
skills are activated before the first model call and filtered _out_ of the
rendered index, so the model never spends a turn re-loading something already
active. Because activation lands at the head of the transcript and never moves,
it sits inside the cached prefix instead of being appended after the first
reply.

### `agents[].fork`

Without the key an agent has no `fork` tool at all: it can only work in its own
conversation. `fork: true` gives it the unrestricted form, and the object form
narrows it.

| Field         | Default              | Meaning                              |
| ------------- | -------------------- | ------------------------------------ |
| `agents`      | every declared agent | Which agents a branch may run        |
| `maxBranches` | unlimited            | Cap on branches per call (minimum 2) |

```yaml
- name: trunk
  fork:
      agents: [lens] # every branch runs the specialist
      maxBranches: 4
```

`agents` may include the forking agent itself — one role fanned out over ten
regions is the common shape, and unlike `handoffs` that is not an error. The
list reaches the model as an `enum` on each branch's `agent` field, so a name
outside it cannot be decoded rather than merely being told off afterwards.

Nesting is capped independently: a branch may fork again, but only while
`forkDepth` is below the run's `maxForkDepth` (2 by default, a `RunOptions`
field), so a fan-out cannot recurse without bound.

---

## Errors caught at load

- Unknown key anywhere (strict schema)
- A name that breaks the name pattern
- `models.<alias>.provider` naming an undeclared provider
- `agents[].tools` naming a tool not passed to `loadProject`, or a group with
  nothing in it
- `agents[].handoffs` naming an unknown agent, or the agent itself
- `agents[].skills.provider` naming an unknown catalog
- `agents[].skills.allow` / `.preload` naming a skill not in the catalog
- A `preload` entry absent from `allow`
- `agents[].fork.agents` naming an unknown agent, or being empty
- `agents[].fork.maxBranches` below 2, which no valid call could satisfy
- `system:` pointing at a missing file, or outside the project root

The loader stops at the first of these. `zen check` does not: it reports every
one it can reach, each with the key it is about and the fix, and adds the checks
that are not load errors — an agent with no prompt at all, a skill with no
description, a folder in the catalog with no `SKILL.md`, a model with no
credential on this machine. Nothing is called; `--json` for the same report
without the rendering.
