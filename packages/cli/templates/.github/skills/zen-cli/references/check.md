# Validating — `zen check` and `zen models`

Both answer without calling a model, so they cost nothing and can be run after
every edit.

## `zen check`

```
zen check [dir] [--project <name|dir>] [--no-sandbox] [--strict] [--quiet]
```

Aliases: `validate`, `doctor`.

Reads the project the way a run does and reports **in full**. Unlike a run it
does not stop at the first problem: the report lists everything it found, each
with a code, a location and the fix for it.

| Flag                    | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `--project <name\|dir>` | Which project                                       |
| `--no-sandbox`          | Skip building and smoke-testing the container image |
| `--strict`              | Warnings count as failure                           |
| `--quiet`               | The findings and nothing else                       |

It takes a bare `[dir]` and needs no `zenera.json`, so an unregistered directory
can be checked too.

### What it checks

- `agents.yaml` parses and satisfies the schema, with unknown keys reported
  rather than ignored.
- Every file the configuration names is on disk and non-empty: `INSTRUCTIONS.md`,
  each agent's prompt, each skill's `SKILL.md`, each asset glob.
- Hand-offs and forks name agents that exist, and no agent hands off to itself.
- Tool selectors resolve against the real tool set, including a skill's own
  `tools:` frontmatter.
- Skills bind to a catalog that holds them, and every declared skill is
  reachable from some agent.
- Every declared model and embedding resolves to a provider, and that provider
  has a credential on this machine.
- The sandbox: paths stay inside the project, the Dockerfile and its context
  exist, and — unless `--no-sandbox` — the image **builds** and one command runs
  in it, against a temporary directory rather than your workspace. That is the
  only thing it starts. No container engine at all is a warning, not an error.

### Findings

Each is `severity` (error, warning, note), a `code`, a `where` and a `message`,
with the fix alongside. Codes are namespaced by what went wrong:

```
root.missing          project.unregistered   config.missing / .invalid / .shadowed
house-rules.missing   agent.duplicate        agent.no-instructions
entry.unknown         entry.ambiguous        prompt.missing / .empty / .outside
tools.unresolved      tools.empty / .none    handoff.self / .unknown
fork.unknown          skills.missing         skill.unloadable / .no-skill-md
skills.no-catalog     skills.unreachable     skill.unused
assets.missing        assets.overbroad       sandbox.dockerfile.missing
sandbox.build         sandbox.smoke          sandbox.start / .unchecked
provider.invalid      model.none             model.unresolvable
credential.*          service.credential
```

The report goes to **stdout** — it is the answer. `--json` gives the same
findings as data.

Exit codes: `0` nothing wrong, `3` at least one error, or with `--strict` at
least one warning. `5` if the container engine itself is missing when something
required it.

### What it cannot catch

Combinations that are only rejected by the provider at the first call. The
known one: **OpenAI reasoning and tools only meet on the responses API.** A
model with `reasoningEffort` and tools on the default chat-completions API is a
valid configuration that fails at runtime with _"Function tools with
reasoning_effort are not supported … in /v1/chat/completions"_. Set
`api: responses` alongside it.

## `zen models`

```
zen models [--project <name|dir>]
```

The narrower question: what each agent would actually talk to. It resolves every
provider, model and embedding the project declares, says which credential each
one needs and whether it is present, and calls nothing.

Reach for `zen models` when a run says a model has no credential and for
`zen check` when something structural is wrong.
