# zenera CLI - Design

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
    projects.json      index of known projects - a cache, never the truth
    keys.json          credential index, mode 0600
    keys/              file-shaped credentials (Google ADC), mode 0700
    faker/             the mock server's container workspace - scratch
    cache/             work already done (§4.2), one file per object
```

`ZENERA_HOME` overrides the root, which is what makes the whole thing testable
and what CI uses to get an empty one.

`projects.json` is derived: every entry can be rebuilt by pointing `zen` at the
directory again. It exists so `zen list` and `zen open` do not have to search the
filesystem, and it is allowed to be wrong - an entry whose path has vanished is
reported as stale, not treated as an error.

### 3.2 A project

A project is a directory: one complete agent definition together with the
sessions that ran against it.

```
<project>/
    agents.yaml                  what makes the directory a project
    agents/
        instructions.md          house rules, prepended to every agent
        <topic>-instructions.md  more of them, as the project grows
        prompts/
        skills/
    .spec-sync/                  what the last sync with the spec applied
        baseline/                the specification as that pass left it
        history/                 one file per pass
    .env                         this project's environment, git-ignored
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
can read is a project - by path, from anywhere, on a machine that has never seen
it. Being _named_ is the registry's business, and a name the directory already
has is not worth a file of its own to hold.

Two `state.json` files, deliberately. The one under `.data/` is mutable - it is
what `zen run` resumes from. The one under `runs/<id>/` is a snapshot taken when
that run finished and is never written again; it is what `report.html` was built
from, and what makes a run reproducible after the session has moved on.

### 3.3 Sessions and runs

A **session** is a context that persists: one workspace, one memory, one blob
store, one accumulating trajectory. A **run** is one `AgentRunner.run()` inside
it - one prompt in, one answer out.

This maps onto the library without inventing anything: the session directory is
just the arguments to `FilePayloadStore` and `FileMemoryStore`, and the session
state is the `AgentState` the runner already serializes.

### 3.4 Identifiers

`YYYYMMDD-HHMMSS-xxxx`, local time, four hex characters of entropy.

Sortable as a string, readable without a decoder, and collision-free when two
runs start in the same second. A bare epoch-like number is neither of the first
two.

## 4. Commands

| Command   | Does                                                                       |
| --------- | -------------------------------------------------------------------------- |
| `init`    | Creates a project here, or in `<dir>`, and registers it.                   |
| `list`    | Every known project: sessions, last run, whether one is live.              |
| `open`    | Opens a project in your editor.                                            |
| `key`     | The credential store (§6).                                                 |
| `models`  | What this machine can use: list, search, test, pick (§6.5).                |
| `run`     | Runs the project - the TUI on a terminal, one shot otherwise (§7).         |
| `meta`    | Runs the meta agent over the project, on the keyring (§7.5).               |
| `inspect` | Opens or rebuilds a run's `report.html`.                                   |
| `memory`  | The memory graph from outside the agents (§10).                            |
| `check`   | Reports on the project in full: files, wiring, credentials, models (§9.2). |
|           | `--fix` rewrites the files a project copies but does not own (§9.3).       |
| `export`  | Writes the project to a shareable zip archive (§11).                       |
| `import`  | Unpacks one, registers it, and runs nothing in it (§11).                   |
| `sandbox` | Checks and prepares the container command-line tools run in (§9).          |
| `cache`   | What work has been kept, and getting rid of it (§4.2).                     |
| `version` | CLI, library and Node versions.                                            |

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

A sibling package - `@zenera/faker`, and whatever follows it - adds a command to
`zen` instead of installing a binary of its own. One thing to install, one
keyring, one name to remember, and the alternative was a family of programs
that share their whole vocabulary and differ only in what they do with it.

It implements `Command`, the same interface as everything in `src/commands/`,
and exports it as `<package>/command`. `zen` finds it through `EXTERNAL` in
[src/commands/index.ts](packages/cli/src/commands/index.ts) - name, package,
summary, usage, install line, and an optional banner.

Two properties are what the design is for, and both are easy to lose:

**Help never loads anything.** `EXTERNAL` is data, held by `zen`, so
`zen --help` lists a command whether or not its package is present and pays
nothing either way. Nothing on the path of `zen list` may import a sibling -
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
there are strangers, that is the moment to build it - not before.

A command that keeps running is not a special case. `run` returns a promise, and
a server's simply does not settle until a signal arrives.

### 4.2 One place for work already done - `zen cache`

Embedding a paragraph, parsing a document, asking a provider what models it
serves, having a model write a mock generator: all expensive, all perfectly
repeatable, and all previously cached by a different hand-rolled file format in
a different directory. There is now one store,
`~/.zenera/neo/cache/<kind>/<ab>/<sha256>.json`, one JSON file per object,
sharded two hex characters deep so no directory grows huge.

The API is four methods - `get`, `put`, `delete`, `commit` - and
`cacheKey(...parts)` to build a key out of everything that produced the value.
Three rules hold it up.

**Nothing throws.** A corrupt file, a full disk, an unreadable directory, a key
that does not match: every one is a miss. A cache that cannot work costs time
and must never cost correctness, so there is no error path for a caller to get
wrong and `--no-cache` is the same code path with a store that remembers
nothing.

**The key carries every input.** Not the text alone but the model, the
dimensions, the version of whatever produced the value. That is why there is no
invalidation step anywhere in the codebase: change an input and you are asking a
different question, which has no answer yet. Vectors from another model are not
evicted, they are never found.

**The key is written into the entry and checked on the way out.** The path is
only a hash of it. Reading it back proves the file is the one that was asked for
rather than trusting sha256 to be injective, and - far more likely to actually
happen - catches a key derivation that changed shape without anyone bumping a
version.

