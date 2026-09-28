# Load-testing: separating the machine from the endpoint

`preflight_sandbox.sh` answers a static question — does the arithmetic fit. This
answers a different one: the batch is slow or dying and you do not yet know
what is causing it. It costs minutes rather than seconds, so reach for it only
when the gate has already passed and the symptom is still there.

The method below is written from a run that did work. It is a method, not a
script to paste: the commands and the index names belong to whatever project
you are in. Build the harness to fit, and throw it away afterwards.

## Two hypotheses, and why you cannot tell them apart by staring

A slow or killed batch has two plausible causes and they present identically at
the call site — a long wall clock, then a timeout:

|        | Hypothesis                                    | What it predicts                                                        |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| **H1** | The podman VM is under-provisioned            | Latency depends on _where_ the command runs, and not on what kind it is |
| **H2** | The embedding or model endpoint is throttling | Latency depends on _what kind_ of call it is, and not on where it runs  |

They are distinguishable because they are separable. H1 lives in the container
boundary, H2 lives in the network call, and a single 2x2 tells you which line
the variance sits on.

## The 2x2

Two factors, crossed, at several concurrencies:

- **where** — `host` (the command run directly) against `container`
  (the same command inside the sandbox)
- **kind** — `local` (touches only the index, makes no network call) against
  `embed` (makes a provider call)

Pick two or three probes of each kind. For a `zen rag` index these fall out
naturally:

| Probe    | kind  | Why it is in the set                                                   |
| -------- | ----- | ---------------------------------------------------------------------- |
| `stats`  | local | Opens the index and reads the manifest; nearly no work                 |
| `grep`   | local | Reads the whole index through the page cache; the heaviest local probe |
| `list`   | local | Walks the node table                                                   |
| `search` | embed | The query is embedded before anything is read                          |
| `schema` | embed | A second embed path, to show the first was not a fluke                 |

Run each cell at concurrency 1, 2, 4 and 8, several replicas each, and write one
row per run. Concurrency 1 is not optional: it is the baseline every other row
is read against, and it is also the figure `--peak-rss` wants.

A useful row shape, and one that a later `awk` can group without parsing:

```
probe,kind,where,concurrency,replica,seconds,exit_code
```

Keep `exit_code`. A cell that got faster because half its replicas were killed
at 137 is not a fast cell, and a mean that silently includes them will tell you
the opposite of the truth.

## Reading the grid

Compare means within a `probe`, across `where` and `concurrency`:

- **container rows slow, host rows fast** — H1, the podman VM
- **both slow, but only on `kind=embed`** — H2, the embedding API
- **both slow, including `kind=local`** — neither: the index itself
- **container rows carry the non-zero exit codes** — H1, and specifically memory;
  go back to the gate and read `admission` rather than running anything else

The run this skill was written from produced the first of those, unambiguously:
`grep` at concurrency 8 took 5.5 s on the host and 105-118 s in the container,
with three of the eight replicas exiting 137.

## When the finger points at the endpoint

If the grid implicates `kind=embed`, test the endpoint on its own before
believing it. Drive one model reference at rising concurrency — 1, 2, 4, 8, 16 —
and classify each reply rather than timing it alone:

```
ref,concurrency,replica,seconds,exit_code,verdict
```

Classify from the reply body, in this order, because a throttle can arrive
wearing a 200:

| verdict     | Recognised by                                                           |
| ----------- | ----------------------------------------------------------------------- |
| `throttled` | `429`, `RESOURCE_EXHAUSTED`, `rate limit`, `quota`, `too many requests` |
| `refused`   | the model declined the request                                          |
| `blocked`   | a safety or policy filter fired                                         |
| `no-answer` | empty body, or a body with no content                                   |
| `ok`        | a substantive reply                                                     |
| `other`     | anything left                                                           |

Keep the raw replies on disk. A verdict you cannot go back and check is a guess
with a column heading.

Then:

- **mean flat as concurrency rises, nothing `throttled`** — H2 is out. The
  endpoint is not your problem; go back to H1.
- **mean climbing, nothing `throttled`** — the endpoint serialises. Lower
  concurrency will not lose you throughput, so lower it.
- **anything `throttled`** — H2 confirmed. Stop here.

A confirmed throttle is the end of this document's usefulness. Rate limits are a
provider matter — quota, region, a different reference, a backoff — and nothing
in this skill or in the sandbox will move them. Hand it off; do not spend a
fine-tuning round on it.

The run this skill was written from found embedding calls roughly 2x slower at
concurrency 8 and **zero** throttled replies. That is what refuted H2, and it is
the reason the sentence about provider tolerance in `zen-finetune` is not the
whole story.

## A skeleton

Substitute your own index names and model reference. Keep the structure — the
value is in the grid, not in the timing code.

```bash
#!/usr/bin/env bash
set -eu
stamp="$(date +%Y%m%d-%H%M%S)"
out=".tmp/loadtest/rag-${stamp}.csv"
mkdir -p "$(dirname "$out")"
echo "probe,kind,where,concurrency,replica,seconds,exit_code" > "$out"

INDEX=@INDEX@                        # e.g. docs
IMAGE="$(zen sandbox status | awk '$1 == "image" { print $2 }')"

run_one() {                          # probe kind where concurrency replica
    case "$1" in
        stats)  cmd="zen rag $INDEX stats" ;;
        grep)   cmd="zen rag $INDEX grep zzzz-not-present" ;;
        search) cmd="zen rag $INDEX search 'how does this work'" ;;
    esac
    start="$(date +%s)"
    if [ "$3" = host ]; then
        sh -c "$cmd" > /dev/null 2>&1 || true
        rc=$?
    else
        podman run --rm -v "$PWD:/work:ro" -w /work --entrypoint="" \
            "$IMAGE" sh -c "$cmd" > /dev/null 2>&1 || true
        rc=$?
    fi
    echo "$1,$2,$3,$4,$5,$(($(date +%s) - start)),$rc" >> "$out"
}

for c in 1 2 4 8; do
    for where in host container; do
        for spec in "stats local" "grep local" "search embed"; do
            set -- ${=spec}          # zsh does not split unquoted expansions
            for r in $(seq 1 "$c"); do run_one "$1" "$2" "$where" "$c" "$r" & done
            wait
        done
    done
done

echo "wrote $out"
```

Two things this deliberately does not do, and neither should yours:

- It does not use `python3 -c`, `node -e` or any other inline interpreter. That
  is a house rule, and a load test is not an exemption from it.
- It does not mutate the machine. If the answer is "resize", say so and let a
  person run `podman machine set` — see the main skill for why stopping the
  machine is not free.

Whole-second timing is coarse for the fast cells. If you need better, use a
timing utility the image already has; do not reach for an inline interpreter to
get microseconds you will not read.

## Afterwards

Whatever the grid says, write the finding down where the next round will see it,
together with the machine spec it was measured on. A load test that is not
recorded next to its `vm memory` figure will be re-run by the next person from
scratch, because they will have no way to know whether it still applies.
