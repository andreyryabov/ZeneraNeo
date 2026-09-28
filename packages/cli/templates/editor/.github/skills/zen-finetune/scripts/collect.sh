#!/usr/bin/env bash
#
# Read back a fine-tuning batch: what each item did, and where its trajectory is.
#
#   collect.sh                    the index: verdict, agent, stop reason, cost
#   collect.sh graphs [id...]     every trajectory graph, concatenated
#   collect.sh paths [id...]      id <TAB> run directory, for xargs and zen inspect
#   collect.sh failures           only the items that did not finish, with errors
#   collect.sh oom                items whose commands were killed; is this round gradeable
#
#   -d <dir>    the batch directory; default the newest .finetune/rounds/*/batch
#   -s <file>   the dataset, for rubrics; default .finetune/dataset.json
#
# Run `oom` first, and do not expect `failures` to have caught it: an item whose
# command was killed usually recovers, answers anyway and is recorded `ok`. A
# round can read "16 items, 16 ok, 0 failed" with six of them OOM-killed inside.
# A round that contains an exit 137 ran out of memory, and nothing it did is
# evidence about the prompt — grading it sends the next round after a defect
# that does not exist. See the zen-sandbox-capacity skill.
#
# `graphs` is the one that saves the most: it is every item's graph.mmd with its
# id, verdict and rubric written above it, which is one read instead of N
# invocations of `zen inspect graph`. Grade from that, then descend into the
# runs that need it with `zen inspect node --dir "$(collect.sh paths | ...)"`.
#
# Run it from anywhere; it finds the project root from its own location, which
# `zen init` and `zen open` fix. See .github/skills/zen-finetune/SKILL.md.

set -eu

# Taken before the cd, or a relative $0 stops naming this file.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../../../.."

MODE=""
BATCH=""
DATASET=.finetune/dataset.json
WANTED=""

usage() {
    sed -n '3,19p' "$SELF" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        -d) BATCH="${2:?-d needs a directory}"; shift 2 ;;
        -s) DATASET="${2:?-s needs a file}"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        index | graphs | paths | failures | oom)
            if [ -n "$MODE" ]; then
                echo "collect.sh: one mode at a time" >&2
                exit 2
            fi
            MODE="$1"
            shift
            ;;
        -*)
            echo "collect.sh: unknown flag $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            WANTED="$WANTED $1"
            shift
            ;;
    esac
done

MODE="${MODE:-index}"

if ! command -v jq > /dev/null 2>&1; then
    echo "collect.sh: jq is required" >&2
    exit 2
fi

