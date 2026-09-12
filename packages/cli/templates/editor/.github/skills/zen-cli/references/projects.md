# Projects - `init`, `list`, `open`, `version`

## `zen init`

```
zen init [dir] [--name <name>] [--model <ref>] [--force]
```

Creates a project here, or in `<dir>`, and records it in the registry so `zen
list` and `zen open` can find it by name.

| Flag            | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `--name <name>` | The registry name. Defaults to the directory's basename |
| `--model <ref>` | The model to scaffold with, taken as written            |
| `--force`       | Write into a directory that already holds a project     |

What it writes:

```
zenera.json                     { version, name }
agents.yaml                     the configuration
agents/instructions.md          house rules, prepended to every agent
agents/memory-instructions.md   more of them, about the memory store
agents/prompts/default.md       the default agent's prompt
agents/skills/                  empty, for skills
assets/README.md
sandbox/Dockerfile              the image the sandbox builds
sessions/                       empty
.env                            this project's environment, git-ignored
.gitignore
.vscode/settings.json           editor files
.github/                        copilot instructions, prompts, this skill
```

More house rules can be added by hand: any `agents/<topic>-instructions.md` is
read too, in filename order, and prepended to every agent. A capability that
needs standing rules - memory, say - gets its own file rather than another
section of `agents/instructions.md`. Memory's are not written from scratch:
`agents/memory-instructions.md` is the same file as
`.github/skills/zen-memory/references/memory-instructions.md`, which init puts
in the project as well, so a copy that was lost or went stale is restored with
`cp` rather than rewritten.

The project's own files are never overwritten - `--force` is what allows
writing into an occupied directory, and the files already there stay. The
editor files are the exception: `.vscode/settings.json` and the `.github/` tree
are ours and are replaced on every `init` and every `zen open`, so edits to them
do not survive.

The default agent gets the file tools and a sandboxed shell, plus `exa:*` when
the keyring holds an Exa key. It also gets memory: the store is scaffolded in
`memory/`, the agent is bound to it with `memory: true`, and it is vectorised by
the chosen provider's embedding model. A provider that publishes none -
Anthropic - gets the store without an `embeddings:` entry, and recall ranks by
term overlap until one is added; an entry naming a provider with no embeddings
API is a project that fails to load, not one that degrades.

**Choosing the model.** Without `--model`, the keyring is asked - not counted.
Stored credentials are probed, because holding a key is not the same as holding
a working one, and the model is picked from a provider that answers. A key from
the environment is taken at its word. Each provider has its own scaffolded
default, and every scaffolded ref names its provider: the model shorthand reads
the first segment as a **provider name**, not a vendor, so a bare
`gemini-3.5-flash` would be asked of OpenAI.

## `zen list`

```
zen list [--sessions] [--prune]
```

Every known project: its sessions, the last run, and whether one is live right
now.

| Flag         | Meaning                                      |
| ------------ | -------------------------------------------- |
| `--sessions` | Expand each project into its sessions        |
| `--prune`    | Forget entries whose directory has gone away |

The registry is an index, not the truth. An entry pointing at a directory that
no longer exists is shown dimmed rather than hidden, because a moved project is
a thing to fix, not a thing to silently lose.

## `zen open`

```
zen open [project] [--editor <cmd>] [--wait]
```

Opens the project directory in an editor. This is the only command that locates
a project for a human rather than for itself.

| Flag             | Meaning                               |
| ---------------- | ------------------------------------- |
| `--editor <cmd>` | The command to launch                 |
| `--wait`         | Do not return until the editor closes |

The editor is chosen in this order: `--editor`, `$ZENERA_EDITOR`, the editor
this terminal belongs to, `$VISUAL` or `$EDITOR`, a known editor on `PATH` or
installed, then the platform opener.

Opening refreshes the editor files (`.vscode/settings.json` and the `.github/`
tree) in the directory being opened. VS Code and its forks are launched with
`--disable-workspace-trust`, so the settings written there apply to the new
window immediately rather than after a prompt.

## `zen version`

```
zen version
```

The CLI version, the library version and the Node version. `zen --version`
prints the CLI version alone and returns before anything else loads.
