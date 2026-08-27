import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ProcResult, runProcess } from 'zenera-neo';
import { extract, split } from '../src/args.ts';
import { auditModels } from '../src/audit.ts';
import { isStamp, stamp, stampInstant } from '../src/ids.ts';
import { mask, parseRef, type KeyStore } from '../src/keys.ts';
import { ensurePodmanReady } from '../src/podman.ts';
import { EXIT, pad, table } from '../src/term.ts';
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

// ---------------------------------------------------------------------------
// The pre-flight
//
// Every process is injected, so what is under test is the order of the
// questions and what each answer leads to — which is the whole of this module.
// Each successful case uses its own image so it gets its own memo entry; a run
// only ever asks these questions once.
// ---------------------------------------------------------------------------

describe('the podman pre-flight', () => {
    const onLinux = platform() === 'linux';

    interface Fake {
        run: typeof runProcess;
        seen: string[];
        reply(match: string, res: Partial<ProcResult>): void;
    }

    const fake = (): Fake => {
        const seen: string[] = [];
        const replies: { match: string; res: Partial<ProcResult> }[] = [];
        return {
            seen,
            reply: (match, res) => void replies.push({ match, res }),
            run: (bin, args) => {
                const line = `${bin} ${args.join(' ')}`;
                seen.push(line);
                const i = replies.findIndex((r) => line.includes(r.match));
                const res = i >= 0 ? replies.splice(i, 1)[0].res : {};
                return Promise.resolve({
                    code: 0,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                    timedOut: false,
                    ...res,
                });
            },
        };
    };

    /** One machine, up and running, so only the step under test is interesting. */
    const running = (f: Fake): Fake => {
        f.reply('machine list', {
            stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: true }]),
        });
        return f;
    };

    it('asks in order: binary, machine, socket, image', async () => {
        const f = running(fake());
        await ensurePodmanReady({ image: 'img-order', yes: true, exec: f.run });

        const verbs = f.seen.map((l) => l.replace('podman ', ''));
        expect(verbs[0]).toBe('--version');
        expect(verbs.at(-2)).toBe('info');
        expect(verbs.at(-1)).toBe('image exists img-order');
        expect(verbs.includes('machine list --format json')).toBe(!onLinux);
    });

    it('fails with the install command for this platform, rather than hanging', async () => {
        const f = fake();
        f.reply('--version', { code: 127, stderr: 'not found' });
        await expect(
            ensurePodmanReady({ image: 'img-missing', yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            hint: expect.stringContaining('install it'),
        });
    });

    it('creates a machine when there is none, sized as configured', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine list', { stdout: '[]' });
        await ensurePodmanReady({
            image: 'img-init',
            cpus: 4,
            memory: 8192,
            yes: true,
            exec: f.run,
        });
        expect(f.seen).toContain('podman machine init --cpus 4 --memory 8192');
        expect(f.seen.some((l) => l.startsWith('podman machine start'))).toBe(true);
    });

    it('starts a machine that exists but is stopped, and leaves a running one alone', async () => {
        if (onLinux) {
            return;
        }
        const stopped = fake();
        stopped.reply('machine list', {
            stdout: JSON.stringify([{ Name: 'other', Running: false, Starting: false }]),
        });
        await ensurePodmanReady({ image: 'img-stopped', yes: true, exec: stopped.run });
        expect(stopped.seen).toContain('podman machine start other');
        expect(stopped.seen).not.toContain('podman machine init');

        const up = running(fake());
        await ensurePodmanReady({ image: 'img-up', yes: true, exec: up.run });
        expect(up.seen.some((l) => l.includes('machine start'))).toBe(false);
    });

    it('pulls the image only when it is not already there', async () => {
        const absent = running(fake());
        absent.reply('image exists', { code: 1 });
        await ensurePodmanReady({ image: 'img-absent', yes: true, exec: absent.run });
        expect(absent.seen).toContain('podman pull img-absent');

        const present = running(fake());
        await ensurePodmanReady({ image: 'img-present', yes: true, exec: present.run });
        expect(present.seen.some((l) => l.includes('pull'))).toBe(false);
    });

    it('says the engine is wedged rather than blaming the image', async () => {
        const f = running(fake());
        f.reply('info', { code: 125, stderr: 'cannot connect to podman socket' });
        await expect(
            ensurePodmanReady({ image: 'img-wedged', yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            message: expect.stringMatching(/responding/),
        });
    });

    /** Treating unreadable output as "no machines" would try to create a second one. */
    it('refuses to guess when machine list is not json', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine list', { stdout: 'podman: unknown flag --format' });
        await expect(
            ensurePodmanReady({ image: 'img-garbage', yes: true, exec: f.run }),
        ).rejects.toThrow(/machine list/);
    });
});
