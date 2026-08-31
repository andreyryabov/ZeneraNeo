---
name: zen-cli
description: How to drive this project from the terminal with `zen` — running it, validating it, credentials, the sandbox and run reports.
---

# The `zen` command line

Everything here operates on a project directory. The project is resolved from
the working directory, or by name from the registry `zen init` wrote to, or
explicitly with `--project <name|dir>`. Every command takes `--json` and prints
a machine-readable answer instead of a rendered one.

## Running

```
zen run [project] [prompt] [options]
```

On a terminal with no prompt it opens the TUI; with a prompt, or without a tty,
it answers once on stdout. The first word is the project when it names one, and
the first word of the prompt when it does not — `--project` settles it.

| Flag                   | What it does                                                |
| ---------------------- | ------------------------------------------------------------ |
| `--project <name\|dir>` | Which project. Inferred from the directory                  |
| `--session <id>`       | Continue a particular session                                |
| `--new`                | Start a fresh one                                            |
| `--workspace <dir>`    | What the agent may read and write                            |
| `--model <ref>`        | Override the default model for this run                      |
| `--image <ref>`        | Override the container commands run in                       |
| `--read-only`          | Withhold every tool that can write                           |
| `--quiet`              | The answer only; no narration                                |
| `--plain`              | One shot, even on a terminal                                 |
| `--out <file>`         | Write the answer to a file as well as stdout                 |
| `--yes`                | Accept the questions it would otherwise ask                  |

Flags always win over the file: the repository states intent, the invocation
overrides it. There is no `resume` — a session continues itself, because its
state is what it is.

With a prompt on the command line nothing is asked: a fresh session, the current
directory as the workspace, writable.

## Validating

```
zen check [dir] [--strict] [--quiet]     everything agents.yaml names
zen models [--project <name|dir>]         providers, models and embeddings resolved
```

`zen check` reads the project the way `zen run` does and reports in full without
calling a model — a missing prompt file, an unknown tool, a handoff to nobody, a
model alias on an undeclared provider. `zen models` answers the narrower
question of what each agent would actually talk to, and which credential it
needs. Run `zen check` after any edit to `agents.yaml`, a prompt or a skill; it
is the cheapest possible test.

## Credentials

```
zen key ls [--check]              what is on the keyring, and whether it works
zen key add <provider>[/name]     add one — never on the command line
zen key use <provider>/<name>     choose the active key for a provider
zen key check [provider[/name]]   a round trip per key
zen key show <provider>[/name]    masked, or --reveal for the secret itself
zen key rm <provider>/<name>      forget it
zen key env [provider …]          `eval "$(zen key env)"` for other tools
```

The secret never comes from argv — a command line lands in `ps`, in shell
history and in CI logs. `zen key add` takes it from piped stdin or an echo-off
prompt, and nowhere else. Real environment variables win over the keyring, so
`.env` still decides inside a run.

## The sandbox

```
zen sandbox status    is a container runtime there, is the image pulled
zen sandbox up        start it
zen sandbox pull      fetch the image ahead of the first run
zen sandbox clean     throw away persisted containers
```

Shell commands run in a container over the session workspace, not on the host.
If runs begin by installing a toolchain, set `sandbox.image` to one that already
has it, or `sandbox.persist: true`, rather than paying for it every run.

## Reports and sessions

```
zen list [--sessions] [--prune]                       every known project
zen inspect [run] [--session <id>] [--open] [--serve]  a run's report.html
zen open [project] [--editor <cmd>] [--wait]           open it in an editor
zen version                                            CLI, library and Node
```

`zen inspect` renders the trajectory of a run — every message, tool call, skill
activation and handoff, in order, with what each one cost. It is the first place
to look when behaviour is wrong and the prompt looks right: it shows what the
model was actually given, which is rarely what you assumed.

Sessions live under `sessions/` and hold run state, memory, blobs and whatever
the agent wrote. None of it is source and none of it is committed.

## Exit codes

Non-zero on failure, with the offending key or file named in the message. A load
error names the exact path — `agents.yaml: agents[1].skills.discovery — …` — so
read it rather than guessing; the loader is strict on purpose and an unknown key
is an error, not a value quietly ignored.
