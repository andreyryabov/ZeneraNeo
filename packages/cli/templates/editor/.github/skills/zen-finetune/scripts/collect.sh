#!/usr/bin/env bash
#
# Read back a fine-tuning batch: what each item did, and where its trajectory is.
#
#   collect.sh                    the index: verdict, agent, stop reason, cost
#   collect.sh graphs [id...]     every trajectory graph, concatenated
#   collect.sh paths [id...]      id <TAB> run directory, for xargs and zen inspect
#   collect.sh failures           only the items that did not finish, with errors
#
#   -d <dir>    the batch directory; default the newest .finetune/rounds/*/batch
#   -s <file>   the dataset, for rubrics; default .finetune/dataset.json
#
# `graphs` is the one that saves the most: it is every item's graph.mmd with its
# id, verdict and rubric written above it, which is one read instead of N
# invocations of `zen inspect graph`. Grade from that, then descend into the
# runs that need it with `zen inspect node --dir "$(collect.sh paths | ...)"`.
#
# Run it from anywhere; it finds the project root from its own location, which
# `zen init` and `zen open` fix. See .github/skills/zen-finetune/SKILL.md.

set -eu
cd "$(dirname "$0")/../../../.."

MODE=""
BATCH=""
DATASET=.finetune/dataset.json
WANTED=""

usage() {
    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        -d) BATCH="${2:?-d needs a directory}"; shift 2 ;;
        -s) DATASET="${2:?-s needs a file}"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        index | graphs | paths | failures)
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
esac