One file per object rather than an append log, which is what three of the four
caches this replaced were. A log needs a reader that tolerates a record a kill
cut in half, a compaction pass, and a rule about what a build is allowed to
forget; a file needs `rename`. Concurrency comes free with it: two builds
writing the same entry write the same bytes, and `writeJson` puts them there
atomically.

**Nothing evicts on its own.** A store that quietly deletes things is only ever
noticed when it has deleted the wrong one, so retention is a decision someone
makes out loud: `zen cache prune --older-than 30d`, `--max-size 2GB`, or
`zen cache clear`. `prune` with no filter is a usage error - deleting everything
is what `clear` is for and it should have to be typed.

Age is when an entry was last _used_. `commit` is what makes that true: entries
read during a run have their mtime refreshed, but only if it is already more
than a day stale, so a warm rebuild is not a write per read.

The store being the _machine's_ rather than the index's is the point of the
whole exercise. The same corpus indexed into two directories is embedded once,
and two projects quoting the same handbook pay for it once between them.

## 5. Projects

### 5.1 `zen init [dir]`

Scaffolds the project - a `SPECIFICATION.md`, a nearly empty
`agents/instructions.md`, a minimal `agents.yaml` naming one `default` agent,
empty `agents/prompts/` and `agents/skills/`, and a `scripts/_setup.sh` with no
steps in it yet - and adds the path to `projects.json`.

`SPECIFICATION.md` is the one file written out in full, and it specifies the
project that was just scaffolded: every line of it is implemented by something
next to it, and everything implemented is in it. It is there to be replaced,
but until it is it is true, which is what makes it a template worth reading
rather than a heading list. `/spec-sync-project` then works from the first edit
onwards, because there is already a specification to diverge from.

`.spec-sync/baseline/` and `.spec-sync/history/` are made empty for it to write
into: a pass records the specification it applied, so the next one diffs against
that record and works the difference rather than re-deriving every decision the
last one already made. Empty is the honest state - git cannot carry an empty
directory, and `zen` never writes into it, so what marks a project as having
completed a pass is `baseline/manifest.txt` rather than the directory. The
mechanism is the `zen-spec-sync` skill's `scripts/snapshot.sh`, in the `.github/`
tree, and not a `zen` command: it is twenty lines of `sh` over `cmp` and
`shasum`, read by the agent that runs it, and nothing in it needs the runtime.

That agent gets `files:*` and `sandbox:*`: an agent that can read and write
files but cannot run the test it just changed is a demo, not a project, and the
shell is a container over the workspace rather than the machine.

Without `--model`, the model is chosen by asking. Stored keys are probed -
one authenticated call each, no tokens - and the first provider that answers
decides the default; an environment variable is taken at its word. `dead` is a
verdict and `unknown` is not, so a flaky network still scaffolds. When nothing
is reachable the project is still written, with the missing key said once, here,
instead of by the first run.

The probes go together rather than in turn. They are independent questions to
different vendors, each worth a round trip and a fifteen-second deadline, so in
sequence a keyring of five spends all five before writing a file. The one
exception is a credential the SDK can only be handed through the environment -
the Vertex service-account file - since two of those in flight would each read
the other's path; those go one at a time, after the rest.

The sandbox image is then built, here rather than on the first run. It has to
happen once either way, and the two moments are not equally good: minutes spent
during a command that is visibly setting a project up read as setup, while the
same minutes in the middle of a question somebody asked read as a hung model.
A machine with no container engine is told so and `init` still succeeds - the
project is fine, its agent just cannot start a shell yet.

Refuses a non-empty directory unless `--force`, because the alternative is
silently merging into someone's source tree. The project name defaults to the
directory's, and `--name` overrides it; a name already in the registry pointing
somewhere else is a usage error, not a silent overwrite.

The files it lists are the project's own. The editor's - `.vscode/` and the
`.github/` tree - are written too but not printed: they are plumbing for
a tool that may not even be installed, and there are more of them than there are
of the project, so listing them buries what was actually made.

It also writes `.vscode/settings.json`:

```json
{
    "chat.useNestedAgentsMdFiles": false
}
```

The project's house rules live in `agents/instructions.md`, deliberately not
`AGENTS.md`. Every coding assistant now reads that name out of the root of an
open folder and feeds it to itself as always-on instructions, and `zen open`
opens exactly this directory - so a project that used it would have its rules,
addressed to _its_ agents about _their_ tools and workspace, confused with the
editor's own every single time. A name nobody else claims settles that without a
setting.

They sit beside the prompts and the skills, under `agents/`, because the root of
a project is where its _subject_ lives - the specification, the sources, the
sessions - and because there is rarely only one of them. Anything named
`agents/<topic>-instructions.md` is read too, in filename order, and prepended to
every agent. That is what gives a capability its own document: the memory usage
rules are true for every agent, but they are about memory, so they arrive with
the `memory:` block and leave with it rather than becoming a section of a file
that only ever grows.

`chat.useNestedAgentsMdFiles` is written anyway. It is already false by default,
but it is opt-in globally, and this is a directory the agent itself writes into;
someone who turned it on would otherwise have the editor pick up whatever
`AGENTS.md` a run left behind. It is a _restricted_ setting, so it applies only
in a trusted workspace, which is the right way round - an untrusted folder is not
one to be running agents in either.

It is written over whatever was there. Unlike the rest of the project, this
file is not the user's: it states how the editor is to treat a directory the
agents write into, and a stale copy of that answer is worse than none.

