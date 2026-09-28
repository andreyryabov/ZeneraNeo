#!/usr/bin/env bash
#
# Choose the next fine-tuning batch out of .finetune/dataset.json.
#
#   sample.sh                             every sample, in stratified order
#   sample.sh -n 16                       sixteen, spread evenly over the strata
#   sample.sh -n 16 --class planning      sixteen out of one class
#   sample.sh --rubric-only -o cases.json only the graded ones, to a file
#
# A stratum is one class x one complexity. The sample is taken one item at a
# time from each stratum in turn, so a budget that cannot afford the dataset
# still buys a cross-section of it rather than the front of the file. Inside a
# stratum, samples carrying a rubric come first: a graded run says why it
# failed, an ungraded one only says what it did.
#
# Deterministic. The same --seed over the same dataset picks the same batch, so
# a re-run after a prompt change is a comparison and not a new experiment.
#
# What it writes is a `zen run batch --input` file: { "batch": [ {id, input} ] }.
# Relative media paths inside `input` resolve against the file they are written
# in, so -o somewhere other than beside the dataset needs absolute paths in it.
#
# Run it from anywhere; it finds the project root from its own location, which
# `zen init` and `zen open` fix. See .github/skills/zen-finetune/SKILL.md.

set -eu
cd "$(dirname "$0")/../../../.."

DATASET=.finetune/dataset.json
LIMIT=0
CLASS=""
COMPLEXITY=""
RUBRIC_ONLY=0
SEED=1
OUT=""

usage() {
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
    echo
    echo "  -d <file>           dataset; default $DATASET"
    echo "  -n <N>              budget; default every sample"
    echo "  -o <file>           where to write; default stdout"
    echo "  --class <name>      one class only"
    echo "  --complexity <lvl>  one complexity only"
    echo "  --rubric-only       drop samples with no rubric"
    echo "  --seed <n>          shuffle seed; default $SEED"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -d) DATASET="${2:?-d needs a file}"; shift 2 ;;
        -n) LIMIT="${2:?-n needs a number}"; shift 2 ;;
        -o) OUT="${2:?-o needs a file}"; shift 2 ;;
        --class) CLASS="${2:?--class needs a name}"; shift 2 ;;
        --complexity) COMPLEXITY="${2:?--complexity needs a level}"; shift 2 ;;
        --rubric-only) RUBRIC_ONLY=1; shift ;;
        --seed) SEED="${2:?--seed needs a number}"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        *)
            echo "sample.sh: unknown argument $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if ! command -v jq > /dev/null 2>&1; then
    echo "sample.sh: jq is required" >&2
    exit 2
fi

if [ ! -f "$DATASET" ]; then
    echo "sample.sh: no $DATASET" >&2
    echo "  build it first: see .github/skills/zen-finetune/SKILL.md, phase 1" >&2
    exit 2
fi

case "$LIMIT$SEED" in
    *[!0-9]*)
        echo "sample.sh: -n and --seed take whole numbers" >&2
        exit 2
        ;;
esac

# ---------------------------------------------------------------------------
# The dataset has to be sound before it is worth sampling. An id names a
# directory under the batch dir, and `zen run batch` refuses a bad one item by
# item, halfway through a long run. Refuse it here instead, all at once.
# ---------------------------------------------------------------------------

if ! jq -e '.samples | type == "array" and length > 0' "$DATASET" > /dev/null 2>&1; then
    echo "sample.sh: $DATASET has no non-empty \"samples\" array" >&2
    exit 2
fi

BAD="$(jq -r '
    .samples[]
    | select((.id | type) != "string"
             or (.id | test("^[A-Za-z0-9_.-]+$") | not)
             or .id == "." or .id == "..")
    | (.id | tostring)' "$DATASET")"
if [ -n "$BAD" ]; then
    echo "sample.sh: these ids cannot name a directory:" >&2
    echo "$BAD" | sed 's/^/  /' >&2
    echo "  letters, digits, dot, dash and underscore only" >&2
    exit 2
fi

