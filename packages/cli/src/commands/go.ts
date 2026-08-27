import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { project as resolveProject } from '../resolve.ts';
import { json, note, usageError, write } from '../term.ts';

const USAGE = 'zen go [project]';

/**
 * A child process cannot change its parent's working directory, so this prints
 * the path and stops. `zen shell-init` supplies the wrapper that turns the
 * printed path into a `cd` — the same arrangement zoxide, nvm and direnv use,
 * for the same reason.
 */
export const go: Command = {
    summary: "Print a project's directory, for the shell to cd to.",
    usage: USAGE,
    details: [
        'Add the wrapper to your shell to make it change directory:',
        '    eval "$(zen shell-init zsh)"',
    ],
    run: async (ctx) => {
        const { positionals } = parse(ctx.args, {}, USAGE);

        const found = await resolveProject({
            cwd: ctx.cwd,
            project: one(positionals, 'project', USAGE),
        });
        const dir = found.dir;

        if (ctx.json) {
            json({ name: found.name, path: dir });
            return;
        }
        write(dir);
        if (process.stdout.isTTY) {
            note('(to cd here, add the wrapper: eval "$(zen shell-init zsh)")');
        }
    },
};

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

const SHELLS = ['zsh', 'bash', 'fish'] as const;

type Shell = (typeof SHELLS)[number];

const SHELL_USAGE = `zen shell-init [${SHELLS.join('|')}]`;

/**
 * Only `zen go` is intercepted and everything else is passed straight through,
 * so the wrapper never needs updating when a command is added. `--json` opts
 * out: a caller asking for a machine-readable answer wants the answer, not a
 * directory change.
 *
 * `zn` is defined as a call to the `zen` function rather than a second copy of
 * it, so the short name behaves identically without the logic existing twice.
 */
function script(shell: Shell): string {
    if (shell === 'fish') {
        return `function zen --wraps zen
    if test (count $argv) -ge 1 -a "$argv[1]" = "go"; and not contains -- --json $argv
        set -l target (command zen $argv); or return $status
        test -n "$target"; and cd $target
    else
        command zen $argv
    end
end

function zn --wraps zen
    zen $argv
end`;
    }
    return `zen() {
    if [ "$1" != "go" ]; then
        command zen "$@"
        return $?
    fi
    case " $* " in
        *" --json "*) command zen "$@"; return $? ;;
    esac
    local target
    target="$(command zen "$@")" || return $?
    [ -n "$target" ] && cd "$target"
}

zn() { zen "$@"; }`;
}

export const shellInit: Command = {
    summary: 'Print a shell function that makes `zen go` change directory.',
    usage: SHELL_USAGE,
    details: ['Add to your rc file:', '    eval "$(zen shell-init zsh)"'],
    run: async (ctx) => {
        const { positionals } = parse(ctx.args, {}, SHELL_USAGE);
        write(script(pick(one(positionals, 'shell', SHELL_USAGE))));
    },
};

function pick(asked: string | undefined): Shell {
    if (asked === undefined) {
        // $SHELL is the login shell, which is the one with the rc file the
        // output is going to be pasted into.
        const from = process.env.SHELL ?? '';
        return SHELLS.find((s) => from.endsWith(s)) ?? 'zsh';
    }
    if (!(SHELLS as readonly string[]).includes(asked)) {
        throw usageError(`no wrapper for "${asked}"`, `known shells: ${SHELLS.join(', ')}`);
    }
    return asked as Shell;
}
