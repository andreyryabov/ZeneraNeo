#!/usr/bin/env bash
#
# Read back a fine-tuning batch: what each item did, and where its trajectory is.
#
#   collect.sh                    the index: verdict, agent, stop reason, cost
#   collect.sh graphs [id...]     every trajectory graph, concatenated
#   collect.sh paths [id...]      id <TAB> run directory, for xargs and zen inspect
#   collect.sh failures           only the items that did not finish, with errors
#   collect.sh oom                items whose commands were killed; is this round gradeable
#   collect.sh compare            the per-sample table findings.md opens with
#
#   -d <dir>    the batch directory; default the newest .finetune/rounds/*/batch
#   -p <dir>    the batch to compare against, for `compare`; default none
#   -s <file>   the dataset, for rubrics; default .finetune/dataset.json
#
# `index`, `graphs` and `compare` each open by saying whether the round was
# COLD, WARM or memory-OFF, because the same trajectory means opposite things
# either way and a round written up without that line compares to nothing.
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
PREV=""
DATASET=.finetune/dataset.json
WANTED=""

usage() {
    sed -n '3,25p' "$SELF" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        -d) BATCH="${2:?-d needs a directory}"; shift 2 ;;
        -p) PREV="${2:?-p needs a directory}"; shift 2 ;;
        -s) DATASET="${2:?-s needs a file}"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        index | graphs | paths | failures | oom | compare)
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

# Everything one item cost, as "tokens secs nodes llm tools forks", from any
# batch directory rather than the current one — `compare` reads two.
#
# The counts come from the graph's own header row, which already states them:
#   %% nodes     103 · 33 llm · 30 tool calls · 1 forks
# Counting nodes out of state.json instead over-counts tool calls about
# threefold, because nested structures repeat the same call.
metrics() {
    out="$1/$2/output.json"
    if [ ! -f "$out" ]; then
        echo "0 0 0 0 0 0"
        return
    fi
    tok="$(jq -r '((.usage.inputTokens // 0) + (.usage.outputTokens // 0))' "$out" 2> /dev/null || echo 0)"
    sec="$(jq -r '(((.durationMs // 0) / 1000) | floor)' "$out" 2> /dev/null || echo 0)"
    graph="$(jq -r '.run.graph // empty' "$out" 2> /dev/null || true)"
    hdr=""
    if [ -n "$graph" ] && [ -f "$graph" ]; then
        hdr="$(sed -n 's/^%% nodes  *//p' "$graph" | head -1 || true)"
    fi
    if [ -z "$hdr" ]; then
        echo "$tok $sec 0 0 0 0"
        return
    fi
    echo "$tok $sec $(echo "$hdr" | awk -F' · ' '{printf "%d %d %d %d", $1+0, $2+0, $3+0, $4+0}')"
}

# 1.09M, 812k, 94 — these are read by eye and compared by eye.
hum() {
    awk -v n="$1" 'BEGIN {
        if (n + 0 >= 1000000)   printf "%.2fM\n", n / 1000000
        else if (n + 0 >= 1000) printf "%dk\n", n / 1000
        else                    printf "%d\n", n
    }'
}

# "33 → 30 (−3)" against a previous round, "33" without one. Tokens and seconds
# read as a percentage because they move continuously; calls and forks read as
# an absolute difference because two of them is two, not eleven per cent.
cell() {
    prev="$1"
    now="$2"
    mode="$3"
    case "$mode" in
        tok) shown_prev="$(hum "$prev")"; shown_now="$(hum "$now")" ;;
        sec) shown_prev="${prev}s"; shown_now="${now}s" ;;
        *) shown_prev="$prev"; shown_now="$now" ;;
    esac
    if [ -z "$PREV" ]; then
        echo "$shown_now"
        return
    fi
    awk -v p="$prev" -v n="$now" -v sp="$shown_prev" -v sn="$shown_now" -v mode="$mode" 'BEGIN {
        d = n - p
        a = (d < 0) ? -d : d
        sign = (d >= 0) ? "+" : "−"
        if (a == 0)            printf "%s (=)\n", sn
        else if (mode == "num") printf "%s → %s (%s%d)\n", sp, sn, sign, a
        else if (p > 0)         printf "%s → %s (%s%.0f%%)\n", sp, sn, sign, a * 100.0 / p
        else                    printf "%s → %s\n", sp, sn
    }'
}

# cold / warm / off, for a batch directory.
#
# batch.json records the mode and the source but not whether that source was a
# real graph when the batch ran — and `--memory .finetune/empty`, which is how a
# cold round is made, records as `copied` exactly like a warm one. The graph
# file is the difference: an empty-graph round never creates one at the source.
memkind() {
    mode="$(jq -r '.batch.memory.mode // "none"' "$1/batch.json" 2> /dev/null || echo none)"
    src="$(jq -r '.batch.memory.source // empty' "$1/batch.json" 2> /dev/null || true)"
    case "$mode" in
        none) echo off ;;
        read-only) echo warm ;;
        copied)
            if [ -n "$src" ] && [ -f "$src/graph.json" ]; then echo warm; else echo cold; fi
            ;;
        *) echo "$mode" ;;
    esac
}