# Without -d, the most recently written batch. Rounds are read far more often
# than they are named, and the one just run is almost always the one meant.
if [ -z "$BATCH" ]; then
    for dir in .finetune/rounds/*/batch; do
        if [ -f "$dir/batch.json" ]; then BATCH="$dir"; fi
    done
fi

if [ -z "$BATCH" ] || [ ! -f "$BATCH/batch.json" ]; then
    echo "collect.sh: no batch.json${BATCH:+ in $BATCH}" >&2
    echo "  name one with -d, or run a batch first" >&2
    exit 2
fi

# `id ok` per line, in the order the batch file listed them, filtered to the
# ids asked for if any were. Everything below walks this.
roster() {
    jq -r '.batch_results[] | "\(.id) \(.ok)"' "$BATCH/batch.json" | while read -r id ok; do
        if [ -z "$WANTED" ]; then
            echo "$id $ok"
        else
            for want in $WANTED; do
                if [ "$want" = "$id" ]; then echo "$id $ok"; fi
            done
        fi
    done
}

# One field out of an item's envelope, empty if the item failed or never wrote.
field() {
    if [ -f "$BATCH/$1/output.json" ]; then
        jq -r "$2 // empty" "$BATCH/$1/output.json" 2> /dev/null || true
    fi
}

# The rubric from the dataset, joined on the id. Absent dataset, absent rubric,
# absent sample: all the same thing here, and none of them is an error.
rubric() {
    if [ -f "$DATASET" ]; then
        jq -r --arg id "$1" '
            .samples[] | select(.id == $id) | (.rubric // [])[]
            | "  - " + .' "$DATASET" 2> /dev/null || true
    fi
}

case "$MODE" in
    index)
        jq -r '.batch | "batch  \(.items) items, \(.ok) ok, \(.failed) failed"
               + "  ·  memory \(.memory.mode) (\(.memory.source // "project"))"
               + "  ·  \((.durationMs / 1000) | floor)s"' "$BATCH/batch.json"
        echo "dir    $BATCH"
        echo
        printf '%-24s %-5s %-12s %-12s %7s %5s %6s\n' \
            ID OK AGENT STOP TOKENS SEC RUBRIC
        roster | while read -r id ok; do
            agent="$(field "$id" .agent)"
            stop="$(field "$id" .stopReason)"
            tokens="$(field "$id" '(.usage.inputTokens + .usage.outputTokens)')"
            secs="$(field "$id" '((.durationMs / 1000) | floor)')"
            lines="$(rubric "$id" | grep -c . || true)"
            if [ "$lines" -eq 0 ]; then lines="-"; fi
            printf '%-24s %-5s %-12s %-12s %7s %5s %6s\n' \
                "$id" "$ok" "${agent:--}" "${stop:--}" "${tokens:--}" "${secs:--}" "$lines"
        done
        echo
        echo "next: collect.sh -d $BATCH graphs | less"
        ;;

    graphs)
        roster | while read -r id ok; do
            graph="$(field "$id" .run.graph)"
            echo "================================================================"
            echo "== $id   ok=$ok"
            lines="$(rubric "$id")"
            if [ -n "$lines" ]; then
                echo "== rubric:"
                echo "$lines" | sed 's/^/== /'
            fi
            echo "================================================================"
            if [ -n "$graph" ] && [ -f "$graph" ]; then
                cat "$graph"
            elif [ -f "$BATCH/$id/output.json" ]; then
                jq -r '.error.message // "no graph was written"' "$BATCH/$id/output.json"
            else
                echo "no output.json"
            fi
            echo
        done
        ;;

    paths)
        roster | while read -r id ok; do
            dir="$(field "$id" .run.dir)"
            printf '%s\t%s\n' "$id" "${dir:--}"
        done
        ;;

    failures)
        # The count comes from batch.json rather than the loop below: a `while`
        # on the right of a pipe is a subshell, and a variable set in one is
        # gone by the time anything could read it.
        if [ "$(jq -r '[.batch_results[] | select(.ok | not)] | length' "$BATCH/batch.json")" -eq 0 ]; then
            echo "nothing failed"
            exit 0
        fi
        roster | while read -r id ok; do
            if [ "$ok" != "true" ]; then
                echo "-- $id"
                if [ -f "$BATCH/$id/output.json" ]; then
                    jq -r '"   " + (.error.message // "unknown")
                           + (if .error.hint then "\n   hint: " + .error.hint else "" end)' \
                        "$BATCH/$id/output.json"
                fi
            fi
        done
        ;;

    oom)
        # The graph is where an exit code survives: every tool call is a node,
        # and a killed `run_command` reads `= exit code 137`. Do not grep the
        # batch directory instead — an item's workspace is full of data files
        # with 137 in them, and every one is a false positive.
        #
        # Collected into a variable rather than counted in the loop: a `while`
        # on the right of a pipe is a subshell, and a count set in one is gone
        # before the verdict could read it.
        scan="$(
            roster | while read -r id ok; do
                graph="$(field "$id" .run.graph)"
                if [ -z "$graph" ] || [ ! -f "$graph" ]; then continue; fi
                killed="$(grep -c 'exit code 137' "$graph" 2> /dev/null || true)"
                timedout="$(grep -c 'exit code 124' "$graph" 2> /dev/null || true)"
                if [ "${killed:-0}" -gt 0 ] || [ "${timedout:-0}" -gt 0 ]; then
                    printf '%s %s %s\n' "$id" "${killed:-0}" "${timedout:-0}"
                fi
            done
        )"

        if [ -z "$scan" ]; then
            echo "no killed commands in this round — it is gradeable"
            exit 0
        fi

        printf '%-32s %8s %8s\n' ITEM 'OOM 137' 'TIME 124'
        echo "$scan" | while read -r id killed timedout; do
            printf '%-32s %8s %8s\n' "$id" "$killed" "$timedout"
        done
        echo

        items_killed="$(echo "$scan" | awk '$2 > 0' | grep -c . || true)"
        total_killed="$(echo "$scan" | awk '{ s += $2 } END { print s + 0 }')"
        total_timedout="$(echo "$scan" | awk '{ s += $3 } END { print s + 0 }')"

        if [ "${items_killed:-0}" -gt 0 ]; then
            echo "$total_killed command(s) across $items_killed item(s) were OOM-killed."
            echo
            echo "THIS ROUND IS VOID, NOT GRADED."
            echo "  Nothing here is evidence about the prompt. Do not grade it, do not"
            echo "  change instructions on it, and do not compare its tokens to another"
            echo "  round. Size the machine, then run it again:"
            echo
            echo "    .github/skills/zen-sandbox-capacity/scripts/preflight_sandbox.sh --concurrency 8"
            exit 1
        fi

        echo "$total_timedout command(s) hit the timeout; none was OOM-killed."
        echo "  Under memory pressure 124 is 137 wearing a different number, and raising"
        echo "  the timeout converts one into the other rather than fixing either. Check"
        echo "  the machine before concluding the index is slow:"
        echo
        echo "    .github/skills/zen-sandbox-capacity/scripts/preflight_sandbox.sh --concurrency 8"
        ;;
esac