Beside it goes `.vscode/agents.schema.json`, a JSON Schema for `agents.yaml`,
and the `yaml.schemas` setting that binds the two - so the file everything else
in the project is configured from gets completion, hover documentation and an
unknown key underlined as it is typed, rather than at the next `zen check`. The
schema is written by hand rather than derived from the loader's zod schema,
because what makes it worth having is the prose: zod holds none of it - the
descriptions are JSDoc comments - and `agents[].memory` is a `preprocess` whose
`memory: true` shorthand no converter keeps. What a hand-written file cannot do
is notice a key being added to the runtime, so `packages/cli/test/schema.test.ts`
compares the two key for key and enum for enum. A `.vscode/extensions.json`
recommends `redhat.vscode-yaml`, without which the setting is inert; nothing
breaks when it is not installed, and the editor is the only thing that ever
reads any of this. `zen check` remains the authority on whether a project loads.

### 5.2 `zen list`

Reads `projects.json`, then stats each project to fill in what the registry does
not store: session count, the newest run, and whether any `sessions/*/.lock`
holds a live pid. A lock whose process is gone is reported as stale and cleaned
on the next run, which is the only reason it records a pid at all.

Stale entries - path missing - are listed dimmed, and `zen list --prune` drops
them.

### 5.3 `zen open [project]`

A project is resolved by name or from the current directory, and the path is
handed to an editor. It exists because opening the project is what everyone does
second, and because choosing the editor has more corners than it looks like.

The editor is the first of: `--editor`, `$ZENERA_EDITOR`, **the editor whose
integrated terminal this is**, `$VISUAL`, `$EDITOR`, the first of
`code`/`cursor`/`code-insiders`/`windsurf`/`zed`/`subl`/`idea` found on `PATH`,
the first of those found installed in `/Applications`, and finally the platform
opener. `$EDITOR` may carry arguments - `code -n`, `emacsclient -c` - which are
split on whitespace and passed as arguments; **no shell is involved**, so
nothing in the path is ever interpreted.

Two of those steps are the ones that matter, and both exist because `PATH` is a
bad place to look for a GUI editor.

VS Code and its forks export `VSCODE_GIT_ASKPASS_MAIN` into their integrated
terminal, pointing inside the running installation. Four directories up is the
app root, and `product.json` there names the CLI and the product - so the
lookup is exact rather than a guess: it picks Cursor when you are in Cursor, and
it works when the `code` shell command was never installed, which on macOS is
the default. That is checked **before** `$EDITOR`, deliberately: `$EDITOR` names
something to edit _a file_ with and is very often `vim`, set once years ago,
whereas this command opens a directory as a project. `$ZENERA_EDITOR` is the way
to say otherwise.

Failing that, macOS keeps applications where they can be found. A bundle in
`/Applications` or `~/Applications` is opened through LaunchServices with `open
-a`, which needs nothing installed. Only when no editor is found at all does the
directory go to the platform opener - and on macOS that is Finder, which is the
symptom this design is arranged to avoid.

Before the window opens, the editor files from `init` - `.vscode/` and the
`.github/` tree - are written into the directory being opened. An editor
reads only the folder it was opened on, and a project may predate either of them
or the version of it this `zen` ships, so the moment it is about to be read is
the moment to put the current one there. Every file is named in the narration,
and in `files` under `--json`. Edits to them do not survive.

The distinction that decides how it is spawned is whether the editor takes over
this terminal. `$VISUAL` and `$EDITOR` name one that does by convention, so they
are run with inherited stdio and waited for, and are an error off a TTY.
Everything else is detached and unreferenced, because a window that dies when
`zen` returns is not an editor. `--wait` forces the attached form and passes the
editor's own wait flag - `--wait`, `-w`, or `open -W`.

A named editor that is not on `PATH` is resolved and rejected _before_ anything
is spawned - an ENOENT on a detached child is a failure nobody would ever see.

## 6. Credentials - `zen key`

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

A value that names an existing readable file is treated as a file - that is how
Google service-account JSON gets in. The file is _copied_ into `keys/<id>.json`
so the credential survives the original being moved, and the entry records that
it is file-shaped so the CLI knows to export `GOOGLE_APPLICATION_CREDENTIALS`
rather than an API key.

Vertex is the one provider where that sniff decides something: anything that is
_not_ a path is an express-mode key, stored as an ordinary secret under
`VERTEX_API_KEY`. The two are alternatives - express mode addresses no project,
and sending a key and a project together is a `403` - so the shape is recorded
per entry, and `--gcp-project` / `--gcp-location` are accepted only alongside a
file. They carry the prefix because every other command's `--project` names a
Zenera project, and one word cannot mean both.

`add` verifies before it stores, unless `--no-check`. A key that fails
verification is still stored - refusing would be wrong when the network is
down - but it is stored marked `dead` and `zen key ls` says so.

### 6.3 Liveness

The cheapest authenticated call each SDK has: `models.list()` for OpenAI and
Anthropic, `models.list()` on `GoogleGenAI`, and for `vertex` an ADC token
refresh. Each entry caches `{ state, checkedAt, detail }`; `ls` prints the cached
verdict with its age and never calls out on its own, because a list command that
makes three network round trips is a list command nobody runs. `zen key check`
is the one that goes to the network, and it does so concurrently.

The distinction that matters in the output is _dead_ (the provider said no -
your key is wrong) versus _unknown_ (we could not ask - your network is wrong).
Collapsing them into one red mark is the classic way to send someone hunting for
the wrong bug.

There is a third, and it earns its place the same way. _blocked_ is the
credential authenticating and the **account** then refusing: an API switched off
in the project, an empty balance, a model this key was never granted. All of
those arrive as a 403, alongside genuine rejections, and all of them are made
worse by rotating the key. A `blocked` check carries a `fix` - for the
`SERVICE_DISABLED` case the exact `gcloud services enable <api> --project <id>`,
dug out of the console URL the vendor buried it in.

