import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, installed, loader } from '../src/commands/completion.ts';

describe('zen completion --install', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'zen-rc-'));
    });
    afterEach(() => {
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
});
