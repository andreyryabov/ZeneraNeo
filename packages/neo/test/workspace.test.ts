import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Workspace, workspaceTools } from '../src/tools/workspace.ts';
import { selectTools } from '../src/types.ts';

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

    /** `/` has no meaning above the root, so it is the root. */
    it('reads a lone slash as the root', () => {
        expect(ws.within('/')).toBe(ws.root);
        expect(ws.within('//')).toBe(ws.root);
        expect(new Workspace({ root, mount: '/workspace' }).within('/')).toBe(ws.root);
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

    /**
     * The sandbox mounts this same directory at /workspace, so a path copied
     * out of a command's output has to land on the same file as a relative one.
     */
    describe('the mounted name', () => {
        const mounted = new Workspace({ root, mount: '/workspace' });

        it('is the same file as the relative one', () => {
            expect(mounted.within('/workspace/a/b.txt')).toBe(mounted.within('a/b.txt'));
            expect(mounted.within('/workspace')).toBe(mounted.root);
            expect(mounted.within('/workspace/')).toBe(mounted.root);
        });

        it('is a name, not a way out', () => {
            expect(() => mounted.within('/workspace/../etc/passwd')).toThrow();
            expect(() => mounted.within('/workspaceX/a')).toThrow();
            expect(() => mounted.within('/etc/passwd')).toThrow();
        });

        it('is not accepted when nothing is mounted there', () => {
            expect(() => ws.within('/workspace/a/b.txt')).toThrow();
        });

        /**
         * The mount is not only about what comes in: a command in the sandbox
         * prints /workspace/..., so the file tools answer in the same words and
         * the model never has to translate between two names for one tree.
         */
        it('is the name paths come back under', () => {
            // `mounted.root` rather than `root`: the workspace resolved its own
            // symlinks, and on macOS the temp dir is behind one.
            expect(mounted.show(join(mounted.root, 'a/b.txt'))).toBe('/workspace/a/b.txt');
            expect(mounted.show(mounted.root)).toBe('/workspace');
            expect(ws.show(join(ws.root, 'a/b.txt'))).toBe('a/b.txt');
            expect(ws.show(ws.root)).toBe('.');
        });

        it('is what the tools report', async () => {
            mkdirSync(join(root, 'src'), { recursive: true });
            writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
            const tools = workspaceTools({ root, mount: '/workspace' });
            const run = async (name: string, args: unknown): Promise<any> => {
                const found = tools.find((t) => t.name === name);
                return await found!.execute(args, {} as never);
            };

            // In under either spelling, out under the mounted one.
            expect((await run('read_file', { path: '/workspace/src/a.ts' })).path).toBe(
                '/workspace/src/a.ts',
            );
            expect((await run('read_file', { path: 'src/a.ts' })).path).toBe('/workspace/src/a.ts');
            expect((await run('list_dir', { path: '/' })).path).toBe('/workspace');
            expect((await run('list_dir', { path: 'src' })).path).toBe('/workspace/src');
            expect((await run('find_files', { pattern: 'a.ts' })).matches).toContain(
                '/workspace/src/a.ts',
            );
            expect(
                (await run('write_file', { path: '/workspace/src/b.ts', content: 'x\n' })).path,
            ).toBe('/workspace/src/b.ts');
            expect(
                await run('move_file', { from: 'src/b.ts', to: '/workspace/src/c.ts' }),
            ).toMatchObject({ from: '/workspace/src/b.ts', to: '/workspace/src/c.ts' });
            expect((await run('delete_file', { path: '/workspace/src/c.ts' })).path).toBe(
                '/workspace/src/c.ts',
            );
        });

        it('tells the model both spellings', () => {
            const say = (w: Workspace): string =>
                JSON.stringify(workspaceTools({ root: w.root, mount: w.mount }));
            expect(say(mounted)).toContain('/workspace');
            expect(say(ws)).not.toContain('/workspace');
        });
    });
});