DUPES="$(jq -r '[.samples[].id] | group_by(.) | map(select(length > 1) | .[0]) | .[]' "$DATASET")"
if [ -n "$DUPES" ]; then
    echo "sample.sh: duplicate ids in $DATASET:" >&2
    echo "$DUPES" | sed 's/^/  /' >&2
    exit 2
fi

MISSING="$(jq -r '.samples[] | select(.input == null) | .id' "$DATASET")"
if [ -n "$MISSING" ]; then
    echo "sample.sh: these samples have no \"input\":" >&2
    echo "$MISSING" | sed 's/^/  /' >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# The sample
#
# Lehmer's generator gives the shuffle: s = s * 48271 mod 2^31-1, which stays
# exact in a double and so gives the same order on every machine jq runs on.
# Strata are interleaved rather than concatenated, which is what makes a short
# budget a cross-section; rubric-bearing samples sort to the front of each.
# ---------------------------------------------------------------------------

PROGRAM='
def lehmer($s): ($s * 48271) % 2147483647;

(($seed | tonumber) % 2147483646 + 1) as $s0
| [ .samples[]
    | select($class == "" or (.class // "") == $class)
    | select($complexity == "" or (.complexity // "") == $complexity)
    | select($rubric == "0" or ((.rubric // []) | length) > 0) ] as $in
| [ foreach range(0; ($in | length)) as $i ($s0; lehmer(.); .) ] as $r
| [ range(0; ($in | length))
    | . as $i
    | { s: $in[$i],
        k: $r[$i],
        st: ((($in[$i].class // "unclassified") + " / "
              + ($in[$i].complexity // "unrated"))),
        rb: (if (($in[$i].rubric // []) | length) > 0 then 0 else 1 end) } ]
| group_by(.st)
| map(sort_by(.rb, .k))
| . as $g
| ((map(length) | max) // 0) as $m
| [ range(0; $m) as $i | $g[] | select(length > $i) | .[$i] ]
| (if ($n | tonumber) > 0 then .[0:($n | tonumber)] else . end)
| .[].s
'

SELECTED="$(jq -c \
    --arg class "$CLASS" \
    --arg complexity "$COMPLEXITY" \
    --arg rubric "$RUBRIC_ONLY" \
    --arg seed "$SEED" \
    --arg n "$LIMIT" \
    "$PROGRAM" "$DATASET")"

COUNT="$(printf '%s' "$SELECTED" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then
    echo "sample.sh: nothing matched" >&2
    if [ -n "$CLASS" ] || [ -n "$COMPLEXITY" ] || [ "$RUBRIC_ONLY" -eq 1 ]; then
        echo "  the filters may be narrower than the dataset; what is in it:" >&2
        jq -r '.samples[] | "  " + (.class // "unclassified") + " / "
               + (.complexity // "unrated")' "$DATASET" | sort | uniq -c >&2
    fi
    exit 1
fi

# The batch file itself. Only `id` and `input`: a rubric is not part of a run
# request, and the dataset stays the one place it is written down. The id is
# the join back to it, and the name of the item's directory in the batch.
CASES="$(printf '%s\n' "$SELECTED" | jq -s '{ batch: map({ id, input }) }')"

if [ -n "$OUT" ]; then
    mkdir -p "$(dirname "$OUT")"
    printf '%s\n' "$CASES" > "$OUT"
else
    printf '%s\n' "$CASES"
fi

# What was taken, and from where, on stderr so it survives a redirect of the
# cases file. A round that looks lopsided here will grade lopsided too.
{
    echo
    echo "sample.sh: $COUNT of $(jq '.samples | length' "$DATASET") samples${OUT:+ -> $OUT}"
    printf '%s\n' "$SELECTED" \
        | jq -r '"  " + (.class // "unclassified") + " / " + (.complexity // "unrated")
                 + (if ((.rubric // []) | length) > 0 then "  [rubric]" else "" end)' \
        | sort | uniq -c
    GRADED="$(printf '%s\n' "$SELECTED" | jq -r 'select(((.rubric // []) | length) > 0) | .id' | grep -c . || true)"
    echo "  $GRADED with a rubric, seed $SEED"
} >&2
