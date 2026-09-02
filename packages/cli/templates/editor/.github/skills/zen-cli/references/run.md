# Running — `zen run`

```
zen run [project] [prompt] [options]
```

On a terminal with no prompt it opens the TUI. With a prompt, or with no tty, it
answers once on stdout and exits.

## Options

| Flag                    | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `--project <name\|dir>` | Which project. Inferred from the directory otherwise   |
| `--session <id>`        | Continue a particular session                          |
| `--new`                 | Start a fresh one                                      |
| `--workspace <dir>`     | What the agent may read and write                      |
| `--model <ref>`         | Override the default model for this run                |
| `--image <ref>`         | Override the container image commands run in           |
| `--read-only`           | Withhold every tool that can write                     |
| `--quiet`               | The answer only; no narration                          |
| `--plain`               | One shot, even on a terminal                           |
| `--theme <dark\|light>` | Force the palette. Detected otherwise; `$ZENERA_THEME` |
| `--out <file>`          | Write the answer to a file as well as to stdout        |
| `--yes`                 | Accept the questions it would otherwise ask            |

Flags always beat the file: the repository states intent, the invocation
overrides it.

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
git diff | zen run --quiet "summarise this diff"
```

## What a prompt on the command line implies

A prompt is a request for an answer, not a conversation to pick up, so it
answers the three questions itself: **a fresh session**, **the directory you are
in** as the workspace, and **no confirmation**. Every flag still wins —
`--session`, `--workspace` and `--read-only` override it — and the TUI, where
there is someone to ask, still asks.

There is no `resume`. A session continues itself, because its state is what it
is; `--session <id>` picks which one.

## The TUI

Drawn only when there is a terminal on both stdin and stdout, no prompt,
no `--plain`, no `--quiet` and no `--json`. It streams the answer, shows
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
        memory/
        blobs/
        sandbox/home/   /home/agent inside the container
    .lock               held while a run is in flight
```

The recorded workspace is what makes resuming safe: a session that quietly
changed what "the workspace" meant between turns would be unexplainable, so it
is written once and reused.

None of `sessions/` is source and none of it is committed.

A session is locked while it runs, and a lock whose process is gone is stale by
definition and is taken over.

## Afterwards

Each run writes a `report.html` next to its state; the run prints a
`file://` link to it. See [inspect.md](inspect.md).
