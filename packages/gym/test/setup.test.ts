import { KeyStore, paths } from '@zenera/cli/lib';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { chooseModel, readSettings, writeSettings } from '../src/setup.ts';

describe('Gym setup', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-setup-'));
        vi.stubEnv('ZENERA_HOME', root);
        vi.stubEnv('ZENERA_GYM_MODEL', undefined);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    it('uses Gym workspace and cache names', () => {
        expect(paths.gym()).toBe(join(root, 'gym'));
        expect(GYM_KIND).toBe('gym-generator');
    });

    it('reads and writes Gym settings, including a cleared model', async () => {
        expect(await readSettings()).toEqual({ version: 1 });
        writeSettings({ version: 1, model: 'openai:stored' });
        expect(await readSettings()).toEqual({ version: 1, model: 'openai:stored' });
        expect(existsSync(join(root, 'gym.json'))).toBe(true);
        writeSettings({ version: 1 });
        expect(await readSettings()).toEqual({ version: 1 });
    });

    it('reports malformed settings', async () => {
        writeFileSync(join(root, 'gym.json'), '{');
        await expect(readSettings()).rejects.toThrow('is not valid JSON');
    });

    it('keeps flag, environment, settings and default precedence', async () => {
        const keys = await KeyStore.open();
        keys.add('openai', 'default', 'sk-test');
        writeSettings({ version: 1, model: 'openai:stored' });
        vi.stubEnv('ZENERA_GYM_MODEL', 'openai:env');
        expect(await chooseModel(undefined, keys)).toEqual({ ref: 'openai:env', from: 'env' });
        expect(await chooseModel('openai:flag', keys)).toEqual({
            ref: 'openai:flag',
            from: 'flag',
        });
        vi.stubEnv('ZENERA_GYM_MODEL', '');
        expect(await chooseModel(undefined, keys)).toEqual({ ref: 'openai:stored', from: 'store' });
        writeSettings({ version: 1 });
        expect(await chooseModel(undefined, keys)).toMatchObject({ from: 'default' });
    });
});
