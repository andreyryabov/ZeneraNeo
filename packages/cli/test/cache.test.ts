import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Cache,
    cacheKey,
    clear,
    items,
    kinds,
    NO_CACHE,
    sweep,
    type CacheItem,
    type CacheKind,
    type CacheStore,
} from '../src/cache.ts';
import { cache as command, duration, size } from '../src/commands/cache.ts';
import { CliError, EXIT } from '../src/term.ts';

// ---------------------------------------------------------------------------
// One place for work already done
//
// The store's whole promise is that it is never wrong and never in the way, so
// this is mostly about the second half: a corrupt file, a wedged directory, a
// key that does not match what is on disk. Every one of them must be a miss and
// nothing louder.
//
// Every test names its own directory. The real store belongs to whoever is
// running the tests, and a suite has no business reading it.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zen-cache-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const open = (kind = 'things'): Cache => new Cache(kind, { dir });

/** Every entry file of a kind, so a test can go and damage one. */
const files = (kind: string): string[] =>
    readdirSync(join(dir, kind), { withFileTypes: true })
        .filter((shard) => shard.isDirectory())
        .flatMap((shard) =>
            readdirSync(join(dir, kind, shard.name)).map((f) => join(dir, kind, shard.name, f)),
        );

describe('a cache key', () => {
    it('is different for every different input', () => {
        expect(cacheKey('a', 1)).not.toBe(cacheKey('a', 2));
        expect(cacheKey('a', 1)).not.toBe(cacheKey('b', 1));
    });

    // 'a' + 'bc' and 'ab' + 'c' must not be the same question.
    it('does not run its parts together', () => {
        expect(cacheKey('a', 'bc')).not.toBe(cacheKey('ab', 'c'));
    });

    it('treats a missing part as an empty one, rather than dropping it', () => {
        expect(cacheKey('a', undefined, 'b')).not.toBe(cacheKey('a', 'b'));
    });
});

describe('the shared store', () => {
    it('gives back what it was given', () => {
        const cache = open();
        cache.put('k', { hello: 'there', n: [1, 2, 3] });

        expect(open().get('k')).toEqual({ hello: 'there', n: [1, 2, 3] });
    });

    it('counts what it answered and what it could not', () => {
        const cache = open();
        cache.put('k', 1);

        expect(cache.get('k')).toBe(1);
        expect(cache.get('nope')).toBeUndefined();
        expect([cache.hits, cache.misses]).toEqual([1, 1]);
    });

    it('says when it was written, for a caller with an opinion about freshness', () => {
        const cache = open();
        cache.put('k', 1);

        const at = new Date(open().entry('k')!.storedAt).getTime();
        expect(Date.now() - at).toBeLessThan(60_000);
    });

    it('separates the kinds, so the same key is two questions', () => {
        open('one').put('k', 'first');
        open('two').put('k', 'second');

        expect(open('one').get('k')).toBe('first');
        expect(open('two').get('k')).toBe('second');
    });

    // The path is only a hash of the key. Reading the key back catches a
    // derivation that changed shape without anyone bumping a version.
    it('is a miss when the entry is not the one that was asked for', () => {
        open().put('k', 'the value');
        const path = files('things')[0]!;
        const stored = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...stored, key: 'some other key' }));

        expect(open().get('k')).toBeUndefined();
    });

    it('is a miss when the file is not JSON at all', () => {
        open().put('k', 'the value');
        writeFileSync(files('things')[0]!, 'not json {{{');

        expect(open().get('k')).toBeUndefined();
    });

    it('is a miss, never an error, when nothing can be written', () => {
        const wedged = join(dir, 'a-file');
        writeFileSync(wedged, 'not a directory');
        const cache = new Cache('things', { dir: join(wedged, 'nope') });

        expect(() => cache.put('k', 'v')).not.toThrow();
        expect(cache.get('k')).toBeUndefined();
    });

    it('forgets one entry without touching the others', () => {
        const cache = open();
        cache.put('a', 1);
        cache.put('b', 2);
        cache.delete('a');

        expect(open().get('a')).toBeUndefined();
        expect(open().get('b')).toBe(2);
    });

    it('keeps a read entry alive, so age means unused rather than unwritten', () => {
        open().put('k', 1);
        const path = files('things')[0]!;
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        utimesSync(path, old, old);

        const cache = open();
        cache.get('k');
        cache.commit();

        expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
    });

    it('leaves an entry it did not read alone', () => {
        open().put('k', 1);
        const path = files('things')[0]!;
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        utimesSync(path, old, old);

        open().commit();

        expect(Date.now() - statSync(path).mtimeMs).toBeGreaterThan(1000);
    });
});

describe('a store that remembers nothing', () => {
    it('answers every question the same way', () => {
        const none: CacheStore = NO_CACHE;
        none.put('k', 'v');

        expect(none.get('k')).toBeUndefined();
        expect(none.entry('k')).toBeUndefined();
        expect(() => {
            none.delete('k');
            none.commit();
        }).not.toThrow();
    });
});

