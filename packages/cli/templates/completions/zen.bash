# zen completion for bash. Add to ~/.bashrc:
#
#     eval "$(zen completion bash)"
#
# Everything it offers comes from `zen __complete`; when that has nothing to
# say, file names are completed instead (`-o default`).
_zen() {
    local out value
    COMPREPLY=()
    out=$("${COMP_WORDS[0]}" __complete "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) || return 0
    while IFS=$'\t' read -r value _; do
        [[ -n $value ]] && COMPREPLY+=("$value")
    done <<< "$out"
}

complete -o default -F _zen zen zn zenera
