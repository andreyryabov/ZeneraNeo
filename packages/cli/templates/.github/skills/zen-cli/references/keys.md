# Credentials — `zen key`

```
zen key <ls|add|use|check|rm|show|env> [ref] [options]
```

Alias: `keys`.

Keys live in `~/.zenera/neo/keys.json`, mode `0600`, and are materialised into
the environment just before a run. **A real environment variable always wins**,
so a `.env` or an exported key still decides.

A reference is `provider` or `provider/name`. A provider may hold several named
keys; one of them is active.

## Subcommands

| Command                           | What it does                            |
| --------------------------------- | --------------------------------------- |
| `zen key ls [--check]`            | Everything stored, and its state        |
| `zen key add <provider>[/name]`   | Read a key from stdin, or ask for it    |
| `zen key use <provider>/<name>`   | Choose which one a run uses             |
| `zen key check [provider[/name]]` | Ask the provider whether it still works |
| `zen key rm <provider>/<name>`    | Forget one                              |
| `zen key show <ref> [--reveal]`   | Masked by default                       |
| `zen key env [provider …]`        | Shell exports, for other tools          |

```
zen key add openai                    # prompts, echo off
pbpaste | zen key add openai/work     # or from stdin
eval "$(zen key env)"                 # hand them to something else
```

**The secret never comes from argv.** A command line lands in `ps`, in shell
history and in CI logs, so `zen key add` takes the value from piped stdin or an
echo-off prompt and from nowhere else.

## Providers

| Name         | Environment variable             | Holds  | Where a key comes from              |
| ------------ | -------------------------------- | ------ | ----------------------------------- |
| `openai`     | `OPENAI_API_KEY`                 | secret | platform.openai.com/api-keys        |
| `anthropic`  | `ANTHROPIC_API_KEY`              | secret | console.anthropic.com/settings/keys |
| `google`     | `GEMINI_API_KEY`                 | secret | aistudio.google.com/apikey          |
| `vertex`     | `GOOGLE_APPLICATION_CREDENTIALS` | file   | a service-account JSON key from GCP |
| `openrouter` | `OPENROUTER_API_KEY`             | secret | openrouter.ai/settings/keys         |
| `exa`        | `EXA_API_KEY`                    | secret | dashboard.exa.ai/api-keys           |

`exa` is a service the tools call, not a model provider. `vertex` holds a
**file**: the JSON key is absorbed into `~/.zenera/neo/keys/` and the variable
points at it. Vertex also wants a project — `GOOGLE_CLOUD_PROJECT`, unless the
key file names one — and it can use Application Default Credentials with no key
at all.

## Liveness

`zen key check` and `zen key ls --check` do one round trip per key and record
the verdict:

- **live** — authenticated. A rate-limited answer counts as live, because it
  proves the credential.
- **dead** — the provider rejected it. A verdict.
- **unknown** — the provider could not be asked. Says nothing about the key;
  usually the network.

`zen init` uses the same probe to pick which provider to scaffold with, so a
project is not built around a revoked key.

## When a run says there is no credential

The frame does **not** materialise the keyring for you — each command that needs
a credential opens the store itself. If `zen key ls` shows a key as live and a
command still says `provider "openai": no api key — set OPENAI_API_KEY`, the
credential is fine and the command is at fault. Everything that runs a model
(`run`, `check`, `models`, `faker`, `rag`) already does this.

Exit code `4` means no usable credential for what was asked.
