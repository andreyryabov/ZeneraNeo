import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { install, installed, loader, rcFiles, shellOf } from '../completion-install.ts';
import { TEMPLATES } from '../scaffold.ts';
import { bold, confirm, usageError, write } from '../term.ts';

export { install, installed, loader, rcFile } from '../completion-install.ts';

const USAGE = 'zen completion [<zsh|bash|fish>] [--install [--yes]]';

interface Flags {
    install?: boolean;
    yes?: boolean;
}

/**
 * Prints the shell's side of tab completion. The script is a few lines that
 * call back into `zen __complete`, so the project names and commands it
 * offers are always read from the machine it runs on, never baked in.
 */
export const completion: Command = {
    summary: 'Print the tab-completion script for your shell.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Completion', subtitle: 'Shell Integration', hue: 'magenta' },
    quiet: () => true,
    details: [
        'Global npm installs set this up automatically. Open a new shell afterward.',
        '',
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
        '  zen meta run my-project /<Tab>           the project’s commands',
        '  zen meta <Tab>                           run, prompts, resume, model …',
        '  zen run <Tab>                            your projects',
        '',
        'The commands are the skills in .github/skills/ an editor offers as slash',
        'commands - not the zen-* ones, which are the model’s. Where there is nothing to offer, file names are.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            { install: { type: 'boolean' }, yes: { type: 'boolean' } },
            USAGE,
        );
        const name = one(positionals, 'shell', USAGE) ?? basename(process.env.SHELL ?? '');
        const shell = shellOf(name);
        if (!shell) {
            throw usageError(
                name ? `no completion for "${name}"` : 'which shell?',
                'try: zen completion zsh|bash|fish',
            );
        }
        if (values.yes && !values.install) {
            throw usageError('--yes only goes with --install', USAGE);
        }
        if (values.install) {
            const files = rcFiles(shell).filter((file) => !installed(shell, file));
            if (files.length === 0) {
                write(`Already set up in ${rcFiles(shell).join(', ')}.`);
                return;
            }
            const line = bold(loader(shell));
            if (!values.yes && !(await confirm(`Add ${line} to ${files.join(', ')}?`, true))) {
                write('Nothing changed.');
                return;
            }
            for (const file of files) {
                install(shell, file);
                write(`Added to ${file}.`);
            }
            write('Open a new shell to use tab completion.');
            return;
        }
        process.stdout.write(readFileSync(`${TEMPLATES}/completions/zen.${shell}`, 'utf8'));
    },
};
