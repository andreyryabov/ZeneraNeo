import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_MOUNT, forgetFile, hostPath, rememberFile } from '../src/memory/files.ts';
import { FILES_DIR } from '../src/memory/store.ts';
import { MemoryError } from '../src/memory/types.ts';
import { workspaceTools } from '../src/tools/workspace.ts';

const SCRIPT = 'print("risky ports")\n';

describe('remembering a file', () => {
    let dir: string;
    let work: string;
    let source: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-memfiles-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        source = join(work, 'audit.py');
        await writeFile(source, SCRIPT);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    it('copies the bytes under the node id and names them by the mount', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        expect(file.path).toBe(`${MEMORY_MOUNT}/ID1.py`);
        expect(file.format).toBe('py');
        expect(file.bytes).toBe(Buffer.byteLength(SCRIPT));
        expect(await readFile(join(dir, FILES_DIR, 'ID1.py'), 'utf8')).toBe(SCRIPT);
    });

    it('survives the workspace it came from', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        await rm(work, { recursive: true, force: true });
        expect(await readFile(hostPath(dir, file), 'utf8')).toBe(SCRIPT);
    });

    it('digests the copy that was kept', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        const { createHash } = await import('node:crypto');
        expect(file.sha256).toBe(createHash('sha256').update(SCRIPT).digest('hex'));
    });

    it('keeps a file with no extension, without a trailing dot', async () => {
        const plain = join(work, 'Makefile');
        await writeFile(plain, 'all:\n');
        const file = await rememberFile(dir, plain, 'ID2');
        expect(file.path).toBe(`${MEMORY_MOUNT}/ID2`);
        expect(file.format).toBe('');
    });

    it('drops an extension it will not put in a filename', async () => {
        const odd = join(work, 'weird.p y!');
        await writeFile(odd, 'x');
        expect((await rememberFile(dir, odd, 'ID3')).format).toBe('');
    });

    it('refuses a file over the limit', async () => {
        const big = join(work, 'big.bin');
        await writeFile(big, Buffer.alloc(64));
        await expect(rememberFile(dir, big, 'ID4', { maxBytes: 32 })).rejects.toThrow(MemoryError);
    });

    it('refuses a directory and a path that is not there', async () => {
        await expect(rememberFile(dir, work, 'ID5')).rejects.toThrow(/not a regular file/);
        await expect(rememberFile(dir, join(work, 'nope.py'), 'ID6')).rejects.toThrow(
            /does not exist/,
        );
    });

    it('resolves a stored path back through the files directory only', async () => {
        const file = await rememberFile(dir, source, 'ID7');
        const escaped = { ...file, path: '/memory/../../etc/passwd' };
        expect(hostPath(dir, escaped)).toBe(join(dir, FILES_DIR, 'passwd'));
    });

    it('forgets the bytes, and forgetting twice is not an error', async () => {
        const file = await rememberFile(dir, source, 'ID8');
        await forgetFile(dir, file);
        await expect(readFile(hostPath(dir, file))).rejects.toThrow();
        await expect(forgetFile(dir, file)).resolves.toBeUndefined();
    });

    it('copies through a symlink rather than storing the link', async () => {
        const link = join(work, 'link.py');
        await symlink(source, link);
        const file = await rememberFile(dir, link, 'ID9');
        await rm(work, { recursive: true, force: true });
        expect(await readFile(hostPath(dir, file), 'utf8')).toBe(SCRIPT);
    });
});

describe('the /memory mount', () => {
    let dir: string;
    let root: string;
    let call: (name: string, args: unknown) => Promise<any>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-memfiles-'));
        root = await mkdtemp(join(tmpdir(), 'neo-work-'));
        const src = join(root, 'audit.py');
        await writeFile(src, SCRIPT);
        await rememberFile(dir, src, 'ID1');

        const opts = {
            root,
            mounts: [{ host: join(dir, FILES_DIR), at: MEMORY_MOUNT }],
        };
        const tools = workspaceTools(opts);
        call = async (name, args) => {
            const found = tools.find((t) => t.name === name);
            if (!found) {
                throw new Error(`no such tool: ${name}`);
            }
            return await found.execute(args, {} as never);
        };
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    });

    it('reads a remembered file by the path stored on the node', async () => {
        expect(await call('read_file', { path: `${MEMORY_MOUNT}/ID1.py` })).toMatchObject({
            path: `${MEMORY_MOUNT}/ID1.py`,
            content: SCRIPT.trimEnd(),
        });
    });

    /** Only a commit puts files here, so every file under /memory has a node. */
    it('refuses to be written through the file tools', async () => {
        await expect(
            call('write_file', { path: `${MEMORY_MOUNT}/sneak.py`, content: 'x' }),
        ).rejects.toThrow(/read-only/i);
    });

    it('is a name, not a way into the rest of the store', async () => {
        await expect(
            call('read_file', { path: `${MEMORY_MOUNT}/../manifest.json` }),
        ).rejects.toThrow(/outside the workspace/);
    });
});
