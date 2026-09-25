import { MemoryStore, type MemoryNode } from '@zenera/neo';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory as command } from '../src/commands/memory.ts';
import { CliError, EXIT } from '../src/term.ts';

// ---------------------------------------------------------------------------
// zen memory grep
//
// Driven through `run` with `--json`, like the merge tests, and for the same
// reason: the answer is what a script or an agent reads, so that is the shape
// worth pinning. The graph is built by hand because grep contacts no model.
//
// The one case that is not about matching is the last: this is the subcommand
// that declines the directory lock, and the two moments it is most wanted are
// the two where taking the lock would fail.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';

function node(id: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        kind: 'fact',
        text: `remembered ${id}`,
        audience: ['*'],
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: T0,
        useCount: 0,
        revision: 1,
        ...over,
    };
}

interface Out {
    found: number;
    truncated: boolean;
    matches: {
        id: string;
        kind: string;
        stale: boolean;
        hits: { where: string; line: number; text: string }[];
    }[];
    unsearched: { id: string; reason: string }[];
}

describe('zen memory grep', () => {
    let root: string;
    let dir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'zen-grep-'));
        dir = join(root, 'mem');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function run(...args: string[]): Promise<{ out: any; err: unknown }> {
        const lines: string[] = [];
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                lines.push(String(chunk));
                return true;
            });
        const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        let err: unknown;
        try {
            await command.run({ args, json: true, cwd: root });
        } catch (e) {
            err = e;
        } finally {
            write.mockRestore();
            quiet.mockRestore();
        }
        return { out: lines.length ? JSON.parse(lines.join('')) : undefined, err };
    }

    async function memory(nodes: MemoryNode[], links: [string, string][] = []): Promise<void> {
        const store = await MemoryStore.open(dir);
        for (const n of nodes) {
            store.graph.adopt(n);
        }
        for (const [from, to] of links) {
            store.graph.link(from, to, 'SUPERSEDES', T0);
        }
        await store.commit();
        store.release();
    }

    it('wants exactly one pattern', async () => {
        await memory([node('A')]);

        const { err } = await run('grep', '--dir', 'mem');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
    });

    it('refuses a broken regex with its own hint, not a stack', async () => {
        await memory([node('A')]);

        const { err } = await run('grep', '(unclosed', '--regex', '--dir', 'mem');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).message).toContain('invalid pattern');
    });

    it('reports the true total even when --limit cut the list', async () => {
        await memory([node('A'), node('B'), node('C')]);

        const { out } = (await run('grep', 'remembered', '--limit', '2', '--dir', 'mem')) as {
            out: Out;
        };

        expect(out.matches).toHaveLength(2);
        expect(out.found).toBe(3);
        expect(out.truncated).toBe(true);
    });

    it('reads unmasked, like everything else here', async () => {
        await memory([node('A', { audience: ['audit'] }), node('B')]);

        const { out } = (await run('grep', 'remembered', '--dir', 'mem')) as { out: Out };

        expect(out.matches.map((m) => m.id).sort()).toEqual(['A', 'B']);
    });

    it('leaves out what was superseded until --all, then marks it', async () => {
        await memory([node('OLD'), node('NEW')], [['NEW', 'OLD']]);

        const plain = (await run('grep', 'remembered', '--dir', 'mem')) as { out: Out };
        expect(plain.out.matches.map((m) => m.id)).toEqual(['NEW']);

        const all = (await run('grep', 'remembered', '--all', '--dir', 'mem')) as { out: Out };
        expect(new Map(all.out.matches.map((m) => [m.id, m.stale]))).toEqual(
            new Map([
                ['NEW', false],
                ['OLD', true],
            ]),
        );

        const stale = (await run('grep', 'remembered', '--stale', '--dir', 'mem')) as { out: Out };
        expect(stale.out.matches.map((m) => m.id)).toEqual(['OLD']);
    });

    it('looks inside remembered files, and names one it could not read', async () => {
        mkdirSync(join(dir, 'files'), { recursive: true });
        writeFileSync(join(dir, 'files', 'A.py'), 'import os\nHOST = "db.internal"\n');
        await memory([
            node('A', {
                kind: 'file',
                text: 'a script',
                file: { path: '/memory/A.py', bytes: 29, sha256: 'x', format: 'py' },
            }),
            node('B', {
                kind: 'file',
                text: 'one whose bytes went missing',
                file: { path: '/memory/B.py', bytes: 1, sha256: 'x', format: 'py' },
            }),
        ]);

        const { out } = (await run('grep', 'db.internal', '--dir', 'mem')) as { out: Out };

        expect(out.matches).toHaveLength(1);
        expect(out.matches[0]!.hits).toEqual([
            { where: 'file', line: 2, text: 'HOST = "db.internal"' },
        ]);
        expect(out.unsearched).toEqual([{ id: 'B', path: '/memory/B.py', reason: 'missing' }]);
    });

    it('narrows to a field, so metadata can be searched on its own', async () => {
        await memory([node('A', { text: 'the host', metadata: { host: 'db.internal' } })]);

        const meta = (await run('grep', 'db.internal', '--in', 'metadata', '--dir', 'mem')) as {
            out: Out;
        };
        expect(meta.out.found).toBe(1);

        const text = (await run('grep', 'db.internal', '--in', 'text', '--dir', 'mem')) as {
            out: Out;
        };
        expect(text.out.found).toBe(0);
    });

    it('names the fields it knows when given one it does not', async () => {
        await memory([node('A')]);

        const { err } = await run('grep', 'x', '--in', 'everything', '--dir', 'mem');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).message).toContain('text, metadata, file');
    });

    // The two moments grep is most wanted are while a run is writing, and
    // against the read-only /memory mount — in both of which claiming the lock
    // fails. A reader that took it would only ever be refusing itself.
    it('answers while another holder has the lock', async () => {
        await memory([node('A', { text: 'the staging host' })]);
        const holder = await MemoryStore.open(dir);

        try {
            const { out, err } = (await run('grep', 'staging', '--dir', 'mem')) as {
                out: Out;
                err: unknown;
            };
            expect(err).toBeUndefined();
            expect(out.matches.map((m) => m.id)).toEqual(['A']);
        } finally {
            holder.release();
        }
    });
});