### 6.4 Handling

- `~/.zenera/neo` is `0700`, `keys.json` and everything in `keys/` is `0600`,
  created that way rather than fixed afterwards.
- Looser permissions are refused with an instruction, the way `ssh` does. A
  world-readable key file is not a warning-level event.
- Secrets are masked everywhere - first four and last four characters - and
  `--reveal` is the only path to plaintext, on a TTY only, never through `--json`.
- Nothing is ever written into the project. Credentials live in `$HOME`, so a
  project directory is safe to commit by construction.

### 6.5 Models - `zen models`

`zen check` answers _does my project work_. `zen models` answers _what can I
use_, needs no project, and is the other half of the same question.

| Subcommand                 | Does                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `zen models`               | Providers, their credential source, and what is cached.      |
| `zen models ls [provider]` | Everything a provider serves.                                |
| `zen models search <q>`    | Narrow it: `--tools`, `--vision`, `--free`, `--min-context`. |
| `zen models show <ref>`    | One model, every field the vendor gave.                      |
| `zen models test <ref> …`  | One real minimal call, per ref.                              |
| `zen models pick`          | `--chat` or `--embedding`: the first ref that answers.       |

`zen models <provider>` is short for `ls <provider>`, because it is what people
type. Safe only because no provider is named after a subcommand - a collision
would have to be resolved in favour of the subcommand, and silently.

**Listings come from the vendors.** Four adapters, each given the client
`ModelRegistry` already built, so a missing optional SDK surfaces as the
library's own install line. OpenAI's listing is three fields and the role has to
be read off the id; Anthropic's is all chat, and emitting an embedding row would
be inventing an endpoint that does not exist; Google's needs `queryBase: true`
or it lists _tuned_ models and an account with none looks like an account with
nothing; OpenRouter's is the richest and arrives in two paginated endpoints,
chat and embeddings, walked separately.

Vertex additionally lists the whole Model Garden. Those rows carry no
`supportedActions` and no token limits because they are deployment recipes, not
model ids, and asking one a question fails in a way no error message explains.
They are dropped.

**The cache is the shared store's `catalog` kind (§4.2), one day old at most,**
`0644` because it is public data and someone will want to look at it. The order
when it is cold is: fresh cache, the provider, a _stale_ cache, then a short
built-in table. Stale-before-built-in is the part worth defending - yesterday's
real answer from this account beats today's guess about accounts in general, and
a listing that failed because the wifi dropped must not silently shrink the list
to four rows. Every row carries its own `source`, so a guess is never mistaken
for the vendor's word.

The day is applied by `loadCatalog` rather than by the store, which has no notion
of expiry - it hands back the entry and the time it was written, and freshness is
the caller's question. It has to be: `stale` is a distinct answer here, and a
store that had already discarded the entry could not give it.

**`pick` is the recovery path**, and the reason the command exists. It walks a
short ordered candidate list, cheapest and fastest first, probing one at a time
and stopping at the first that answers. Sequential on purpose: the goal is _one_
working ref, and firing eight billable calls to find it is the wrong trade -
particularly for the caller most likely to be running it, which is an agent that
has just been refused. The ref goes to stdout alone and unstyled, so
`$(zen models pick --embedding)` is the ref and nothing else.

The loop this closes:

```
zen check                            → embedding "index" blocked: … zen models pick --embedding
zen models pick --embedding          → openai:text-embedding-3-small
```

There is no `test --all`. A matrix sweep across every model on the machine is a
bill, not a diagnostic.

## 7. Running - `zen run`

### 7.1 Resolution

Three questions, each answered from flags, then from context, then by asking -
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
path - and `--yes` is required to skip that in a script. An agent with file tools
pointed at `$HOME` is a mistake that should take more than one keystroke.

Once chosen, the workspace is recorded in the session, so resuming never
re-asks and never silently moves.

`--memory <dir>` is the fourth path a run can be pointed at, and the only one
that is not asked about: it defaults to the project's own `memory/` and is
nobody's business otherwise. It has to reach two places that would otherwise
disagree - the mount table, which decides what `/memory` is in the container,
and the loader, which decides where the graph is opened - so both take it from
`memoryDir(root, config, override)` and there is one answer. Naming a directory
declares memory for a project that has none; it cannot bind an agent to it, so a
run whose agents all lack `memory: true` is warned rather than left looking
broken.

A prompt on the command line answers all three questions by itself: `zen run
acme "what changed?"` starts a **fresh** session with the **current directory**
as the workspace, writable, and asks nothing - the point of typing a question
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

Every run, either way, writes `runs/<id>/` in full - input, output, state,
report, meta. The TUI is a view, not a mode: nothing is recorded only when you
are watching.

### 7.3 What the TUI shows

The drawing mode is the only thing in the CLI that repaints rather than prints.
It renders the event stream live - thinking, tool calls, handoffs, usage - which
`console.log` cannot do.

**Ink** (React for the terminal) is the intended renderer, behind a dynamic
import in this command alone: it is the one dependency the CLI takes, and no
other command pays for its startup. Everything it draws comes from `RunStream`
events and the `Architecture` projection - the TUI holds no state the trajectory
does not already have, which is what keeps it a view and makes `report.html`
and the TUI two renderings of one thing.

The screen is in two halves and the split is not cosmetic. Everything that is
finished - the banner, each turn, each tool call - goes through `Static`, which
prints once and is never touched again, so it scrolls into real terminal
scrollback. Everything else is the **repainting frame**, and the frame must
never be taller than the terminal: Ink erases the previous one by moving the
cursor back over it, which only works while it is still on screen. A frame that
outgrows the viewport scrolls its own top away, the erase falls short, and every
repaint strands another copy of its first line in the scrollback.

