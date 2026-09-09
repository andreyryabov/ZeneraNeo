#!/usr/bin/env bash
#
# The one command that initialises this project.
#
#   scripts/_setup.sh            do whatever is not done yet
#   scripts/_setup.sh --force    do all of it again
#
# Anything that has to be in place before a run — an index built, a document
# fetched, a file generated — is a script in this directory rather than a
# paragraph somebody is meant to follow. The leading underscore is what
# separates the runner from the steps it runs.
#
# Each step is `scripts/<name>.sh`, named below in the order they depend on
# each other. A step:
#
#   - starts `set -eu` and `cd "$(dirname "$0")/.."`, so it works from anywhere
#   - takes no arguments, and reads $FORCE to know whether to redo finished work
#   - exits 0 when it did the work, 3 when there was nothing to do, non-zero
#     when it failed
#   - writes under .tmp/ and moves the result into place, so an interrupted run
#     never leaves half an artefact behind
#
# Running this twice has to be safe, and the second run is what proves it: every
# step should report `skipped`.

set -eu
cd "$(dirname "$0")/.."

FORCE=0
if [ "${1:-}" = "--force" ]; then
    FORCE=1
fi
export FORCE

LOGS=.tmp/logs

# The steps, in order. Nothing here yet — a project with nothing to build
# before it runs is a project with no steps, and that is a real answer.
#
# An example of what one looks like, for when there is something to build:
#
#   STEPS="docs_index"
#
# with scripts/docs_index.sh holding
#
#   set -eu
#   cd "$(dirname "$0")/.."
#   if [ "${FORCE:-0}" = 0 ] && [ -f assets/docs-db/manifest.json ]; then
#       echo "assets/docs-db is already built"
#       exit 3
#   fi
#   rm -rf .tmp/docs-db
#   zen rag docs index assets/docs \
#       --embedding openai:text-embedding-3-small --out .tmp/docs-db
#   rm -rf assets/docs-db
#   mv .tmp/docs-db assets/docs-db
#
STEPS=""

if [ -z "$STEPS" ]; then
    echo "nothing to set up — this project builds nothing before it runs"
    exit 0
fi

mkdir -p "$LOGS"
summary=""
failed=0

for name in $STEPS; do
    log="$LOGS/setup-$name.log"
    echo
    echo "-- $name  $(date '+%H:%M:%S')  ($log)"

    # Watched rather than waited on: the output goes to the screen and to its
    # own log at once, so a long step can be followed from either.
    set +e
    "scripts/$name.sh" 2>&1 | tee "$log"
    code=${PIPESTATUS[0]}
    set -e

    case "$code" in
        0) word=ok ;;
        3) word=skipped ;;
        *)
            word="failed ($code)"
            failed=1
            ;;
    esac
    summary="${summary}  ${name}: ${word}
"
    # Later steps depend on earlier ones, so a failure stops rather than
    # producing a second failure that is only a consequence of the first.
    if [ "$failed" = 1 ]; then
        break
    fi
done

echo
echo "setup:"
printf '%s' "$summary"
exit "$failed"
