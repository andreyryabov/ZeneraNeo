# Running - `zen run`

```
zen run [project] [prompt] [options]
```

On a terminal with no prompt it opens the TUI. With a prompt, or with no tty, it
answers once on stdout and exits.

## Options

| Flag                    | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `--project <name\|dir>` | Which project. Inferred from the directory otherwise |
| `--session <id>`        | Continue a particular session                        |
| `--new`                 | Start a new session rather than continuing one       |
| `--workspace <dir>`     | What the agent may read and write                    |
| `--model <ref>`         | Override the default model for this run              |
| `--image <ref>`         | Override the container image commands run in         |
| `--read-only`           | Withhold every tool that can write                   |
| `--plain`               | Never open the TUI; a prompt is then required        |
| `--theme <dark\|light>` | Palette for the TUI; `auto` detects. `$ZENERA_THEME` |
| `--out <file>`          | Put the answer in this file instead of on stdout     |
| `--yes`                 | Say yes to the workspace and install questions       |

Flags always beat the file: the repository states intent, the invocation
overrides it.

## Where the answer goes

The answer goes to stdout and the progress to stderr, so `zen run "…" >
answer.md` leaves a file with the answer in it and nothing else, watched or not.
`--out` is a destination rather than a copy: it takes the answer off stdout, so
the file is the only place it lands.

```
zen run "what changed?" > out.md              answer in the file, progress on screen
zen run "what changed?" > out.md 2>/dev/null  ... and nothing on screen at all
zen run --out out.md "what changed?"          the same file, stdout left empty
```

There is no `--quiet`. Narration is on stderr already, so a redirect is enough;
`--json` silences it for machine use.

`--json` answers with the paths as well as the answer: the session and run
directories, every file the run left behind, and every tree the agent could see,
with the path it had on this machine beside the path it had inside the
container.

```json
{
    "session": { "id": "...", "dir": "<project>/sessions/<id>" },
    "run": {
        "id": "...",
        "dir": "<project>/sessions/<id>/runs/<run-id>",
        "input": ".../input.md",
        "output": ".../output.md",
        "state": ".../state.json",
        "meta": ".../meta.json",
        "report": ".../report.html"
    },
    "mounts": [
        { "host": "...", "at": "/workspace", "readOnly": false },
        { "host": "...", "at": "/assets", "readOnly": true },
        { "host": "...", "at": "/skills/<name>", "readOnly": true }
    ],
    "agent": "...",
    "stopReason": "final",
    "durationMs": 0,
    "usage": {},
    "output": "the answer"
}
```

`mounts` also lists the container's `$HOME` and, when keys are forwarded, the
credential files mounted under `/run/zenera/keys`.

`--plain` never opens the TUI. The TUI is the only thing that can ask for a
prompt, so with `--plain` the prompt has to be there already - in the argument
or on stdin - and `zen run --plain` with neither is an error instead of a
window. Say it in a script that must not meet one.

## Which word is the project

The first positional is read as a project when it names one, and as the first
word of the prompt when it does not:

```
zen run acme                     the acme project, TUI
zen run acme "what changed?"     the acme project, one answer
zen run "what changed?"          this directory's project, one answer
zen run --project why "why?"     when the project is called "why"
```

The prompt comes from the argument, or from stdin, or from the TUI:

```
git diff | zen run "summarise this diff"
```

## What a prompt on the command line implies

A prompt is a request for an answer, not a conversation to pick up, so it
answers the three questions itself: **a fresh session**, **the directory you are
in** as the workspace, and **no confirmation**. Every flag still wins -
`--session`, `--workspace` and `--read-only` override it - and the TUI, where
there is someone to ask, still asks.

There is no `resume`. A session continues itself, because its state is what it
is; `--session <id>` picks which one.

`--new` only matters when there is no prompt. A prompt on the command line
already starts a new session, so `zen run --new "what changed?"` is the same as
`zen run "what changed?"`. Without a prompt the TUI asks which session to
continue, and `--new` is how you skip that question. It contradicts `--session`.

## The TUI

Drawn only when there is a terminal on both stdin and stdout, no prompt,
no `--plain` and no `--json`. It streams the answer, shows
reasoning as it arrives, and reports per-turn and per-session token usage in the
footer.

Reasoning only _arrives_ if the model was asked for it: OpenAI needs
`reasoningSummary` on the responses API, Anthropic needs `thinkingBudgetTokens`,
Gemini has `includeThoughts` on by default. An OpenAI project shows nothing
until `agents.yaml` asks.

Palette selection: `--theme` > `$ZENERA_THEME` > a query to the terminal >
`COLORFGBG` > dark.

## Sessions

One session is one continuing conversation, with its own workspace, memory and
run history. Ids look like `20260825-143012-a7f3`.

```
<project>/sessions/<id>/
    workspace/          what the agent sees, unless --workspace said otherwise
    runs/<run-id>/      input.md, output.md, state.json, report.html, meta.json
    .data/
        state.json      the live, resumable state, rewritten after every run
        session.json    when it was made, and the workspace it is rooted at
        blobs/
        sandbox/home/   /home/agent inside the container
    .lock               held while a run is in flight
```

Memory is **not** in here: the graph belongs to the project, at
`<project>/memory/`, so what one session learned is there for the next one.

The recorded workspace is what makes resuming safe: a session that quietly
changed what "the workspace" meant between turns would be unexplainable, so it
is written once and reused.

None of `sessions/` is source and none of it is committed.

A session is locked while it runs, and a lock whose process is gone is stale by
definition and is taken over.

## Afterwards

Each run writes a `report.html` next to its state; the run prints a
`file://` link to it. See [inspect.md](inspect.md).
