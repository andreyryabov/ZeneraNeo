# Specification-driven projects

A Zenera project is a folder of files an agent can read and change: prompts,
skills, `agents.yaml`, a Dockerfile, a few scripts. That makes it a rare thing —
a system whose implementation an agent can actually maintain, provided somebody
says what it is supposed to do.

`SPECIFICATION.md` is where that is said. It is the intent; everything around
it is the implementation. Where the two disagree the specification wins, so a
change to what the system does starts there and not in `agents.yaml`.

`zen init` writes one, and the one it writes is true: it specifies the project
that was just scaffolded, line for line, so you start from a specification and
its implementation rather than from an empty heading list.

## Getting to it

```sh
zen init my-project      # writes SPECIFICATION.md and the project implementing it
zen open my-project      # opens that folder in your editor
```

`zen open` launches the editor you already use — the one this terminal belongs
to, or `$ZENERA_EDITOR`, or the first of VS Code, Cursor, Windsurf, Zed, Sublime
Text or IntelliJ it can find; `--editor <cmd>` names one outright. On the way in
it rewrites `.vscode/settings.json` and the `.github/` tree, so the chat
commands below are always the current ones.

Then, in that window:

1. **Edit `SPECIFICATION.md`.** What the system is for, which agents exist, what
   each may reach for, and what _done_ means.
2. **Open the chat panel and send `/sync-with-spec`.**
3. **Read `SPECIFICATION-FEEDBACK.md`.** Answer its questions by editing
   `SPECIFICATION.md` — never by editing a prompt — and send `/sync-with-spec`
   again.

Back in the terminal: `zen check`, `scripts/_setup.sh`, `zen run`.

`zen init` installs four prompt files under `.github/prompts/`, which VS Code
and its forks offer as chat slash-commands:

| In chat           | Does                                                        |
| ----------------- | ----------------------------------------------------------- |
| `/sync-with-spec` | Makes every file match `SPECIFICATION.md`, both directions. |
| `/review-project` | Reads the project as a reviewer would, and reports.         |
| `/new-agent`      | Adds an agent — prompt, wiring and hand-offs.               |
| `/new-skill`      | Adds a skill under `agents/skills/`.                        |

In an editor with no support for prompt files, paste the contents of
`.github/prompts/sync-with-spec.prompt.md` into its chat instead — it is only a
prompt, and it says everything it needs about where to look.

## The loop

```
edit SPECIFICATION.md
        ↓
/sync-with-spec          make the files match it
        ↓
SPECIFICATION-FEEDBACK.md   what it could not do without guessing
        ↓
zen check                the project still loads
        ↓
scripts/_setup.sh        what has to be built is built
        ↓
zen run                  see whether it does the thing
        ↓
edit SPECIFICATION.md    ← the report goes back into the spec, not into a prompt
```

The turn that matters is the last one. When a run comes out wrong, the fix is
not a sentence bolted onto a prompt — it is the sentence that was missing from
the specification, after which the prompt edit follows from it. Prompts patched
directly drift away from the document that is supposed to describe them, and a
project whose specification is no longer true is a project with no specification.

### `/sync-with-spec`

`zen init` installs `.github/prompts/sync-with-spec.prompt.md`, so the command
is available in your editor's chat from the first minute — type `/` in the chat
panel and it is in the list. It is a long prompt and worth reading once; in
outline it:

1. **Reads everything before editing anything** — the specification, then
   `agents.yaml`, `INSTRUCTIONS.md`, every prompt, every skill, the assets, the
   Dockerfile and the scripts. Then runs `zen check`.
2. **Builds a difference list both ways.** Forwards: for each item in the
   specification, is it present, missing, divergent or unclear. Backwards: for
   each line of each prompt and skill, which specification item does it serve —
   a line serving none is an **extra**, and that is how prompts stop growing
   sediment.
3. **Changes the smallest thing that closes the gap** — a prompt edit over a new
   skill, a new skill over a new agent, a tool grant over asking the model to
   remember. A capability gap is a `tools:` grant _plus_ the prompt line that
   says when to use it, because a granted tool no prompt mentions is not
   implemented.
4. **Never invents a value you did not state.** A model id, a limit, a retry
   count, a path — an unstated value becomes a question, not a guess.
