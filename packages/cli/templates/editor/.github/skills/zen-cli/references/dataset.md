# `zen meta dataset` - the cases a project is evaluated on

The project's dataset lives in `dataset/` and only this command writes it. The
rules for reading cases out of a source, anchors, drift and sampling are in the
**zen-dataset** skill; this page is the command surface.

```sh
zen meta dataset [status]                    # revision, counts, drift summary
zen meta dataset ls [filters]                # one row per case
zen meta dataset show <id>[@rev]...          # whole cases, now or at a revision
zen meta dataset log [id...]                 # changes and notes, with their sessions
zen meta dataset drift [--all]               # cases whose source section moved
zen meta dataset apply <file> --why "…"      # write a proposal; --partial, --dry-run
zen meta dataset update <id> --why "…"       # --set k=v, --rubric-add/-edit/-drop, --tag-add/-drop, --override
zen meta dataset retire|restore <id>... --why "…"
zen meta dataset reanchor <id> --why "…"     # --file, --heading "A > B", --pointer /x/0
zen meta dataset ignore <file> --why "…"     # --heading or --pointer; --drop to undo
zen meta dataset note <id>... -m "…"         # --kind, --run, --verdict, --rubric r1=pass,...
zen meta dataset sample [filters]            # -n, --seed, --by, --weight, --order, --format, -o
zen meta dataset export [id...] [filters]    # --format cases|batch, -o
```

- The project is the one you are in, `--project <name|dir>`, or
  `zen meta <project> dataset …`.
- Every verb takes the global `--json`. `sample --format json` is the record
  that reproduces a draw.
- Writes take `dataset/.lock` and need `--why`. Reads and notes take no lock.
- `sample --format batch -o <file>` is `zen run batch` input, never with a
  rubric. Media paths are written relative to `-o`.
- Exit codes: 2 for a wrong invocation (an unknown verb, flag or class),
  3 for a proposal or anchor that cannot be applied - and then nothing is written.
- Changes and notes are stamped with the `zen meta` session and prompt that ran
  them (`ZENERA_META_SESSION`, `ZENERA_META_PROMPT`); `log` prints how to
  resume each session this machine still holds.