The unit that decides "taller" is the row the terminal draws, not the line the
model wrote - a reasoning stream is one enormous paragraph, so counting `\n`
says six lines while the terminal draws sixty. So the two unbounded things, the
reasoning stream and the answer as it arrives, are wrapped by
[tui/wrap.ts](packages/cli/src/tui/wrap.ts) to a known width, windowed onto
their last N rows, and then given that same N again as an explicit `height`
with `overflow="hidden"` - a miscount clips rather than corrupts. Nothing is
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

### 7.5 The meta agent - `zen meta`

`zen run` runs the agents a project describes. `zen meta` runs an agent _over_
the project: a coding agent rooted at the project directory, spending the same
keyring. It is the agent you point at the repository to change it, not the one
the repository ships.

Which coding agent is an implementation detail, and the CLI surface is written
so it can be replaced: today it drives GitHub Copilot CLI, and nothing above
[meta.ts](packages/cli/src/meta.ts) names it.

```
zen meta run [project] "<question>"      ask it something
zen meta run [project] /<name> [words]   run .github/prompts/<name>.prompt.md
zen meta run [project]                   pick one of those prompts
zen meta prompts [project]               list those prompts
zen meta model [ref]                     show or set the model it uses
```

Every prompt goes through `run`. The earlier grammar asked for the verb only in
front of a stored prompt, which made the first bare word after `zen meta` mean
different things on different days: `zen meta acme run` read as the question
"run", asked of project `acme`, and spent a model call saying so. A verb that is
always there cannot be mistaken for the thing it introduces. The project may sit
on either side of it - `zen meta acme run` and `zen meta run acme` are the same
command - because that is the one reordering people actually type.

Three things make it more than `copilot -C`.

**It always brings its own key.** Copilot activates BYOK when
`COPILOT_PROVIDER_BASE_URL` is set, and nothing else turns it on - so every
provider gets one, OpenAI included, or the run quietly falls back to a GitHub
subscription that the keyring was supposed to replace. The zen provider becomes
copilot's `openai` or `anthropic` type, since those and `azure` are the only
three it has: Vertex, Gemini and OpenRouter all ride the OpenAI wire.

Vertex is the case worth the code. Its endpoint is built from the project and
region already on the key entry, it speaks publisher names on the wire
(`google/gemini-3.8-flash`) while keeping the bare id as the catalogue key, and
its credential is an access token that lives an hour - which a session does
not. So copilot is handed `COPILOT_PROVIDER_API_KEY_COMMAND=zen key token
vertex` and mints a fresh one per request rather than being given one that goes
stale mid-run.

Nothing secret reaches a command line. Every credential arrives in the child's
environment, and `--secret-env-vars` names them so copilot redacts them from
its own transcript too.

**It knows what `.github/prompts/` is.** Copilot reads `AGENTS.md`,
`.github/skills/` and `.github/agents/`, but not the `*.prompt.md` files an
editor offers as slash commands. `zen meta run /project-review` reads one,
drops the frontmatter, and sends the body - which is how the same prompt runs
from the editor and from a script. Nothing on a terminal drops a menu down as
you type a slash, so `zen meta prompts` lists them and a bare `zen meta run`
asks.

**It re-renders the transcript.** `--output-format json` is a JSONL stream of
tool calls, reasoning and bookkeeping with the answer somewhere inside it:
`assistant.message` carries both the running commentary and the last word, and
what separates them is whether it asked for a tool. The last message that asked
for none is the answer and goes to stdout; everything else is narration and
goes to stderr. So `zen meta run … > out.md` holds the answer alone, the same
way `zen run` does.

Which model, highest first: `--model`, `ZENERA_META_MODEL` in the shell, the
same in the project's `.env`, `~/.zenera/neo/meta.json` (`zen meta model <ref>`),
then the project's `agents.yaml` `model:`. The first three and the last are
free - `.env` is read for the keyring anyway and only fills gaps, so the shell
beats the file without a line of code. The store exists because the model a
coding agent runs on is a personal choice about a tool, like a key, and
`agents.yaml` is a committed decision about the project's own agents. `zen meta
model` with no argument prints the whole chain with the winner marked, because
the question that gets asked is not _what model_ but _why that one_.

Below all of them is a last resort that is not an error: the best model known
for the first provider holding a key. A first `zen meta` on a machine with one
key should run, and the agent is pointed at the project's own specification, so
the deep tier is what it falls back to rather than the cheap one. The choice is
announced on stderr with the command that overrides it, since a model picked
for you is only acceptable if you can see it happen.

**A stored ref is vetted before it is stored.** `zen meta model <ref>` asks the
model one word and refuses to write one that does not answer, because the whole
value of the store is that the next run works. Ahead of that is the cheaper
check: a prefix that names no provider but is one edit away from one. It cannot
be rejected on shape alone - `vertes/gemini-3.5-flash` is built exactly like the
OpenRouter id `meta-llama/llama-4` - so the near miss is what gives it away, and
catching it matters because an unrecognised prefix is not an error anywhere
else: it becomes the model id, and the id goes to whichever provider the
default names. `--force` writes without asking, for an offline machine or a
model newer than everything that could check it.

One sharp edge: copilot offers its tools as OpenAI _custom_ tools, which the
completions API rejects outright - `400 Invalid value: 'custom'`. Only the
responses API accepts them, so the wire API follows the model rather than being
a flag nobody would know to set.

## 8. Distribution - the `zen` binary

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
with something. All three point at the same file - the CLI never branches on
`argv[0]`, so there is no behaviour to keep in step between them, and nothing to
choose between when reading someone else's script.

Three things have to hold or the shim is broken, and all three do:

- `dist/main.js` starts with `#!/usr/bin/env node`. `tsc` preserves the shebang.
  npm sets the exec bit at install time; on Windows it writes `.cmd`/`.ps1`
  shims instead, so the bit does not matter there.
