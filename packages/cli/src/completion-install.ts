import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const SHELLS = ['zsh', 'bash', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

export function shellOf(value: string): Shell | undefined {
    const name = basename(value);
    return SHELLS.find((shell) => shell === name);
}

/** The primary startup file for an interactive shell. */
export function rcFile(
    shell: Shell,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string {
    const home = env.HOME || homedir();
    switch (shell) {
        case 'zsh':
            return join(env.ZDOTDIR || home, '.zshrc');
        case 'bash':
            if (platform === 'darwin') {
                // Login Bash reads only the first existing profile in this order.
                return (
                    ['.bash_profile', '.bash_login', '.profile']
                        .map((name) => join(home, name))
                        .find((file) => existsSync(file)) ?? join(home, '.bash_profile')
                );
            }
            return join(home, '.bashrc');
        case 'fish':
            return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'fish', 'config.fish');
    }
}

/** macOS needs both login and non-login Bash startup files. */
export function rcFiles(
    shell: Shell,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string[] {
    const primary = rcFile(shell, env, platform);
    return shell === 'bash' && platform === 'darwin'
        ? [primary, join(env.HOME || homedir(), '.bashrc')]
        : [primary];
}

/** Guard the loader so uninstalling zen does not break shell startup. */
export function loader(shell: Shell): string {
    return shell === 'fish'
        ? 'if type -q zen; zen completion fish | source; end'
        : `if command -v zen >/dev/null 2>&1; then eval "$(zen completion ${shell})"; fi`;
}

/** Whether `file` already loads the script; a commented-out line does not count. */
export function installed(shell: Shell, file: string): boolean {
    if (!existsSync(file)) {
        return false;
    }
    const loads = new RegExp(`\\b(zen|zn|zenera)\\s+completion\\s+${shell}\\b`);
    return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .some((line) => !line.trimStart().startsWith('#') && loads.test(line));
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

export function autoInstall(env: NodeJS.ProcessEnv = process.env): void {
    // Local dependencies, npx and workspace installs must not edit shell startup.
    if (env.npm_config_global !== 'true') {
        return;
    }
    if (process.getuid?.() === 0 || env.SUDO_UID || env.SUDO_USER) {
        console.error(
            'zen: skipping automatic completion setup under root/sudo. Run zen completion --install as your normal user.',
        );
        return;
    }
    if (process.platform === 'win32' || (env.CI && env.CI !== 'false')) {
        console.error(
            'zen: skipping automatic completion setup on Windows or in CI. Run zen completion --install in a supported shell.',
        );
        return;
    }
    const shell = shellOf(env.SHELL ?? '');
    if (!shell) {
        console.error(
            'zen: cannot detect a supported shell. Run zen completion <zsh|bash|fish> --install.',
        );
        return;
    }
    for (const file of rcFiles(shell, env)) {
        const result = install(shell, file);
        console.error(
            `zen: completion ${result === 'added' ? 'added to' : 'already set up in'} ${file}.`,
        );
    }
    console.error('zen: open a new terminal to use tab completion.');
}
