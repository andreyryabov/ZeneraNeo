import type { Embedder, EmbeddingRequest, Model, ProcResult, runProcess } from '@zenera/neo';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract, split } from '../src/args.ts';
import { auditModels } from '../src/audit.ts';
import {
    CATALOG_TTL_MS,
    CURATED,
    fetchCatalog,
    loadCatalog,
    matches,
    type CatalogEntry,
} from '../src/catalog.ts';
import { ALIASES, COMMANDS, EXTERNAL, type External } from '../src/commands/index.ts';
import { cliManifest, versionOf } from '../src/commands/version.ts';
import { hasExternal, loadExternal } from '../src/external.ts';
import { History, historyPath, MAX_ENTRIES } from '../src/history.ts';
import { paths, writeJson } from '../src/home.ts';
import { isStamp, stamp, stampInstant } from '../src/ids.ts';
import {
    ambient,
    assertUsable,
    credentials,
    envNames,
    envOf,
    mask,
    parseRef,
    type KeyEntry,
    type KeyStore,
} from '../src/keys.ts';
import { classify, probeModels } from '../src/liveness.ts';
import { engineDisk, ensurePodmanReady, ownedContainers } from '../src/podman.ts';
import { dirSize } from '../src/projects.ts';
import { scaffold } from '../src/scaffold.ts';
import { bytes, CliError, EXIT, pad, table } from '../src/term.ts';
import { windowOf, wrap } from '../src/tui/wrap.ts';
import { validateProject, type Report } from '../src/validate.ts';

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

