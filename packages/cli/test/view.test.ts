import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { placeOf } from '../src/commands/view.ts';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'zenera-view-cmd-')));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('zen view: what it serves', () => {
    it('serves a file inside the cwd from the cwd, so its links up the tree resolve', () => {
        mkdirSync(join(cwd, 'finetune'));
        writeFileSync(join(cwd, 'finetune', 'STATUS.md'), '#');
        expect(placeOf(cwd, join(cwd, 'finetune', 'STATUS.md'))).toEqual({
            root: cwd,
            start: '/finetune/STATUS.md',
        });
    });

    it('serves a file under a dot-folder from its own folder, which is not refused as hidden', () => {
        mkdirSync(join(cwd, '.out', 'mm'), { recursive: true });
        writeFileSync(join(cwd, '.out', 'mm', 'd.md'), '#');
        expect(placeOf(cwd, join(cwd, '.out', 'mm', 'd.md'))).toEqual({
            root: join(cwd, '.out', 'mm'),
            start: '/d.md',
        });
    });

    it('serves a directory from itself', () => {
        expect(placeOf(cwd, join(cwd, 'finetune'))).toEqual({
            root: join(cwd, 'finetune'),
            start: '/',
        });
    });
});
