import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completion, install, installed, loader } from '../src/commands/completion.ts';
import { autoInstall, rcFile, rcFiles, shellOf } from '../src/completion-install.ts';

describe('zen completion --install', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'zen-rc-'));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    it('creates the file, with its directory, and is a no-op the second time', () => {
        const file = join(dir, 'fish', 'config.fish');
        expect(install('fish', file)).toBe('added');
        expect(readFileSync(file, 'utf8')).toBe(`# zen tab completion\n${loader('fish')}\n`);
        expect(install('fish', file)).toBe('present');
        expect(readFileSync(file, 'utf8').match(/completion fish/g)).toHaveLength(1);
    });

    it('appends after what is there, separated, whether or not it ends in a newline', () => {
        const a = join(dir, 'a');
        const b = join(dir, 'b');
        writeFileSync(a, 'export A=1\n');
        writeFileSync(b, 'export B=1');
        install('zsh', a);
        install('zsh', b);
        expect(readFileSync(a, 'utf8')).toBe(
            `export A=1\n\n# zen tab completion\n${loader('zsh')}\n`,
        );
        expect(readFileSync(b, 'utf8')).toBe(
            `export B=1\n\n# zen tab completion\n${loader('zsh')}\n`,
        );
    });

    it('recognises a hand-written line, but not a commented-out one or another shell’s', () => {
        const file = join(dir, 'rc');
        writeFileSync(file, '# eval "$(zen completion zsh)"\neval "$(zen completion bash)"\n');
        expect(installed('zsh', file)).toBe(false);
        expect(installed('bash', file)).toBe(true);
        writeFileSync(file, 'zen completion fish | source\n');
        expect(installed('fish', file)).toBe(true);
        expect(installed('zsh', join(dir, 'missing'))).toBe(false);
    });

    it('does not count indented comments or comments after a blank line as installed', () => {
        const file = join(dir, 'rc');
        writeFileSync(file, '\n  # eval "$(zen completion zsh)"\n');
        expect(installed('zsh', file)).toBe(false);
        expect(install('zsh', file)).toBe('added');
        expect(installed('zsh', file)).toBe(true);
    });

    it.each(['zn', 'zenera'])('recognises the %s alias in an existing loader', (program) => {
        const file = join(dir, 'rc');
        writeFileSync(file, `eval "$(${program} completion bash)"\n`);
        expect(install('bash', file)).toBe('present');
    });

    it('detects supported shell names and paths', () => {
        expect(shellOf('/bin/bash')).toBe('bash');
        expect(shellOf('/usr/local/bin/fish')).toBe('fish');
        expect(shellOf('zsh')).toBe('zsh');
        expect(shellOf('/bin/sh')).toBeUndefined();
        expect(shellOf('')).toBeUndefined();
    });

    it('respects home and shell configuration directories', () => {
        expect(rcFile('zsh', { HOME: dir })).toBe(join(dir, '.zshrc'));
        expect(rcFile('zsh', { HOME: dir, ZDOTDIR: join(dir, 'zsh') })).toBe(
            join(dir, 'zsh', '.zshrc'),
        );
        expect(rcFile('fish', { HOME: dir })).toBe(join(dir, '.config/fish/config.fish'));
        expect(rcFile('fish', { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') })).toBe(
            join(dir, 'config/fish/config.fish'),
        );
        expect(rcFiles('bash', { HOME: dir }, 'linux')).toEqual([join(dir, '.bashrc')]);
    });

    it('covers macOS login and non-login Bash even when .bashrc already exists', () => {
        writeFileSync(join(dir, '.bashrc'), '# non-login shell\n');
        expect(rcFiles('bash', { HOME: dir }, 'darwin')).toEqual([
            join(dir, '.bash_profile'),
            join(dir, '.bashrc'),
        ]);
    });

    it('selects the first active Bash login profile without shadowing another one', () => {
        const env = { HOME: dir };
        writeFileSync(join(dir, '.profile'), '# shared profile\n');
        expect(rcFile('bash', env, 'darwin')).toBe(join(dir, '.profile'));
        writeFileSync(join(dir, '.bash_login'), '# login\n');
        expect(rcFile('bash', env, 'darwin')).toBe(join(dir, '.bash_login'));
        writeFileSync(join(dir, '.bash_profile'), '# bash profile\n');
        expect(rcFile('bash', env, 'darwin')).toBe(join(dir, '.bash_profile'));
    });

    it.skipIf(process.platform === 'win32')(
        'does not produce Bash startup errors when zen is no longer on PATH',
        () => {
            const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', loader('bash')], {
                env: { HOME: dir, PATH: dir },
                encoding: 'utf8',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
        },
    );

    describe('manual setup', () => {
        beforeEach(() => {
            vi.stubEnv('HOME', dir);
            vi.stubEnv('ZDOTDIR', dir);
            vi.stubEnv('XDG_CONFIG_HOME', join(dir, '.config'));
            vi.stubEnv('SHELL', '/bin/zsh');
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        });

        it.each(['zsh', 'bash', 'fish'] as const)(
            'still supports explicit %s installation without duplicating loaders',
            async (shell) => {
                const ctx = { args: [shell, '--install', '--yes'], cwd: dir, json: false };
                await completion.run(ctx);
                const files = rcFiles(shell);
                expect(files.every((file) => installed(shell, file))).toBe(true);
                const contents = files.map((file) => readFileSync(file, 'utf8'));
                await completion.run(ctx);
                expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(contents);
            },
        );

        it('detects the default shell', async () => {
            await completion.run({ args: ['--install', '--yes'], cwd: dir, json: false });
            expect(installed('zsh', join(dir, '.zshrc'))).toBe(true);
        });

        it('rejects --yes without --install', async () => {
            await expect(
                completion.run({ args: ['zsh', '--yes'], cwd: dir, json: false }),
            ).rejects.toThrow('--yes only goes with --install');
        });

        it('rejects unsupported shells', async () => {
            await expect(
                completion.run({ args: ['sh', '--install', '--yes'], cwd: dir, json: false }),
            ).rejects.toThrow('no completion for "sh"');
        });
    });

    describe.skipIf(process.platform === 'win32')('global npm postinstall', () => {
        let env: NodeJS.ProcessEnv;

        beforeEach(() => {
            env = { HOME: dir, SHELL: '/bin/zsh', npm_config_global: 'true' };
            vi.spyOn(process, 'getuid').mockReturnValue(1000);
            vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        it.each(['zsh', 'bash', 'fish'] as const)(
            'sets up %s once, preserving existing startup contents',
            (shell) => {
                env.SHELL = `/bin/${shell}`;
                const files = rcFiles(shell, env);
                mkdirSync(dirname(files[0]), { recursive: true });
                writeFileSync(files[0], '# existing configuration\n', { flag: 'a' });
                autoInstall(env);
                for (const file of files) {
                    expect(installed(shell, file)).toBe(true);
                }
                const contents = files.map((file) => readFileSync(file, 'utf8'));
                expect(contents[0]).toMatch(/^# existing configuration\n/);
                autoInstall(env);
                expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(contents);
                expect(console.error).toHaveBeenCalledWith(
                    'zen: open a new terminal to use tab completion.',
                );
            },
        );

        it('uses ZDOTDIR and XDG_CONFIG_HOME during automatic setup', () => {
            env.ZDOTDIR = join(dir, 'custom-zsh');
            autoInstall(env);
            expect(installed('zsh', join(env.ZDOTDIR, '.zshrc'))).toBe(true);
            expect(existsSync(join(dir, '.zshrc'))).toBe(false);

            env.SHELL = '/bin/fish';
            env.XDG_CONFIG_HOME = join(dir, 'custom-config');
            autoInstall(env);
            expect(installed('fish', join(env.XDG_CONFIG_HOME, 'fish/config.fish'))).toBe(true);
        });

        it.each([undefined, 'false'])(
            'does not touch home or log during a local/npx install (global=%s)',
            (global) => {
                env.npm_config_global = global;
                autoInstall(env);
                expect(readdirSync(dir)).toEqual([]);
                expect(console.error).not.toHaveBeenCalled();
            },
        );

        it.each(['SUDO_UID', 'SUDO_USER', 'CI'])('does not edit home under %s', (flag) => {
            env[flag] = '1';
            autoInstall(env);
            expect(readdirSync(dir)).toEqual([]);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('zen completion --install'),
            );
        });

        it('does not edit root startup files', () => {
            vi.spyOn(process, 'getuid').mockReturnValue(0);
            autoInstall(env);
            expect(readdirSync(dir)).toEqual([]);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('root/sudo'));
        });

        it.each(['', '/bin/sh'])(
            'reports an unknown shell (%s) without changing files',
            (shell) => {
                env.SHELL = shell;
                autoInstall(env);
                expect(readdirSync(dir)).toEqual([]);
                expect(console.error).toHaveBeenCalledWith(
                    expect.stringContaining('cannot detect a supported shell'),
                );
            },
        );

        it('reports write failures without failing the npm lifecycle script', async () => {
            const home = join(dir, 'not-a-directory');
            writeFileSync(home, 'keep this file');
            vi.stubEnv('HOME', home);
            vi.stubEnv('SHELL', '/bin/zsh');
            vi.stubEnv('ZDOTDIR', '');
            vi.stubEnv('npm_config_global', 'true');
            vi.stubEnv('CI', '');
            vi.stubEnv('SUDO_UID', '');
            vi.stubEnv('SUDO_USER', '');
            const exitCode = process.exitCode;

            await import('../src/postinstall.ts');

            expect(readFileSync(home, 'utf8')).toBe('keep this file');
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('automatic completion setup failed:'),
            );
            expect(console.error).toHaveBeenCalledWith(
                'zen: run zen completion --install to retry.',
            );
            expect(process.exitCode).toBe(exitCode);
        });
    });
});
