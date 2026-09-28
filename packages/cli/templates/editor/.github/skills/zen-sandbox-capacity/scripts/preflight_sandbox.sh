#!/usr/bin/env bash
#
# Whether this machine can run the batch you are about to start.
#
#   preflight_sandbox.sh --concurrency 8      the gate: exit 0 fits, 1 does not
#   preflight_sandbox.sh --skip-probe         the free half, in about a second
#   preflight_sandbox.sh --peak-rss 912       use a figure you measured yourself
#
# Containers do not run on the host. On macOS they run inside one podman virtual
# machine whose memory is fixed, is not the host's, and is 2 GiB by default — so
# eight concurrent containers over a multi-gigabyte index thrash and are killed
# while the host sits nearly empty. The symptom is exit 124, which everybody
# already has a theory about, so the VM is the last thing anyone looks at.
#
# Two bounds are reported, because they fail for different reasons:
#
#   admission     concurrency x sandbox.memory <= vm_memory
#                 what podman will permit to be allocated. Static and free.
#   working set   largest_index + concurrency x peak_rss + 1 GiB <= vm_memory
#                 what the work actually wants. The index is counted once: it
#                 is page cache in the VM and every container shares it.
#
# It measures; it never changes anything. `podman machine set` needs the machine
# stopped, which kills every running container, so that command is printed and
# handed over rather than run.
#
# Exit 0 sufficient, 1 insufficient, 3 not applicable. See
# .github/skills/zen-sandbox-capacity/SKILL.md.

set -eu

# Taken before the cd, or a relative $0 stops naming this file.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../../../.."

CONCURRENCY=1
ASSETS=assets
SKIP_PROBE=0
PEAK_RSS=0
AS_JSON=0
PROBE_TIMEOUT=25

# A node-based agent container costs this much before it has done anything, so
# a generic probe that measures less than it has measured the probe, not the
# agent. Override with a real figure using --peak-rss.
# A gate that guesses should guess high: guessing low returns a cheerful "ok"
# and the batch dies anyway. 1024 is a round number just above the only figure
# anyone has actually measured here (912 MiB), so an unprobed answer errs
# toward refusing. Pass --peak-rss with a real number and this is unused.
PEAK_FLOOR_MIB=1024
HEADROOM_MIB=1024

# What zen scaffolds when `sandbox:` names neither, and what `strict` uses.
DEFAULT_CONTAINER_MIB=4096
STRICT_CONTAINER_MIB=2048

usage() {
    sed -n '3,7p' "$SELF" | sed 's/^# \{0,1\}//'
    echo
    echo "  --concurrency <n>   batch width to answer for; default $CONCURRENCY"
    echo "  --assets <dir>      where the indexes are; default $ASSETS"
    echo "  --skip-probe        admission bound only; starts no container"
    echo "  --peak-rss <MiB>    a measured per-container figure, instead of sampling"
    echo "  --json              the same answer as data"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --concurrency | -c) CONCURRENCY="${2:?--concurrency needs a number}"; shift 2 ;;
        --assets) ASSETS="${2:?--assets needs a directory}"; shift 2 ;;
        --peak-rss) PEAK_RSS="${2:?--peak-rss needs a number of MiB}"; shift 2 ;;
        --skip-probe) SKIP_PROBE=1; shift ;;
        --json) AS_JSON=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *)
            echo "preflight_sandbox.sh: unknown argument $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

case "$CONCURRENCY$PEAK_RSS" in
    *[!0-9]*)
        echo "preflight_sandbox.sh: --concurrency and --peak-rss take whole numbers" >&2
        exit 2
        ;;
esac
if [ "$CONCURRENCY" -lt 1 ]; then
    echo "preflight_sandbox.sh: --concurrency must be at least 1" >&2
    exit 2
fi

NOTES=""
note() {
    NOTES="$NOTES$1
"
}

mib() { awk -v b="$1" 'BEGIN { printf "%d", b / 1048576 }'; }
gib() { awk -v m="$1" 'BEGIN { printf "%.1f", m / 1024 }'; }

# Everything below prints through here, so --json can suppress the prose without
# every site having to know about it.
say() {
    if [ "$AS_JSON" -eq 0 ]; then printf '%s\n' "$1"; fi
}

