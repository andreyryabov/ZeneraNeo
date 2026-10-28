import { KeyStore, paths } from '@zenera/cli/lib';
import type { Runner } from '@zenera/neo';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { AVAILABLE, ensureImage, imageTag, REQUIREMENTS } from '../src/image.ts';
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

    it('provides the Python libraries the generators need', () => {
        expect(REQUIREMENTS).toContain('Faker>=37');
        expect(AVAILABLE).toContain('faker');
    });

    it.each(['current', 'absent', 'build-failure'] as const)(
        'handles a %s image explicitly',
        async (state) => {
            const tag = imageTag();
            expect(tag).toMatch(/^localhost\/zenera-gym:[0-9a-f]{12}$/);
            const calls: string[][] = [];
            const exec: Runner = async (_bin, args) => {
                calls.push([...args]);
                const code =
                    args[1] === 'exists'
                        ? Number(state !== 'current')
                        : Number(state === 'build-failure');
                return {
                    code,
                    stdout: '',
                    stderr: code ? 'image failure' : '',
                    truncated: false,
                    timedOut: false,
                };
            };
            const result = ensureImage({ root, exec });
            if (state === 'build-failure') {
                await expect(result).rejects.toThrow('image failure');
            } else {
                await expect(result).resolves.toBe(tag);
            }
            if (state === 'current') {
                expect(calls).toEqual([['image', 'exists', tag]]);
            } else {
                expect(calls[0]).toEqual(['image', 'exists', tag]);
                expect(calls[1]?.slice(0, 3)).toEqual(['build', '--tag', tag]);
                expect(calls).toHaveLength(2);
                expect(existsSync(join(root, 'Containerfile'))).toBe(true);
            }
        },
    );
});
