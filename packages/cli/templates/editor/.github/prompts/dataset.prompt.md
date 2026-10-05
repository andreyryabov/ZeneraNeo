---
description: Build or refresh this project's dataset - every case read from its sources with a class, complexity, tags, a verbatim rubric and an anchor - re-reading only the sections that changed since the last revision. Name a source after the command to add it, `rebuild` to read everything again, or a case and what to fix.
---

Keep `dataset/` in step with its sources. **Load the `zen-dataset` skill before
anything else**, and `zen-cli` for the command reference. The skill holds the
extraction rules and every verb; this prompt is the order of the work. If
loading a skill fails, read `.github/skills/<name>/SKILL.md` with your file tool
before going on.

You never run cases, never edit `agents/`, and never edit a source. Only
`zen meta dataset` writes `dataset/` - never a file tool, never a script.

This prompt is **reentrant**: the state on disk says what to do, so running it
twice in a row does nothing the second time.

## 1. Where things stand

```sh
zen meta dataset status
zen meta dataset drift
zen meta dataset ls --note rubric-suspect
```

Say in three lines: the revision and case count, the sources, and how many
sections are `changed`, `gone` or `uncovered`.

## 2. What to do

The last line of this prompt may hold words. Then read the table top down and
take the first row that fits:

| State                                    | Do                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------- |
| the words name a case and a fix          | that fix only, with `update`, `retire` or `reanchor` - then section 6 |
| the words say `rebuild`                  | read every source in full, as a whole proposal - section 3            |
| the words name a source file             | read that file in full, add it as a `--partial` proposal - section 3  |
| no dataset, and no source named anywhere | **stop**: say which training set to name. The only stop               |
| no dataset                               | read every source `SPECIFICATION.md` points at - section 3            |
| drift reports anything                   | read only the drifted sections - section 3                            |
| drift is clean                           | nothing to do: report the status and stop                             |

Never ask a question mid-run - nobody is there to answer it. What you could not
decide goes into the report and onto the case as a note.

## 3. Read the sections

Read each section yourself and write the cases out by the skill's rules: the
rubric **verbatim**, class from the source's own distinctions, complexity from
the trajectory the query demands, an anchor on every case, and **the id a case
already has** when you re-read its section. Write them to
`.tmp/dataset/proposal.json`.

On a refresh, the proposal holds only the cases of the drifted sections, and is
applied `--partial`. A case whose section changed but which still asks, expects
and is judged the same goes in unchanged - that is how its drift is settled.

## 4. Settle what is gone and what is new

Every `gone` and `uncovered` line from step 1 gets an answer, or the next drift
check reports it again:

- **gone** - the section was deleted: `retire <id> --why "…"`. It was renamed
  or moved: `reanchor <id> --heading "…" --why "…"`.
- **uncovered** - it holds queries: they are new cases in the proposal. It does
  not (an introduction, a glossary): `ignore <file> --heading "…" --why "…"`.

## 5. Apply

```sh
zen meta dataset apply .tmp/dataset/proposal.json [--partial] --dry-run
```

Check the dry run against what you meant before writing anything:

- nothing `retired` you did not intend - a whole proposal retires every case it
  leaves out
- no id changed for a case you only re-read
- every `restarted` case is one whose input, rubric or expected answer really
  changed in the source

Then the same command without `--dry-run`, with `--why` naming what changed in
the source.

## 6. Check

```sh
zen meta dataset drift
zen meta dataset status
```

Drift must be clean. The count per class must match a count you take from the
source by hand. Every media path must exist - apply refuses one that does not,
so a refusal here is a path to fix, not a step to skip.

## 7. Report

- the revision, and what changed: added, updated, retired, restored and
  **restarted** cases, by id
- cases per class and per complexity, and how many have a rubric
- what restarted means for whoever runs the cases next: their earlier results
  are about a different question - `zen meta dataset sample --restarted` lists
  them
- every case with an open `rubric-suspect` note, and what the source would
  need to say
- what you could not decide, each with the case or section it is about; leave
  each one on its case as well:
  `zen meta dataset note <id> --kind observation -m "…"`
