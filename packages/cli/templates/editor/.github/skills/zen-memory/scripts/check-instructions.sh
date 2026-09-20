#!/usr/bin/env bash
#
# Whether this project's memory house rules are still the rules.
#
#   check-instructions.sh          diff the copy against the reference
#   check-instructions.sh diff     the same, showing every differing line
#   check-instructions.sh fix      overwrite the copy from the reference
#
# `agents/memory-instructions.md` is a *copy* of the `zen-memory` skill's
# `references/memory-instructions.md`, and the reference is rewritten by every
# `zen init` and `zen open`. So the copy goes stale silently, and it drifts by
# trailing whitespace inside tables, which no one can see by reading. That is
# the whole reason this is a script and not a checklist line.
#
# Run it from anywhere; it finds the project root from its own location.

set -eu
cd "$(dirname "$0")/../../../.."

COPY=agents/memory-instructions.md
REFERENCE=.github/skills/zen-memory/references/memory-instructions.md
REMEDY="cp $REFERENCE $COPY"

if [ ! -f "$REFERENCE" ]; then
    echo "check-instructions.sh: no $REFERENCE in $PWD" >&2
    echo "check-instructions.sh: run \`zen open\` to rewrite the .github tree" >&2
    exit 2
fi

# The project turns memory on when something declares it — the top-level block
# or an agent's binding — so any `memory:` key in the configuration counts.
# The config is found by name, in the order a run finds it.
config() {
    for file in agents.yaml agents.yml agents/agents.yaml agents/agents.yml; do
        if [ -f "$file" ]; then
            echo "$file"
            return 0
        fi
    done
}

uses_memory() {
    # `|| true` because no configuration at all is an answer, not a failure.
    conf="$(config || true)"
    if [ -z "$conf" ]; then
        return 1
    fi
    grep -Eq '^[[:space:]]*(-[[:space:]]+)?memory:' "$conf"
}

# The file with every line's trailing whitespace removed. Two of these being
# equal is the drift nobody can see by reading, named as such.
trimmed() {
    sed 's/[[:space:]]*$//' "$1"
}

report() {
    if uses_memory; then
        echo "memory: on"
    else
        echo "memory: off"
    fi

    if [ ! -f "$COPY" ]; then
        if uses_memory; then
            echo "missing: $COPY"
            echo "remedy: $REMEDY"
            return 1
        fi
        echo "ok: no copy, and nothing needs one"
        return 0
    fi

    if cmp -s "$REFERENCE" "$COPY"; then
        if ! uses_memory; then
            # Harmless, but it is rules for a capability nothing turned on.
            echo "note: the copy is current, but no agent has a memory: binding"
        fi
        echo "ok: $COPY is the reference, byte for byte"
        return 0
    fi

    echo "drift: $COPY differs from the reference"
    # Said out loud because it is invisible on screen, and is the usual cause:
    # a trailing space inside a table, or a lost final newline.
    if [ "$(trimmed "$REFERENCE")" = "$(trimmed "$COPY")" ]; then
        echo "drift: trailing whitespace only — nothing you could have seen"
    fi
    echo "remedy: $REMEDY"
    return 1
}

show_diff() {
    report || true
    # `-L` names the two sides, since both files are called the same thing.
    diff -u -L reference -L "$COPY" "$REFERENCE" "$COPY" || true
    # The report's verdict, not the diff's.
    report >/dev/null
}

fix() {
    cp "$REFERENCE" "$COPY"
    echo "wrote: $COPY"
    echo "note: project policy belongs in agents/memory-policy-instructions.md,"
    echo "      which must open with '---' / 'requires: [memory]' / '---'"
}

case "${1:-status}" in
    status) report ;;
    diff) show_diff ;;
    fix) fix ;;
    *)
        echo "usage: check-instructions.sh [status|diff|fix]" >&2
        exit 2
        ;;
esac
