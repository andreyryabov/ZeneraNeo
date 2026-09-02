# Reports — `zen inspect`

```
zen inspect [run] [--session <id>] [--open] [--rebuild] [--serve [port]]
```

Alias: `report`.

Renders the trajectory of a run: every message, tool call, skill activation and
hand-off, in order, with what each one cost. With no arguments it takes the
newest run of the newest session.

| Flag             | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `[run]`          | A run id. The newest otherwise                          |
| `--session <id>` | Which session the run belongs to                        |
| `--open`         | Open the report in a browser                            |
| `--rebuild`      | Rebuild `report.html` from the recorded state           |
| `--serve [port]` | Serve it locally, which the report needs for its assets |

Use `--serve` rather than opening the file directly when the report has media in
it; the page fetches its assets and `file://` will not give them to it.

## Why it is the first thing to look at

It shows what the model was actually given, which is rarely what you assumed. A
prompt that reads correctly and behaves wrongly is nearly always a prompt that
was assembled differently from how it looks in the repository: a skill that did
not activate, a hand-off that fired early, a tool that was withheld, an asset
that was not attached.

The report also draws the architecture — agents, their tools, their hand-offs —
and falls back to reconstructing the wiring from the trajectory when the run
did not record it.

## Where it comes from

```
<project>/sessions/<session-id>/runs/<run-id>/
    input.md      what was asked
    output.md     what came back
    state.json    the whole trajectory
    report.html   the rendering, rebuilt from state.json on demand
    meta.json     when it ran, how long it took
```

Ids are timestamps: `20260825-143012-a7f3`. Listing them is `zen list --sessions`.

Large images are lifted out of the recorded state and stored alongside it, so a
photograph re-sent on every turn does not bloat every message. The report
resolves them back.

## What it prints

The path to `report.html` on stdout — it is the answer, so it pipes. `--json`
gives `{ session, run, report }` instead. A report that is missing is built
before either; `--rebuild` builds one that already exists again, which is always
safe because the report is derived and `state.json` is the truth. That is also
what makes an old run readable by a newer renderer.

To assert on a run in a script, read `state.json` rather than the report.
