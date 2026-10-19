# zen completion for fish. Save as ~/.config/fish/completions/zen.fish, or:
#
#     zen completion fish | source
#
# Everything it offers comes from `zen __complete`; when that has nothing to
# say, file names are completed instead.
function __zen_complete
    set -l words (commandline -opc)
    set -l cur (commandline -ct)
    set -l program $words[1]
    set -e words[1]
    set -l found (command $program __complete $words "$cur" 2>/dev/null)
    if test (count $found) -gt 0
        printf '%s\n' $found
    else
        __fish_complete_path "$cur"
    end
end

for program in zen zn zenera
    complete -c $program -f -a '(__zen_complete)'
end