/**
 * A second tree under a name of its own — the project's `assets/`, or the skill
 * catalogue. It is reference material: reachable by every reading tool and by
 * none of the writing ones, and the refusal is here rather than only in the
 * container's `:ro` because the file tools never go through the container.
 */
describe('a mounted tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-ws-mounts-'));
    const assets = mkdtempSync(join(tmpdir(), 'zen-assets-'));
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(assets, { recursive: true, force: true });
    });

    writeFileSync(join(assets, 'handbook.md'), '# handbook\n');
    mkdirSync(join(assets, 'specs'), { recursive: true });
    writeFileSync(join(assets, 'specs', 'api.md'), 'GET /things\n');

    const opts = { root, mount: '/workspace', mounts: [{ host: assets, at: '/assets' }] };
    const ws = new Workspace(opts);
    const tools = workspaceTools(opts);
    const call = async (name: string, args: unknown): Promise<any> => {
        const found = tools.find((t) => t.name === name);
        if (!found) {
            throw new Error(`no such tool: ${name}`);
        }
        return await found.execute(args, {} as never);
    };

    it('resolves under its own name', () => {
        expect(ws.within('/assets/handbook.md')).toBe(join(ws.mounts[0].host, 'handbook.md'));
        expect(ws.within('/assets')).toBe(ws.mounts[0].host);
        expect(ws.within('/assets/')).toBe(ws.mounts[0].host);
    });

    it('is a name, not a way out', () => {
        expect(() => ws.within('/assets/../etc/passwd')).toThrow(/outside the workspace/);
        expect(() => ws.within('/assetsX/a')).toThrow();
    });

    /** A relative path still means the workspace, not the newest mount. */
    it('does not take over the relative spelling', () => {
        expect(ws.within('handbook.md')).toBe(join(ws.root, 'handbook.md'));
        expect(ws.within('/')).toBe(ws.root);
    });

    it('is the name paths come back under', () => {
        expect(ws.show(join(ws.mounts[0].host, 'specs/api.md'))).toBe('/assets/specs/api.md');
        expect(ws.show(ws.mounts[0].host)).toBe('/assets');
        expect(ws.rel(join(ws.mounts[0].host, 'specs/api.md'))).toBe('specs/api.md');
    });

    it('can be read, listed and searched', async () => {
        expect(await call('read_file', { path: '/assets/handbook.md' })).toMatchObject({
            path: '/assets/handbook.md',
            content: '# handbook',
        });
        expect(await call('list_dir', { path: '/assets' })).toMatchObject({ path: '/assets' });
        // With no path to search under, everything the model can see is searched.
        expect((await call('find_files', { pattern: 'api.md' })).matches).toContain(
            '/assets/specs/api.md',
        );
    });

    /**
     * With a second tree in reach, `/` is no longer another name for the
     * workspace root — it is where both trees hang, so listing it is how the
     * model finds out what it can reach without being told.
     */
    it('is listed at the top, next to the workspace', async () => {
        const top = { path: '/', entries: [{ name: '/workspace' }, { name: '/assets' }] };
        expect(await call('list_dir', { path: '/' })).toMatchObject(top);
        expect(await call('list_dir', {})).toMatchObject(top);
        expect(await call('list_dir', { path: '' })).toMatchObject(top);
        // `.` still means the workspace itself.
        expect(await call('list_dir', { path: '.' })).toMatchObject({ path: '/workspace' });
    });

    it('refuses every tool that would change it', async () => {
        await expect(call('write_file', { path: '/assets/new.md', content: 'x' })).rejects.toThrow(
            /\/assets is read-only/,
        );
        await expect(call('delete_file', { path: '/assets/handbook.md' })).rejects.toThrow(
            /read-only/,
        );
        await expect(
            call('move_file', { from: '/assets/handbook.md', to: 'stolen.md' }),
        ).rejects.toThrow(/read-only/);
        await expect(call('move_file', { from: 'a.txt', to: '/assets/a.txt' })).rejects.toThrow(
            /read-only/,
        );
        expect(existsSync(join(assets, 'handbook.md'))).toBe(true);
    });

    /** A patch that touches one file it may not write writes none of them. */
    it('fails a patch whole, not halfway', async () => {
        const out = await call('apply_patch', {
            patch:
                '*** Begin Patch\n' +
                '*** Add File: fine.txt\n' +
                '+ok\n' +
                '*** Add File: /assets/sneaky.md\n' +
                '+no\n' +
                '*** End Patch',
        });
        expect(out.error).toContain('read-only');
        expect(out.hint).toContain('nothing was written');
        expect(existsSync(join(root, 'fine.txt'))).toBe(false);
        expect(existsSync(join(assets, 'sneaky.md'))).toBe(false);
    });

    /** The tool descriptions are the only place the model learns the tree exists. */
    it('is named in what the model is told', () => {
        const said = JSON.stringify(tools);
        expect(said).toContain('/assets');
        expect(said.toLowerCase()).toContain('read-only');
    });

    it('refuses a mount it cannot make sense of', () => {
        const bad = (mounts: { host: string; at: string }[]): (() => Workspace) => {
            return () => new Workspace({ root, mount: '/workspace', mounts });
        };
        expect(bad([{ host: assets, at: 'assets' }])).toThrow(/absolute/);
        expect(bad([{ host: assets, at: '/' }])).toThrow(/absolute/);
        expect(bad([{ host: join(assets, 'nope'), at: '/assets' }])).toThrow(/no such directory/);
        expect(bad([{ host: join(assets, 'handbook.md'), at: '/assets' }])).toThrow(
            /not a directory/,
        );
        // One name may not mean two directories, nor sit inside another name.
        expect(bad([{ host: assets, at: '/workspace/assets' }])).toThrow(/overlap/);
        expect(
            bad([
                { host: assets, at: '/assets' },
                { host: root, at: '/assets/inner' },
            ]),
        ).toThrow(/overlap/);
    });
});

