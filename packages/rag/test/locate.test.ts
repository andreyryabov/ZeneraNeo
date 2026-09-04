import { CliError } from '@zenera/cli/lib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isIndex, locateIndex, outputDir } from '../src/common/locate.ts';
import { SCHEMA_INDEX } from '../src/schema/files.ts';

const { defaultDir: DEFAULT_DIR, envName: DIR_ENV } = SCHEMA_INDEX;

// ---------------------------------------------------------------------------
// Finding the index nobody named
//
// The rule under test is that nothing here knows the word `schema-db`: an
// index is a directory with a manifest in it, and that is the only thing
// looked for. What is asserted alongside is the refusal — two indexes the same
// distance away is a question for the caller, because an index chosen by
// accident does not fail, it answers confidently about the wrong API.
//
// Every case builds its own tree and passes it as the ceiling. The search
// climbs, so a shared root would let one case find another's index, and a test
// that can see its neighbours is testing the neighbours.
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function world(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'zenera-rag-locate-'));
    roots.push(root);
    return root;
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** An index, as far as anything looking for one is concerned. */
async function index(...path: string[]): Promise<string> {
    const dir = join(...path);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), '{}');
    return dir;
}

async function plain(...path: string[]): Promise<string> {
    const dir = join(...path);
    await mkdir(dir, { recursive: true });
    return dir;
}

/** Confined to the tree the case built, so nothing outside it can be found. */
const within = (root: string) => ({ env: {}, ceiling: root });

describe('locateIndex', () => {
    it('takes --dir as written, whether or not anything is there', async () => {
        const root = await world();
        expect(locateIndex(root, 'nowhere', SCHEMA_INDEX, within(root))).toEqual({
            dir: join(root, 'nowhere'),
            from: 'flag',
        });
    });

    it(`takes ${DIR_ENV} the same way, so it does not have to be typed twice`, async () => {
        const root = await world();
        const located = locateIndex(root, undefined, SCHEMA_INDEX, { env: { [DIR_ENV]: 'named' } });
        expect(located).toEqual({ dir: join(root, 'named'), from: 'env' });
    });

    it('prefers the flag to the environment, since the flag is this invocation', async () => {
        const root = await world();
        const located = locateIndex(root, 'flag', SCHEMA_INDEX, { env: { [DIR_ENV]: 'env' } });
        expect(located.dir).toBe(join(root, 'flag'));
    });

    it('finds one by its manifest, whatever the directory is called', async () => {
        const root = await world();
        const one = await index(root, 'anything-at-all');
        const cwd = await plain(root, 'work');

        expect(locateIndex(cwd, undefined, SCHEMA_INDEX, within(root))).toEqual({
            dir: one,
            from: 'found',
        });
    });

    it('finds one several levels down a sibling, which is what --dir was for', async () => {
        const root = await world();
        const one = await index(root, 'assets', 'integrations', 'schema-db');
        const cwd = await plain(root, 'workspace', 'deep');

        expect(locateIndex(cwd, undefined, SCHEMA_INDEX, within(root)).dir).toBe(one);
    });

    it('answers with the working directory when it is itself an index', async () => {
        const root = await world();
        const one = await index(root, 'itself');
        expect(locateIndex(one, undefined, SCHEMA_INDEX, within(root)).dir).toBe(one);
    });

    it('prefers the nearer of two rather than counting them as a tie', async () => {
        const root = await world();
        const near = await index(root, 'work', 'near');
        await index(root, 'far', 'down', 'below');
        const cwd = await plain(root, 'work');

        expect(locateIndex(cwd, undefined, SCHEMA_INDEX, within(root)).dir).toBe(near);
    });

    it('refuses to guess between two equally close, because the wrong one answers too', async () => {
        const root = await world();
        const cwd = await plain(root, 'two');
        await index(root, 'two', 'first');
        await index(root, 'two', 'second');

        expect(() => locateIndex(cwd, undefined, SCHEMA_INDEX, within(root))).toThrow(CliError);
        expect(() => locateIndex(cwd, undefined, SCHEMA_INDEX, within(root))).toThrow(
            /more than one index/,
        );
    });

    it('will not climb above the ceiling, since another tree is not yours to read', async () => {
        const root = await world();
        await index(root, 'outside');
        const cwd = await plain(root, 'fenced', 'work');
        const fenced = { env: {}, ceiling: join(root, 'fenced') };

        expect(locateIndex(cwd, undefined, SCHEMA_INDEX, fenced).from).toBe('default');
    });

    it('falls back to the default, so the error names the expected directory', async () => {
        const root = await world();
        const cwd = await plain(root, 'empty');
        const located = locateIndex(cwd, undefined, SCHEMA_INDEX, within(root));

        expect(located.from).toBe('default');
        expect(located.dir).toBe(join(cwd, 'schema-db'));
        expect(DEFAULT_DIR).toBe('./schema-db');
    });
});

describe('outputDir', () => {
    it('writes where reads look, without searching for what is not there yet', async () => {
        const root = await world();
        expect(outputDir(root, 'out', SCHEMA_INDEX, {})).toBe(join(root, 'out'));
        expect(outputDir(root, undefined, SCHEMA_INDEX, { [DIR_ENV]: 'shared' })).toBe(
            join(root, 'shared'),
        );
        expect(outputDir(root, undefined, SCHEMA_INDEX, {})).toBe(join(root, 'schema-db'));
    });
});

describe('isIndex', () => {
    it('asks the manifest and nothing else', async () => {
        const root = await world();
        expect(isIndex(await index(root, 'probe'), 'schema')).toBe(true);
        expect(isIndex(await plain(root, 'probe-not'), 'schema')).toBe(false);
        expect(isIndex(join(root, 'absent'), 'schema')).toBe(false);
    });
});
