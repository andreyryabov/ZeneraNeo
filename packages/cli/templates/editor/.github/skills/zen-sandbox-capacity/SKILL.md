---
name: zen-sandbox-capacity
description: Whether the machine can actually run the batch you are about to start. The podman VM is the ceiling and it is sized once, at 2 GiB by default, whatever the host has - so N concurrent containers over a multi-gigabyte index thrash and are OOM-killed while the host sits idle. Covers the three layers (host, VM, container) and which one can add memory, the exit-code table (137 is always capacity, 124 is usually 137 in disguise, and raising `timeout:` converts one into the other and hides the fault), the memory budget and how to measure its terms instead of assuming them, separating `local` probes from `embed` ones so a starved index is never mistaken for a throttled provider, recording the machine spec so two rounds' token counts are comparable at all, and `scripts/preflight_sandbox.sh` as the gate that answers it in under a minute. Load before any `zen run batch`, before raising `--concurrency` above 1, on exit 137, on a `killed` message from the shell, on an exit 124 from a `zen rag` call, when a batch is slow or timed out, and before comparing tokens or wall-clock between two rounds. Not for a single interactive `zen run` - one container is not a capacity problem.
---

# Capacity

A container is not a machine. On macOS every container `zen` starts lives inside
one Linux virtual machine, that VM has a fixed amount of memory, and **the
number is not the host's**. A laptop with 36 GiB routinely runs a 2 GiB VM, and
the host being nearly empty is no comfort at all to the process being killed
inside it.

That gap is what this skill exists for. It reads as a provider problem, a
network problem, a slow-index problem and a flaky-model problem long before it
reads as what it is, because the symptom arrives as a timeout and timeouts are
the one error everybody already has a theory about.

The evidence is at the bottom. The short version: five tuning rounds, eighty
minutes of wall clock and six prose edits were spent on an exit 124 produced by
a VM smaller than the index it was asked to read.

## Does this apply here

Three things, and if any is absent say so and stop rather than guessing:

| Needs                                   | Without it                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `podman` on `PATH`                      | Nothing below is measurable. Report it and stop           |
| A VM — i.e. macOS or Windows, not Linux | Linux podman is native: no VM, no ceiling, not applicable |
| An agent holding `sandbox:*`            | No container is ever started; capacity is not the fault   |

The check reports all three and exits `3` for any of them. Docker, Colima and
Lima are out of scope on purpose: they have their own VM with its own controls,
and a number read out of podman would be about a machine that is not running the
work.

## The three layers

Routinely confused, and only one of them can add memory.

| Layer         | Read with                                      | Set with                           | Can add memory?                        |
| ------------- | ---------------------------------------------- | ---------------------------------- | -------------------------------------- |
| The host      | `sysctl -n hw.memsize`                         | —                                  | No. It bounds what the VM may be given |
| **The VM**    | `podman info --format json` → `.host.memTotal` | `podman machine set --memory`      | **Yes. This is the ceiling**           |
| One container | `podman inspect … .HostConfig.Memory`          | `sandbox.memory:` in `agents.yaml` | No. It only divides the VM up          |

`sandbox.memory: 8192` does not give a container 8 GiB. It gives it permission
to use 8 GiB of whatever the VM has, and a 2 GiB VM cannot honour that promise to
one container, let alone to eight.

## The machine is sized once, by whichever project created it

This is the fact that makes the whole failure mode invisible, and it is worth
stating on its own.

`zen` creates the podman machine the first time any project needs a container,
with `machine init --cpus <n> --memory <m>` taken from **that project's**
`sandbox:` block, falling back to **2 CPUs and 2048 MiB**. From then on the
machine exists, so the code path that sizes it is never reached again.

Three consequences:

1. **Editing `sandbox.memory:` afterwards resizes nothing.** It changes the
   per-container cap inside an unchanged VM. The `agents.yaml` diff looks like a
   capacity fix and is not one.
2. **The VM may be sized by a project you have forgotten about.** The first
   project to start a container on this host wins, permanently.
3. **The scaffolded default is already oversubscribed.** `zen init` writes
   `memory: 4096` per container, and the default VM is 2048 MiB — so one
   container is permitted twice the whole machine, and podman will admit eight of
   them without a word of complaint. Nothing refuses an impossible sum; it is
   only ever discovered by being killed.

Resizing is the operator's to do, never this skill's and never the check's:

```sh
podman machine stop
podman machine set --memory 12288 --cpus 6
podman machine start
```

`machine stop` kills every running container, so it does not happen in the
middle of somebody's batch. Print the command and hand it over.

## Reading a failure: the exit codes

The single most useful table here, because the whole misdiagnosis turns on one
row of it.

|        Exit | Means                        | Points at                                                     |
| ----------: | ---------------------------- | ------------------------------------------------------------- |
|       `124` | `timeout` fired              | The work was too slow — **often a symptom of 137 conditions** |
|       `137` | SIGKILL — the **OOM killer** | Capacity. Always. There is no other reading                   |
|       `143` | SIGTERM                      | Shutdown or `stop_command`, not capacity                      |
| `0`, slowly | Thrash                       | Capacity, near the edge and not yet over it                   |

