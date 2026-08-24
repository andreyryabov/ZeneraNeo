# zenera CLI — Design

Status: draft
Scope: `packages/cli`

## 1. What it is

A shell over `zenera-neo`. The library owns agents, models and runs; the CLI
owns arguments, terminal output and exit codes, and nothing else. Every command
is a thin translation of flags into a library call.

It is a separate package so the library stays free of terminal concerns, and so
the CLI can take dependencies the library refuses to.

## 2. Principles

1. **No logic here.** If a command needs behaviour the library does not expose,
   the fix goes in the library. The CLI never reimplements a projection.
2. **One frame.** Parsing, help, version and exit codes are settled in
   [src/main.ts](packages/cli/src/main.ts). Adding a command is writing one
   function and naming it in `COMMANDS`.
3. **Two output modes.** Human by default, `--json` for everything else. A
   command that cannot answer in JSON says so rather than printing prose.
4. **stdout is the answer, stderr is the narration.** Progress, warnings and
   errors never touch stdout, so `zen run … | jq` always works.
5. **Zero dependencies for the frame.** `parseArgs` and `styleText` are Node's.
   Only the drawing surface (§7.3) may add one, and only behind a dynamic import.
6. **Never prompt when nobody is there.** Every interactive step has a flag, and
   off a TTY the missing flag is an error rather than a hang.

## 3. State on disk

Two roots, and the split between them is the whole storage design: **the machine
owns credentials and an index; a project owns everything about itself.** A
project directory can be copied to another machine, or committed, and lose
nothing but the convenience of being listed.

### 3.1 The home directory

```
~/.zenera/neo/
    projects.json      index of known projects — a cache, never the truth
    keys.json          credential index, mode 0600
    keys/              file-shaped credentials (Google ADC), mode 0700
```

`ZENERA_HOME` overrides the root, which is what makes the whole thing testable
and what CI uses to get an empty one.

`projects.json` is derived: every entry can be rebuilt by pointing `zen` at the
directory again. It exists so `zen list` and `zen go` do not have to search the
filesystem, and it is allowed to be wrong — an entry whose path has vanished is
reported as stale, not treated as an error.

### 3.2 A project

A project is a directory of **versions**. A version is a complete, immutable-ish
agent definition together with the sessions that ran against it, so changing the
prompt never silently reinterprets old runs.

```
<project>/
    zenera.json                  { name, activeVersion } — the project's own truth
    v1/
        AGENTS.md
        agents.yaml
        .agents/
            prompts/
            skills/
        sessions/
            20260825-143012-a7f3/
                workspace/       what the agent can see and write
                .data/
                    state.json   the live, resumable session state
                    memory/      MemoryStore (file)
                    blobs/       PayloadStore (file)
                .lock            present only while a run holds it
                runs/
                    20260825-143012-b104/
                        input.md
                        output.md
                        state.json    immutable snapshot of this run
                        report.html   `renderReportHtml` output
                        meta.json     model, usage, duration, exit
    v2/
        …
```

`zenera.json` at the top rather than only in the registry: the project stays
self-describing, so moving the directory does not lose the active version.

Two `state.json` files, deliberately. The one under `.data/` is mutable — it is
what `zen run` resumes from. The one under `runs/<id>/` is a snapshot taken when
that run finished and is never written again; it is what `report.html` was built
from, and what makes a run reproducible after the session has moved on.

### 3.3 Sessions and runs

A **session** is a context that persists: one workspace, one memory, one blob
store, one accumulating trajectory. A **run** is one `AgentRunner.run()` inside
it — one prompt in, one answer out.

This maps onto the library without inventing anything: the session directory is
just the arguments to `FilePayloadStore` and `FileMemoryStore`, and the session
state is the `AgentState` the runner already serializes.

### 3.4 Identifiers

`YYYYMMDD-HHMMSS-xxxx`, local time, four hex characters of entropy.

Sortable as a string, readable without a decoder, and collision-free when two
runs start in the same second. A bare epoch-like number is neither of the first
two.

## 4. Commands