- `dist` is in `files`, so the target exists in the published tarball.
- `engines.node` is `>=24` - the source ships as ESM with top-level `await`.

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
symlink - not a copy - in the global prefix:

```
<prefix>/lib/node_modules/@zenera/cli  ->  packages/cli
<prefix>/bin/zen                       ->  ../lib/node_modules/@zenera/cli/dist/main.js
```

So `zen` picks up every rebuild with no reinstall, and `@zenera/neo` resolves
through the workspace: Node takes the realpath of the shim's target before
walking up for `node_modules`, so the lookup starts inside the repo and finds
the workspace symlink - the published library is never fetched.

`npm i -g ./packages/cli` is the wrong tool here - it copies the directory out of
the workspace, so `@zenera/neo` comes from the registry and your local edits to
the library are invisible.

`npm run cli:unlink` removes it.

## 9. The sandbox - `zen sandbox`

Command-line tools run in a container, and containers are native on Linux and a
background virtual machine everywhere else. "Is the engine ready" is therefore
four questions, not one - is the binary installed, does the machine exist, is it
running, is the image pulled - and asked late each of them surfaces as a
different opaque failure in the middle of a turn the user is already paying for.

So they are asked first, in that order, by
[podman.ts](packages/cli/src/podman.ts), and everything that can be fixed
without a decision is fixed without asking: the machine is created at the
project's `cpus`/`memory`, started, and the image pulled with progress on
stderr. Installing Podman itself _is_ a decision, so it is the one step that
prompts - Homebrew on macOS, on a terminal, once. Off a terminal, or under
`--json` or `--yes`, it fails with exit code `5` and the exact command to run,
because a CLI that hangs in CI is worse than one that fails in CI.

The pre-flight runs only when it is needed. After the project loads, the CLI
looks at the _resolved_ tool lists - not at the config's selectors, since
`sandbox:*`, `'*'` and a bare tool name all mean the same thing by then - and a
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
is what makes a session self-contained the way the rest of it already is - a
`pip install --user` is still there when the session is reopened, and travels
with the directory when it is copied. Everything outside the two mounts is
thrown away when the session closes, unless `sandbox.persist` says otherwise.

The container's environment comes from three places. `sandbox.env` names host
variables to pass through, by name only and never anything credential-shaped.
The keyring's selected credentials are forwarded for the model, a service
account file being bind-mounted read-only under `/run/zenera/keys` instead. And
the project's own `.env` - written by `zen init`, ignored by git - is read
before the project loads and forwarded whole. All of it goes to podman as
`--env NAME` without a value, so nothing appears in an argv, in `ps` or in
`podman inspect`, and the container's identity is a function of the names
rather than of the secrets: rotating a key does not abandon a persisted rootfs.
`keys: false`, or `zen run --no-keys`, withholds the credentials and the `.env`
together - a `.env` is where an api token lives, so splitting them would make
the flag a promise it does not keep.

### 9.1 Building instead of pulling

A project can name a Dockerfile instead of an image, and `zen init` writes one:

```yaml
sandbox:
    build:
        dockerfile: sandbox/Dockerfile
```

Building is a host concern, so none of it is in the library - `@zenera/neo`
gains the schema and nothing else, and a `SandboxSpec` still only ever holds an
image reference. [image.ts](packages/cli/src/image.ts) resolves the block to a
tag before a container is ever named, and the pre-flight builds it where it
would otherwise pull.

The tag has to be **content-addressed** - `localhost/zenera-sandbox:<digest>`,
over the Dockerfile and every file in its context - because the container's
name is a hash of its spec, and a stable tag over changed content would leave a
`persist: true` container running a rootfs the project no longer describes.
Hashing is a synchronous read, so the pool is still built in one shot; only the
`podman build` is deferred to the pre-flight.

It builds only when that tag is not already on disk. Skipping is safe here in a
way it would not be for an ordinary tag - the image existing _means_ the content
is unchanged - so a warm `zen run` costs one `image exists` call. A moved base
image is the gap that leaves, since `podman build` defaults to `--pull=missing`;
`zen sandbox pull` forces the build.

### 9.2 What `zen check` does with it

`zen check` is otherwise a reading of files, and says so. The sandbox is one of
two exceptions: a Dockerfile that does not build is a broken project, and
nothing short of building it says so. So the check builds the image and runs one
command in it - against a temporary directory, never the workspace, with no
host environment forwarded and `persist` off, so nothing survives it.

It is skipped when no agent can reach a shell, skipped by `--no-sandbox`, and a
host with no container engine is a **warning** rather than an error: that is the
host most likely to be running the check in the first place. A build that runs
and fails is the one case that fails the check.

The other exception is the models. A credential that authenticates says nothing
about the id it is spent on, so the check asks each model that has one to answer
a single word - a few tokens apiece, and the only reading that catches a misspelt,
retired or ungranted model. It runs after everything the files alone can say, so
an interrupted check is still a useful one; a refusal is an **error** because
every run will meet the same answer, and silence is a **warning** because that is
the network's fault and not the project's. `--no-models` skips it.

### 9.3 `--fix`, and what a project does not own

A check is a reader, and `--fix` is the one thing it writes. It is here rather
than behind a verb of its own because the set it may touch is narrow enough to
state in a sentence: the files a project holds a copy of without owning them -
`agents/files-instructions.md`, `agents/fork-instructions.md`,
`agents/memory-instructions.md`, `agents/tools-instructions.md`, and the
`.vscode/` and `.github/` trees. Every one of them documents _this version of
`zen`_ rather than this project, so the current text is the only one worth
having and a copy left behind by an upgrade is worse than none. They are
replaced whether or not they were edited, and the report is taken afterwards, so
its exit code answers the repaired project.

