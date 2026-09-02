# zenera CLI — Design

Status: draft
Scope: `packages/cli`

## 1. What it is

A shell over `@zenera/neo`. The library owns agents, models and runs; the CLI
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
directory again. It exists so `zen list` and `zen open` do not have to search the
filesystem, and it is allowed to be wrong — an entry whose path has vanished is
reported as stale, not treated as an error.

### 3.2 A project

A project is a directory: one complete agent definition together with the
sessions that ran against it.

```
<project>/
    INSTRUCTIONS.md
    agents.yaml                  what makes the directory a project
    agents/
        prompts/
        skills/
    sessions/
        20260825-143012-a7f3/
            workspace/           what the agent can see and write
            .data/
                state.json       the live, resumable session state
                memory/          MemoryStore (file)
                blobs/           PayloadStore (file)
            .lock                present only while a run holds it
            runs/
                20260825-143012-b104/
                    input.md
                    output.md
                    state.json    immutable snapshot of this run
                    report.html   `renderReportHtml` output
                    meta.json     model, usage, duration, exit
```

`agents.yaml` is the marker, and there is no second one. A directory the loader
can read is a project — by path, from anywhere, on a machine that has never seen
it. Being _named_ is the registry's business, and a name the directory already
has is not worth a file of its own to hold.

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
| `list`    | Every known project: sessions, last run, whether one is live.            |
| `open`    | Opens a project in your editor.                                          |
| `key`     | The credential store (§6).                                               |
| `run`     | Runs the project — the TUI on a terminal, one shot otherwise (§7).       |
| `inspect` | Opens or rebuilds a run's `report.html`.                                 |
| `models`  | Resolves providers and models and validates the config, calling nothing. |
| `sandbox` | Checks and prepares the container command-line tools run in (§9).        |
| `version` | CLI, library and Node versions.                                          |

And, when the package providing it is installed:

| Command | Package         | Does                                         |
| ------- | --------------- | -------------------------------------------- |
| `faker` | `@zenera/faker` | A mock API from an openapi/swagger document. |

Global flags: `-h/--help`, `-v/--version`, `--json`, `-C <dir>`.

Exit codes: `0` ok, `1` the run failed, `2` the invocation was wrong, `3` the
project is invalid, `4` no usable credential, `5` the sandbox is unavailable.

There is no `chat` and no `resume`. Both were `run` with a different starting
point, and a flag says that better than a command does.

### 4.1 Commands from another package

A sibling package — `@zenera/faker`, and whatever follows it — adds a command to
`zen` instead of installing a binary of its own. One thing to install, one
keyring, one name to remember, and the alternative was a family of programs
that share their whole vocabulary and differ only in what they do with it.

It implements `Command`, the same interface as everything in `src/commands/`,
and exports it as `<package>/command`. `zen` finds it through `EXTERNAL` in
[src/commands/index.ts](packages/cli/src/commands/index.ts) — name, package,
summary, usage, install line, and an optional banner.

Two properties are what the design is for, and both are easy to lose:

**Help never loads anything.** `EXTERNAL` is data, held by `zen`, so
`zen --help` lists a command whether or not its package is present and pays
nothing either way. Nothing on the path of `zen list` may import a sibling —
`zen` starts fast because it depends on almost nothing, and one static import of
a mock server would end that. `src/external.ts` builds the specifier rather than
writing it, which is also what keeps the dependency acyclic: the sibling depends
on `@zenera/cli`, never the reverse, so `zen` cannot name it at compile time.
Asking for _one_ command's help does load that package, because that request
already named it.

**A missing package is an answer, not a crash.** `ERR_MODULE_NOT_FOUND` becomes
exit `2` and the line to run, in the same shape the library uses for a missing
vendor SDK.

It is a known list rather than a scan of `node_modules`. These packages are
released in lockstep by one author, so discovery would buy nothing and cost a
manifest format, an API version, and a public contract with strangers. When
there are strangers, that is the moment to build it — not before.

A command that keeps running is not a special case. `run` returns a promise, and
a server's simply does not settle until a signal arrives.

## 5. Projects

### 5.1 `zen init [dir]`

Scaffolds the project — an empty `INSTRUCTIONS.md`, an empty
`SPECIFICATION.md`, a minimal `agents.yaml` naming one `default` agent, and
empty `agents/prompts/` and `agents/skills/` — and adds the path to
`projects.json`.

That agent gets `workspace:*` and `sandbox:*`: an agent that can read and write
files but cannot run the test it just changed is a demo, not a project, and the
shell is a container over the workspace rather than the machine.