describe('looking at the store from outside', () => {
    const fill = (): void => {
        const one = open('one');
        one.put('a', 'x'.repeat(100));
        one.put('b', 'y'.repeat(100));
        open('two').put('c', 'z'.repeat(100));
    };

    it('reports a row per kind', () => {
        fill();
        const rows = kinds(dir);

        expect(rows.map((r) => r.kind)).toEqual(['one', 'two']);
        expect(rows[0]!.entries).toBe(2);
        expect(rows[0]!.bytes).toBeGreaterThan(200);
    });

    it('reports nothing at all for a store nobody has written to', () => {
        expect(kinds(join(dir, 'never-used'))).toEqual([]);
    });

    it('lists the entries of one kind, most recently used first', () => {
        fill();
        const path = files('one')[0]!;
        const old = new Date(Date.now() - 60_000);
        utimesSync(path, old, old);

        const { rows, found } = items('one', { dir });
        expect(found).toBe(2);
        expect(rows).toHaveLength(2);
        expect(rows[0]!.usedAt).toBeGreaterThanOrEqual(rows[1]!.usedAt);
        // The key is stored in the entry, which is the only reason it can be shown.
        expect(rows.map((r) => r.key).sort()).toEqual(['a', 'b']);
    });

    it('opens only the entries it will show', () => {
        fill();
        const { rows, found } = items('one', { dir, limit: 1 });

        expect(found).toBe(2);
        expect(rows).toHaveLength(1);
    });

    it('still lists an entry it cannot parse, because it is still taking up room', () => {
        fill();
        writeFileSync(files('two')[0]!, 'not json');

        const { rows } = items('two', { dir });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.key).toBe('');
    });
});

describe('getting rid of what is cached', () => {
    const age = (path: string, ms: number): void => {
        const at = new Date(Date.now() - ms);
        utimesSync(path, at, at);
    };

    it('removes what has not been used for long enough, and nothing else', () => {
        const cache = open('one');
        cache.put('old', 1);
        cache.put('new', 2);
        const [first] = files('one').sort();
        age(first!, 40 * 24 * 60 * 60 * 1000);

        const swept = sweep({ dir, olderThanMs: 30 * 24 * 60 * 60 * 1000 });
        expect(swept).toEqual([{ kind: 'one', removed: 1, bytes: expect.any(Number) }]);
        expect(files('one')).toHaveLength(1);
    });

    it('leaves the other kinds alone when one is named', () => {
        open('one').put('a', 1);
        open('two').put('b', 2);
        age(files('one')[0]!, 60_000);

        sweep({ dir, kind: 'one', olderThanMs: 1000 });

        expect(kinds(dir).map((r) => r.kind)).toEqual(['two']);
    });

    // The disk is one thing; least recently used across the whole store is the
    // only ordering on it that means anything.
    it('removes the least recently used until it fits', () => {
        const cache = open('one');
        for (const key of ['a', 'b', 'c', 'd']) {
            cache.put(key, 'x'.repeat(200));
        }
        const all = files('one').sort();
        for (const [i, path] of all.entries()) {
            age(path, (all.length - i) * 60_000);
        }
        const total = all.reduce((n, p) => n + statSync(p).size, 0);

        sweep({ dir, maxBytes: Math.floor(total / 2) });

        const left = files('one');
        expect(left.length).toBeGreaterThan(0);
        expect(left.length).toBeLessThan(4);
        // What went is the oldest; what stayed is the newest.
        expect(left).toContain(all.at(-1));
    });

    it('takes the empty directories with it', () => {
        open('one').put('a', 1);
        age(files('one')[0]!, 60_000);
        sweep({ dir, olderThanMs: 1000 });

        expect(readdirSync(dir)).not.toContain('one');
    });

    it('reports nothing when there was nothing to remove', () => {
        open('one').put('a', 1);
        expect(sweep({ dir, olderThanMs: 30 * 24 * 60 * 60 * 1000 })).toEqual([]);
    });

    it('clears one kind, or all of them', () => {
        open('one').put('a', 1);
        open('two').put('b', 2);

        clear({ dir, kind: 'one' });
        expect(kinds(dir).map((r) => r.kind)).toEqual(['two']);

        clear({ dir });
        expect(kinds(dir)).toEqual([]);
    });

    it('does not mind being asked to clear a store that is not there', () => {
        expect(() => clear({ dir: join(dir, 'never-used') })).not.toThrow();
    });
});

