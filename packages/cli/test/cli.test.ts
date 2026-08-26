import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { extract, split } from '../src/args.ts';
import { auditModels } from '../src/audit.ts';
import { isStamp, stamp, stampInstant } from '../src/ids.ts';
import { mask, parseRef, type KeyStore } from '../src/keys.ts';
import { pad, table } from '../src/term.ts';
import { windowOf, wrap } from '../src/tui/wrap.ts';

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

describe('the streaming window', () => {
    // The bug this exists for: a reasoning stream is one long paragraph with no
    // newlines, so counting `\n` says one line while the terminal draws fifty,
    // and a frame taller than the viewport cannot be erased.
    const paragraph = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');

    it('measures the rows a terminal will draw, not the newlines', () => {
        expect(paragraph.split('\n')).toHaveLength(1);
        expect(windowOf(paragraph, 40, 6)).toHaveLength(6);
    });

    it('never returns a row the terminal would wrap again', () => {
        for (const row of windowOf(paragraph, 40, 6)) {
            expect(row.length).toBeLessThanOrEqual(40);
        }
    });

    it('shows the tail, which is where the stream is', () => {
        const rows = windowOf(paragraph, 40, 6);
        expect(rows.at(-1)).toContain('word399');
    });

    it('breaks a word wider than the terminal rather than overflowing', () => {
        expect(wrap('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    });

    it('asks for no more rows than there are', () => {
        expect(windowOf('one\ntwo', 40, 6)).toEqual(['one', 'two']);
    });
});

describe('the credential audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-audit-'));
    // Only the keyring's verdict on a key is asked for here; the keys
    // themselves reach the audit the way they reach the library, through the
    // environment.
    const store = { active: () => undefined } as unknown as KeyStore;
    const kept = { ...process.env };

    afterEach(() => {
        process.env = { ...kept };
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const project = (models: string): string => {
        writeFileSync(
            join(dir, 'agents.yaml'),
            `version: 1\nmodel: fast\nmodels:\n${models}\nagents:\n  - name: default\n`,
        );
        return dir;
    };

    it('names the model and the variable that would carry its key', () => {
        delete process.env.GEMINI_API_KEY;
        const issues = auditModels(
            project('    fast:\n        provider: google\n        model: gemini-2.5-flash\n'),
            store,
        );
        expect(issues).toEqual([
            {
                name: 'fast',
                provider: 'google',
                env: 'GEMINI_API_KEY',
                reason: 'missing',
                add: 'google',
            },
        ]);
    });

    it('says nothing about a model that can be reached', () => {
        process.env.GEMINI_API_KEY = 'k';
        expect(
            auditModels(
                project('    fast:\n        provider: google\n        model: gemini-2.5-flash\n'),
                store,
            ),
        ).toEqual([]);
    });

    /**
     * Vertex takes no api key at all, so asking after `VERTEX_API_KEY` would
     * warn about every correctly configured service account there is.
     */
    it('looks for vertex credentials where vertex keeps them', () => {
        const config = '    fast:\n        provider: vertex\n        model: gemini-2.5-flash\n';
        process.env.GOOGLE_APPLICATION_CREDENTIALS = join(dir, 'sa.json');
        expect(auditModels(project(config), store)).toEqual([]);

        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        process.env.CLOUDSDK_CONFIG = join(dir, 'no-gcloud');
        expect(auditModels(project(config), store)).toEqual([
            {
                name: 'fast',
                provider: 'vertex',
                env: 'GOOGLE_APPLICATION_CREDENTIALS',
                reason: 'missing',
                add: 'vertex',
            },
        ]);
    });

    /** A config nothing can read is the loader's to complain about, in its own words. */
    it('stays quiet when there is no config to read', () => {
        expect(auditModels(join(dir, 'nowhere'), store)).toEqual([]);
    });
});
