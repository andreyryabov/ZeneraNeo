import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tool, type AnyTool } from 'zenera-neo';

// ---------------------------------------------------------------------------
// Workspace tools
//
// The library ships no filesystem tools, and should not: what an agent may
// touch is a deployment decision, not a runtime one. The CLI makes that
// decision explicitly here, and it makes it once — every tool below resolves
// through `within`, so there is a single place where a path is allowed to
// become real.
//
// Containment is enforced on the *resolved, symlink-followed* path. Checking
// the string before resolving is the classic hole: `notes/../../.ssh/id_rsa`
// and a symlink called `notes` both pass a prefix test and both escape.
// ---------------------------------------------------------------------------

/** Reads are capped so one `cat` of a log file cannot fill the context. */
const MAX_READ = 256 * 1024;
const MAX_WRITE = 1024 * 1024;
const MAX_ENTRIES = 500;

export interface WorkspaceOptions {
    root: string;
    /** refuse every mutating tool; `zn run --read-only` */
    readOnly?: boolean;
}

export class Workspace {
    readonly root: string;
    readonly readOnly: boolean;

    constructor(opts: WorkspaceOptions) {
        // Resolve the root's own symlinks once, so a workspace that *is* a
        // symlink does not fail every containment check against itself.
        this.root = realpathSync(resolve(opts.root));
        this.readOnly = opts.readOnly ?? false;
    }

    /**
     * The one gate. Returns an absolute path inside the workspace, or throws.
     *
     * A path that does not exist yet cannot be realpath'd, so the nearest
     * existing ancestor is resolved instead and the remainder appended — which
     * is exactly what a create needs and closes the same hole a create opens.
     */
    within(input: string): string {
        if (typeof input !== 'string' || input.length === 0) {
            throw new Error('path is required');
        }
        if (input.includes('\0')) {
            throw new Error('path contains a null byte');
        }
        const wanted = resolve(this.root, input);
        const real = this.#realish(wanted);
        if (real !== this.root && !real.startsWith(this.root + sep)) {
            throw new Error(`outside the workspace: ${input}`);
        }
        return real;
    }

    #realish(path: string): string {
        const missing: string[] = [];
        let at = path;
        for (;;) {
            try {
                return join(realpathSync(at), ...missing.reverse());
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw err;
                }
                const parent = dirname(at);
                if (parent === at) {
                    // Walked to the filesystem root without finding anything
                    // real; nothing here can be inside the workspace.
                    throw new Error(`cannot resolve: ${path}`);
                }
                missing.push(at.slice(parent.length + 1));
                at = parent;
            }
        }
    }

    rel(path: string): string {
        return relative(this.root, path) || '.';
    }

    mutable(): void {
        if (this.readOnly) {
            throw new Error('the workspace is read-only for this run');
        }
    }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function workspaceTools<TCtx = unknown>(opts: WorkspaceOptions): AnyTool<TCtx>[] {
    const ws = new Workspace(opts);

    const readFileTool = tool<{ path: string }, TCtx>({
        name: 'read_file',
        description:
            'Reads a UTF-8 text file from the workspace. Paths are relative to the ' +
            'workspace root. Long files are truncated.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path inside the workspace.' } },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path }) => {
            const at = ws.within(path);
            const info = await stat(at);
            if (info.isDirectory()) {
                return { error: `${ws.rel(at)} is a directory`, hint: 'use list_dir' };
            }
            const body = await readFile(at, 'utf8');
            return body.length > MAX_READ
                ? {
                      path: ws.rel(at),
                      truncated: true,
                      bytes: info.size,
                      content: body.slice(0, MAX_READ),
                  }
                : { path: ws.rel(at), bytes: info.size, content: body };
        },
    });

    const listDir = tool<{ path?: string }, TCtx>({
        name: 'list_dir',
        description: 'Lists the entries of a directory in the workspace.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Directory, relative to the root. Defaults to the root.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        execute: async ({ path = '.' }) => {
            const at = ws.within(path);
            const entries = await readdir(at, { withFileTypes: true });
            const listed = entries.slice(0, MAX_ENTRIES).map((e) => ({
                name: e.name,
                kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
            }));
            return {
                path: ws.rel(at),
                entries: listed,
                truncated: entries.length > MAX_ENTRIES ? entries.length : undefined,
            };
        },
    });

    const writeFileTool = tool<{ path: string; content: string }, TCtx>({
        name: 'write_file',
        description:
            'Creates or overwrites a UTF-8 text file in the workspace, making parent ' +
            'directories as needed.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        execute: async ({ path, content }) => {
            ws.mutable();
            if (content.length > MAX_WRITE) {
                return { error: `content exceeds ${MAX_WRITE} bytes` };
            }
            const at = ws.within(path);
            await mkdir(dirname(at), { recursive: true });
            await writeFile(at, content, 'utf8');
            return { path: ws.rel(at), bytes: Buffer.byteLength(content), written: true };
        },
    });

    const deleteFile = tool<{ path: string }, TCtx>({
        name: 'delete_file',
        description: 'Deletes a file from the workspace. Directories are not removed.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path }) => {
            ws.mutable();
            const at = ws.within(path);
            if (at === ws.root) {
                return { error: 'refusing to delete the workspace root' };
            }
            const info = await stat(at);
            if (info.isDirectory()) {
                return { error: `${ws.rel(at)} is a directory`, hint: 'only files can be deleted' };
            }
            await rm(at);
            return { path: ws.rel(at), deleted: true };
        },
    });

    const findFiles = tool<{ pattern: string; path?: string }, TCtx>({
        name: 'find_files',
        description:
            'Finds files in the workspace whose path contains the given substring. ' +
            'Case-insensitive.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Substring to match against the path.' },
                path: { type: 'string', description: 'Directory to search under.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        execute: async ({ pattern, path = '.' }) => {
            const at = ws.within(path);
            const needle = pattern.toLowerCase();
            const hits: string[] = [];
            await walk(at, ws, (file) => {
                const rel = ws.rel(file);
                if (rel.toLowerCase().includes(needle)) {
                    hits.push(rel);
                }
                return hits.length < MAX_ENTRIES;
            });
            return { pattern, matches: hits, truncated: hits.length >= MAX_ENTRIES };
        },
    });

    return opts.readOnly
        ? [readFileTool, listDir, findFiles]
        : [readFileTool, listDir, findFiles, writeFileTool, deleteFile];
}

/** Depth-first, skipping the noise nobody means to search. */
const SKIP = new Set(['.git', 'node_modules', '.data', 'dist', '.venv', '__pycache__']);

async function walk(
    dir: string,
    ws: Workspace,
    visit: (file: string) => boolean,
): Promise<boolean> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return true;
    }
    for (const entry of entries) {
        if (SKIP.has(entry.name)) {
            continue;
        }
        const child = join(dir, entry.name);
        // Symlinks are not followed: a link out of the workspace would
        // otherwise let a listing report paths the tools cannot open anyway.
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (entry.isDirectory()) {
            if (!(await walk(child, ws, visit))) {
                return false;
            }
        } else if (entry.isFile() && !visit(child)) {
            return false;
        }
    }
    return true;
}