describe('how long and how much', () => {
    it('reads the units a person would write', () => {
        expect(duration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
        expect(duration('2w')).toBe(14 * 24 * 60 * 60 * 1000);
        expect(duration('12h')).toBe(12 * 60 * 60 * 1000);
        expect(duration('90m')).toBe(90 * 60 * 1000);
        expect(duration('45s')).toBe(45_000);
    });

    it('reads a bare number of days, which is what people mean', () => {
        expect(duration('7')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('reads sizes in powers of a thousand, like every disk is sold in', () => {
        expect(size('500mb')).toBe(500_000_000);
        expect(size('2gb')).toBe(2_000_000_000);
        expect(size('1024b')).toBe(1024);
    });

    it('reads a bare number as megabytes', () => {
        expect(size('500')).toBe(500_000_000);
    });

    it('refuses what it cannot read, rather than guessing', () => {
        expect(() => duration('a fortnight')).toThrow(/is not an age/);
        expect(() => size('quite a lot')).toThrow(/is not a size/);
        expect(() => duration('')).toThrow(/is not an age/);
    });

    it('has nothing to say when nothing was asked', () => {
        expect(duration(undefined)).toBeUndefined();
        expect(size(undefined)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// The command
//
// Driven through `run` with `--json`, which is the contract another program
// would use and the only output worth asserting on. `ZENERA_HOME` is set per
// test rather than once, because neighbouring suites snapshot and restore the
// whole environment.
// ---------------------------------------------------------------------------

describe('zen cache', () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'zen-home-'));
        process.env.ZENERA_HOME = home;
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        delete process.env.ZENERA_HOME;
    });

    /** Runs the command and gives back what it put on stdout, parsed. */
    async function run(...args: string[]): Promise<any> {
        const out: string[] = [];
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                out.push(String(chunk));
                return true;
            });
        const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await command.run({ args, json: true, cwd: home });
        } finally {
            write.mockRestore();
            quiet.mockRestore();
        }
        return out.length === 0 ? undefined : JSON.parse(out.join(''));
    }

    const fill = (): void => {
        new Cache('one').put('a', 'x'.repeat(100));
        new Cache('one').put('b', 'y'.repeat(100));
        new Cache('two').put('c', 'z'.repeat(100));
    };

    it('says an empty store is empty rather than failing', async () => {
        expect(await run('ls')).toMatchObject({ kinds: [], entries: 0, bytes: 0 });
    });

    it('lists what is there, kind by kind', async () => {
        fill();
        const out = await run('ls');

        expect(out.kinds.map((k: CacheKind) => k.kind)).toEqual(['one', 'two']);
        expect(out.entries).toBe(3);
        expect(out.dir).toContain(home);
    });

    it('lists the entries of one kind when asked', async () => {
        fill();
        const out = await run('ls', '--kind', 'one');

        expect(out.found).toBe(2);
        expect(out.entries.map((e: CacheItem) => e.key).sort()).toEqual(['a', 'b']);
    });

    it('shows only as many entries as asked for, and says how many more', async () => {
        fill();
        const out = await run('ls', '--kind', 'one', '--limit', '1');

        expect(out.found).toBe(2);
        expect(out.entries).toHaveLength(1);
    });

    it('lists nothing for a kind that was never written', async () => {
        expect(await run('ls', '--kind', 'nope')).toMatchObject({ found: 0, entries: [] });
    });

    it('refuses to prune without being told what to prune', async () => {
        fill();
        const err = await run('prune').catch((e: unknown) => e);

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
        // Deleting everything is what clear is for, and it should have to be typed.
        expect((err as CliError).hint).toContain('zen cache clear');
    });

    it('removes what has been unused for too long', async () => {
        fill();
        const kind = join(home, 'cache', 'one');
        for (const shard of readdirSync(kind)) {
            for (const file of readdirSync(join(kind, shard))) {
                const at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
                utimesSync(join(kind, shard, file), at, at);
            }
        }

        const out = await run('prune', '--older-than', '30d');
        expect(out.entries).toBe(2);
        expect(out.removed).toEqual([{ kind: 'one', removed: 2, bytes: expect.any(Number) }]);
        expect((await run('ls')).kinds.map((k: CacheKind) => k.kind)).toEqual(['two']);
    });

    it('says so plainly when a prune had nothing to remove', async () => {
        fill();
        expect(await run('prune', '--older-than', '30d')).toMatchObject({
            removed: [],
            entries: 0,
        });
    });

    it('clears one kind and leaves the rest', async () => {
        fill();
        const out = await run('clear', '--kind', 'one');

        expect(out.entries).toBe(2);
        expect((await run('ls')).kinds.map((k: CacheKind) => k.kind)).toEqual(['two']);
    });

    it('clears the lot', async () => {
        fill();
        await run('clear');

        expect(await run('ls')).toMatchObject({ kinds: [], entries: 0 });
    });

    // --json is not a terminal, so nothing is asked and nothing hangs.
    it('does not ask before clearing when the answer cannot be typed', async () => {
        expect(await run('clear')).toMatchObject({ entries: 0 });
    });

    it('rejects a subcommand it does not have', async () => {
        const err = await run('sweep').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
    });

    it('rejects two subcommands at once', async () => {
        const err = await run('ls', 'prune').catch((e: unknown) => e);
        expect((err as CliError).code).toBe(EXIT.usage);
    });
});
