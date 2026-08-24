import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extract, split } from '../src/args.ts';
import { isStamp, stamp, stampInstant } from '../src/ids.ts';
import { mask, parseRef } from '../src/keys.ts';
import { pad, table } from '../src/term.ts';
import { Workspace } from '../src/workspace.ts';

// ---------------------------------------------------------------------------
// The parts of the CLI that are pure functions of their input. Everything else
// is a directory and a network call, and is covered by using the tool.
// ---------------------------------------------------------------------------

describe('splitting the command line', () => {
    it('takes the first bare word as the command', () => {
        expect(split(['run', 'hello'])).toEqual({ before: [], name: 'run', after: ['hello'] });
    });

    it('keeps global flags that come first', () => {
        const s = split(['--json', '-C', '/tmp', 'list']);
        expect(s.before).toEqual(['--json', '-C', '/tmp']);
        expect(s.name).toBe('list');
    });

    /**
     * The regression this file exists for: an unknown flag must survive to the
     * command that defines it, rather than being absorbed by the frame.
     */
    it("does not swallow a command's own flags", () => {
        const { after } = split(['key', 'add', 'openai', '--no-check']);
        const { rest } = extract(after);
        expect(rest).toEqual(['add', 'openai', '--no-check']);
    });

    it('lifts global flags out of a command’s arguments', () => {
        const { rest, global } = extract(['--sessions', '--json', '-C', '/tmp']);
        expect(rest).toEqual(['--sessions']);
        expect(global).toEqual(['--json', '-C', '/tmp']);
    });

    it('leaves everything after -- alone', () => {
        const { rest } = extract(['--', '--json', '--help']);
        expect(rest).toEqual(['--json', '--help']);
    });
});

describe('identifiers', () => {
    it('round-trips a stamp', () => {
        const id = stamp(new Date(2026, 7, 25, 14, 30, 12));
        expect(id).toMatch(/^20260825-143012-[0-9a-f]{4}$/);
        expect(isStamp(id)).toBe(true);
        expect(stampInstant(id)).toBe(new Date(2026, 7, 25, 14, 30, 12).toISOString());
    });

    it('rejects anything that could be a path', () => {
        for (const bad of ['..', 'workspace', '20260825', '20260825-143012-zzzz', '../../etc']) {
            expect(isStamp(bad)).toBe(false);
        }
    });
});

describe('keys', () => {
    it('splits a reference and refuses one that is not a name', () => {
        expect(parseRef('openai')).toEqual({ provider: 'openai', name: undefined });
        expect(parseRef('openai/work')).toEqual({ provider: 'openai', name: 'work' });
        expect(() => parseRef('openai/../etc')).toThrow();
        expect(() => parseRef('nope')).toThrow();
    });

    it('shows enough of a secret to recognise it and no more', () => {
        expect(mask('sk-proj-abcdefghijklmnop')).toBe('sk-p…mnop');
        expect(mask('short')).not.toContain('short');
    });
});

describe('columns', () => {
    it('aligns on visible width, not byte length', () => {
        const styled = '\u001b[1mzn\u001b[22m';
        expect(pad(styled, 5)).toBe(`${styled}   `);
        expect(
            table([
                ['a', 'one'],
                ['bbbb', 'two'],
            ]),
        ).toEqual(['a     one', 'bbbb  two']);
    });
});

describe('workspace containment', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'zen-out-'));
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    const ws = new Workspace({ root });

    it('allows paths inside, including ones that do not exist yet', () => {
        expect(ws.within('notes.md')).toBe(join(ws.root, 'notes.md'));
        expect(ws.within('a/b/c.txt')).toBe(join(ws.root, 'a/b/c.txt'));
    });

    it('refuses to climb out', () => {
        expect(() => ws.within('../escape')).toThrow();
        expect(() => ws.within('/etc/passwd')).toThrow();
        expect(() => ws.within('a/../../escape')).toThrow();
    });

    it('refuses a null byte', () => {
        expect(() => ws.within('ok\u0000/../../etc/passwd')).toThrow();
    });

    /** The check is on the resolved path, so a symlink cannot be a back door. */
    it('follows symlinks before deciding', () => {
        writeFileSync(join(outside, 'secret.txt'), 'no');
        mkdirSync(join(root, 'links'), { recursive: true });
        symlinkSync(outside, join(root, 'links', 'out'));
        expect(() => ws.within('links/out/secret.txt')).toThrow();
    });
});