# ---------------------------------------------------------------------------
# 1. Does this apply at all
#
# Three ways not to. Each is a real answer and none of them is a failure, so
# they share exit 3 and each says what could not be checked rather than what
# went wrong.
# ---------------------------------------------------------------------------

not_applicable() {
    if [ "$AS_JSON" -eq 1 ]; then
        printf '{"applicable":false,"reason":%s}\n' "\"$1\""
    else
        echo "not applicable: $1"
        if [ -n "$2" ]; then echo "  $2"; fi
    fi
    exit 3
}

if ! command -v podman > /dev/null 2>&1; then
    not_applicable "podman is not on PATH" \
        "nothing here is measurable; install podman, or run \`zen sandbox up\`"
fi

if [ "$(uname -s)" = "Linux" ]; then
    not_applicable "podman is native on Linux — there is no VM to be the ceiling" \
        "containers here are bounded by the host and by cgroups, not by a machine"
fi

CONF=""
for candidate in agents.yaml agents.yml agents/agents.yaml agents/agents.yml; do
    if [ -f "$candidate" ]; then CONF="$candidate"; break; fi
done
if [ -z "$CONF" ]; then
    not_applicable "no agents.yaml in $PWD" \
        "run this from a project, or from anywhere inside one"
fi
if ! grep -Eq 'sandbox:(\*|run_command|run_command_background|read_command_output|stop_command)' "$CONF"; then
    not_applicable "no agent in $CONF holds a sandbox tool" \
        "no container is ever started, so capacity cannot be the fault"
fi

# ---------------------------------------------------------------------------
# 2. The host
#
# It bounds what the VM may be given and it is where `zen run batch` itself
# runs, which has been OOM-killed in its own right. Free pages are the ones
# that could be handed to a resize today.
# ---------------------------------------------------------------------------

HOST_MIB="$(mib "$(sysctl -n hw.memsize 2> /dev/null || echo 0)")"
HOST_FREE_MIB=0
if command -v vm_stat > /dev/null 2>&1; then
    HOST_FREE_MIB="$(
        vm_stat 2> /dev/null | awk '
            /page size of/ { gsub(/[^0-9]/, "", $8); ps = $8 }
            /Pages free/ || /Pages inactive/ { gsub(/[^0-9]/, "", $NF); p += $NF }
            END { printf "%d", (ps ? ps : 4096) * p / 1048576 }' || true
    )"
fi

# ---------------------------------------------------------------------------
# 3. The VM — the ceiling
#
# `podman info` is the authority because it reports the machine as it is
# running, swap included. A machine that is stopped cannot answer, so the
# configured size from `machine list` stands in and is labelled as such.
# ---------------------------------------------------------------------------

VM_MIB=0
VM_SWAP_MIB=0
VM_CPUS=0
VM_NAME=""
VM_STATE=running

INFO="$(podman info --format '{{.Host.MemTotal}} {{.Host.SwapTotal}} {{.Host.CPUs}}' 2> /dev/null || true)"
case "$INFO" in
    [0-9]*)
        VM_MIB="$(mib "$(echo "$INFO" | awk '{print $1}')")"
        VM_SWAP_MIB="$(mib "$(echo "$INFO" | awk '{print $2}')")"
        VM_CPUS="$(echo "$INFO" | awk '{print $3}')"
        ;;
    *) VM_STATE=stopped ;;
esac

# `Memory` is bytes on podman 4 and a string like `2GiB` on podman 5, so it is
# normalised rather than trusted. Read whatever the state, for the name.
MACHINE="$(podman machine list --format '{{.Name}} {{.Memory}} {{.CPUs}} {{.Running}}' 2> /dev/null | head -1 || true)"
if [ -n "$MACHINE" ]; then
    # `list` marks the default machine with a trailing asterisk.
    VM_NAME="$(echo "$MACHINE" | awk '{print $1}' | sed 's/\*$//')"
    if [ "$VM_STATE" = stopped ]; then
        VM_MIB="$(
            echo "$MACHINE" | awk '{
                v = $2
                n = v + 0
                if (v ~ /GiB|GB|[Gg]$/) n = n * 1024
                else if (v ~ /MiB|MB|[Mm]$/) n = n
                else if (n > 1073741823) n = n / 1048576
                printf "%d", n
            }' || true
        )"
        VM_CPUS="$(echo "$MACHINE" | awk '{print $3}')"
    fi
