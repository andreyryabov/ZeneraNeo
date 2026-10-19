import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { TEMPLATES } from '../scaffold.ts';
import { bold, confirm, usageError, write } from '../term.ts';

const USAGE = 'zen completion [<zsh|bash|fish>] [--install [--yes]]';

const SHELLS = ['zsh', 'bash', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

interface Flags {
    install?: boolean;
    yes?: boolean;
}

/** The startup file a shell reads for every interactive session. */
export function rcFile(shell: Shell, env: NodeJS.ProcessEnv = process.env): string {
    const home = homedir();
    switch (shell) {
        case 'zsh':
            return join(env['ZDOTDIR'] || home, '.zshrc');
        case 'bash': {
            // macOS terminals start login shells, which skip .bashrc.
            const rc = join(home, '.bashrc');
            const profile = join(home, '.bash_profile');
            return process.platform === 'darwin' && !existsSync(rc) && existsSync(profile)
                ? profile
                : rc;
        }
        case 'fish':
            return join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'fish', 'config.fish');
    }
}

/** The line that loads the script, as the shell's own startup file would say it. */
export function loader(shell: Shell): string {
    return shell === 'fish' ? 'zen completion fish | source' : `eval "$(zen completion ${shell})"`;
}

/** Whether `file` already loads the script — a commented-out line does not count. */
export function installed(shell: Shell, file: string): boolean {
    if (!existsSync(file)) {
        return false;
    }
    const loads = new RegExp(`^\\s*(?!#).*\\b(zen|zn|zenera)\\s+completion\\s+${shell}\\b`, 'm');
    return loads.test(readFileSync(file, 'utf8'));
}

/** Appends the loader to `file`, unless it is already there. */
export function install(shell: Shell, file: string): 'added' | 'present' {
    if (installed(shell, file)) {
        return 'present';
    }
    const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
    mkdirSync(dirname(file), { recursive: true });
    const gap = have === '' || have.endsWith('\n\n') ? '' : have.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(file, `${gap}# zen tab completion\n${loader(shell)}\n`);
    return 'added';
}

/**
 * Prints the shell's side of tab completion. The script is a few lines that
 * call back into `zen __complete`, so the project names and stored prompts it
 * offers are always read from the machine it runs on, never baked in.
 */
export const completion: Command = {
    summary: 'Print the tab-completion script for your shell.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Completion', subtitle: 'Shell Integration', hue: 'magenta' },
    quiet: () => true,
    details: [
        'Add one line to your shell’s startup file:',
        '  zsh    eval "$(zen completion zsh)"      in ~/.zshrc',
        '  bash   eval "$(zen completion bash)"     in ~/.bashrc',
        '  fish   zen completion fish | source      in ~/.config/fish/config.fish',
        '',
        'Or let zen do it — it appends that line to the file, once, after asking:',
        '  zen completion --install                 for the shell you are in',
        '  zen completion zsh --install --yes       without asking',
        '',
        'Then, in a new shell:',
        '  zen meta run my-project /<Tab>           the project’s stored prompts',
        '  zen meta <Tab>                           run, prompts, resume, model …',
        '  zen run <Tab>                            your projects',
        '',
        'The prompts are the files in .github/prompts/ — the same ones an editor',
        'offers as slash commands. Where there is nothing to offer, file names are.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            { install: { type: 'boolean' }, yes: { type: 'boolean' } },
            USAGE,
        );
        const shell = one(positionals, 'shell', USAGE) ?? basename(process.env.SHELL ?? '');
        if (!(SHELLS as readonly string[]).includes(shell)) {
            throw usageError(
                shell ? `no completion for "${shell}"` : 'which shell?',
                `try: zen completion ${SHELLS.join('|')}`,
            );
        }
        if (values.yes && !values.install) {
            throw usageError('--yes only goes with --install', USAGE);
        }
        if (values.install) {
            const file = rcFile(shell as Shell);
            if (installed(shell as Shell, file)) {
                write(`Already set up in ${file}.`);
                return;
            }
            const line = bold(loader(shell as Shell));
            if (!values.yes && !(await confirm(`Add ${line} to ${file}?`, true))) {
                write('Nothing changed.');
                return;
            }
            install(shell as Shell, file);
            write(`Added to ${file}. Open a new shell, or run: source ${file}`);
            return;
        }
        process.stdout.write(readFileSync(`${TEMPLATES}/completions/zen.${shell}`, 'utf8'));
    },
};
