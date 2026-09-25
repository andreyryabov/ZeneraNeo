import { MemoryStore, type MemoryNode } from '@zenera/neo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory as command } from '../src/commands/memory.ts';
import { CliError, EXIT } from '../src/term.ts';

// ---------------------------------------------------------------------------
// zen memory search
//
// Recall from the terminal. Every test here runs the lexical path: the memory
// is written without vectors, so nothing contacts a model and the suite stays
// offline. What that leaves uncovered is the embedding call itself — and what
// it covers is everything around it, including the promise this subcommand
// lives or dies by: that it says which ranking you are looking at.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';

function node(id: string, text: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        kind: 'fact',
        text,
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
    query: { text: string; limit?: number; maxHops?: number; minScore?: number };
    sees: string[];
    ranking: { by: string; model?: string; reason?: string };
    seeds: string[];
    truncated: boolean;
    nodes: { id: string; kind: string; score: number; seed: boolean; text: string }[];
    edges: { source: string; target: string; relation: string }[];
    block: string;
}

describe('zen memory search', () => {
    let root: string;
    let dir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'zen-recall-'));
        dir = join(root, 'mem');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /**
     * `--json` is a global flag, so it arrives as context rather than in the
     * argument list. Said here once so the call sites can spell it the way
     * someone at a terminal would.
     */
    async function run(...args: string[]): Promise<{ out: any; err: unknown; said: string }> {
        const out: string[] = [];
        const said: string[] = [];
        const asJson = args.includes('--json');
        const argv = args.filter((a) => a !== '--json');
        const stdout = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                out.push(String(chunk));
                return true;
            });
        const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                said.push(String(chunk));
                return true;
            });
        let err: unknown;
        try {
            await command.run({ args: argv, json: asJson, cwd: root });
        } catch (e) {
            err = e;
        } finally {
            stdout.mockRestore();
            stderr.mockRestore();
        }
        const text = out.join('');
        return { out: asJson && text ? JSON.parse(text) : text, err, said: said.join('') };
    }

    async function memory(nodes: MemoryNode[], links: [string, string, string][] = []) {
        const store = await MemoryStore.open(dir);
        for (const n of nodes) {
            store.graph.adopt(n);
        }
        for (const [from, to, relation] of links) {
            store.graph.link(from, to, relation as never, T0);
        }
        await store.commit();
        store.release();
    }

    const GRAPH: [MemoryNode[], [string, string, string][]] = [
        [
            node('REQ', 'deploy the billing service to staging', { kind: 'task' }),
            node('SCR', 'the deploy script for staging', {
                kind: 'file',
                file: { path: '/memory/SCR.sh', bytes: 12, sha256: 'x', format: 'sh' },
            }),
            node('FCT', 'staging lives at staging.example.com'),
            node('SEC', 'the key rotation policy', { audience: ['audit'] }),
        ],
        [
            ['REQ', 'SCR', 'PRODUCED'],
            ['SCR', 'FCT', 'REFERENCES'],
        ],
    ];

    it('wants something to recall', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { err } = await run('search', '--dir', 'mem');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
    });

    it('takes the query unquoted, because it is the only argument', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { out } = (await run('search', 'deploy', 'staging', '--dir', 'mem', '--json')) as {
            out: Out;
        };

        expect(out.query.text).toBe('deploy staging');
    });

    it('hands back the subgraph, not just the seeds', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { out } = (await run('search', 'deploy', '--dir', 'mem', '--json')) as { out: Out };

        expect(out.seeds).toContain('REQ');
        // FCT is two hops out and never matched the query; it is here because
        // the walk brought it, which is the whole difference from grep.
        expect(out.nodes.map((n) => n.id).sort()).toEqual(['FCT', 'REQ', 'SCR']);
        expect(out.nodes.find((n) => n.id === 'FCT')!.seed).toBe(false);
        expect(out.edges).toHaveLength(2);
    });

    it('prints the block a model would have been given', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { out } = (await run('search', 'deploy', '--dir', 'mem', '--json')) as { out: Out };

        expect(out.block).toContain('task  REQ');
        expect(out.block).toContain('→produced');
        // The tag is the model's envelope; a person reading a terminal is not
        // parsing an element out of it.
        expect(out.block).not.toContain('memory-recollection');
    });

    it('says when the ranking is not the one an agent sees', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { out } = (await run('search', 'deploy', '--dir', 'mem', '--json')) as { out: Out };
        expect(out.ranking).toMatchObject({ by: 'term overlap', reason: expect.any(String) });

        const { said } = await run('search', 'deploy', '--dir', 'mem');
        expect(said).toContain('term overlap');
    });

    it('reads unmasked by default, and as one agent when asked', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const open = (await run('search', 'rotation policy', '--dir', 'mem', '--json')) as {
            out: Out;
        };
        expect(open.out.nodes.map((n) => n.id)).toContain('SEC');
        expect(open.out.sees).toContain('audit');

        // An agent that sees only `*` cannot reach it — which is the answer to
        // "why did it not recall that", and is invisible from `ls`.
        const masked = (await run(
            'search',
            'rotation policy',
            '--audience',
            'reviewer',
            '--dir',
            'mem',
            '--json',
        )) as { out: Out };
        expect(masked.out.nodes.map((n) => n.id)).not.toContain('SEC');
    });

    it('leaves out what was superseded until --all', async () => {
        await memory(
            [node('OLD', 'deploy with the old script'), node('NEW', 'deploy with the new script')],
            [['NEW', 'OLD', 'SUPERSEDES']],
        );

        const plain = (await run('search', 'deploy', '--dir', 'mem', '--json')) as { out: Out };
        expect(plain.out.nodes.map((n) => n.id)).toEqual(['NEW']);

        const all = (await run('search', 'deploy', '--all', '--dir', 'mem', '--json')) as {
            out: Out;
        };
        expect(all.out.nodes.map((n) => n.id).sort()).toEqual(['NEW', 'OLD']);
    });

    it('turns --stale away rather than ignoring it', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { err } = await run('search', 'deploy', '--stale', '--dir', 'mem');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).hint).toContain('--all');
    });

    it('leaves the engine defaults alone unless a flag names one', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const bare = (await run('search', 'deploy', '--dir', 'mem', '--json')) as { out: Out };
        expect(bare.out.query.limit).toBeUndefined();
        expect(bare.out.query.maxHops).toBeUndefined();

        const set = (await run(
            'search',
            'deploy',
            '--limit',
            '1',
            '--hops',
            '0',
            '--dir',
            'mem',
            '--json',
        )) as { out: Out };
        expect(set.out.query.limit).toBe(1);
        // Nothing was followed, so the subgraph is the one seed.
        expect(set.out.nodes).toHaveLength(1);
    });

    it('refuses a limit or a score that is not a number', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const limit = await run('search', 'deploy', '--limit', 'lots', '--dir', 'mem');
        expect((limit.err as CliError).message).toContain('--limit');

        const score = await run('search', 'deploy', '--min-score', '7', '--dir', 'mem');
        expect((score.err as CliError).message).toContain('--min-score');
    });

    it('prints bare ids for piping into show', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { out } = await run('search', 'deploy', '--ids-only', '--dir', 'mem');

        expect(String(out).trim().split('\n').sort()).toEqual(['FCT', 'REQ', 'SCR']);
    });

    it('says so when nothing was close enough', async () => {
        await memory(GRAPH[0], GRAPH[1]);

        const { said, err } = await run('search', 'quantum chromodynamics', '--dir', 'mem');

        expect(err).toBeUndefined();
        expect(said).toContain('nothing recalled');
    });
});
