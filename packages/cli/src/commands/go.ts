import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { versionDir } from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import { json, note, usageError, write } from '../term.ts';

const USAGE = 'zn go [project] [--version-dir <vN>] [--root]';

interface Flags {
    'version-dir'?: string;
    root?: boolean;
}

/**
 * A child process cannot change its parent's working directory, so this prints
 * the path and stops. `zn shell-init` supplies the wrapper that turns the
 * printed path into a `cd` — the same arrangement zoxide, nvm and direnv use,
 * for the same reason.
 */
export const go: Command = {
    summary: "Print a project's active version directory, for the shell to cd to.",
    usage: USAGE,
    details: [
        'Add the wrapper to your shell to make it change directory:',
        '    eval "$(zn shell-init zsh)"',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            { 'version-dir': { type: 'string' }, root: { type: 'boolean' } },
            USAGE,
        );

        const found = await resolveProject({
            cwd: ctx.cwd,
            project: one(positionals, 'project', USAGE),
        });
        const dir = values.root ? found.dir : versionDir(found, values['version-dir']);

        if (ctx.json) {
            json({ name: found.meta.name, path: dir, root: found.dir });
            return;
        }
        write(dir);
        if (process.stdout.isTTY) {
            note('(to cd here, add the wrapper: eval "$(zn shell-init zsh)")');
        }
    },
};

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

const SHELLS = ['zsh', 'bash', 'fish'] as const;

type Shell = (typeof SHELLS)[number];

const SHELL_USAGE = `zn shell-init [${SHELLS.join('|')}]`;

/**
 * Only `zn go` is intercepted and everything else is passed straight through,
 * so the wrapper never needs updating when a command is added. `--json` opts
 * out: a caller asking for a machine-readable answer wants the answer, not a
 * directory change.
 */
function script(shell: Shell): string {
    if (shell === 'fish') {
        return `function zn --wraps zn
    if test (count $argv) -ge 1 -a "$argv[1]" = "go"; and not contains -- --json $argv
        set -l target (command zn $argv); or return $status
        test -n "$target"; and cd $target
    else
        command zn $argv
    end
end`;
    }
    return `zn() {
    if [ "$1" != "go" ]; then
        command zn "$@"
        return $?
    fi
    case " $* " in
        *" --json "*) command zn "$@"; return $? ;;
    esac
    local target
    target="$(command zn "$@")" || return $?
    [ -n "$target" ] && cd "$target"
}`;
}

export const shellInit: Command = {
    summary: 'Print a shell function that makes `zn go` change directory.',
    usage: SHELL_USAGE,
    details: ['Add to your rc file:', '    eval "$(zn shell-init zsh)"'],
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