**124 and 137 co-occur under memory pressure**, and that is the trap. A VM under
pressure swaps (or, with no swap, spends the time in reclaim), so everything runs
an order of magnitude slower, so commands hit their timeout — and the ones that
do not hit it get killed outright. A run shows both, and 124 is the more common
of the two, so the 124 gets investigated.

Then the obvious repair makes it worse:

```yaml
sandbox:
    timeout: 600 # was 120 — "the commands just need longer"
```

Raising the timeout converts 137 into 124 and converts 124 into a very long
success. It has removed the only unambiguous signal in the system. If a project
has a `timeout:` well above the 120-second default, treat it as evidence that
this diagnosis was already made once and got it wrong.

## The budget

Two bounds. Report both, always, because they fail for different reasons and
take different fixes.

### 1. Admission — free, static, and usually the finding

```
concurrency × sandbox.memory  ≤  vm_memory
```

This is what podman will _permit_ to be allocated. It needs no probe, no
container and no timing: it is two numbers out of `agents.yaml` and one out of
`podman info`. When it fails, nothing in the system will refuse the sum — the
only thing keeping the machine alive is that the containers do not all peak at
once, which is luck rather than configuration.

It is a warning and not the verdict, because a container permitted 4 GiB that
only ever wants 900 MiB does no harm. The exception is not a warning at all:
when `sandbox.memory` alone exceeds the VM, the promise is impossible at
`--concurrency 1` and the batch width has nothing to do with it. That is the
scaffolded default on an unresized machine — `memory: 4096` against 2048 MiB.

### 2. Working set — measured, and the one that names a number

```
required_vm_memory  ≥  largest_index_size
                     + (concurrency × per_container_peak_rss)
                     + 1 GiB headroom
```

Every term is measured, never assumed:

- **`largest_index_size`** — `du -sk` over each index under `assets/`. An index
  is read through the page cache, and the cache lives in the VM's memory. A 3.2
  GiB index inside a 2 GiB VM cannot be cached at all, which is why the same
  `grep` takes 5 seconds on the host and 110 inside the container.
- **`per_container_peak_rss`** — **sampled at `--concurrency 1`**, with
  `podman stats`, running the command the batch will actually run. Never
  estimated from the image size, and never divided out of a loaded run, because a
  run under pressure reports the RSS it was _allowed_, not the one it wanted.
- **`1 GiB headroom`** — not optional. Check `swapTotal` first: a podman machine
  normally reports **`SwapTotal 0`**, so there is no pressure valve. The kernel
  does not slow down and then recover; it kills something immediately. Headroom
  is the whole of the margin.

## The check

```sh
.github/skills/zen-sandbox-capacity/scripts/preflight_sandbox.sh --concurrency 8
```

| Flag                | Effect                                                 |
| ------------------- | ------------------------------------------------------ |
| `--concurrency <n>` | The batch width to answer for. Default 1               |
| `--assets <dir>`    | Where the indexes are. Default `assets`                |
| `--skip-probe`      | Admission bound only — instant, and needs no container |
| `--peak-rss <MiB>`  | Use a known figure instead of sampling one             |
| `--json`            | The same answer as data                                |

| Exit | Means                                                     |
| ---: | --------------------------------------------------------- |
|  `0` | Sufficient. Start the batch                               |
|  `1` | Insufficient. The output names by how much, and two fixes |
|  `3` | Not applicable — no podman, no VM, or no sandboxed agent  |

Non-zero is usable as a gate, which is the point of it being a script:

```sh
.github/skills/zen-sandbox-capacity/scripts/preflight_sandbox.sh --concurrency 8 \
    && zen run batch --input cases.json --concurrency 8
```

It **mutates nothing**. It starts one short-lived container with `--rm`, reads,
and prints; it never stops, resizes or reconfigures the machine.

What it prints is a verdict with the numbers that produced it and the exact
command that fixes it — the shape `zen models test` uses:

```
host       36.0 GiB total
vm         2.0 GiB total · 0 swap · 2 cpus      podman-machine-default
container  4096 MiB cap · 4 cpus                agents.yaml
index      3.2 GiB  assets/docs-db (largest of 2)
peak rss   912 MiB  sampled at concurrency 1

admission  8 x 4096 MiB = 32.0 GiB permitted against a 2.0 GiB vm   OVERSUBSCRIBED
concurrency 8 needs ~11.4 GiB   vm has 2.0 GiB   INSUFFICIENT
  fix:  podman machine stop && podman machine set --memory 12288 && podman machine start
  or:   run the batch at --concurrency 1
```

**Both remedies, every time.** Resizing is not available on every machine — a
shared host, a CI runner, a laptop with 8 GiB — and lowering concurrency always
is. A check that offers only the fix the reader cannot apply has told them
nothing.

Target runtime is under 60 seconds so that running it is never a decision. A
full concurrency sweep would be better evidence and would not get run; that
sweep is the _diagnostic_ and this is the _gate_. `--skip-probe` drops it to
about a second when the admission bound is all that is in question.

