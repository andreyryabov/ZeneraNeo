# The frame

What is true of every command, whichever one is being run.

## Invocation

```
zen <command> [options]
```

Three names run the same program: `zen`, `zn` and `zenera`. Help and error
hints name the binary that was actually invoked, so `zn run` is spelled `zn`
back at you.

## Global options

| Flag                    | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `-h`, `--help`          | The command list, or a command's own help                |
| `-v`, `--version`       | The version, and nothing else                            |
| `--json`                | Machine-readable output on stdout instead of a rendering |
| `-C`, `--directory <d>` | Act as if run in `<d>`                                   |

These are lifted out of the argument list before a command parses its own
flags, so they work in any position and a command never declares them itself.
Everything after the command name belongs to that command.

## Aliases

Not listed in help, but they work.

| Alias                | Command   |
| -------------------- | --------- |
| `ls`                 | `list`    |
| `new`                | `init`    |
| `keys`               | `key`     |
| `validate`, `doctor` | `check`   |
| `report`             | `inspect` |
| `edit`, `code`       | `open`    |
| `mock`               | `faker`   |

## stdout is the answer, stderr is the narration

The answer to what was asked goes to stdout: a model's reply, a report, a list.
Progress, banners, warnings and the spinner go to stderr. So
`zen run acme "…" > answer.md` captures the answer and nothing else, and
`2>/dev/null` silences everything but it.

`--json` applies to every command and prints one machine-readable document on
stdout in place of the rendered form. Under `--json` nothing is asked
interactively — the questions a run would ask are taken as answered.

The banner is drawn only when stderr is a terminal, so a piped invocation never
sees it.

## Exit codes

| Code | Name        | Means                                                      |
| ---- | ----------- | ---------------------------------------------------------- |
| 0    | ok          | It worked                                                  |
| 1    | failed      | It ran and did not succeed                                 |
| 2    | usage       | The command line was wrong                                 |
| 3    | invalid     | The project is not valid — bad `agents.yaml`, missing file |
| 4    | credentials | No usable credential for what was asked                    |
| 5    | sandbox     | No container engine, or the image could not be prepared    |

A wrong invocation and a wrong answer are deliberately not the same code, which
is what a script needs. Failure messages name the offending key or file; a load
error names the exact path, as in `agents.yaml: agents[1].skills.discovery — …`.
Read it rather than guessing: the loader is strict on purpose and an unknown key
is an error, not a value quietly ignored.

## Which project

Most commands operate on a project directory, resolved in this order:

1. `--project <name|dir>` — a registry name or a path.
2. The working directory, if it is a project (or is inside one).
3. For `zen run`, a bare first word that names a registered project.

`zen check` is the exception: it takes a bare `[dir]` and needs no
`zenera.json`, so an unregistered directory can still be validated.

## Environment

| Variable           | Effect                                                |
| ------------------ | ----------------------------------------------------- |
| `ZENERA_HOME`      | Moves the whole home tree. Default `~/.zenera/neo`    |
| `ZENERA_THEME`     | `dark`, `light` or `auto` for the TUI palette         |
| `ZENERA_EDITOR`    | The editor `zen open` launches                        |
| `ZENERA_DEBUG`     | Print a stack trace when something unexpected escapes |
| `VISUAL`, `EDITOR` | Consulted by `zen open` after `ZENERA_EDITOR`         |
| `COLORFGBG`        | Read as a hint when the palette is being detected     |
| Provider keys      | `OPENAI_API_KEY` and friends — see [keys.md](keys.md) |

A real environment variable always beats the keyring.

## Where things live

```
~/.zenera/neo/            the home tree (0700)
    projects.json         the registry: name -> directory
    keys.json             credentials (0600)
    keys/                 key files, for providers that hold a file
    faker/                generator cache for `zen faker`

<project>/
    zenera.json           { version, name }
    INSTRUCTIONS.md       house rules, prepended to every agent's prompt
    agents.yaml           the configuration
    agents/prompts/       one .md per agent
    agents/skills/        one directory per skill, each with SKILL.md
    sandbox/Dockerfile    the image commands run in, when the project builds one
    sessions/             run state, memory, blobs, reports — never committed
```

Credential files are refused if anyone but the owner can read them, the way
`ssh` refuses a loose private key: `chmod 600` and try again.