This is the other half of `keep: true` in
[scaffold.ts](packages/cli/src/scaffold.ts). A scaffold never overwrites, which
is right for `agents.yaml`, the prompts, the specification and
`agents/instructions.md` - the project's own house rules, whose template says
"replace this with yours" - and wrong for the four that only restate how the
runtime behaves. Before `--fix` there was no way to upgrade them except by
hand, which is why `agents/memory-instructions.md` was also copied into the
`zen-memory` skill's `references/`: somewhere to `diff` against. That copy is
still written, and is now a second opinion rather than the only route back.

`agents/files-instructions.md`, `agents/fork-instructions.md` and
`agents/memory-instructions.md` are copied into every project, using files,
forking or remembering or not, because `--fix` cannot know what the project
will declare next week. All three carry a `requires:` line, so an inert copy
reaches no prompt and costs nothing; they are the files in the set the check
does not report for going unread.

Being there is not the same as being current, and a stale copy looks like
nothing at all: it parses, it loads, and it describes a runtime that has since
moved with exactly the authority of the text that is true. So the check
compares all four against the ones `--fix` would write and reports
`rules.stale` for any that differ - the whole file, because no reading of one
would have caught what actually goes stale in them. The `requires:` lines are
the case in hand. Every project scaffolded before they existed carries a memory
document with no condition on it, which still reaches every agent and still
loads without complaint; the bytes are the only thing that says so.

`sandbox/Dockerfile` goes stale the same silent way and is handled the other
way round. `zen init` pins `@zenera/cli` and `@zenera/rag` to its own version,
and `keep: true` means no later `init` or `open` rewrites the file - so the pin
is fixed at creation and the host walks away from it at the next upgrade, while
the file parses, the image builds and the only symptom is a tool inside the
container behaving unlike the documentation outside it. The check reads the
`npm install -g` line and reports `sandbox.pin.stale`, or `sandbox.pin.absent`
for a name with no version on it. Both are warnings: the project runs, it just
runs a different `zen` than the one you are holding. Neither is repaired by
`--fix`, because that command replaces only the files that are ours and this
one is the project's - a rewrite would discard whatever else was added to it.
The reading is textual and needs no engine, which is the point: `--no-sandbox`
and a laptop with no podman are exactly the cases nothing else would tell.

### 9.4 Where the disk goes

A container is per _session_, not per project, so a project worked on for a
week has a container per session it ran and `persist: true` keeps every one of
them stopped rather than removed. The count surprises people, so `zen sandbox
status` lists them with an age and says where they came from - the ones _this_
project made, since a container carries the session id that made it and a
session id is a directory name under a project. Outside every project it falls
back to all of them, which is then the only honest answer.

The project comes from `--project` or from the directory the command was run
in, and is never asked for: a list of every project on the machine is not a
question a reading has any business asking, and the engine half of the report
does not depend on the answer.

`zen sandbox disk` answers the question that follows. It has to keep two disks
apart, because only one of them is reclaimed by removing a container:

- **In podman** - images and container layers, inside the machine's disk image
  on the platforms that have one. Read from `system df` and `ps --size`, which
  is asked for by name because podman works a size out by diffing the layer.
- **On disk** - the project directory itself: workspaces, blobs, memory, every
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

## 10. Memory - `zen memory`

A project can give its agents a memory: a graph of what they were asked, what
they planned, what they learned, and the files they kept. It is `@zenera/neo`
that owns it. What the CLI owes it is a way to look.

The question that makes the command necessary is **why did it recall that?**,
and it cannot be answered from inside a run. Recall is masked per agent, ranked
and truncated before an agent ever sees it, so what reached the prompt is a
selection - and when the selection is wrong, the evidence is in the part that
was left out.

So **every subcommand reads the graph unmasked**. That is not a hole in the
model: the mask keeps agents apart, and this command is a person at a terminal
in the project directory, who already owns the files. Withholding a node from
them would protect nothing and hide the bug.

**Nothing here contacts a model.** The store is opened with no embedder, so
inspection is free, offline, and cannot fail on a missing credential - which is
precisely the state a project is in when someone starts debugging it. The price
is that `ls` filters on text rather than on meaning, and that is the right way
round for a tool whose job is to show what is there rather than to find what is
relevant.

For the same reason it does not call `loadProject`. Loading would resolve every
model and read every prompt file in order to inspect a graph that needs none of
them, and would fail on a project whose credentials are missing. It reads the
config and opens the directory, and that is all.

### 10.1 `export` - the whole graph as one page

`zen memory export` writes a single self-contained HTML file, and it is the
subcommand the others exist around. Three panes: the node list with its filters
on the left, the graph in the middle, and the selected node on the right - in
full, including the content of a remembered file, rendered as an image when it
is one.

The middle pane is Mermaid, as the run report is, and shares the pinned CDN URL
with it so the two cannot drift. Above 300 drawn nodes it declines and asks for
a filter instead, because a Mermaid diagram that large is not a picture of
anything. The diagram is fitted to its pane and re-fitted when the pane
resizes, until the first manual zoom or pan - after which the view belongs to
the reader and the page stops moving it.

One file and no server is what makes it mailable: it attaches to a bug. The
only network it does is the Mermaid fetch, and without it the page degrades to
a working list and detail view.

Escaping follows the run report exactly, because the content is no less
hostile - node text and remembered files are model output. Data reaches the
document only inside an inert `application/json` block and leaves it only
through `textContent`.