## Separating the index from the provider

Any probe of a capacity problem must label each command as one of two kinds:

| Kind    | Makes a network call           | Examples                                       |
| ------- | ------------------------------ | ---------------------------------------------- |
| `local` | No                             | `zen rag docs stats`, `grep`, `list`, `show`   |
| `embed` | Yes, one, before anything else | `zen rag docs search`, `zen rag schema search` |

Without the split, a slow `search` is indistinguishable from a throttled one,
and the operator is sent to the wrong vendor. With it, the reading is mechanical:

| Observed                                        | Verdict                                |
| ----------------------------------------------- | -------------------------------------- |
| Container slow, host fast                       | The VM. Capacity, and only capacity    |
| Both slow, `embed` only                         | The embedding endpoint. Not this skill |
| Both slow, `local` too                          | Neither — the index itself             |
| Container slow on `local`, host slow on `embed` | Both, independently                    |

This is also why the check probes with a `local` command. A gate that needed a
credential and a network round trip would fail for reasons that have nothing to
do with the machine.

## A machine spec is part of a round

Record it into the round directory, next to the findings:

```sh
{
    echo "host      $(($(sysctl -n hw.memsize) / 1073741824)) GiB"
    podman info --format json | jq -r '.host | "vm        \(.memTotal / 1073741824 | floor) GiB · swap \(.swapTotal) · \(.cpus) cpus"'
    echo "batch     --concurrency 8"
} > .finetune/rounds/r5/machine.txt
```

The consequence is not bookkeeping, it is validity: **token counts and
wall-clock are only comparable within one machine spec.** A round that ran at 2
GiB and a round that ran at 12 GiB differ in trajectory length for reasons that
have nothing to do with the prose — retries, timeouts, abandoned branches and
compactions all move with pressure. Resizing the VM invalidates a baseline
exactly as editing a prompt does, and for the same reason.

And the harder rule: **a round containing any exit 137 is void, not graded.** Its
trajectories are of a system being killed, not of a system following
instructions. No prose may be changed on its evidence. Re-run it on a machine
that fits and grade that.

## The host side too

The containers are not the only process. `zen run batch` is itself a Node
process on the host, holding every item's envelope, and it has been OOM-killed
in its own right — the shell reports `zsh: killed` and there is no run directory
to inspect, which looks like nothing happened at all.

Two remedies, in order:

1. Lower `--concurrency`. It reduces both sides at once.
2. `NODE_OPTIONS=--max-old-space-size=8192 zen run batch …`, when the host
   genuinely has the memory and Node's default heap is the binding constraint.

The check reports host total and free alongside the VM's, so the two are never
confused for each other.

## When to escalate

The check answers _is there enough_. When the answer is yes and it is still
slow, the question has become _what is it spending the time on_, and that wants
a sweep rather than a gate. The method is in
[references/loadtest.md](./references/loadtest.md): a 2×2 of host against
container and `local` against `embed`, at rising concurrency, written to CSV.

Escalate when, and only when:

- The check passes and a batch is still timing out.
- The verdict is "both slow", so the split has not settled which side it is.
- A resize did not move the numbers — that refutes the capacity hypothesis and
  something else is wrong.

Do not escalate to establish that 8 concurrent containers do not fit in 2 GiB.
The check already said so, and a sweep that confirms it has spent twenty minutes
agreeing.

## The evidence this skill was written from

One project, one afternoon, measured rather than reasoned:

| Fact                        | Measured                                   |
| --------------------------- | ------------------------------------------ |
| podman VM default on macOS  | 2 GiB, on a host with 36 GiB               |
| `docs` index                | 3.2 GiB — larger than the whole VM         |
| `docs grep`, host, c=8      | 5.5 s                                      |
| `docs grep`, container, c=8 | 105–118 s, and **3 of 8 exited 137**       |
| Embedding calls, c=8        | ~2× latency, and **zero 429s**             |
| VM swap                     | **0** — no valve, so the kill is immediate |

Read the last two rows together. The provider was never throttling; the
hypothesis that it was survived five rounds because the only visible symptom was
a timeout, and the one measurement that would have refuted it — the same command
run on the host — was never made.

## What this does not cover

- **Sandbox configuration generally.** `persist`, mounts, `keys`, hardening,
  images: load **zen-sandbox**.
- **Docker, Colima, Lima, or Linux-native podman.** Detected and reported as not
  applicable, never attempted.
- **Provider rate limits.** A probe that finds throttling hands off; diagnosing
  a quota is the provider's documentation and **zen-cli**'s `zen models test`.
- **Index construction and sizing.** How large an index ought to be, and how to
  make it smaller, is **zen-rag-docs**.

## Related

- **zen-sandbox** — what a container is, how to configure it, and the mounts
- **zen-finetune** — the tuning loop this is a precondition of; its Phase 3
- **zen-cli** — `zen sandbox status|up|disk`, and what each exit code means
- **zen-inspect** — finding the failed node once the round has been re-run