fi

if [ "$VM_STATE" = stopped ]; then
    note "the podman machine is not running, so these are its configured sizes, not live ones"
    note "  start it to measure: podman machine start"
fi
if [ "$VM_MIB" -eq 0 ]; then
    not_applicable "podman could not report the machine's memory" \
        "try \`podman machine start\`, then run this again"
fi

# ---------------------------------------------------------------------------
# 4. The container cap, out of agents.yaml
#
# A numeric `memory:` can only be the sandbox's: the memory *graph* block takes
# a directory and an embedding, and an agent's binding takes a boolean or a map.
# Per-agent overrides are read too, and the largest wins — it is the one that
# decides whether the sum fits.
# ---------------------------------------------------------------------------

CONTAINER_MIB="$(
    grep -E '^[[:space:]]+memory:[[:space:]]*[0-9]+[[:space:]]*(#.*)?$' "$CONF" 2> /dev/null \
        | sed -E 's/.*memory:[[:space:]]*([0-9]+).*/\1/' | sort -n | tail -1 || true
)"
CONTAINER_SOURCE="$CONF"
if [ -z "$CONTAINER_MIB" ]; then
    if grep -Eq '^[[:space:]]+hardening:[[:space:]]*strict' "$CONF"; then
        CONTAINER_MIB="$STRICT_CONTAINER_MIB"
        CONTAINER_SOURCE="default (strict)"
    else
        CONTAINER_MIB="$DEFAULT_CONTAINER_MIB"
        CONTAINER_SOURCE="default"
    fi
fi

CONTAINER_CPUS="$(
    grep -E '^[[:space:]]+cpus:[[:space:]]*[0-9]+' "$CONF" 2> /dev/null \
        | sed -E 's/.*cpus:[[:space:]]*([0-9]+).*/\1/' | sort -n | tail -1 || true
)"
CONTAINER_CPUS="${CONTAINER_CPUS:-4}"

if [ "$CONTAINER_MIB" -eq 0 ]; then
    note "sandbox.memory is 0 — unconstrained, so one container may take the whole VM"
    CONTAINER_MIB="$VM_MIB"
fi

# ---------------------------------------------------------------------------
# 5. The indexes
#
# An index is read through the page cache and the cache lives in the VM, so an
# index larger than the VM cannot be cached at all — which is the difference
# between a five-second grep and a two-minute one. Counted once: the mount is
# read-only and shared by every container.
# ---------------------------------------------------------------------------

INDEX_MIB=0
INDEX_NAME=""
INDEX_COUNT=0
if [ -d "$ASSETS" ]; then
    while IFS= read -r manifest; do
        [ -n "$manifest" ] || continue
        dir="$(dirname "$manifest")"
        size="$(du -sk "$dir" 2> /dev/null | awk '{printf "%d", $1 / 1024}' || echo 0)"
        INDEX_COUNT=$((INDEX_COUNT + 1))
        if [ "${size:-0}" -gt "$INDEX_MIB" ]; then
            INDEX_MIB="$size"
            INDEX_NAME="$dir"
        fi
    done <<EOF
$(find "$ASSETS" -maxdepth 3 -name manifest.json -type f 2> /dev/null || true)
EOF
fi

# ---------------------------------------------------------------------------
# 6. The probe — one container, one real read, peak RSS while it runs
#
# Process RSS, deliberately, not the cgroup's `memory.current`: that includes
# page cache, and the index is already a term of its own in the budget. Summing
# VmRSS across /proc inside the container is exactly the container's processes,
# because it has its own pid namespace.
#
# The command is `local` — it makes no network call. A gate that needed a
# credential would fail for reasons that are not about this machine.
# ---------------------------------------------------------------------------

PROBE_NAME=none
PROBE_SECS=0
SAMPLED_MIB=0