describe('the workspace tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-ws-tools-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    // The tools only ever touch `args`; the ToolContext is inert here.
    const tools = workspaceTools({ root });
    const call = async (name: string, args: unknown): Promise<any> => {
        const found = tools.find((t) => t.name === name);
        if (!found) {
            throw new Error(`no such tool: ${name}`);
        }
        return await found.execute(args, {} as never);
    };

    it('withholds the mutating tools when read-only', () => {
        const names = (readOnly: boolean): string[] =>
            workspaceTools({ root, readOnly }).map((t) => t.name);
        expect(names(true)).toEqual(['read_file', 'list_dir', 'find_files']);
        expect(names(false)).toEqual([
            'read_file',
            'list_dir',
            'find_files',
            'write_file',
            'apply_patch',
            'move_file',
            'delete_file',
        ]);
    });

    it('tags every tool with the workspace group', () => {
        const groups = workspaceTools({ root }).map((t) => t.group);
        expect(new Set(groups)).toEqual(new Set(['workspace']));
    });

    /**
     * Node names the host path when the filesystem says no. The model was never
     * given that name, so a failure has to arrive in the words it wrote.
     */
    it('reports a filesystem failure under the workspace name, not the host one', async () => {
        for (const [name, args] of [
            ['list_dir', { path: 'ghost/dir' }],
            ['read_file', { path: 'ghost.txt' }],
            ['delete_file', { path: 'ghost.txt' }],
            ['move_file', { from: 'ghost.txt', to: 'found.txt' }],
        ] as const) {
            const err = await call(name, args).catch((e: Error) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.message).not.toContain(root);
            expect(err.message).not.toContain('ENOENT');
        }
        await expect(call('list_dir', { path: 'ghost/dir' })).rejects.toThrow(
            'ghost/dir does not exist',
        );
        await expect(call('read_file', { path: 'poem.txt/nope' })).rejects.toThrow(
            /poem\.txt\/nope (does not exist|is not a directory)/,
        );
    });

    it('accepts a tool named bare or qualified by its group', () => {
        const pick = (selectors: string[]): string[] =>
            selectTools(tools, selectors, { where: 'test' }).map((t) => t.name);
        expect(pick(['workspace:read_file', 'list_dir'])).toEqual(['read_file', 'list_dir']);
        expect(pick(['workspace:*', '-workspace:delete_file'])).not.toContain('delete_file');
        // The qualified form still has to be true: a right name in the wrong
        // group is a mistake worth naming, not a silent grant.
        expect(() => pick(['sandbox:read_file'])).toThrow(/group "workspace"/);
        expect(() => pick(['workspace:nope'])).toThrow(/unknown tool/);
    });

    it('reads a range of lines and says where it stopped', async () => {
        await call('write_file', { path: 'poem.txt', content: 'one\ntwo\nthree\nfour\n' });
        const whole = await call('read_file', { path: 'poem.txt' });
        expect(whole.lines).toBe(4);
        expect(whole.start_line).toBe(1);
        expect(whole.end_line).toBe(4);
        expect(whole.truncated).toBeUndefined();

        const middle = await call('read_file', { path: 'poem.txt', start_line: 2, end_line: 3 });
        expect(middle.content).toBe('two\nthree');
        expect(middle.start_line).toBe(2);
        expect(middle.end_line).toBe(3);
        expect(middle.truncated).toBe(true);

        const past = await call('read_file', { path: 'poem.txt', start_line: 99 });
        expect(past.error).toContain('4 lines');
    });

    it('refuses to read a file that is not text', async () => {
        writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
        const out = await call('read_file', { path: 'blob.bin' });
        expect(out.error).toContain('not a text file');
        expect(out.format).toBe('binary');
    });

    it('describes what it lists', async () => {
        mkdirSync(join(root, 'sub'), { recursive: true });
        writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const { entries } = await call('list_dir', { path: '.' });
        const byName = new Map(entries.map((e: any) => [e.name, e]));
        expect(byName.get('sub')).toEqual({ name: 'sub', kind: 'dir' });
        expect(byName.get('poem.txt')).toMatchObject({ format: 'text', lines: 4, bytes: 19 });
        expect(byName.get('pic.png')).toMatchObject({ format: 'image', bytes: 4 });
        expect(byName.get('blob.bin')).toMatchObject({ format: 'binary' });

        const slash = await call('list_dir', { path: '/' });
        expect(slash.entries).toEqual(entries);
    });

    /**
     * Four spellings of the same idea, and a model picks whichever it has in
     * mind — being refused for sending "" instead of omitting the argument
     * teaches it nothing.
     */
    it('takes every spelling of the root where the path is optional', async () => {
        const listed = await call('list_dir', {});
        for (const path of ['', ' ', '.', '/']) {
            expect(await call('list_dir', { path })).toEqual(listed);
        }
        expect((await call('find_files', { pattern: 'poem', path: '' })).matches).toEqual(
            (await call('find_files', { pattern: 'poem' })).matches,
        );
    });

    it('patches a file by its context', async () => {
        await call('write_file', {
            path: 'code.ts',
            content: 'class A {\n    run() {\n        return 1;\n    }\n}\n',
        });
        const out = await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Update File: code.ts',
                '@@ class A {',
                '     run() {',
                '-        return 1;',
                '+        return 2;',
                '     }',
                '*** End Patch',
                '',
            ].join('\n'),
        });
        expect(out.applied).toBe(1);
        expect(out.files[0]).toMatchObject({ path: 'code.ts', action: 'updated', chunks: 1 });
        expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe(
            'class A {\n    run() {\n        return 2;\n    }\n}\n',
        );
    });

    /** The `@@` heading is what makes an otherwise repeated line addressable. */
    it('uses the heading to pick between identical lines', async () => {
        await call('write_file', {
            path: 'twice.ts',
            content: 'function a() {\n    return 0;\n}\nfunction b() {\n    return 0;\n}\n',
        });
        await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Update File: twice.ts',
                '@@ function b() {',
                '-    return 0;',
                '+    return 9;',
                '*** End Patch',
            ].join('\n'),
        });
        expect(readFileSync(join(root, 'twice.ts'), 'utf8')).toBe(
            'function a() {\n    return 0;\n}\nfunction b() {\n    return 9;\n}\n',
        );
    });

    it('adds, moves and deletes in one patch', async () => {
        await call('write_file', { path: 'old.txt', content: 'hello\n' });
        await call('write_file', { path: 'doomed.txt', content: 'bye\n' });
        const out = await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Add File: notes/new.md',
                '+# New',
                '+',
                '+body',
                '*** Update File: old.txt',
                '*** Move to: notes/moved.txt',
                '-hello',
                '+hello there',
                '*** Delete File: doomed.txt',
                '*** End Patch',
            ].join('\n'),
        });
        expect(out.applied).toBe(3);
        expect(readFileSync(join(root, 'notes/new.md'), 'utf8')).toBe('# New\n\nbody\n');
        expect(readFileSync(join(root, 'notes/moved.txt'), 'utf8')).toBe('hello there\n');
        expect(existsSync(join(root, 'old.txt'))).toBe(false);
        expect(existsSync(join(root, 'doomed.txt'))).toBe(false);
    });

    /** The second file fails, so the first one must not have been written. */
    it('writes nothing when any part of the patch fails', async () => {
        const before = readFileSync(join(root, 'code.ts'), 'utf8');
        const out = await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Update File: code.ts',
                '-        return 2;',
                '+        return 3;',
                '*** Update File: twice.ts',
                '-    nothing like this',
                '+    gone',
                '*** End Patch',
            ].join('\n'),
        });
        expect(out.error).toContain('not in the file');
        expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe(before);
    });

    it('rejects a malformed patch', async () => {
        expect((await call('apply_patch', { patch: 'just some text' })).error).toContain(
            'Begin Patch',
        );
        const bad = await call('apply_patch', {
            patch: '*** Begin Patch\n*** Update File: code.ts\nno marker here\n*** End Patch',
        });
        expect(bad.error).toContain('expected a line starting with');
    });

    it('will not add a file that is already there', async () => {
        const out = await call('apply_patch', {
            patch: '*** Begin Patch\n*** Add File: code.ts\n+x\n*** End Patch',
        });
        expect(out.error).toContain('already exists');
    });

    it('will not patch its way out of the workspace', async () => {
        const out = await call('apply_patch', {
            patch: '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch',
        });
        expect(out.error).toContain('outside the workspace');
        expect(out.hint).toContain('nothing was written');
    });

    it('moves and renames, without clobbering by accident', async () => {
        await call('write_file', { path: 'keep.txt', content: 'keep' });
        const moved = await call('move_file', { from: 'poem.txt', to: 'sub/poem.txt' });
        expect(moved.moved).toBe(true);
        expect(existsSync(join(root, 'sub', 'poem.txt'))).toBe(true);

        const clash = await call('move_file', { from: 'keep.txt', to: 'sub/poem.txt' });
        expect(clash.error).toContain('already exists');

        await call('move_file', { from: 'keep.txt', to: 'sub/poem.txt', overwrite: true });
        expect(readFileSync(join(root, 'sub', 'poem.txt'), 'utf8')).toBe('keep');
    });

    it('will not move a path outside, or into itself', async () => {
        await expect(call('move_file', { from: 'sub', to: '../gone' })).rejects.toThrow();
        expect((await call('move_file', { from: 'sub', to: 'sub/deeper' })).error).toContain(
            'into itself',
        );
    });

    it('deletes a directory only when told to be recursive', async () => {
        expect((await call('delete_file', { path: 'sub' })).error).toContain('is a directory');
        expect(existsSync(join(root, 'sub'))).toBe(true);

        await call('delete_file', { path: 'sub', recursive: true });
        expect(existsSync(join(root, 'sub'))).toBe(false);

        await call('delete_file', { path: 'code.ts' });
        expect(existsSync(join(root, 'code.ts'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The patch format, in the corners
//
// The interesting failures are all about *where* a chunk lands and what the
// file looks like afterwards, so these tests seed the file directly and assert
// on the exact bytes rather than going through the tools to check the tools.
// ---------------------------------------------------------------------------

describe('apply_patch', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-ws-patch-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const apply = workspaceTools({ root }).find((t) => t.name === 'apply_patch')!;
    const patch = async (...lines: string[]): Promise<any> =>
        await apply.execute(
            { patch: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
            {} as never,
        );
    const seed = (name: string, content: string): string => {
        writeFileSync(join(root, name), content);
        return name;
    };
    const read = (name: string): string => readFileSync(join(root, name), 'utf8');

    it('leaves a file without a trailing newline without one', async () => {
        seed('bare.txt', 'alpha\nbeta');
        await patch('*** Update File: bare.txt', '-beta', '+gamma');
        expect(read('bare.txt')).toBe('alpha\ngamma');
    });

    it('keeps the trailing newline a file already had', async () => {
        seed('ended.txt', 'alpha\nbeta\n');
        await patch('*** Update File: ended.txt', '-beta', '+gamma');
        expect(read('ended.txt')).toBe('alpha\ngamma\n');
    });

    it('inserts without removing anything', async () => {
        seed('insert.ts', 'const a = 1;\nconst c = 3;\n');
        await patch(
            '*** Update File: insert.ts',
            ' const a = 1;',
            '+const b = 2;',
            ' const c = 3;',
        );
        expect(read('insert.ts')).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    });

    it('appends at the end of the file', async () => {
        seed('tail.md', '# Title\n\nbody\n');
        await patch('*** Update File: tail.md', ' body', '+more', '*** End of File');
        expect(read('tail.md')).toBe('# Title\n\nbody\nmore\n');
    });

    /** The cursor must move past what the previous chunk wrote, not re-match it. */
    it('applies several chunks in file order', async () => {
        seed('two.txt', 'a\ndup\nb\ndup\nc\n');
        const out = await patch(
            '*** Update File: two.txt',
            '@@',
            ' a',
            '-dup',
            '+one',
            '@@',
            ' b',
            '-dup',
            '+two',
        );
        expect(out.files[0].chunks).toBe(2);
        expect(read('two.txt')).toBe('a\none\nb\ntwo\nc\n');
    });

    it('empties a file when every line is removed', async () => {
        seed('gone.txt', 'x\ny\n');
        await patch('*** Update File: gone.txt', '-x', '-y');
        expect(read('gone.txt')).toBe('');
        expect(existsSync(join(root, 'gone.txt'))).toBe(true);
    });

    it('takes a blank line as blank context even without its leading space', async () => {
        seed('blank.md', 'one\n\ntwo\n');
        await patch('*** Update File: blank.md', ' one', '', '-two', '+three');
        expect(read('blank.md')).toBe('one\n\nthree\n');
    });

    it('matches through wrong trailing whitespace, and says that it did', async () => {
        seed('sloppy.ts', 'function f() {\n    return 1;\n}\n');
        const out = await patch(
            '*** Update File: sloppy.ts',
            '-    return 1;   ',
            '+    return 2;',
        );
        expect(out.fuzzy).toBe(1);
        expect(read('sloppy.ts')).toBe('function f() {\n    return 2;\n}\n');
    });

    /** An exact match anywhere beats a whitespace-only match earlier in the file. */
    it('prefers the exact match to the near one', async () => {
        seed('near.txt', 'value = 1;  \nmiddle\nvalue = 1;\n');
        const out = await patch('*** Update File: near.txt', '-value = 1;', '+value = 2;');
        expect(out.fuzzy).toBeUndefined();
        expect(read('near.txt')).toBe('value = 1;  \nmiddle\nvalue = 2;\n');
    });

    it('reads a patch that arrives with CRLF line endings', async () => {
        seed('crlf.txt', 'first\nsecond\n');
        const out = await apply.execute(
            {
                patch: [
                    '*** Begin Patch',
                    '*** Update File: crlf.txt',
                    '-second',
                    '+changed',
                    '*** End Patch',
                ].join('\r\n'),
            },
            {} as never,
        );
        expect((out as any).applied).toBe(1);
        expect(read('crlf.txt')).toBe('first\nchanged\n');
    });

    /**
     * Without the closing sentinel the trailing newline would become a blank
     * context line the file has to contain, so the marker is required and the
     * error says so instead of complaining about missing context.
     */
    it('insists on the closing sentinel', async () => {
        seed('unterminated.txt', 'here\n');
        const out = await apply.execute(
            {
                patch: '*** Begin Patch\n*** Update File: unterminated.txt\n-here\n+there\n',
            },
            {} as never,
        );
        expect((out as any).error).toContain('End Patch');
        expect(read('unterminated.txt')).toBe('here\n');
    });

    /** A `+` line is content, whatever it looks like. */
    it('adds a line that looks like a section header', async () => {
        await patch('*** Add File: sentinel.txt', '+*** Update File: nope.txt', '+done');
        expect(read('sentinel.txt')).toBe('*** Update File: nope.txt\ndone\n');
    });

    it('creates an empty file from an empty add', async () => {
        await patch('*** Add File: empty.txt');
        expect(read('empty.txt')).toBe('');
    });

    it('refuses a file named twice in one patch', async () => {
        seed('once.txt', 'a\nb\n');
        const out = await patch(
            '*** Update File: once.txt',
            '-a',
            '+A',
            '*** Update File: once.txt',
            '-b',
            '+B',
        );
        expect(out.error).toContain('twice');
        expect(read('once.txt')).toBe('a\nb\n');
    });

    it('refuses an update with nothing in it', async () => {
        seed('idle.txt', 'a\n');
        expect((await patch('*** Update File: idle.txt')).error).toContain('nothing to change');
    });

    it('refuses to update or delete what is not there', async () => {
        expect((await patch('*** Update File: ghost.txt', '-a', '+b')).error).toContain(
            'does not exist',
        );
        expect((await patch('*** Delete File: ghost.txt')).error).toContain('does not exist');
    });

    it('refuses to patch a file that is not text', async () => {
        writeFileSync(join(root, 'bin.dat'), Buffer.from([0x01, 0x00, 0x02]));
        expect((await patch('*** Update File: bin.dat', '-a', '+b')).error).toContain('not text');
    });

    /** The move fails late, so the edit that came with it must not survive. */
    it('writes nothing when the move half of an update collides', async () => {
        seed('src.txt', 'body\n');
        seed('taken.txt', 'occupied\n');
        const out = await patch(
            '*** Update File: src.txt',
            '*** Move to: taken.txt',
            '-body',
            '+new body',
        );
        expect(out.error).toContain('already exists');
        expect(read('src.txt')).toBe('body\n');
        expect(read('taken.txt')).toBe('occupied\n');
    });

    it('reports the heading it could not find', async () => {
        seed('heading.ts', 'class A {}\n');
        const out = await patch('*** Update File: heading.ts', '@@ class B', '-x', '+y');
        expect(out.error).toContain('class B');
    });

    it('refuses a patch that changes nothing at all', async () => {
        const out = await apply.execute({ patch: '*** Begin Patch\n*** End Patch' }, {} as never);
        expect((out as any).error).toContain('changes nothing');
    });
});
