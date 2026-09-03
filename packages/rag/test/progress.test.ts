import type { Embedder, EmbeddingResponse } from '@zenera/neo';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex } from '../src/schema/build.ts';
import { LOCK_FILE, README_FILE } from '../src/schema/progress.ts';
import { StubEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// What the directory says about itself
//
// The two files a build leaves behind are the only thing anyone watching it
// has: a second terminal, a colleague, or an agent that reads the index as
// `/assets/<name>` and has no idea what a host path is. So the assertions here
// are about what is written, and about what is never written.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

const dirs: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-progress-'));
    dirs.push(dir);
    return dir;
}

afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

async function build(dir: string, embedder: Embedder = new StubEmbedder()): Promise<void> {
    await buildIndex({
        files: [spec('petstore.yaml'), spec('billing.json')],
        out: dir,
        embedder,
        embeddingRef: 'stub:bag-of-words',
        indexer: 'test',
    });
}

describe('the README a finished index carries', () => {
    let dir = '';

    beforeEach(async () => {
        dir = await scratch();
        await build(dir);
    });

    it('describes what was indexed, and with what', () => {
        const readme = read(dir, README_FILE);

        expect(readme).toContain('Petstore, Billing');
        expect(readme).toContain('2 API documents');
        expect(readme).toContain('stub:bag-of-words');
        expect(readme).not.toContain('being built');
    });

    it('names every file in the directory, so a reader knows where to start', () => {
        const readme = read(dir, README_FILE);

        for (const file of [
            'manifest.json',
            'graph.json',
            'schemas.json',
            'operations.json',
            'sources/',
        ]) {
            expect(readme).toContain(file);
        }
        expect(readme).toContain('zen rag schema search');
    });

    it('holds no absolute path, because the index is read under another name', () => {
        expect(read(dir, README_FILE)).not.toMatch(/\s\/[A-Za-z]/);
        expect(read(dir, 'manifest.json')).not.toContain('"/');
    });

    it('releases the lock', () => {
        expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    });
});

describe('the documents the index carries', () => {
    let dir = '';

    beforeEach(async () => {
        dir = await scratch();
        await build(dir);
    });

    it('keeps a copy of each one, named the way the manifest points at it', () => {
        const manifest = JSON.parse(read(dir, 'manifest.json')) as {
            sources: { name: string; file: string; path: string }[];
        };

        expect(manifest.sources.map((s) => s.file)).toEqual(['petstore.yaml', 'billing.json']);
        expect(manifest.sources.map((s) => s.path)).toEqual([
            'sources/petstore.json',
            'sources/billing.json',
        ]);
        for (const source of manifest.sources) {
            expect(isAbsolute(source.path)).toBe(false);
            const copy = JSON.parse(read(dir, source.path)) as { info?: { title?: string } };
            expect(copy.info?.title).toBeTruthy();
        }
    });

    it('leaves nothing pointing outside itself', () => {
        for (const file of ['manifest.json', 'graph.json', 'operations.json']) {
            expect(read(dir, file)).not.toContain(spec('petstore.yaml'));
        }
    });

    it('can be told not to, for an index that will never be moved', async () => {
        const bare = await scratch();
        await buildIndex({
            files: [spec('petstore.yaml')],
            out: bare,
            embedder: new StubEmbedder(),
            indexer: 'test',
            sources: false,
        });

        const manifest = JSON.parse(read(bare, 'manifest.json')) as {
            sources: { path?: string }[];
        };
        expect(manifest.sources.every((s) => s.path === undefined)).toBe(true);
        expect(existsSync(join(bare, 'sources'))).toBe(false);
    });
});

describe('the lock', () => {
    it('refuses a second build of the same directory', async () => {
        const dir = await scratch();
        writeFileSync(
            join(dir, LOCK_FILE),
            JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'now' }),
        );

        await expect(build(dir)).rejects.toThrow(/already being built/);
    });

    it('takes over one whose process is gone', async () => {
        const dir = await scratch();
        writeFileSync(
            join(dir, LOCK_FILE),
            JSON.stringify({ pid: 999_999, host: hostname(), startedAt: 'yesterday' }),
        );

        await expect(build(dir)).resolves.toBeUndefined();
        expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    });
});

describe('a build that dies', () => {
    class Broken implements Embedder {
        readonly id = 'stub:broken';
        async embed(): Promise<EmbeddingResponse> {
            throw new Error('the embedder gave up\nand said more about it');
        }
    }

    it('says so in the README, and lets go of the directory', async () => {
        const dir = await scratch();

        await expect(build(dir, new Broken())).rejects.toThrow('the embedder gave up');

        const readme = read(dir, README_FILE);
        expect(readme).toContain('failed');
        expect(readme).toContain('embedding');
        // One line of the reason: a stack trace in a README helps nobody.
        expect(readme).toContain('the embedder gave up');
        expect(readme).not.toContain('and said more about it');
        expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    });
});