# The line every report opens with, so that no round is ever graded or compared
# without it being plain whether memory was in play.
memline() {
    mode="$(jq -r '.batch.memory.mode // "none"' "$1/batch.json" 2> /dev/null || echo none)"
    src="$(jq -r '.batch.memory.source // empty' "$1/batch.json" 2> /dev/null || true)"
    case "$(memkind "$1")" in
        off) echo "OFF — no memory was given to this batch, and none was written" ;;
        cold) echo "COLD — every item started from an empty graph and wrote its own (${src:-none})" ;;
        warm)
            if [ "$mode" = read-only ]; then
                echo "WARM — one shared graph, read-only, every item read it and none wrote ($src)"
            else
                echo "WARM — each item got its own copy of an existing graph ($src)"
            fi
            ;;
        *) echo "$mode${src:+ ($src)}" ;;
    esac
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
               + "  ·  \((.durationMs / 1000) | floor)s"' "$BATCH/batch.json"
        echo "dir    $BATCH"
        echo "memory $(memline "$BATCH")"
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
        # Before the first graph, because a warm trajectory graded as a cold one
        # reads as an agent that knew things it was never told.
        echo "== memory: $(memline "$BATCH")"
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

    compare)
        # roster is redirected to a file rather than piped: a `while` on the
        # right of a pipe is a subshell, and the totals set in one are gone by
        # the time the total row could print them.
        tmp="$(mktemp)"
        trap 'rm -f "$tmp"' EXIT
        roster > "$tmp"

        if [ -n "$PREV" ] && [ ! -f "$PREV/batch.json" ]; then
            echo "collect.sh: no batch.json in $PREV" >&2
            exit 2
        fi

        # Part of the table, not a footnote: the same numbers mean opposite
        # things depending on this line, and a pasted table loses anything
        # printed after it.
        echo "memory: $(memline "$BATCH")"
        if [ -n "$PREV" ]; then
            echo "prev memory: $(memline "$PREV")"
        fi
        echo
        echo "| sample | verdict | tokens | llm calls | tool calls | forks | time |"
        echo "| --- | --- | --- | --- | --- | --- | --- |"

        ptok=0; psec=0; pllm=0; ptool=0; pfork=0
        ntok=0; nsec=0; nllm=0; ntool=0; nfork=0
        while read -r id ok; do
            read -r a_tok a_sec a_nodes a_llm a_tool a_fork <<< "$(metrics "$BATCH" "$id")"
            if [ -n "$PREV" ]; then
                read -r b_tok b_sec b_nodes b_llm b_tool b_fork <<< "$(metrics "$PREV" "$id")"
            else
                b_tok=0; b_sec=0; b_llm=0; b_tool=0; b_fork=0
            fi
            ntok=$((ntok + a_tok)); nsec=$((nsec + a_sec))
            nllm=$((nllm + a_llm)); ntool=$((ntool + a_tool)); nfork=$((nfork + a_fork))
            ptok=$((ptok + b_tok)); psec=$((psec + b_sec))
            pllm=$((pllm + b_llm)); ptool=$((ptool + b_tool)); pfork=$((pfork + b_fork))
            # The verdict column is left for the grader: it is the one thing
            # here no script can read off a trajectory.
            verdict="?"
            if [ "$ok" != "true" ]; then verdict="**did not finish**"; fi
            printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
                "$id" \
                "$verdict" \
                "$(cell "$b_tok" "$a_tok" tok)" \
                "$(cell "$b_llm" "$a_llm" num)" \
                "$(cell "$b_tool" "$a_tool" num)" \
                "$(cell "$b_fork" "$a_fork" num)" \
                "$(cell "$b_sec" "$a_sec" sec)"
        done < "$tmp"

        printf '| **total** | %s | **%s** | **%s** | **%s** | **%s** | **%s** |\n' \
            "—" \
            "$(cell "$ptok" "$ntok" tok)" \
            "$(cell "$pllm" "$nllm" num)" \
            "$(cell "$ptool" "$ntool" num)" \
            "$(cell "$pfork" "$nfork" num)" \
            "$(cell "$psec" "$nsec" sec)"

        echo
        echo "this  $BATCH"
        if [ -n "$PREV" ]; then echo "prev  $PREV"; fi
        echo "note: wall time is concurrent — the totals are machine load, not a sum anybody waited."
        if [ -n "$PREV" ] && [ "$(memkind "$BATCH")" != "$(memkind "$PREV")" ]; then
            echo
            echo "note: these two rounds did not run on the same memory ($(memkind "$PREV") → $(memkind "$BATCH"))."
            echo "  Cold against warm is the phase-8 measurement and reads as one; cold against"
            echo "  cold is a prose diff. Say which this is in the verdict block, or the numbers"
            echo "  will be read as the effect of an instruction that did nothing."
        fi
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