| Command   | Does                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `init`    | Creates a project here, or in `<dir>`, and registers it.                 |
| `list`    | Every known project: version, sessions, last run, whether one is live.   |
| `go`      | Prints a project's active version directory, for the shell to `cd` to.   |
| `open`    | Opens a project in your editor.                                          |
| `fork`    | Copies the active version to the next one and makes it active.           |
| `key`     | The credential store (§6).                                               |
| `run`     | Runs the project — the TUI on a terminal, one shot otherwise (§7).       |
| `inspect` | Opens or rebuilds a run's `report.html`.                                 |
| `models`  | Resolves providers and models and validates the config, calling nothing. |
| `version` | CLI, library and Node versions.                                          |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`.

Exit codes: `0` ok, `1` the run failed, `2` the invocation was wrong, `3` the
project is invalid, `4` no usable credential.

There is no `chat` and no `resume`. Both were `run` with a different starting
point, and a flag says that better than a command does.

## 5. Projects

### 5.1 `zen init [dir]`

Scaffolds `v1` — an empty `AGENTS.md`, a minimal `agents.yaml` naming one
`default` agent, and empty `.agents/prompts/` and `.agents/skills/` — writes
`zenera.json`, and adds the path to `projects.json`.

Refuses a non-empty directory unless `--force`, because the alternative is
silently merging into someone's source tree. The project name defaults to the
directory's, and `--name` overrides it; a name already in the registry pointing
somewhere else is a usage error, not a silent overwrite.

### 5.2 `zen list`

Reads `projects.json`, then stats each project to fill in what the registry does
not store: session count, the newest run, and whether any `sessions/*/.lock`
holds a live pid. A lock whose process is gone is reported as stale and cleaned
on the next run, which is the only reason it records a pid at all.

Stale entries — path missing — are listed dimmed, and `zen list --prune` drops
them.

### 5.3 `zen go <project>`

**A process cannot change its parent shell's directory.** So `zen go` does the
only honest thing: it prints the resolved path to stdout and exits. `cd "$(zen go
foo)"` works everywhere, immediately, with no setup.

For the ergonomic version, `zen shell-init [zsh|bash|fish]` emits a shell
function that shadows `zen`, intercepts `go`, and `cd`s for you, passing
everything else through:

```sh
eval "$(zen shell-init zsh)"    # in ~/.zshrc
```

This is the standard shape — `zoxide`, `nvm` and `direnv` all do it — and it
keeps the binary free of any assumption about the shell it was called from.

### 5.4 `zen open [project]`

The same resolution as `go`, but the path is handed to an editor rather than to
the shell. It exists because `code "$(zen go)"` is what everyone types second,
and because choosing the editor has more corners than it looks like.

The editor is the first of: `--editor`, `$ZENERA_EDITOR`, **the editor whose
integrated terminal this is**, `$VISUAL`, `$EDITOR`, the first of
`code`/`cursor`/`code-insiders`/`windsurf`/`zed`/`subl`/`idea` found on `PATH`,
the first of those found installed in `/Applications`, and finally the platform
opener. `$EDITOR` may carry arguments — `code -n`, `emacsclient -c` — which are
split on whitespace and passed as arguments; **no shell is involved**, so
nothing in the path is ever interpreted.

Two of those steps are the ones that matter, and both exist because `PATH` is a
bad place to look for a GUI editor.

VS Code and its forks export `VSCODE_GIT_ASKPASS_MAIN` into their integrated
terminal, pointing inside the running installation. Four directories up is the
app root, and `product.json` there names the CLI and the product — so the
lookup is exact rather than a guess: it picks Cursor when you are in Cursor, and
it works when the `code` shell command was never installed, which on macOS is
the default. That is checked **before** `$EDITOR`, deliberately: `$EDITOR` names
something to edit _a file_ with and is very often `vim`, set once years ago,
whereas this command opens a directory as a project. `$ZENERA_EDITOR` is the way
to say otherwise.

Failing that, macOS keeps applications where they can be found. A bundle in
`/Applications` or `~/Applications` is opened through LaunchServices with `open
-a`, which needs nothing installed. Only when no editor is found at all does the
directory go to the platform opener — and on macOS that is Finder, which is the
symptom this design is arranged to avoid.

The distinction that decides how it is spawned is whether the editor takes over
this terminal. `$VISUAL` and `$EDITOR` name one that does by convention, so they
are run with inherited stdio and waited for, and are an error off a TTY.
Everything else is detached and unreferenced, because a window that dies when
`zen` returns is not an editor. `--wait` forces the attached form and passes the
editor's own wait flag — `--wait`, `-w`, or `open -W`.

A named editor that is not on `PATH` is resolved and rejected _before_ anything
is spawned — an ENOENT on a detached child is a failure nobody would ever see.

### 5.5 `zen fork`

`v<n>` → `v<n+1>`: copies `AGENTS.md`, `agents.yaml` and `.agents/`, and copies
**no sessions**, then points `zenera.json` at the new version. Editing prompts
in place stays legal; `fork` is for when you want the old runs to keep meaning
what they meant.

Not called `version` because that name is taken by the CLI's own, and overloading
it would make `zen version` ambiguous in exactly the situation you most want a
straight answer.

## 6. Credentials — `zen key`

### 6.1 The shape of it

The library reads credentials from the environment and from `${VAR}` expansion
in `agents.yaml`, and it will keep doing so. The keyring is **a CLI feature the
library never learns about**: before any command touches `loadProject`, the CLI
materializes the selected credentials into `process.env`. Nothing downstream
changes, `${OPENAI_API_KEY}` in a config keeps working, and a project checked out
on a machine with no `zen` still runs.

A real environment variable always wins over the store, so CI and `docker run
-e` behave as they always did. `--key <name>` overrides both.

Entries are `<provider>/<name>`, so one provider can hold several:

```
openai/default   sk-…3PzJSZ    live    checked 2m ago
openai/work      sk-…9Qm2       dead    401 invalid_api_key
anthropic/default sk-ant-…AlA   live    checked 2m ago
vertex/prod      ~/.keys/vertexai-key.json (copied)   live
```

### 6.2 The commands

```
zen key                              # same as `zen key ls`
zen key ls [--json]
zen key add <provider> [value] [--name <name>] [--use]
zen key use <provider> <name>        # pick the active one for that provider
zen key check [<provider>[/<name>] | --all]
zen key rm  <provider>/<name>
zen key show <provider>/<name> [--reveal]
zen key env [--export]               # eval-able lines, for scripts
```

`add` with no value reads from stdin, and prompts with echo off on a terminal.
**Passing a secret as an argument is supported but never suggested**: argv is
visible in `ps` and lands in shell history. `zen key add openai < key.txt` and the
prompt are the documented paths; the help text says so.

A value that names an existing readable file is treated as a file — that is how
Google service-account JSON gets in. The file is _copied_ into `keys/<id>.json`
so the credential survives the original being moved, and the entry records that
it is file-shaped so the CLI knows to export `GOOGLE_APPLICATION_CREDENTIALS`
rather than an API key.

`add` verifies before it stores, unless `--no-check`. A key that fails
verification is still stored — refusing would be wrong when the network is
down — but it is stored marked `dead` and `zen key ls` says so.

### 6.3 Liveness

The cheapest authenticated call each SDK has: `models.list()` for OpenAI and
Anthropic, `models.list()` on `GoogleGenAI`, and for `vertex` an ADC token
refresh. Each entry caches `{ state, checkedAt, detail }`; `ls` prints the cached
verdict with its age and never calls out on its own, because a list command that
makes three network round trips is a list command nobody runs. `zen key check`
is the one that goes to the network, and it does so concurrently.

The distinction that matters in the output is _dead_ (the provider said no —
your key is wrong) versus _unknown_ (we could not ask — your network is wrong).
Collapsing them into one red mark is the classic way to send someone hunting for
the wrong bug.

### 6.4 Handling

- `~/.zenera/neo` is `0700`, `keys.json` and everything in `keys/` is `0600`,
  created that way rather than fixed afterwards.
- Looser permissions are refused with an instruction, the way `ssh` does. A
  world-readable key file is not a warning-level event.
- Secrets are masked everywhere — first four and last four characters — and
  `--reveal` is the only path to plaintext, on a TTY only, never through `--json`.
- Nothing is ever written into the project. Credentials live in `$HOME`, so a
  project directory is safe to commit by construction.

## 7. Running — `zen run`

### 7.1 Resolution

Three questions, each answered from flags, then from context, then by asking —
and on a non-terminal the asking step is an error instead, so a script never
hangs on a prompt.

| Question  | Flag                      | Inferred from                               | Otherwise      |
| --------- | ------------------------- | ------------------------------------------- | -------------- |
| Project   | `--project <name\|dir>`   | `zenera.json` at or above the cwd           | Pick from list |
| Version   | `--version-dir <vN>`      | `zenera.json`'s `activeVersion`             | —              |
| Session   | `--session <id>`, `--new` | The most recent session, resumed            | Pick or create |
| Workspace | `--workspace <dir>`       | `sessions/<id>/workspace` for a new session | Ask            |

The workspace is what the agent can read and write. For a new session the
default is the session's own empty `workspace/`; `--workspace .` points it at
wherever `zen run` was started, which is the useful case and the dangerous one.
Anything outside the session directory is confirmed once, explicitly, naming the
path — and `--yes` is required to skip that in a script. An agent with file tools
pointed at `$HOME` is a mistake that should take more than one keystroke.

Once chosen, the workspace is recorded in the session, so resuming never
re-asks and never silently moves.

### 7.2 One shot or a TUI

`run` draws when it has nothing to read and something to draw: **a TTY on both
ends and no prompt supplied**. Given a prompt argument, `--file`, or piped stdin,
it runs once and writes the answer to stdout.

It is one command rather than two because it is one operation. The presentation
already keys off the same TTY check that decides colour and progress; making the
user pick the noun as well would be asking them to say what the terminal has
already said.

Every run, either way, writes `runs/<id>/` in full — input, output, state,
report, meta. The TUI is a view, not a mode: nothing is recorded only when you
are watching.

### 7.3 What the TUI shows

The drawing mode is the only thing in the CLI that repaints rather than prints.
It renders the event stream live — thinking, tool calls, handoffs, usage — which
`console.log` cannot do.

**Ink** (React for the terminal) is the intended renderer, behind a dynamic
import in this command alone: it is the one dependency the CLI takes, and no
other command pays for its startup. Everything it draws comes from `RunStream`
events and the `Architecture` projection — the TUI holds no state the trajectory
does not already have, which is what keeps it a view and makes `report.html`
and the TUI two renderings of one thing.

## 8. Distribution — the `zen` binary

The command name is a `bin` entry in [package.json](packages/cli/package.json),
nothing more. npm creates the shim on install: a symlink in `node_modules/.bin`
locally, one in the npm prefix's `bin` directory globally.

```json
"bin": {
    "zen": "./dist/main.js",
    "zn": "./dist/main.js",
    "zenera": "./dist/main.js"
}
```

`zen` is the name, and the only one the help, the errors and this document ever
use. `zn` is an abbreviation for people who type it fifty times a day, and
`zenera` the unambiguous long form for when a two-letter command has collided
with something. All three point at the same file — the CLI never branches on
`argv[0]`, so there is no behaviour to keep in step between them, and nothing to
choose between when reading someone else's script.

`zen shell-init` emits its wrapper for both short names, defining `zn` as a call
to the `zen` function rather than a second copy of it.

Three things have to hold or the shim is broken, and all three do:

- `dist/main.js` starts with `#!/usr/bin/env node`. `tsc` preserves the shebang.
  npm sets the exec bit at install time; on Windows it writes `.cmd`/`.ps1`
  shims instead, so the bit does not matter there.
- `dist` is in `files`, so the target exists in the published tarball.
- `engines.node` is `>=24` — the source ships as ESM with top-level `await`.

How it becomes available:

| Situation          | What the user runs                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| Global install     | `npm i -g zenera-cli` → `zen` on `PATH`                                          |
| Without installing | `npx zenera-cli …`                                                               |
| Project dependency | `npx zen …`, or `zen` inside an npm script                                       |
| This repo          | `npm install` at the root links `node_modules/.bin/zen` at the workspace symlink |

The package is still `private: true`; publishing means dropping that flag. Until
then the only path is the workspace link or `npm link packages/cli`.

### 8.1 Before publishing

`npm run cli:link` builds and then `npm link -w packages/cli`, which puts a
symlink — not a copy — in the global prefix:

```
<prefix>/lib/node_modules/zenera-cli  ->  packages/cli
<prefix>/bin/zen                       ->  ../lib/node_modules/zenera-cli/dist/main.js
```

So `zen` picks up every rebuild with no reinstall, and `zenera-neo` resolves
through the workspace: Node takes the realpath of the shim's target before
walking up for `node_modules`, so the lookup starts inside the repo and finds
the workspace symlink. The unpublished exact-version dependency is never fetched.

`npm i -g ./packages/cli` is the wrong tool here — it copies the directory out of
the workspace and then tries to install `zenera-neo@0.1.0` from the registry,
which does not exist yet.

`npm run cli:unlink` removes it.

## 9. Not here

- **No daemon.** Nothing runs between commands. "Is a run live" is answered by a
  lockfile holding a pid, not by a service that has to be kept alive to answer.
- **No server** beyond `inspect --serve`, which is a static file handler.
- **No project config of its own.** `agents.yaml` is the configuration; the CLI
  adds `zenera.json` and it holds two fields.
- **No credential logic in the library.** The keyring ends at `process.env`.
- **No sync, no remote projects, no team sharing.** The registry is one
  machine's index of one machine's directories.