probe() {
    if [ -z "$INDEX_NAME" ]; then
        note "no index under ${ASSETS}/ to read — nothing representative to probe"
        return 0
    fi
    image="${ZEN_IMAGE:-$(zen sandbox status 2> /dev/null | awk '$1 == "image" { print $2 }' || true)}"
    if [ -z "$image" ]; then
        note "no sandbox image to probe with — run \`zen sandbox up\`, or pass --peak-rss"
        return 0
    fi
    PROBE_NAME="read $INDEX_NAME"

    # Passed as one argv element, so no second shell re-parses it. The loop
    # bounds itself rather than trusting `timeout` to be in the project's image.
    script="$(
        cat << EOS
( zen --version > /dev/null 2>&1; grep -rl zzzz-not-present /assets > /dev/null 2>&1 ) &
p=\$!
peak=0
ticks=0
while kill -0 \$p 2> /dev/null; do
    cur=\$(awk '/^VmRSS:/ { s += \$2 } END { print s + 0 }' /proc/[0-9]*/status 2> /dev/null)
    if [ "\${cur:-0}" -gt "\$peak" ]; then peak=\$cur; fi
    ticks=\$((ticks + 1))
    if [ \$ticks -gt $((PROBE_TIMEOUT * 5)) ]; then kill \$p 2> /dev/null; break; fi
    sleep 0.2
done
wait \$p 2> /dev/null
echo "PEAK_KB=\$peak"
EOS
    )"

    started="$(date +%s)"
    out="$(
        podman run --rm -v "$PWD/$ASSETS:/assets:ro" \
            --memory "${CONTAINER_MIB}m" --entrypoint="" \
            "$image" sh -c "$script" 2> /dev/null || true
    )"
    PROBE_SECS=$(($(date +%s) - started))

    kb="$(printf '%s' "$out" | sed -n 's/^PEAK_KB=\([0-9]*\)$/\1/p' | tail -1 || true)"
    if [ -n "${kb:-}" ] && [ "${kb:-0}" -gt 0 ]; then
        SAMPLED_MIB=$((kb / 1024))
    else
        note "the probe reported nothing — using the floor of ${PEAK_FLOOR_MIB} MiB"
    fi
}

if [ "$PEAK_RSS" -gt 0 ]; then
    PEAK_MIB="$PEAK_RSS"
    PEAK_SOURCE="--peak-rss"
elif [ "$SKIP_PROBE" -eq 1 ]; then
    PEAK_MIB="$PEAK_FLOOR_MIB"
    PEAK_SOURCE="floor (--skip-probe)"
else
    probe
    if [ "$SAMPLED_MIB" -gt "$PEAK_FLOOR_MIB" ]; then
        PEAK_MIB="$SAMPLED_MIB"
        PEAK_SOURCE="sampled at concurrency 1"
    elif [ "$SAMPLED_MIB" -gt 0 ]; then
        PEAK_MIB="$PEAK_FLOOR_MIB"
        PEAK_SOURCE="floor — the probe measured ${SAMPLED_MIB} MiB, below it"
    else
        # The probe did not run, or reported nothing. `note` has already said
        # which; do not claim a measurement that was never taken.
        PEAK_MIB="$PEAK_FLOOR_MIB"
        PEAK_SOURCE="floor (unmeasured)"
    fi
fi

# ---------------------------------------------------------------------------
# 7. The verdict
# ---------------------------------------------------------------------------

ADMITTED_MIB=$((CONCURRENCY * CONTAINER_MIB))
REQUIRED_MIB=$((INDEX_MIB + CONCURRENCY * PEAK_MIB + HEADROOM_MIB))

OVERSUBSCRIBED=0
if [ "$ADMITTED_MIB" -gt "$VM_MIB" ]; then OVERSUBSCRIBED=1; fi

SUFFICIENT=1
if [ "$REQUIRED_MIB" -gt "$VM_MIB" ]; then SUFFICIENT=0; fi

# The width that does fit today, which is the remedy available on every machine.
FITS=0
budget=$((VM_MIB - INDEX_MIB - HEADROOM_MIB))
if [ "$budget" -gt 0 ]; then FITS=$((budget / PEAK_MIB)); fi

# Rounded up to the next whole GiB, because `machine set` takes MiB and nobody
# wants a ceiling that is exact.
SUGGEST_MIB=$(((REQUIRED_MIB + 1023) / 1024 * 1024))