Without `--model`, the model is chosen by asking. Stored keys are probed —
one authenticated call each, no tokens — and the first provider that answers
decides the default; an environment variable is taken at its word. `dead` is a
verdict and `unknown` is not, so a flaky network still scaffolds. When nothing
is reachable the project is still written, with the missing key said once, here,
instead of by the first run.

The probes go together rather than in turn. They are independent questions to
different vendors, each worth a round trip and a fifteen-second deadline, so in
sequence a keyring of five spends all five before writing a file. The one
exception is a credential the SDK can only be handed through the environment —
the Vertex service-account file — since two of those in flight would each read
the other's path; those go one at a time, after the rest.

The sandbox image is then built, here rather than on the first run. It has to
happen once either way, and the two moments are not equally good: minutes spent
during a command that is visibly setting a project up read as setup, while the
same minutes in the middle of a question somebody asked read as a hung model.
A machine with no container engine is told so and `init` still succeeds — the
project is fine, its agent just cannot start a shell yet.

Refuses a non-empty directory unless `--force`, because the alternative is
silently merging into someone's source tree. The project name defaults to the
directory's, and `--name` overrides it; a name already in the registry pointing
somewhere else is a usage error, not a silent overwrite.

The files it lists are the project's own. The editor's — `.vscode/settings.json`
and the `.github/` tree — are written too but not printed: they are plumbing for
a tool that may not even be installed, and there are more of them than there are
of the project, so listing them buries what was actually made.

It also writes `.vscode/settings.json`:

```json
{
    "chat.useNestedAgentsMdFiles": false
}
```

The project's house rules live in `INSTRUCTIONS.md`, deliberately not
`AGENTS.md`. Every coding assistant now reads that name out of the root of an
open folder and feeds it to itself as always-on instructions, and `zen open`
opens exactly this directory — so a project that used it would have its rules,
addressed to _its_ agents about _their_ tools and workspace, confused with the
editor's own every single time. A name nobody else claims settles that without a
setting.

`chat.useNestedAgentsMdFiles` is written anyway. It is already false by default,
but it is opt-in globally, and this is a directory the agent itself writes into;
someone who turned it on would otherwise have the editor pick up whatever
`AGENTS.md` a run left behind. It is a _restricted_ setting, so it applies only
in a trusted workspace, which is the right way round — an untrusted folder is not
one to be running agents in either.

It is written over whatever was there. Unlike the rest of the project, this
file is not the user's: it states how the editor is to treat a directory the
agents write into, and a stale copy of that answer is worse than none.

### 5.2 `zen list`

Reads `projects.json`, then stats each project to fill in what the registry does
not store: session count, the newest run, and whether any `sessions/*/.lock`
holds a live pid. A lock whose process is gone is reported as stale and cleaned
on the next run, which is the only reason it records a pid at all.

Stale entries — path missing — are listed dimmed, and `zen list --prune` drops
them.

### 5.3 `zen open [project]`

A project is resolved by name or from the current directory, and the path is
handed to an editor. It exists because opening the project is what everyone does
second, and because choosing the editor has more corners than it looks like.

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

Before the window opens, the editor files from `init` — `.vscode/settings.json`
and the `.github/` tree — are written into the directory being opened. An editor
reads only the folder it was opened on, and a project may predate either of them
or the version of it this `zen` ships, so the moment it is about to be read is
the moment to put the current one there. Every file is named in the narration,
and in `files` under `--json`. Edits to them do not survive.

The distinction that decides how it is spawned is whether the editor takes over
this terminal. `$VISUAL` and `$EDITOR` name one that does by convention, so they
are run with inherited stdio and waited for, and are an error off a TTY.
Everything else is detached and unreferenced, because a window that dies when
`zen` returns is not an editor. `--wait` forces the attached form and passes the
editor's own wait flag — `--wait`, `-w`, or `open -W`.

A named editor that is not on `PATH` is resolved and rejected _before_ anything
is spawned — an ENOENT on a detached child is a failure nobody would ever see.

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
| Project   | `--project <name\|dir>`   | `agents.yaml` at or above the cwd           | Pick from list |
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

A prompt on the command line answers all three questions by itself: `zen run
acme "what changed?"` starts a **fresh** session with the **current directory**
as the workspace, writable, and asks nothing — the point of typing a question
where you are is to have it answered about what is there. The path is still
named on stderr, and `--session`, `--workspace` and `--read-only` override it.
The TUI, where there is someone to ask, still asks.

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

