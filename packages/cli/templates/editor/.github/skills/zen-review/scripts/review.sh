#!/usr/bin/env bash
#
# Every check a review can make without judgement, in the order it makes them.
#
#   review.sh            zen check, then paths, memory, and the spec-sync record
#   review.sh fast       the same, with `zen check --no-models --no-sandbox`
#
# What it prints is findings. What it cannot see — whether an agent has one job,
# whether a description is a condition, whether a fact belongs in a skill — is
# the rest of /project-review, and the reason that prompt still exists.
#
# Every step runs even when an earlier one fails: a review that stops at the
# first problem is one somebody has to run four times. The exit code is 1 if
# anything wants attention, 0 if nothing does.
#
# Run it from anywhere; it finds the project root from its own location.

set -u
cd "$(dirname "$0")/../../../.."

SKILLS=.github/skills
CHECK_FLAGS=""

case "${1:-full}" in
    full) ;;
    fast) CHECK_FLAGS="--no-models --no-sandbox" ;;
    *)
        echo "usage: review.sh [full|fast]" >&2
        exit 2
        ;;
esac

SUMMARY=""
WORST=0

# Records one step's verdict for the summary, and remembers the worst of them.
verdict() {
    SUMMARY="$SUMMARY$1: $2
"
    if [ "$3" -ne 0 ]; then
        WORST=1
    fi
}

step() {
    printf '\n--- %s ---\n' "$1"
}

step 'zen check'
if command -v zen >/dev/null 2>&1; then
    # Unquoted on purpose: empty means no flags rather than one empty argument.
    # shellcheck disable=SC2086
    zen check $CHECK_FLAGS
    rc=$?
    if [ "$rc" -eq 0 ]; then
        verdict 'zen check' 'ok' 0
    else
        verdict 'zen check' "exit $rc — nothing below matters until this passes" 1
    fi
else
    echo "zen is not on PATH — install it, or run the other three alone"
    verdict 'zen check' 'not run' 1
fi

step 'paths'
"$SKILLS/zen-review/scripts/check-paths.sh"
rc=$?
if [ "$rc" -eq 0 ]; then
    verdict 'paths' 'ok' 0
else
    verdict 'paths' 'candidates to explain or fix' 1
fi

step 'memory'
"$SKILLS/zen-memory/scripts/check-instructions.sh"
rc=$?
if [ "$rc" -eq 0 ]; then
    verdict 'memory' 'ok' 0
else
    verdict 'memory' 'the house rules are missing or stale' 1
fi

step 'spec-sync'
if [ -f SPECIFICATION.md ]; then
    # `status` reports a tampered baseline rather than failing on one, so the
    # verdict has to read what it said.
    state="$("$SKILLS/zen-spec-sync/scripts/snapshot.sh" status)"
    rc=$?
    printf '%s\n' "$state"
    if [ "$rc" -ne 0 ]; then
        verdict 'spec-sync' "exit $rc" 1
    elif printf '%s' "$state" | grep -q 'mode: tampered'; then
        verdict 'spec-sync' 'the baseline does not match its own manifest' 1
    else
        verdict 'spec-sync' "$(printf '%s' "$state" | sed -n 's/^mode: /mode /p')" 0
    fi
else
    echo "no SPECIFICATION.md — this project keeps no spec-sync record"
    verdict 'spec-sync' 'not applicable' 0
fi

step 'summary'
printf '%s' "$SUMMARY"
exit "$WORST"
