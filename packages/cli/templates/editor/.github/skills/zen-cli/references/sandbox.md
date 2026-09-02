# The sandbox — `zen sandbox`

```
zen sandbox [status|up|pull|clean|disk] [options]
```

Shell commands run in a container over the session workspace, never on the
host. None of this is required: a run does all of it on its own, the first time
an agent that can reach a shell is about to start one. These subcommands are for
doing it deliberately — before a demo, in CI, or when diagnosing.

| Subcommand | What it does                                                   |
| ---------- | -------------------------------------------------------------- |
| `status`   | What is installed, running and pulled. Changes nothing         |
| `up`       | Install if asked, start the machine, pull or build the image   |
| `pull`     | Just the image: pulled, or built from the project's Dockerfile |
| `clean`    | Remove every container this CLI created                        |
| `disk`     | What the engine and every known project occupy                 |

| Flag                    | Meaning                                 |
| ----------------------- | --------------------------------------- |
| `--project <name\|dir>` | Which project the image comes from      |
| `--image <ref>`         | Use this image instead of the project's |

The engine is Podman. On macOS a machine has to exist and be running; `up`
offers to install and start one, and its size follows the project's `cpus` and
`memory`.

## Configuring it — `sandbox:` in `agents.yaml`

Top level, and again per agent, where an agent's block is merged over the base.

| Key       | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `image`   | The image to run. Mutually exclusive with `build`                |
| `build`   | `{ dockerfile, context? }` — build one instead. Excludes `image` |
| `cpus`    | CPU limit                                                        |
| `memory`  | Memory limit, in MiB                                             |
| `network` | Whether the container has one                                    |
| `workdir` | Where the workspace is mounted. `/workspace` by default          |
| `timeout` | Seconds one command may take                                     |
| `user`    | Who commands run as                                              |
| `persist` | Keep the container between runs                                  |
| `env`     | A name-only allow-list of variables to pass in                   |

`env` refuses names matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or
`CREDENTIAL`: the keyring has already materialised real credentials into the
process environment, and a sandbox is the last place they should be forwarded to.

## `persist: true` is usually what you want

Only `/workspace` and `/home/agent` survive an ephemeral container. A
`pip install` as root, or an `apt-get install`, lands in the image's system
paths and is gone by the next run — so the agent silently reinstalls its
toolchain every single time. `zen init` scaffolds `persist: true` for that
reason.

The caveat: the container's name is a function of its configuration, so any
change to the sandbox block names a _new_ container and abandons the installed
rootfs. If runs keep beginning with an install, either persist, or bake the
toolchain into the image.

## Building an image instead of naming one

```yaml
sandbox:
    build:
        dockerfile: sandbox/Dockerfile
    persist: true
```

The tag is content-addressed — a hash of the Dockerfile and every file in its
context — so a changed Dockerfile is a different image and a `persist: true`
container can never be left sitting on a stale rootfs. It is built only when
that tag is absent, which is safe precisely because the tag follows the content.
`zen sandbox pull` forces a rebuild.

## Hardening

`no-new-privileges`, an init process, a pid limit, no restart policy. Not
`--cap-drop=ALL` (it breaks `apt` and `pip`) and never `--privileged`.

## When it goes wrong

Exit code `5` means the container engine is missing or the image could not be
prepared, and the message names the command to run for this platform. `zen check`
distinguishes the two cases: a broken Dockerfile is an error, a laptop with no
Podman is a warning.

`zen sandbox clean` removes every container this CLI created — the way out of a
container left on a bad rootfs.