5. **Writes `SPECIFICATION-FEEDBACK.md`** for everything it could not settle,
   grouped under 🛑 blocking, ❓ ambiguous, ⚡ contradictions, ✏️ errors, ➕ out
   of scope. Each entry quotes the specification, says why it could not be
   implemented as written, says what was done in the meantime, and asks one
   question a single line can answer.
6. **Runs `scripts/_setup.sh` and watches it finish**, then runs it again to
   prove every step reports `skipped`.

Read the feedback file first, every time. It is the shortest description of what
your specification does not yet say.

## Writing a specification an agent can implement

The scaffolded file has the headings worth keeping:

| Section                  | The question it answers                                           |
| ------------------------ | ----------------------------------------------------------------- |
| **Purpose**              | What the system produces, in one paragraph                        |
| **Scope**                | What is in, what is out, and what a single request covers         |
| **Agents**               | Who exists, what each is for, and who hands to whom               |
| **Tools and boundaries** | What each may reach for, and what nothing may reach               |
| **Environment**          | Models, container, network, what has to exist before a run        |
| **Done means**           | How a finished job is told from an unfinished one                 |
| **Out of scope**         | What the runtime could do that this project deliberately does not |

Two of those do more work than the rest.

**Done means** is what turns a description into something checkable. "Reports
its findings" cannot be implemented; "the reply names every file it changed, and
every claim about a command is one it ran and read the output of" can be, and
can be reviewed afterwards. Write the acceptance test in prose.

**Out of scope** is what stops a helpful agent from adding memory, a second
agent and a document index because they seemed useful. Naming the thing you are
not doing is cheaper than removing it later.

### Be specific where a reader could decide either way

An ambiguity here becomes a guess three files away, and a value nobody stated
becomes one somebody invented. Say the model. Say the limit. Say what happens
when the answer is not knowable — because if you do not, something will be
written down that sounds right.

| Instead of                  | Write                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| "handles large inputs"      | "a request over 200 files is refused with a count, not truncated"       |
| "uses a fast model"         | "`openai:gpt-5-mini`, with reasoning off"                               |
| "asks the user when unsure" | "asks at most once per run, and only for a value nothing else supplies" |
| "should be reliable"        | "a failed tool call is retried once, then reported"                     |

### Say it once

The specification is not a copy of `agents.yaml` in prose. It says _what_ and
_why_; the files say _how_. If a line of the specification could be pasted into
`agents.yaml` unchanged, it is probably configuration that wandered into the
wrong file.

## Setup steps are scripts

Anything that has to be done before the project can run — an index built, a
document fetched, a file generated — is a script under `scripts/`, and
`scripts/_setup.sh` is the only entry point. Not a paragraph in a README that a
person is supposed to follow, because the thing following it is usually an
agent.

```sh
scripts/_setup.sh            # do whatever is not done yet
scripts/_setup.sh --force    # do all of it again
```

The runner `zen init` writes holds a `STEPS` list at the top and runs
`scripts/<name>.sh` for each name, in order, teeing each one's output to
`.tmp/logs/setup-<name>.log` and finishing with one line per step. Adding a step
is adding a file and a name.

Each step exits **0** when it did the work, **3** when there was nothing to do,
and non-zero when it failed — which is how a second run can report `skipped` and
prove itself re-entrant. A step writes into `.tmp/` and moves the result into
place, so an interrupted build never leaves half an artefact behind, and reads
`$FORCE` to know whether `--force` was passed.

Everything transient lives under `.tmp/`, which is git-ignored: deleting it must
leave the project runnable and `scripts/_setup.sh` re-runnable.

## `zen check`

`zen check` validates the project — that it loads, that every model reference
resolves, that every agent's tools and handoffs exist, that the sandbox is
buildable. It says nothing about whether the prose is any good, which is what
the review pass in `/sync-with-spec` is for. Run it before the setup script and
again after the changes.

## Further

- [projects.md](projects.md) — what a project directory is, and how it loads
- [agents-yaml.md](agents-yaml.md) — the configuration reference
- [knowledge.md](knowledge.md) — giving agents a corpus to search
- [integrations.md](integrations.md) — giving agents an API to work against
- [memory.md](memory.md) — carrying something from one session to the next