The screen is in two halves and the split is not cosmetic. Everything that is
finished — the banner, each turn, each tool call — goes through `Static`, which
prints once and is never touched again, so it scrolls into real terminal
scrollback. Everything else is the **repainting frame**, and the frame must
never be taller than the terminal: Ink erases the previous one by moving the
cursor back over it, which only works while it is still on screen. A frame that
outgrows the viewport scrolls its own top away, the erase falls short, and every
repaint strands another copy of its first line in the scrollback.

The unit that decides "taller" is the row the terminal draws, not the line the
model wrote — a reasoning stream is one enormous paragraph, so counting `\n`
says six lines while the terminal draws sixty. So the two unbounded things, the
reasoning stream and the answer as it arrives, are wrapped by
[tui/wrap.ts](packages/cli/src/tui/wrap.ts) to a known width, windowed onto
their last N rows, and then given that same N again as an explicit `height`
with `overflow="hidden"` — a miscount clips rather than corrupts. Nothing is
lost: the finished answer lands in `Static` whole, and the full reasoning chain
is in the trajectory.

### 7.4 Light and dark

The terminal already has a colour scheme. The answer is drawn in its own
foreground, asides are drawn dim, and only four things take a colour: the
person's turn, the agent name, a warning, an error. Those four swap between a
dark and a light palette ([tui/theme.ts](packages/cli/src/tui/theme.ts)),
because `cyan` and `gray` are the two ANSI colours a light background reliably
ruins.

Which palette is chosen: `--theme dark|light|auto`, then `ZENERA_THEME`, then
the terminal asked directly (OSC 11, before Ink takes stdin), then `COLORFGBG`,
then dark. The override comes first because detection can be wrong and nobody
should have to argue with a terminal about what colour it is.

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

Three things have to hold or the shim is broken, and all three do:

- `dist/main.js` starts with `#!/usr/bin/env node`. `tsc` preserves the shebang.
  npm sets the exec bit at install time; on Windows it writes `.cmd`/`.ps1`
  shims instead, so the bit does not matter there.
- `dist` is in `files`, so the target exists in the published tarball.
- `engines.node` is `>=24` — the source ships as ESM with top-level `await`.

How it becomes available:

| Situation          | What the user runs                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| Global install     | `npm i -g @zenera/cli` → `zen` on `PATH`                                         |
| Without installing | `npx @zenera/cli …`                                                              |
| Project dependency | `npx zen …`, or `zen` inside an npm script                                       |
| This repo          | `npm install` at the root links `node_modules/.bin/zen` at the workspace symlink |

The package is published as `@zenera/cli`; `npm pack --dry-run -w packages/cli`
shows the exact tarball before it leaves the machine. For working on the CLI
itself, the workspace link below beats reinstalling.

### 8.1 Developing against the workspace

`npm run cli:link` builds and then `npm link -w packages/cli`, which puts a
symlink — not a copy — in the global prefix:

```
<prefix>/lib/node_modules/@zenera/cli  ->  packages/cli
<prefix>/bin/zen                       ->  ../lib/node_modules/@zenera/cli/dist/main.js
```

So `zen` picks up every rebuild with no reinstall, and `@zenera/neo` resolves
through the workspace: Node takes the realpath of the shim's target before
walking up for `node_modules`, so the lookup starts inside the repo and finds
the workspace symlink — the published library is never fetched.

`npm i -g ./packages/cli` is the wrong tool here — it copies the directory out of
the workspace, so `@zenera/neo` comes from the registry and your local edits to
the library are invisible.

`npm run cli:unlink` removes it.

## 9. The sandbox — `zen sandbox`

Command-line tools run in a container, and containers are native on Linux and a
background virtual machine everywhere else. "Is the engine ready" is therefore
four questions, not one — is the binary installed, does the machine exist, is it
running, is the image pulled — and asked late each of them surfaces as a
different opaque failure in the middle of a turn the user is already paying for.

So they are asked first, in that order, by
[podman.ts](packages/cli/src/podman.ts), and everything that can be fixed
without a decision is fixed without asking: the machine is created at the
project's `cpus`/`memory`, started, and the image pulled with progress on
stderr. Installing Podman itself _is_ a decision, so it is the one step that
prompts — Homebrew on macOS, on a terminal, once. Off a terminal, or under
`--json` or `--yes`, it fails with exit code `5` and the exact command to run,
because a CLI that hangs in CI is worse than one that fails in CI.

The pre-flight runs only when it is needed. After the project loads, the CLI
looks at the _resolved_ tool lists — not at the config's selectors, since
`sandbox:*`, `'*'` and a bare tool name all mean the same thing by then — and a
project whose agents cannot reach a shell never asks any of it. The container
itself is lazier still: it is created on the first `run_command`, so a session
that only asks a question leaves nothing behind at all.