if [ "$AS_JSON" -eq 1 ]; then
    printf '{"applicable":true,"sufficient":%s,"oversubscribed":%s,' \
        "$([ "$SUFFICIENT" -eq 1 ] && echo true || echo false)" \
        "$([ "$OVERSUBSCRIBED" -eq 1 ] && echo true || echo false)"
    printf '"concurrency":%s,"hostMib":%s,"hostFreeMib":%s,' \
        "$CONCURRENCY" "$HOST_MIB" "$HOST_FREE_MIB"
    printf '"vm":{"name":"%s","state":"%s","memoryMib":%s,"swapMib":%s,"cpus":%s},' \
        "$VM_NAME" "$VM_STATE" "$VM_MIB" "$VM_SWAP_MIB" "$VM_CPUS"
    printf '"container":{"memoryMib":%s,"cpus":%s,"source":"%s"},' \
        "$CONTAINER_MIB" "$CONTAINER_CPUS" "$CONTAINER_SOURCE"
    printf '"index":{"largestMib":%s,"name":"%s","count":%s},' \
        "$INDEX_MIB" "$INDEX_NAME" "$INDEX_COUNT"
    printf '"peakRssMib":%s,"peakSource":"%s","probe":"%s","probeSeconds":%s,' \
        "$PEAK_MIB" "$PEAK_SOURCE" "$PROBE_NAME" "$PROBE_SECS"
    printf '"admittedMib":%s,"requiredMib":%s,"suggestMib":%s,"fitsAtConcurrency":%s}\n' \
        "$ADMITTED_MIB" "$REQUIRED_MIB" "$SUGGEST_MIB" "$FITS"
else
    say "host       $(gib "$HOST_MIB") GiB total · $(gib "$HOST_FREE_MIB") GiB free"
    swap="$VM_SWAP_MIB MiB swap"
    if [ "$VM_SWAP_MIB" -eq 0 ]; then swap="no swap — the kill is immediate, not gradual"; fi
    say "vm         $(gib "$VM_MIB") GiB total · $swap · ${VM_CPUS} cpus   ${VM_NAME:-?} ($VM_STATE)"
    say "container  ${CONTAINER_MIB} MiB cap · ${CONTAINER_CPUS} cpus   ${CONTAINER_SOURCE}"
    if [ "$INDEX_COUNT" -gt 0 ]; then
        say "index      $(gib "$INDEX_MIB") GiB  ${INDEX_NAME} (largest of ${INDEX_COUNT})"
    else
        say "index      none found under ${ASSETS}/"
    fi
    timing=""
    if [ "$PROBE_SECS" -gt 0 ]; then timing=" · probe ${PROBE_SECS}s"; fi
    say "peak rss   ${PEAK_MIB} MiB  ${PEAK_SOURCE}${timing}"
    say ""

    if [ "$OVERSUBSCRIBED" -eq 1 ]; then
        say "admission  ${CONCURRENCY} x ${CONTAINER_MIB} MiB = $(gib "$ADMITTED_MIB") GiB permitted against a $(gib "$VM_MIB") GiB vm   OVERSUBSCRIBED"
        if [ "$CONTAINER_MIB" -gt "$VM_MIB" ]; then
            say "           one container alone is permitted more than the whole machine"
        else
            say "           nothing will refuse the sum; only the containers not all"
            say "           peaking together is keeping this alive"
        fi
    fi

    if [ "$SUFFICIENT" -eq 1 ]; then
        say "concurrency ${CONCURRENCY} needs ~$(gib "$REQUIRED_MIB") GiB   vm has $(gib "$VM_MIB") GiB   ok"
    else
        say "concurrency ${CONCURRENCY} needs ~$(gib "$REQUIRED_MIB") GiB   vm has $(gib "$VM_MIB") GiB   INSUFFICIENT"
        say "  fix:  podman machine stop && podman machine set --memory ${SUGGEST_MIB} && podman machine start"
        if [ "$FITS" -ge 1 ]; then
            say "  or:   run the batch at --concurrency ${FITS}"
        else
            say "  or:   nothing fits — the index alone exceeds this vm; resizing is the only way"
        fi
        if [ "$SUGGEST_MIB" -gt "$HOST_MIB" ]; then
            say "  note: that is more than the host has. Lower the concurrency instead"
        fi
    fi

    if [ -n "$NOTES" ]; then
        say ""
        printf '%s' "$NOTES" | sed 's/^/note: /'
    fi
fi

if [ "$SUFFICIENT" -eq 1 ]; then exit 0; fi
exit 1