### 10.2 `merge` - putting a fanned-out warmup back together

The memory lock is per directory, which is what keeps two runs of one project
from interleaving commits. It also means warming a memory in parallel is N runs
writing N memories. `merge` is the other half of that: it folds them into one,
offline, with no model and no re-embedding.

It is the only subcommand here that writes a memory into existence. Everything
else is an inspector, and a target with no `manifest.json` is a mistake worth
naming; a merge target that does not exist yet is the ordinary case, because
the warmed graph is usually assembled somewhere new before it is promoted.
Sources are positional and the target is `--dir`, so the shell expands
`.tmp/warmup-$STAMP/memory-*` and the command shape matches every other
subcommand's.

The work itself is `mergeMemories` in `@zenera/neo`, for the same reason
`forget` delegates: the rules for what two memories mean together belong beside
the graph, not in a renderer. What the CLI owes it is the table, the
confirmation before writing into a memory that already holds something, and
turning a refusal into ids a person can look at.

Refusal is the interesting part of the design. Node ids survive a merge, so
parallel runs seeded from a copy of the same memory produce the same id on
several sides - the common case, not a collision. Same revision and same
content is a shared ancestor and reconciles to nothing more than counters, and
those take the larger of the two rather than the sum so that merging a source
twice is a no-op. Anything else is a real divergence: the whole merge stops
before a byte is written and lists the ids with both revisions, because which
piece of work was right is a question, and answering it silently is how a merge
loses the answer. `--force` answers it with the highest revision.

### 10.3 Forgetting

`forget` asks before it removes, and refuses outright when there is no terminal
to ask at; `--yes` is the only way through a script. It then delegates to the
library's own `MemoryIndex.forget`, so that a node, its vector row and its file
bytes going together has exactly one implementation and cannot drift from what
the agent-facing tool does.

It is deliberately not the usual correction. The agents' way to fix a wrong
memory is to commit the corrected node and supersede the old one, which keeps
the record of having been wrong; `zen memory ls --stale` is how you read that
back. `forget` is for what should never have been stored.

## 11. Moving a project - `zen export` and `zen import`

A project is a directory, so the reason this is not `zip -r` is that half of the
directory is _this machine_ rather than the project. `export` writes the other
half, and `import` reads it back.

```
<name>-<stamp>.zip
├── zenera-export.json          the manifest, at the root and outside the project
└── <name>/                     the project, verbatim
```

What travels is the `.gitignore` rule with one deliberate difference: **the
vectors travel.** A clone rebuilds a rag index from the documents it already
carries, and memory has no such fallback - a graph without `vectors.f32` recalls
by term overlap until every node is written again. An archive is not a clone
with a setup step waiting for it; it is the whole thing, or it is not worth
sending. `--no-vectors` makes the small archive for someone who will run
`zen rag <subject> restore`, and says so on both ends.

What is left behind: `sessions/`, `.tmp/`, `.git/`, `node_modules/`, lock files,
`.DS_Store`, any `*.zip` sitting at the top of the project - the default
destination puts one there, and a second export must not pack the first - and
`.env`. Symbolic links are counted and never followed. The `.env` is the one
that needs saying twice: the values never travel, behind no flag, and the names
do - as a synthesized `.env.example` with every value blank and every comment
kept, because "which credentials does this need" is the first question on the
other end and the answer is not a secret.

The archive is a zip because every machine already opens one, and because a
person handed an archive should be able to look inside without this tool.
Reading and writing are streaming throughout (`yazl`, `yauzl`): an assets tree
with vectors runs to hundreds of megabytes, and a reader that has to hold the
archive in memory to open it is a reader that fails on the archives worth
sending.

`export` refuses only one thing - memory held by a live run, because a graph
copied mid-write is an archive that opens and is wrong, which is worse than one
that does not open. A project that fails `zen check` is exported with a warning:
sending someone a broken project to ask for help is the point.

### 11.1 Import is the suspicious half

An archive is a file somebody sent, and every path, size and mode in it is a
claim. The guards live in `src/archive.ts`, next to the code that writes them,
because a guard kept apart from the thing it guards is a guard that drifts:

- **Every entry path is resolved and checked** - no absolute path, no `..`
  segment, no backslash, no drive letter, and nothing outside the single
  directory the manifest names. `safePath` is exported so it can be tested
  directly.
- **An entry claiming to be a symbolic link is refused.** That is the classic
  way an unpacker is talked into writing outside the tree it checked.
- **Entry count and unpacked size are bounded**, against an archive that
  decompresses to more than the disk holds.
- **Modes are replaced, not honoured** - `0644`, and `0755` for `*.sh` only.
- **The manifest is parsed field by field**, and the project name is checked
  before it becomes a directory or a registry key.

And the rule the command is built on: **nothing in the archive is executed.** It
carries `scripts/`, a Dockerfile and a `.github/` tree, every one of which a
machine could be talked into running on arrival. `import` writes files,
registers a name, and prints the commands you would type next - which you can
read first, because they are on your screen and not in somebody else's zip.

## 12. Not here

- **No daemon.** Nothing runs between commands. "Is a run live" is answered by a
  lockfile holding a pid, not by a service that has to be kept alive to answer.
- **No server** beyond `inspect --serve`, which is a static file handler.
- **No project config of its own.** `agents.yaml` is the configuration, and the
  CLI adds nothing beside it.
- **No credential logic in the library.** The keyring ends at `process.env`.
- **No sync, no remote projects, no team sharing.** The registry is one
  machine's index of one machine's directories, and `zen export` is a file you
  send - not an upload, not a registry, not an account.
- **No encryption or signing** on an archive beyond the zip's own CRC. Send it
  over something you already trust.