describe('commands in another package', () => {
    const absent: External = {
        package: 'zenera-nothing-at-all',
        summary: 'Nothing.',
        usage: 'zen nothing',
        install: 'npm i -g zenera-nothing-at-all',
    };

    it('says what to install instead of throwing a resolver error', async () => {
        const err = await loadExternal('nothing', absent).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
        expect((err as CliError).hint).toContain(absent.install);
    });

    it('reports an uninstalled package without loading anything', () => {
        expect(hasExternal(absent)).toBe(false);
    });

    it('finds the faker, which this workspace has', () => {
        expect(hasExternal(EXTERNAL.faker)).toBe(true);
    });

    it('finds the rag package, which this workspace also has', () => {
        expect(hasExternal(EXTERNAL.rag)).toBe(true);
    });

    it('routes mock to the faker', () => {
        expect(ALIASES.mock).toBe('faker');
        expect(COMMANDS[ALIASES.mock]).toBeUndefined();
        expect(EXTERNAL[ALIASES.mock]).toBeDefined();
    });

    /**
     * The whole point of the seam: `zen list` must not pay for a mock server's
     * dependencies, which it would the moment anything imports it statically.
     */
    it('is not imported by the frame', () => {
        const dist = join(import.meta.dirname, '..', 'dist');
        const sources = readdirSync(dist, { recursive: true }) as string[];
        for (const file of sources.filter((f) => f.endsWith('.js'))) {
            const text = readFileSync(join(dist, file), 'utf8');
            for (const ext of Object.values(EXTERNAL)) {
                expect(text).not.toContain(`from '${ext.package}`);
            }
        }
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

    // A key that a tool spends is held the same way a model key is, and is
    // named the same way on the command line. What it must not do is answer
    // the question the run gate asks, which is whether anything here can
    // reach a model.
    describe('a service key', () => {
        const kept = { ...process.env };
        afterEach(() => {
            process.env = { ...kept };
        });

        const only = (provider: string): KeyStore => {
            const entry = { provider, name: 'default', holds: 'secret', value: 'k' };
            return {
                active: (p: string) => (p === provider ? (entry as KeyEntry) : undefined),
            } as unknown as KeyStore;
        };

        const blank = (): void => {
            for (const name of Object.keys(process.env)) {
                if (/_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$/.test(name)) {
                    delete process.env[name];
                }
            }
        };

        it('is a name the reference parser knows', () => {
            expect(parseRef('exa')).toEqual({ provider: 'exa', name: undefined });
            expect(parseRef('exa/work')).toEqual({ provider: 'exa', name: 'work' });
        });

        it('does not make a keyring usable on its own', () => {
            blank();
            expect(() => assertUsable(only('exa'))).toThrow(/no credentials/);
            expect(() => assertUsable(only('openai'))).not.toThrow();
        });
    });

    // Vertex is reached two ways that have nothing in common: a service-account
    // file the SDK resolves for itself, and an express-mode api key. Which one
    // an entry is decides the variable it occupies, so a keyring that knew only
    // the provider would export the wrong name for one of them.
    describe('a provider with two shapes', () => {
        const kept = { ...process.env };
        afterEach(() => {
            process.env = { ...kept };
        });

        const blank = (): void => {
            for (const name of Object.keys(process.env)) {
                if (/_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$|^CLOUDSDK_CONFIG$/.test(name)) {
                    delete process.env[name];
                }
            }
            // A developer's own gcloud login must not decide what this asserts.
            process.env.CLOUDSDK_CONFIG = join(dir, 'no-gcloud');
        };

        const dir = mkdtempSync(join(tmpdir(), 'zen-keys-'));
        afterAll(() => rmSync(dir, { recursive: true, force: true }));

        const empty = { active: () => undefined } as unknown as KeyStore;

        it('names both variables it could arrive in', () => {
            expect(envNames('vertex')).toEqual([
                'GOOGLE_APPLICATION_CREDENTIALS',
                'VERTEX_API_KEY',
            ]);
            expect(envNames('openai')).toEqual(['OPENAI_API_KEY']);
        });

        it('exports each entry under the variable its own shape uses', () => {
            const file = { provider: 'vertex', holds: 'file' } as KeyEntry;
            const key = { provider: 'vertex', holds: 'secret' } as KeyEntry;
            expect(envOf(file)).toBe('GOOGLE_APPLICATION_CREDENTIALS');
            expect(envOf(key)).toBe('VERTEX_API_KEY');
        });

        it('honours the variable an entry recorded, over anything inferred', () => {
            const entry = { provider: 'vertex', holds: 'secret', env: 'LEGACY' } as KeyEntry;
            expect(envOf(entry)).toBe('LEGACY');
        });

        it('reports a credential the environment brought, under either name', () => {
            blank();
            process.env.VERTEX_API_KEY = 'vx-express';
            expect(ambient(empty, ['vertex'])).toEqual([
                { provider: 'vertex', env: 'VERTEX_API_KEY', holds: 'secret', value: 'vx-express' },
            ]);

            process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
            expect(ambient(empty, ['vertex']).map((c) => c.env)).toEqual([
                'GOOGLE_APPLICATION_CREDENTIALS',
                'VERTEX_API_KEY',
            ]);
        });

        it('collects what a run is actually carrying, whatever put it there', () => {
            blank();
            process.env.OPENAI_API_KEY = 'sk-openai';
            process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
            expect(credentials()).toEqual([
                { env: 'OPENAI_API_KEY', holds: 'secret', value: 'sk-openai' },
                {
                    env: 'GOOGLE_APPLICATION_CREDENTIALS',
                    holds: 'file',
                    value: '/tmp/sa.json',
                },
            ]);
        });
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

describe('the prompt history', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-history-'));
    let n = 0;

    const project = (): string => {
        const dir = join(root, `p${n++}`);
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('survives the process that wrote it', () => {
        const dir = project();
        const first = History.open(dir);
        first.add('what changed in the last release?');
        first.add('summarise it');
        expect(History.open(dir).entries).toEqual([
            'what changed in the last release?',
            'summarise it',
        ]);
    });

    it('lives beside the sessions, not inside one', () => {
        const dir = project();
        expect(historyPath(dir)).toBe(join(dir, 'sessions', '.history'));
        History.open(dir).add('hello');
        expect(readFileSync(historyPath(dir), 'utf8')).toBe('hello\n');
    });

    it('keeps blanks and repeats out of it', () => {
        const dir = project();
        const history = History.open(dir);
        history.add('  ');
        history.add('again');
        history.add('again');
        history.add('  again  ');
        history.add('once more');
        expect(history.entries).toEqual(['again', 'once more']);
    });

    it('reads a file it did not write', () => {
        const dir = project();
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        writeFileSync(historyPath(dir), 'one\n\ntwo\n');
        expect(History.open(dir).entries).toEqual(['one', 'two']);
    });

    it('keeps the newest entries and no more', () => {
        const dir = project();
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        const lines = Array.from({ length: MAX_ENTRIES * 3 }, (_, i) => `q${i}`);
        writeFileSync(historyPath(dir), `${lines.join('\n')}\n`);
        const history = History.open(dir);
        expect(history.entries).toHaveLength(MAX_ENTRIES);
        expect(history.entries.at(-1)).toBe(`q${MAX_ENTRIES * 3 - 1}`);
        // Past twice the cap the file itself is rewritten, so it cannot grow
        // without bound just because nobody ever deletes it.
        expect(readFileSync(historyPath(dir), 'utf8').trimEnd().split('\n')).toHaveLength(
            MAX_ENTRIES,
        );
    });

    it('is absent until something is asked', () => {
        const dir = project();
        expect(History.open(dir).entries).toEqual([]);
        expect(existsSync(historyPath(dir))).toBe(false);
    });
});

describe('the model probe', () => {
    const served: Model = {
        id: 'gpt-stub',
        generate: async () => ({ text: 'ok', toolCalls: [] }),
    };
    const refuses = (err: unknown): Model => ({
        id: 'gpt-stub',
        generate: async () => {
            throw err;
        },
    });
    const fails = (message: string, status?: number): Error =>
        Object.assign(new Error(message), status === undefined ? {} : { status });

    it('reports a model that answers, and what it answered as', async () => {
        const [probe] = await probeModels([{ ref: 'main', kind: 'model', model: served }]);
        expect(probe).toMatchObject({ ref: 'main', id: 'gpt-stub', kind: 'model' });
        expect(probe!.check.state).toBe('live');
    });

    // The whole point of asking: a credential that works, spent on a model id
    // that does not. Nothing short of the call says so — and the answer is
    // `blocked` rather than `dead`, because a new key would be refused for
    // exactly the same reason and the fix is a different model.
    it('calls an unserved model id blocked, and points at the listing', async () => {
        const err = fails('The model `gpt-9` does not exist or you do not have access', 404);
        const [probe] = await probeModels([
            { ref: 'openai:gpt-9', kind: 'model', model: refuses(err) },
        ]);
        expect(probe!.check.state).toBe('blocked');
        expect(probe!.check.fix).toBe('zen models ls openai');
    });

    it('keeps the credential refusal and the unreachable host apart', async () => {
        const [refused, silent] = await probeModels([
            { ref: 'a', kind: 'model', model: refuses(fails('invalid_api_key', 401)) },
            { ref: 'b', kind: 'model', model: refuses(fails('fetch failed')) },
        ]);
        expect(refused!.check.state).toBe('dead');
        expect(silent!.check.state).toBe('unknown');
    });

    it('asks an embedder for a vector instead of a completion', async () => {
        let asked: EmbeddingRequest | undefined;
        const embedder: Embedder = {
            id: 'embed-stub',
            embed: async (req) => {
                asked = req;
                return { vectors: [[1]], dimensions: 1 };
            },
        };
        const [probe] = await probeModels([{ ref: 'main', kind: 'embedding', embedder }]);
        expect(probe).toMatchObject({ id: 'embed-stub', kind: 'embedding' });
        expect(probe!.check.state).toBe('live');
        expect(asked?.input).toHaveLength(1);
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
                role: 'model',
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
                role: 'model',
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
// The project check
//
// What is under test is the thing the loader cannot do: keep going. Every case
// below plants more than one problem and asserts that more than one comes
// back, because a check that stopped at the first would be the loader with a
// longer name.
// ---------------------------------------------------------------------------

describe('the project check', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-check-'));
    let n = 0;

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A project directory holding exactly the files a case names. */
    const project = (files: Record<string, string>): string => {
        const dir = join(root, `p${n++}`);
        for (const [rel, body] of Object.entries(files)) {
            mkdirSync(join(dir, rel, '..'), { recursive: true });
            writeFileSync(join(dir, rel), body);
        }
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    const codes = (report: Report): string[] => report.findings.map((f) => f.code);
    const errors = (report: Report): string[] =>
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code);

    it('passes a project whose files are all there', async () => {
        const dir = project({
            'INSTRUCTIONS.md': 'House rules.\n',
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            'agents/prompts/solo.md': 'Be useful.\n',
        });
        const report = await validateProject({ dir });

        expect(report.ok).toBe(true);
        expect(errors(report)).toEqual([]);
        expect(report.project.entry).toBe('solo');
        expect(report.agents[0].instructions).toEqual([
            'INSTRUCTIONS.md',
            'agents/prompts/solo.md',
        ]);
        // No keyring was passed, so nothing may be said about credentials.
        expect(report.models[0].credential).toBe('unknown');
    });

    it('reports every broken reference, not the first', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\ndefault: nobody\nagents:\n' +
                '  - name: intake\n    system: prompts/gone.md\n' +
                '    tools: [workspace:*, invented_tool]\n' +
                '    handoffs: [ghost, intake]\n',
        });
        const found = errors(await validateProject({ dir }));

        expect(found).toContain('entry.unknown');
        expect(found).toContain('prompt.missing');
        expect(found).toContain('tools.unresolved');
        expect(found).toContain('handoff.unknown');
        expect(found).toContain('handoff.self');
    });

    /**
     * A hand-off is a one-way door, so an edge with no way home leaves the
     * agent it points at owning the conversation for good. Indirect returns
     * count, and a fork needs no edge at all.
     */
    it('warns about a hand-off that can never come back', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n' +
                '    handoffs: [billing, technical]\n' +
                '  - name: billing\n    description: Bills.\n    handoffs: [technical]\n' +
                '  - name: technical\n    description: Fixes.\n    handoffs: [intake]\n',
        });
        const report = await validateProject({ dir });

        // intake → billing → technical → intake closes; billing → technical
        // does too, the long way round. Nothing is one-way here.
        expect(codes(report)).not.toContain('handoff.one-way');
        expect(errors(report)).toEqual([]);
    });

    it('names the edge that strands the conversation', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n    handoffs: [docs]\n' +
                '  - name: docs\n    description: Searches documents.\n',
        });
        const report = await validateProject({ dir });

        const one = report.findings.find((f) => f.code === 'handoff.one-way');
        expect(one?.severity).toBe('warning');
        expect(one?.where).toBe('agents.intake.handoffs');
        expect(errors(report)).toEqual([]);
    });

    /** A branch returns on its own, so a fork is never a dead end. */
    it('asks nothing of a fork', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n' +
                '    fork:\n      agents: [docs]\n' +
                '  - name: docs\n    description: Searches documents.\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report)).not.toContain('handoff.one-way');
    });

    it('says which files it looked for when there is no config at all', async () => {
        const report = await validateProject({ dir: project({ 'INSTRUCTIONS.md': 'hello\n' }) });

        expect(errors(report)).toEqual(['config.missing']);
        expect(report.project.config).toBeNull();
    });

    /**
     * A schema failure ends the walk, so the one thing that must survive it is
     * the file inventory: it is what says whether the prompts a broken config
     * points at are even on disk.
     */
    it('keeps the file inventory when the schema fails', async () => {
        const report = await validateProject({
            dir: project({
                'agents.yaml': 'version: 1\nagents:\n  - name: Not A Name\n',
                'INSTRUCTIONS.md': 'hello\n',
            }),
        });

        expect(errors(report)).toEqual(['config.invalid']);
        expect(report.files.find((f) => f.path === 'INSTRUCTIONS.md')?.exists).toBe(true);
    });

    it('checks the skill catalog it will actually read', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n' +
                '    skills:\n      allow: [known]\n      preload: [unlisted]\n',
            'agents/prompts/solo.md': 'Be useful.\n',
            'agents/skills/known/SKILL.md': '---\nname: known\ndescription: A skill.\n---\nBody.\n',
            'agents/skills/halfway/notes.md': 'no SKILL.md here\n',
            'agents/skills/loose.md': '---\ndescription: Loose.\n---\nBody.\n',
        });
        const report = await validateProject({ dir });

        expect(errors(report)).toContain('skills.preload-not-allowed');
        expect(errors(report)).toContain('skills.preload-unknown');
        expect(codes(report)).toContain('skill.no-skill-md');
        // A bare `<name>.md` is indexed, and is still the wrong layout.
        expect(errors(report)).toContain('skill.flat');
        expect(report.skills.entries.map((s) => s.name)).toEqual(['known', 'loose']);
        expect(report.skills.entries[0].usedBy).toEqual(['solo']);
    });

    /** The files a skill folder ships, which the agent reaches under /skills. */
    it('lists what else is in a skill folder', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            'agents/skills/render/SKILL.md': '---\ndescription: Renders.\n---\nRun scripts/go.py\n',
            'agents/skills/render/scripts/go.py': 'print("hi")\n',
            'agents/skills/plain.md': 'Just text.\n',
        });
        const report = await validateProject({ dir });

        const byName = new Map(report.skills.entries.map((s) => [s.name, s]));
        expect(byName.get('render')?.files).toEqual(['scripts/']);
        // A bare `<name>.md` skill's neighbours are other skills, not its own files.
        expect(byName.get('plain')?.files).toBeUndefined();
    });

    it('reports an assets directory that is named but not there', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nassets: handbook\nagents:\n  - name: solo\n',
        });
        const report = await validateProject({ dir });

        expect(errors(report)).toContain('assets.missing');
        expect(report.files.find((f) => f.path === 'handbook')?.from).toBe('assets');
    });

    /**
     * Pointing `assets:` at the project itself hands every agent the sessions
     * directory — every transcript of every run, including the one reading it.
     */
    it('warns when assets would include the project’s own files', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nassets: .\nagents:\n  - name: solo\n',
            'sessions/keep.txt': 'a transcript would live here\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report)).toContain('assets.overbroad');
        expect(errors(report)).not.toContain('assets.overbroad');
    });

    /** No `assets:`, no folder, nothing to say. */
    it('says nothing about assets when the project has none', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report).filter((c) => c.startsWith('assets.'))).toEqual([]);
        expect(report.files.some((f) => f.path === 'assets')).toBe(false);
    });

    it('notes an assets directory with nothing in it', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
        });
        mkdirSync(join(dir, 'assets'), { recursive: true });
        const report = await validateProject({ dir });

        expect(codes(report)).toContain('assets.empty');
        expect(errors(report)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// What `zen init` writes
//
// One case, because there is only one thing worth asserting about a scaffold:
// that the project it produces is one `zen check` passes. Everything else —
// which files, in what order — is the scaffold's business and changes with it.
// ---------------------------------------------------------------------------

describe('the scaffold', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-scaffold-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('writes a Dockerfile, names it, and passes its own check', async () => {
        const dir = join(root, 'fresh');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });

        expect(written.files).toContain(join('sandbox', 'Dockerfile'));
        // The editor's files are written, but they are not what was created.
        expect(
            written.files.filter((f) => f.startsWith('.github') || f.startsWith('.vscode')),
        ).toEqual([]);
        expect(written.editor).toContain(join('.vscode', 'settings.json'));
        const dockerfile = readFileSync(join(dir, 'sandbox', 'Dockerfile'), 'utf8');
        expect(dockerfile).toMatch(/^FROM /m);
        // The tools in the container are the ones that wrote the project.
        expect(dockerfile).toContain(`@zenera/cli@${await versionOf(cliManifest)}`);
        expect(readFileSync(join(dir, 'agents.yaml'), 'utf8')).toContain(
            'dockerfile: sandbox/Dockerfile',
        );

        // The one part that would run something is off: what is under test is
        // the project, not the container engine on whatever machine this is.
        const report = await validateProject({ dir, sandbox: { enabled: false } });
        expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
    });

    /** It is the project's file once written, and editing it is the point. */
    it('leaves an edited Dockerfile alone', () => {
        const dir = join(root, 'edited');
        mkdirSync(join(dir, 'sandbox'), { recursive: true });
        writeFileSync(join(dir, 'sandbox', 'Dockerfile'), 'FROM mine\n');
        scaffold({ dir, model: 'gpt-4o' });

        expect(readFileSync(join(dir, 'sandbox', 'Dockerfile'), 'utf8')).toBe('FROM mine\n');
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

    /**
     * A Dockerfile replaces the pull entirely, and is skipped once the tag is
     * on disk: the tag is a hash of the content, so the image existing means
     * the content is unchanged.
     */
    it('builds a Dockerfile instead of pulling', async () => {
        const build = { tag: 'localhost/zenera-sandbox:abc', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        f.reply('image exists', { code: 1 });
        await ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run });

        expect(f.seen).toContain('podman build --tag localhost/zenera-sandbox:abc --file /p/D /p');
        expect(f.seen.some((l) => l.includes('pull'))).toBe(false);
    });

    it('does not rebuild a tag that is already on disk, unless asked to', async () => {
        const build = { tag: 'localhost/zenera-sandbox:cached', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        await ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run });
        expect(f.seen).toContain('podman image exists localhost/zenera-sandbox:cached');
        expect(f.seen.some((l) => l.includes('build --tag'))).toBe(false);

        // `zen sandbox pull` is the way to catch a base image that moved.
        const forced = running(fake());
        await ensurePodmanReady({
            image: 'localhost/zenera-sandbox:forced',
            build: { ...build, tag: 'localhost/zenera-sandbox:forced' },
            rebuild: true,
            yes: true,
            exec: forced.run,
        });
        expect(forced.seen.some((l) => l.includes('build --tag'))).toBe(true);
        expect(forced.seen.some((l) => l.includes('image exists'))).toBe(false);
    });

    it('blames the Dockerfile, and quotes the end of the build log', async () => {
        const build = { tag: 'localhost/zenera-sandbox:bad', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        f.reply('image exists', { code: 1 });
        f.reply('build --tag', { code: 1, stderr: 'STEP 2\nError: no such package: nope\n' });
        await expect(
            ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            message: expect.stringContaining('/p/D'),
            hint: expect.stringContaining('no such package'),
        });
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

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The disk report
//
// `zen sandbox disk` answers a question people ask after seeing a long list of
// stopped containers, and the answer is only useful if it keeps two disks
// apart: what the engine holds inside its machine, and what a project holds in
// its own directory. Removing a container reclaims one of them.
// ---------------------------------------------------------------------------

describe('the disk report', () => {
    const reply = (stdout: string, code = 0): typeof runProcess => {
        return () =>
            Promise.resolve({ code, stdout, stderr: '', truncated: false, timedOut: false });
    };

    const ps = JSON.stringify([
        {
            Names: ['zn-old-aaaaaaaaaa'],
            State: 'exited',
            Created: 1_700_000_000,
            Labels: { zenera: '1', 'zenera.key': '20260827-213141-fa7d' },
            Size: { rootFsSize: 100_000_000, rwSize: 64_900_000 },
        },
        {
            Names: ['zn-new-bbbbbbbbbb'],
            State: 'running',
            Created: 1_800_000_000,
            Labels: { zenera: '1', 'zenera.key': '20260901-132913-2eac' },
        },
    ]);

    it('reads a listing as json, newest first, keeping the session label', async () => {
        const found = await ownedContainers('podman', reply(ps));
        expect(found.map((c) => c.name)).toEqual(['zn-new-bbbbbbbbbb', 'zn-old-aaaaaaaaaa']);
        expect(found[0].state).toBe('running');
        expect(found[1].key).toBe('20260827-213141-fa7d');
        expect(found[1].size).toBe(64_900_000);
    });

    it('only pays for sizes when they are asked for', async () => {
        const seen: string[] = [];
        const run: typeof runProcess = (bin, args) => {
            seen.push(args.join(' '));
            return reply(ps)(bin, args, {});
        };
        await ownedContainers('podman', run);
        await ownedContainers('podman', run, { sizes: true });
        expect(seen[0]).not.toContain('--size');
        expect(seen[1]).toContain('--size');
    });

    it('reports nothing rather than throwing when the engine talks nonsense', async () => {
        expect(await ownedContainers('podman', reply('not json'))).toEqual([]);
        expect(await engineDisk('podman', reply('not json'))).toBeUndefined();
        expect(await engineDisk('podman', reply('', 1))).toBeUndefined();
    });

    it('separates what is used from what could be reclaimed', async () => {
        const df = JSON.stringify([
            { Type: 'Images', TotalCount: 10, Active: 3, RawSize: 665, RawReclaimable: 600 },
            { Type: 'Containers', TotalCount: 9, Active: 0, RawSize: 72, RawReclaimable: 72 },
            { Type: 'Local Volumes', TotalCount: 0, Active: 0, RawSize: 0, RawReclaimable: 0 },
        ]);
        const usage = await engineDisk('podman', reply(df));
        expect(usage?.images).toEqual({ count: 10, active: 3, size: 665, reclaimable: 600 });
        expect(usage?.containers.count).toBe(9);
        expect(usage?.volumes.size).toBe(0);
    });

    it('measures a tree in the blocks it occupies', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-size-'));
        try {
            expect(dirSize(dir)).toBe(0);
            mkdirSync(join(dir, 'deep'));
            writeFileSync(join(dir, 'deep', 'file'), 'x'.repeat(10_000));
            const size = dirSize(dir);
            expect(size).toBeGreaterThanOrEqual(10_000);
            expect(size % 512).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prints sizes in the units the engine prints them in', () => {
        expect(bytes(0)).toBe('0 B');
        expect(bytes(999)).toBe('999 B');
        expect(bytes(1000)).toBe('1.0 kB');
        expect(bytes(11_332)).toBe('11.3 kB');
        expect(bytes(72_366_052)).toBe('72.4 MB');
        expect(bytes(665_426_572)).toBe('665 MB');
    });
});

// ---------------------------------------------------------------------------
// The sandbox check
//
// `zen check` is the one command that both reads and runs: a Dockerfile that
// does not build is a broken project, and only building it says so. The engine
// is injected here, so what these cases pin down is when it is asked and what
// each answer is reported as — in particular that a machine with no podman on
// it still gets a passing report, because that is the machine most likely to
// be running the check.
//
// Every case writes a different Dockerfile so it gets a different tag, and so
// its own entry in the pre-flight's memo.
// ---------------------------------------------------------------------------

describe('the sandbox check', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-sandbox-check-'));
    let n = 0;

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A project that builds its own image and has an agent that can use it. */
    const project = (dockerfile: string, tools = 'sandbox:*'): string => {
        const dir = join(root, `p${n++}`);
        mkdirSync(join(dir, 'sandbox'), { recursive: true });
        writeFileSync(join(dir, 'sandbox', 'Dockerfile'), dockerfile);
        writeFileSync(
            join(dir, 'agents.yaml'),
            'version: 1\nmodel: gpt-4o\n' +
                'sandbox:\n    build:\n        dockerfile: sandbox/Dockerfile\n' +
                `agents:\n  - name: solo\n    tools: [${tools}]\n`,
        );
        return dir;
    };

    /** A working engine that has never seen this project's image before. */
    const engine = (): { run: typeof runProcess; seen: string[] } => {
        const seen: string[] = [];
        return {
            seen,
            run: (bin, args) => {
                const line = `${bin} ${args.join(' ')}`;
                seen.push(line);
                const res: Partial<ProcResult> = line.includes('machine list')
                    ? { stdout: JSON.stringify([{ Name: 'default', Running: true }]) }
                    : line.includes('image exists')
                      ? { code: 1 }
                      : line.includes('/bin/sh')
                        ? { stdout: 'zen-check\n/workspace\n' }
                        : {};
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

    const of = (report: Report, severity: string): string[] =>
        report.findings.filter((f) => f.severity === severity).map((f) => f.code);

    it('builds the image, runs a command in it, and takes the container away', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # happy\n'),
            sandbox: { enabled: true, exec: e.run },
        });

        expect(of(report, 'error')).toEqual([]);
        expect(report.sandbox.probed).toBe(true);
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
        expect(report.sandbox.image).toMatch(/^localhost\/zenera-sandbox:[0-9a-f]+$/);
        expect(e.seen.some((l) => l.includes('build --tag'))).toBe(true);
        // Whatever else happened, nothing is left running.
        expect(e.seen.some((l) => l.includes('rm --force'))).toBe(true);
    });

    it('reports a Dockerfile that does not build as an error', async () => {
        const e = engine();
        const failing: typeof runProcess = (bin, args, opts) =>
            args[0] === 'build'
                ? Promise.resolve({
                      code: 1,
                      stdout: '',
                      stderr: 'Error: nope',
                      truncated: false,
                      timedOut: false,
                  })
                : e.run(bin, args, opts);

        const report = await validateProject({
            dir: project('FROM scratch # broken\n'),
            sandbox: { enabled: true, exec: failing },
        });

        expect(report.ok).toBe(false);
        expect(of(report, 'error')).toContain('sandbox.build');
        expect(report.sandbox.probed).toBe(false);
    });

    /** The check has to be useful on the machine that is not set up yet. */
    it('warns, rather than failing, when there is no container engine', async () => {
        const absent: typeof runProcess = () =>
            Promise.resolve({
                code: 127,
                stdout: '',
                stderr: 'command not found',
                truncated: false,
                timedOut: false,
            });

        const report = await validateProject({
            dir: project('FROM scratch # no engine\n'),
            sandbox: { enabled: true, exec: absent },
        });

        expect(report.ok).toBe(true);
        expect(of(report, 'error')).toEqual([]);
        expect(of(report, 'warning')).toContain('sandbox.unchecked');
        expect(report.sandbox.probed).toBe(false);
    });

    it('says a container started but could not be worked in', async () => {
        const e = engine();
        const mute: typeof runProcess = (bin, args, opts) =>
            args.includes('/bin/sh')
                ? Promise.resolve({
                      code: 1,
                      stdout: '',
                      stderr: 'sh: cannot create zen-check.txt: read-only file system',
                      truncated: false,
                      timedOut: false,
                  })
                : e.run(bin, args, opts);

        const report = await validateProject({
            dir: project('FROM scratch # read only\n'),
            sandbox: { enabled: true, exec: mute },
        });

        expect(of(report, 'error')).toContain('sandbox.smoke');
        expect(report.sandbox.probed).toBe(false);
    });

    it('touches nothing when the check is asked not to', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # skipped\n'),
            sandbox: { enabled: false, exec: e.run },
        });

        expect(e.seen).toEqual([]);
        expect(report.sandbox.probed).toBe(false);
        // The files it names are still checked; only the building is skipped.
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
    });

    /** Nothing is gained by building an image no agent can reach a shell in. */
    it('skips the build when no agent has the shell tools', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # unused\n', 'workspace:*'),
            sandbox: { enabled: true, exec: e.run },
        });

        expect(e.seen).toEqual([]);
        expect(report.sandbox.used).toBe(false);
    });

    it('names the missing file when the Dockerfile is not there', async () => {
        const dir = join(root, `p${n++}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'agents.yaml'),
            'version: 1\nmodel: gpt-4o\n' +
                'sandbox:\n    build:\n        dockerfile: sandbox/Dockerfile\n' +
                'agents:\n  - name: solo\n    tools: [sandbox:*]\n',
        );

        const e = engine();
        const report = await validateProject({ dir, sandbox: { enabled: true, exec: e.run } });

        expect(of(report, 'error')).toContain('sandbox.dockerfile.missing');
        // A file that is not there cannot be built, so the engine is never asked.
        expect(e.seen.some((l) => l.includes('build'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The catalog
//
// The vendor adapters are the part most likely to break without anyone
// noticing: a payload reshapes, a listing quietly returns nothing, and the
// only symptom is a shorter list. Stubbed clients keep them honest offline.
// ---------------------------------------------------------------------------

describe('reading a provider listing', () => {
    const pages = <T>(...items: T[]) => ({ models: { list: async () => items } });

    it('reads a role off an OpenAI id, and drops what cannot be reached', async () => {
        const rows = await fetchCatalog('openai', {
            models: {
                list: async () => [
                    { id: 'gpt-4o' },
                    { id: 'text-embedding-3-small' },
                    { id: 'dall-e-3' },
                    { id: 'chatgpt-image-latest' },
                    { id: 'omni-moderation-latest' },
                ],
            },
        });
        const roles = Object.fromEntries(rows.map((r) => [r.id, r.roles]));
        expect(roles).toEqual({
            'gpt-4o': ['chat'],
            'text-embedding-3-small': ['embedding'],
            'dall-e-3': ['image'],
            'chatgpt-image-latest': ['image'],
        });
        expect(rows[0]!.ref).toBe('openai:gpt-4o');
    });

    // OpenAI's listing has no dimensions field at all, and a blank there sends
    // someone to the docs for something this file already knows.
    it('fills an OpenAI embedding width in from the built-in list', async () => {
        const [row] = await fetchCatalog('openai', {
            models: { list: async () => [{ id: 'text-embedding-3-small' }] },
        });
        expect(row!.dimensions).toBe(1536);
        expect(row!.source).toBe('live');
    });

    it('never invents an Anthropic embedding model', async () => {
        const rows = await fetchCatalog('anthropic', {
            models: {
                list: async () => [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }],
            },
        });
        expect(rows.every((r) => r.roles.includes('chat'))).toBe(true);
        expect(rows.some((r) => r.roles.includes('embedding'))).toBe(false);
    });

    it('asks Google for base models, not tuned ones', async () => {
        let asked: unknown;
        await fetchCatalog('vertex', {
            models: {
                list: async (params: unknown) => {
                    asked = params;
                    return [];
                },
            },
        });
        // Without this the SDK lists tuned models, and an account with none
        // looks like an account with no models at all.
        expect(asked).toMatchObject({ config: { queryBase: true } });
    });

    it('strips the resource prefix and reads the role off supportedActions', async () => {
        const rows = await fetchCatalog(
            'vertex',
            pages(
                {
                    name: 'models/gemini-2.5-flash',
                    supportedActions: ['generateContent'],
                    inputTokenLimit: 1_048_576,
                },
                {
                    name: 'publishers/google/models/text-embedding-005',
                    supportedActions: ['embedContent'],
                },
            ),
        );
        expect(rows.map((r) => [r.id, r.roles])).toEqual([
            ['gemini-2.5-flash', ['chat']],
            ['text-embedding-005', ['embedding']],
        ]);
        expect(rows[0]!.contextLength).toBe(1_048_576);
    });

    // Vertex lists the whole Model Garden. Those rows are deployment recipes,
    // and asking one a question fails in a way no error message explains.
    it('leaves out Model Garden rows the GenAI API will not serve', async () => {
        const rows = await fetchCatalog(
            'vertex',
            pages(
                { name: 'publishers/google/models/bart-large-cnn' },
                { name: 'publishers/google/models/alphafold3-request' },
                { name: 'publishers/google/models/gemini-3-experimental' },
            ),
        );
        expect(rows.map((r) => r.id)).toEqual(['gemini-3-experimental']);
    });

    it('walks every OpenRouter page and folds in the separate embedding list', async () => {
        const chat = (id: string) => ({
            id,
            name: id,
            contextLength: 200_000,
            pricing: { prompt: '0', completion: '0' },
            architecture: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
            supportedParameters: ['tools'],
        });
        const rows = await fetchCatalog('openrouter', {
            models: {
                list: async () => [
                    { result: { data: [chat('a/one')] } },
                    { result: { data: [chat('a/two')] } },
                ],
            },
            embeddings: {
                listModels: async () => [{ result: { data: [{ id: 'a/embed' }] } }],
            },
        });
        expect(rows.map((r) => r.id)).toEqual(['a/one', 'a/two', 'a/embed']);
        expect(rows[0]).toMatchObject({
            roles: ['chat'],
            supports: { tools: true, vision: true },
            pricing: { free: true },
        });
        expect(rows[2]!.roles).toEqual(['embedding']);
    });

    // The embeddings endpoint is the newer of the two and the one a gateway is
    // most likely not to proxy. Losing every chat model over it is a bad trade.
    it('still returns chat models when the embedding listing fails', async () => {
        const rows = await fetchCatalog('openrouter', {
            models: { list: async () => [{ result: { data: [{ id: 'a/one' }] } }] },
            embeddings: {
                listModels: async () => {
                    throw new Error('404 not found');
                },
            },
        });
        expect(rows.map((r) => r.id)).toEqual(['a/one']);
    });
});

describe('where a listing comes from', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-catalog-'));
    // Set per test rather than once: neighbouring suites snapshot and restore
    // the whole environment, and a value written at collection time is gone by
    // the time anything here runs.
    beforeEach(() => {
        process.env.ZENERA_HOME = root;
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const cache = (provider: string, fetchedAt: string, ids: string[]): void =>
        writeJson(join(paths.catalog(), `${provider}.json`), {
            version: 1,
            provider,
            fetchedAt,
            entries: ids.map((id) => ({
                ref: `${provider}:${id}`,
                id,
                provider,
                roles: ['chat'],
                source: 'live',
            })),
        });

    it('falls back to the built-in list when there is nothing else', async () => {
        const cat = await loadCatalog('anthropic', { offline: true });
        expect(cat.origin).toBe('curated');
        expect(cat.entries.every((e) => e.source === 'curated')).toBe(true);
        expect(cat.entries.map((e) => e.id)).toEqual(CURATED.anthropic.map((e) => e.id));
    });

    it('uses a cache written inside the day without asking anyone', async () => {
        cache('openai', new Date().toISOString(), ['cached-model']);
        const cat = await loadCatalog('openai', { offline: true });
        expect(cat.origin).toBe('cache');
        expect(cat.entries.map((e) => e.id)).toEqual(['cached-model']);
    });

    // Yesterday's real answer from this account beats today's guess about
    // accounts in general.
    it('prefers a stale cache to the built-in list', async () => {
        cache('google', new Date(Date.now() - 2 * CATALOG_TTL_MS).toISOString(), ['old-model']);
        const cat = await loadCatalog('google', { offline: true });
        expect(cat.origin).toBe('stale');
        expect(cat.entries.map((e) => e.id)).toEqual(['old-model']);
    });

    it('ignores a cache written by a version that is not this one', async () => {
        writeJson(join(paths.catalog(), 'openrouter.json'), {
            version: 99,
            provider: 'openrouter',
            fetchedAt: new Date().toISOString(),
            entries: [{ ref: 'openrouter:x', id: 'x', provider: 'openrouter', roles: ['chat'] }],
        });
        const cat = await loadCatalog('openrouter', { offline: true });
        expect(cat.origin).toBe('curated');
    });
});

describe('narrowing a list of models', () => {
    const row = (over: Partial<CatalogEntry>): CatalogEntry => ({
        ref: 'openrouter:a/one',
        id: 'a/one',
        provider: 'openrouter',
        roles: ['chat'],
        source: 'live',
        ...over,
    });

    it('wants every word, so a second one narrows rather than widens', () => {
        const claude = row({ name: 'Anthropic: Claude Haiku 4.5' });
        expect(matches(claude, 'claude haiku')).toBe(true);
        expect(matches(claude, 'claude sonnet')).toBe(false);
    });

    it('matches the ref as well as the name', () => {
        expect(matches(row({}), 'a/one')).toBe(true);
    });

    it('keeps a row only if it holds one of the roles asked for', () => {
        const embed = row({ roles: ['embedding'] });
        expect(matches(embed, '', { roles: ['embedding'] })).toBe(true);
        expect(matches(embed, '', { roles: ['chat'] })).toBe(false);
        expect(matches(embed, '', { roles: [] })).toBe(true);
    });

    it('treats an unknown context length as too small rather than as a match', () => {
        expect(matches(row({}), '', { minContext: 1000 })).toBe(false);
        expect(matches(row({ contextLength: 2000 }), '', { minContext: 1000 })).toBe(true);
    });
});

describe('telling a blocked account from a bad key', () => {
    const fails = (message: string, status?: number): Error =>
        Object.assign(new Error(message), status === undefined ? {} : { status });

    // The case this whole verdict exists for: a perfectly good service-account
    // key against a project where the API was never switched on. It arrives as
    // a 403, and calling it `dead` sends someone off to rotate a working key.
    it('calls a disabled API blocked, and says which one in which project', () => {
        const check = classify(
            fails(
                '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Vertex AI API has ' +
                    'not been used in project my-proj before or it is disabled. Enable it by ' +
                    'visiting https://console.developers.google.com/apis/api/aiplatform.googleapis' +
                    '.com/overview?project=my-proj then retry."}}',
                403,
            ),
        );
        expect(check.state).toBe('blocked');
        expect(check.fix).toBe(
            'gcloud services enable aiplatform.googleapis.com --project my-proj',
        );
        // The sentence, not the JSON envelope it arrived in.
        expect(check.detail).toMatch(/^Vertex AI API has not been used/);
    });

    it('still calls a rejected credential dead', () => {
        expect(classify(fails('invalid_api_key', 401)).state).toBe('dead');
        expect(classify(fails('403 permission_denied on this resource', 403)).state).toBe('dead');
    });

    it('calls an empty balance blocked, and a rate limit live', () => {
        expect(classify(fails('Your credit balance is too low', 400)).state).toBe('blocked');
        // 429 is this minute's problem; the account is fine.
        expect(classify(fails('Rate limit exceeded, quota exceeded', 429)).state).toBe('live');
    });

    it('keeps an unreachable provider out of both', () => {
        expect(classify(fails('fetch failed')).state).toBe('unknown');
    });
});
