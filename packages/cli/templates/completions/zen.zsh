# zen completion for zsh. Add to ~/.zshrc:
#
#     eval "$(zen completion zsh)"
#
# Everything it offers comes from `zen __complete`; when that has nothing to
# say, file names are completed instead.
_zen() {
    local line
    local -a items
    for line in "${(@f)$("${words[1]}" __complete "${(@)words[2,CURRENT]}" 2>/dev/null)}"; do
        [[ -n $line ]] || continue
        if [[ $line == *$'\t'* ]]; then
            items+=("${${line%%$'\t'*}//:/\\:}:${line#*$'\t'}")
        else
            items+=("${line//:/\\:}")
        fi
    done
    if (( $#items )); then
        _describe -t zen-words 'zen' items
    else
        _files
    fi
}

if (( ! $+functions[compdef] )); then
    autoload -Uz compinit && compinit
fi
compdef _zen zen zn zenera
