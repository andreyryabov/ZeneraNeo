import { CliError, EXIT } from '@zenera/cli/lib';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '../src/command.ts';
import { inspectIndex } from '../src/common/manifest.ts';
import { stagingFor, swapIn } from '../src/common/restore.ts';
import { buildIndex } from '../src/docs/build.ts';
import { DOCS_INDEX, readManifest, SOURCES_DIR } from '../src/docs/files.ts';
import { DocsIndex } from '../src/docs/search.ts';
import { ChunkStore } from '../src/docs/store.ts';
import { buildIndex as buildSchema } from '../src/schema/build.ts';
import { StubEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// An index that cannot answer, and getting it back
//
// The case being defended is a clone: `lance/` is binary and rebuildable, so it
// is git-ignored, and everything else is committed. What arrives is an index
// with a manifest saying a build finished — on a machine that is not this one.
// Every test below is a step of that story, in the order it happens to someone.
// ---------------------------------------------------------------------------

const CORPUS: Record<string, string> = {
    'guide/install.md': [
        '# Install',
        '',
        'Unpack the archive and run the installer.',
        '',
        '## Requirements',
        '',
        'A supported operating system and 2 GB of free disk.',
        '',
    ].join('\n'),

    'guide/upgrade.md': ['# Upgrade', '', 'Stop the service before replacing the binary.', ''].join(
        '\n',
    ),

    'notes.txt': ['The staging cluster is rebuilt every Sunday.', ''].join('\n'),
};

const spec = (name: string) => fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

const source = await mkdtemp(join(tmpdir(), 'zenera-restore-src-'));
const dir = await mkdtemp(join(tmpdir(), 'zenera-restore-'));
const embedder = new StubEmbedder();

for (const [name, text] of Object.entries(CORPUS)) {
    const path = join(source, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
}

await buildIndex({
    files: [source],
    cwd: process.cwd(),
    out: dir,
    embedder,
    indexer: 'test',
    chunk: { chunkTokens: 200 },
});

afterAll(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** Runs a `zen rag` command with both streams captured, and keeps the error. */
async function invoke(args: string[], json = false): Promise<CliError | undefined> {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await command.run({ args, json, cwd: process.cwd() });
    } catch (thrown) {
        return thrown as CliError;
    }
    return undefined;
}

describe('what the manifest does not say', () => {
    it('records the chunk settings a build was given, so a restore can repeat them', async () => {
        expect((await readManifest(dir)).chunk).toEqual({ chunkTokens: 200 });
    });

    it('records nothing when nothing was asked, which means the defaults', async () => {
        const plain = await mkdtemp(join(tmpdir(), 'zenera-restore-plain-'));
        await buildIndex({
            files: [source],
            cwd: process.cwd(),
            out: plain,
            embedder,
            indexer: 'test',
        });
        expect((await readManifest(plain)).chunk).toBeUndefined();
        await rm(plain, { recursive: true, force: true });
    });
});

describe('ready', () => {
    it('says a freshly built index is searchable', async () => {
        const health = await inspectIndex(dir, DOCS_INDEX, ChunkStore.open);
        expect(health.state).toBe('ready');
        expect(health.fix).toBe('');
        expect(await invoke(['docs', 'ready', '--dir', dir])).toBeUndefined();
    });

    it('tells a directory with no index from one whose vectors are gone', async () => {
        const empty = await mkdtemp(join(tmpdir(), 'zenera-restore-empty-'));
        const absent = await inspectIndex(empty, DOCS_INDEX, ChunkStore.open);
        expect(absent.state).toBe('absent');
        expect(absent.fix).toContain('index');

        const clone = await cloneWithoutVectors();
        const incomplete = await inspectIndex(clone, DOCS_INDEX, ChunkStore.open);
        expect(incomplete.state).toBe('incomplete');
        // The difference is the whole point: one has to be built, the other
        // only re-embedded, and the message has to name the cheaper one.
        expect(incomplete.fix).toContain('restore');
        expect(incomplete.head?.embedding.ref).toBe('stub:bag-of-words');

        await rm(empty, { recursive: true, force: true });
        await rm(clone, { recursive: true, force: true });
    });

    it('refuses with the invalid-project code, so a setup step can branch on it', async () => {
        const clone = await cloneWithoutVectors();
        const error = await invoke(['docs', 'ready', '--dir', clone, '--quiet']);
        expect(error).toBeInstanceOf(CliError);
        expect(error!.code).toBe(EXIT.invalid);
        await rm(clone, { recursive: true, force: true });
    });
});

describe('restoring', () => {
    it('rebuilds a searchable index from the copies alone, with the same names', async () => {
        const clone = await cloneWithoutVectors();
        const manifest = await readManifest(clone);
        const staging = stagingFor(clone);

        // What `restore` does, minus the credential: the documents are the
        // index's own copies and every setting comes off the manifest.
        const built = await buildIndex({
            files: [join(clone, SOURCES_DIR)],
            cwd: clone,
            root: join(clone, SOURCES_DIR),
            out: staging.dir,
            embedder,
            embeddingRef: manifest.embedding.ref,
            indexer: manifest.indexer,
            chunk: manifest.chunk,
        });
        await swapIn(clone, staging);

        expect(built.manifest.sources.map((s) => s.name).sort()).toEqual(
            manifest.sources.map((s) => s.name).sort(),
        );
        expect(built.manifest.counts).toEqual(manifest.counts);
        expect((await inspectIndex(clone, DOCS_INDEX, ChunkStore.open)).state).toBe('ready');

        const index = await DocsIndex.open(clone, embedder);
        try {
            const found = await index.search({ query: 'free disk requirements' });
            expect(found.matches.length).toBeGreaterThan(0);
            // The lines are read back out of `sources/`, so a restore that lost
            // them would rank passages it cannot quote.
            expect((await index.lines('guide/install.md')).join('\n')).toBe(
                CORPUS['guide/install.md'],
            );
        } finally {
            index.close();
        }
        await rm(clone, { recursive: true, force: true });
    });

    it('leaves nothing beside the index, and nothing a search could find', async () => {
        const staging = stagingFor(dir);
        expect(existsSync(staging.dir)).toBe(false);
        expect(existsSync(staging.previous)).toBe(false);
        // Hidden, because the nearest-index search skips dotted directories —
        // a half-built sibling holding a manifest must never be findable.
        expect(staging.dir.split('/').pop()!.startsWith('.')).toBe(true);
    });

    it('puts the old index back when the rebuild cannot be moved into place', async () => {
        const clone = await cloneWithoutVectors();
        const staging = stagingFor(clone);
        // Nothing was staged, so the second rename fails; the index must
        // survive, because a failed restore that eats the index is worse than
        // the missing vectors it was fixing.
        await expect(swapIn(clone, staging)).rejects.toThrow();
        expect((await readManifest(clone)).counts.documents).toBe(3);
        await rm(clone, { recursive: true, force: true });
    });

    it('refuses a schema index that kept no copy of its documents', async () => {
        const bare = await mkdtemp(join(tmpdir(), 'zenera-restore-bare-'));
        await buildSchema({
            files: [spec('petstore.yaml')],
            out: bare,
            embedder,
            indexer: 'test',
            sources: false,
        });
        const error = await invoke(['schema', 'restore', '--dir', bare]);
        expect(error).toBeInstanceOf(CliError);
        expect(error!.code).toBe(EXIT.invalid);
        expect(error!.hint).toContain('--no-sources');
        await rm(bare, { recursive: true, force: true });
    });
});

/** An index as a clone has it: everything committed, and no vectors. */
async function cloneWithoutVectors(): Promise<string> {
    const clone = await mkdtemp(join(tmpdir(), 'zenera-restore-clone-'));
    await rm(clone, { recursive: true, force: true });
    await cp(dir, clone, { recursive: true });
    await rm(join(clone, 'lance'), { recursive: true, force: true });
    return clone;
}