`zen sandbox` exposes the same steps on their own, because the slow machine-wide
half of a run is the half most likely to fail and debugging it should not cost a
model call:

| Subcommand | Does                                                        |
| ---------- | ----------------------------------------------------------- |
| `status`   | What is installed, running and pulled. Changes nothing      |
| `up`       | The whole pre-flight: install, machine, socket, image       |
| `pull`     | Just the image: pulled, or built from the Dockerfile        |
| `clean`    | Removes every container this CLI created (`label=zenera=1`) |
| `disk`     | What the engine and every known project occupy              |

Two directories are bind-mounted into every container: the session's workspace
at `/workspace`, and `sessions/<id>/.data/sandbox/home` as `$HOME`. The second
is what makes a session self-contained the way the rest of it already is — a
`pip install --user` is still there when the session is reopened, and travels
with the directory when it is copied. Everything outside the two mounts is
thrown away when the session closes, unless `sandbox.persist` says otherwise.

### 9.1 Building instead of pulling

A project can name a Dockerfile instead of an image, and `zen init` writes one:

```yaml
sandbox:
    build:
        dockerfile: sandbox/Dockerfile
```

Building is a host concern, so none of it is in the library — `@zenera/neo`
gains the schema and nothing else, and a `SandboxSpec` still only ever holds an
image reference. [image.ts](packages/cli/src/image.ts) resolves the block to a
tag before a container is ever named, and the pre-flight builds it where it
would otherwise pull.

The tag has to be **content-addressed** — `localhost/zenera-sandbox:<digest>`,
over the Dockerfile and every file in its context — because the container's
name is a hash of its spec, and a stable tag over changed content would leave a
`persist: true` container running a rootfs the project no longer describes.
Hashing is a synchronous read, so the pool is still built in one shot; only the
`podman build` is deferred to the pre-flight.

It builds only when that tag is not already on disk. Skipping is safe here in a
way it would not be for an ordinary tag — the image existing _means_ the content
is unchanged — so a warm `zen run` costs one `image exists` call. A moved base
image is the gap that leaves, since `podman build` defaults to `--pull=missing`;
`zen sandbox pull` forces the build.

### 9.2 What `zen check` does with it

`zen check` is otherwise a reading of files, and says so. The sandbox is the
exception: a Dockerfile that does not build is a broken project, and nothing
short of building it says so. So the check builds the image and runs one
command in it — against a temporary directory, never the workspace, with no
host environment forwarded and `persist` off, so nothing survives it.

It is skipped when no agent can reach a shell, skipped by `--no-sandbox`, and a
host with no container engine is a **warning** rather than an error: that is the
host most likely to be running the check in the first place. A build that runs
and fails is the one case that fails the check.

### 9.3 Where the disk goes

A container is per _session_, not per project, so a project worked on for a
week has a container per session it ran and `persist: true` keeps every one of
them stopped rather than removed. The count surprises people, so `zen sandbox
status` lists them with an age and says where they came from.

`zen sandbox disk` answers the question that follows. It has to keep two disks
apart, because only one of them is reclaimed by removing a container:

- **In podman** — images and container layers, inside the machine's disk image
  on the platforms that have one. Read from `system df` and `ps --size`, which
  is asked for by name because podman works a size out by diffing the layer.
- **On disk** — the project directory itself: workspaces, blobs, memory, every
  session that was ever opened. Measured in allocated blocks, not bytes, so a
  sparse file costs what it was given.

Containers carry the session id that made them in a `zenera.key` label, and a
session id is a directory name under a project, so attributing one needs no
second index that could fall out of step. A container whose session directory
is gone is reported as unclaimed rather than hidden.

The machine's disk image gets a line of its own because it is the only number
that is really missing from this host's SSD, and it is the one podman is least
willing to state: it is created sparse at its full size, so its apparent size
means nothing, and blocks freed inside the machine are not handed back until
something trims them. `machine inspect` no longer carries the path, so the
documented default location is checked and the line is simply absent when the
file is not there.

## 10. Not here

- **No daemon.** Nothing runs between commands. "Is a run live" is answered by a
  lockfile holding a pid, not by a service that has to be kept alive to answer.
- **No server** beyond `inspect --serve`, which is a static file handler.
- **No project config of its own.** `agents.yaml` is the configuration, and the
  CLI adds nothing beside it.
- **No credential logic in the library.** The keyring ends at `process.env`.
- **No sync, no remote projects, no team sharing.** The registry is one
  machine's index of one machine's directories.
