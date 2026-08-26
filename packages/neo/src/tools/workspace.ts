import { realpathSync, type Stats } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tool, type AnyTool } from '../types.ts';

// ---------------------------------------------------------------------------
// Workspace tools
//
// Nothing here is wired in by default: what an agent may touch is a deployment
// decision, not a runtime one, so a host that wants filesystem access asks for
// it by calling `workspaceTools` and handing the result to a project. What the
// library does provide is the containment, once — every tool below resolves
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
/** Nothing is pulled into memory whole beyond this; bigger files are read by the head. */
const MAX_OPEN = 8 * 1024 * 1024;
/** How much of a file is examined to decide text vs binary. */
const SNIFF_BYTES = 8 * 1024;
/** A file is only read through to count its lines when it is at most this big. */
const MAX_SCAN = 1024 * 1024;
/** ...and one listing only spends this much on line counting in total. */
const LIST_SCAN_BUDGET = 8 * 1024 * 1024;

export interface WorkspaceOptions {
    root: string;
    /** refuse every mutating tool; `zen run --read-only` */
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
// What a file is
//
// A listing that says nothing but a name forces the model to open everything to
// find out what it is looking at, and opening a jpeg costs a turn and teaches
// it nothing. So every entry carries its shape: the format, the size, and — for
// text — how many lines, which is the coordinate system the ranged read and the
// patcher both speak.
// ---------------------------------------------------------------------------

export type FileFormat = 'text' | 'binary' | 'image' | 'audio' | 'video' | 'pdf' | 'archive';

export interface FileInfo {
    name: string;
    kind: 'file' | 'dir' | 'link' | 'other';
    format?: FileFormat;
    bytes?: number;
    lines?: number;
}

/**
 * Formats that are decided by name alone. Everything absent from here is
 * sniffed, so an unknown extension still lands on text or binary correctly.
 * `.svg` is deliberately *not* an image: it is editable text, and calling it an
 * image would tell the model not to open it.
 */
const BY_EXTENSION: Record<string, FileFormat> = {
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.gif': 'image',
    '.webp': 'image',
    '.avif': 'image',
    '.bmp': 'image',
    '.ico': 'image',
    '.tif': 'image',
    '.tiff': 'image',
    '.heic': 'image',
    '.mp3': 'audio',
    '.wav': 'audio',
    '.flac': 'audio',
    '.ogg': 'audio',
    '.m4a': 'audio',
    '.aac': 'audio',
    '.mp4': 'video',
    '.mov': 'video',
    '.avi': 'video',
    '.mkv': 'video',
    '.webm': 'video',
    '.pdf': 'pdf',
    '.zip': 'archive',
    '.tar': 'archive',
    '.gz': 'archive',
    '.tgz': 'archive',
    '.bz2': 'archive',
    '.xz': 'archive',
    '.7z': 'archive',
    '.rar': 'archive',
    '.jar': 'archive',
};

/**
 * A NUL byte is decisive; a replacement character means the bytes are not
 * UTF-8. When the buffer is a prefix its tail may be half of a multi-byte
 * character, so the last three bytes are dropped before decoding.
 */
function looksBinary(buf: Buffer, partial: boolean): boolean {
    const view = partial ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf;
    if (view.includes(0)) {
        return true;
    }
    return view.toString('utf8').includes('\uFFFD');
}

function countLines(buf: Buffer): number {
    if (buf.length === 0) {
        return 0;
    }
    let lines = 0;
    for (const byte of buf) {
        if (byte === 0x0a) {
            lines++;
        }
    }
    return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

/** Same arithmetic as `countLines`, for content already decoded. */
function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0a) {
            lines++;
        }
    }
    return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * `scan` is the caller's permission to read the file through — a listing hands
 * it out from a budget so that one `list_dir` of a build output directory does
 * not read a gigabyte to report line counts nobody asked for.
 */
async function inspectFile(
    at: string,
    bytes: number,
    scan: boolean,
): Promise<{ format: FileFormat; lines?: number }> {
    const known = BY_EXTENSION[extname(at).toLowerCase()];
    if (known) {
        return { format: known };
    }
    if (bytes === 0) {
        return { format: 'text', lines: 0 };
    }
    if (scan && bytes <= MAX_SCAN) {
        const buf = await readFile(at);
        return looksBinary(buf, false)
            ? { format: 'binary' }
            : { format: 'text', lines: countLines(buf) };
    }
    const handle = await open(at, 'r');
    try {
        const buf = Buffer.alloc(Math.min(bytes, SNIFF_BYTES));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        return {
            format: looksBinary(buf.subarray(0, bytesRead), bytesRead < bytes) ? 'binary' : 'text',
        };
    } finally {
        await handle.close();
    }
}

/** Reads a file as text, taking only the head of one too large to hold. */
async function readText(at: string, bytes: number): Promise<{ body: string; whole: boolean }> {
    if (bytes <= MAX_OPEN) {
        return { body: await readFile(at, 'utf8'), whole: true };
    }
    const handle = await open(at, 'r');
    try {
        const buf = Buffer.alloc(MAX_OPEN);
        const { bytesRead } = await handle.read(buf, 0, MAX_OPEN, 0);
        return { body: buf.subarray(0, bytesRead).toString('utf8'), whole: false };
    } finally {
        await handle.close();
    }
}

/** Splits into lines without inventing a trailing empty one. */
function toLines(body: string): string[] {
    const lines = body.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

// ---------------------------------------------------------------------------
// The patch format
//
// A patch, not a rewrite, and not a set of line numbers either. Line numbers
// are the thing a model gets wrong: they drift the moment an earlier hunk
// changes the length of the file, and a wrong count in a `@@ -12,7 +12,9 @@`
// header either corrupts the file or forces the applier to guess. So the format
// below carries no offsets at all — a change is located by the unchanged text
// around it, and `@@ <heading>` narrows the search to the right block when the
// same lines occur more than once.
//
//     *** Begin Patch
//     *** Update File: src/server.ts
//     @@ class Server
//          start() {
//     -        this.port = 80;
//     +        this.port = 8080;
//          }
//     *** End Patch
//
// Whole files are added, deleted and moved by the same document, which is the
// real reason to have a patch at all rather than a per-file editor: a rename
// plus the edits that follow from it either both land or neither does.
//
// The grammar is the one Codex's `apply_patch` uses (sometimes called V4A), on
// purpose: frontier models have seen a great deal of it and emit it well. That
// lineage is deliberately *not* mentioned in the tool description — the sentinel
// lines and the worked example are what a model actually keys on, whereas naming
// a vendor in a prompt sent to three of them buys nothing and invites the model
// to assume behaviour of a reference implementation this parser does not share.
// ---------------------------------------------------------------------------

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';

/** A failure the model can act on: reported as a tool error, never thrown out. */
class PatchError extends Error {}

interface PatchChunk {
    /** `@@ heading` lines that say which block the chunk belongs to. */
    headings: string[];
    /** context + removed lines, in file order — what must be there now. */
    before: string[];
    /** context + added lines — what takes its place. */
    after: string[];
    /** the chunk is anchored to the end of the file */
    eof: boolean;
    /** 1-based line inside the patch, so an error can point at it */
    at: number;
}

type PatchOp =
    | { kind: 'add'; path: string; lines: string[]; at: number }
    | { kind: 'delete'; path: string; at: number }
    | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[]; at: number };

/** Only a bare `*** ` line can open a section; body lines are always prefixed. */
function isSection(line: string): boolean {
    return (
        line === END ||
        line.startsWith(ADD) ||
        line.startsWith(DELETE) ||
        line.startsWith(UPDATE) ||
        line === BEGIN
    );
}

function parsePatch(text: string): PatchOp[] {
    // A stray CR would otherwise end up inside every added line.
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') {
        i++;
    }
    if (i >= lines.length || lines[i].trim() !== BEGIN) {
        throw new PatchError(`the patch must start with '${BEGIN}'`);
    }
    i++;

    const ops: PatchOp[] = [];
    // The closing sentinel is not decoration. A blank line inside a chunk is
    // meaningful context, so without something to end the last chunk on, the
    // newline a model leaves at the end of the string becomes a blank line the
    // file has to contain — and the failure surfaces as a baffling "context not
    // found" instead of the missing marker it is.
    let closed = false;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === END) {
            closed = true;
            break;
        }
        if (line.trim() === '') {
            i++;
            continue;
        }
        if (line.startsWith(ADD)) {
            const at = i + 1;
            const path = line.slice(ADD.length).trim();
            i++;
            const body: string[] = [];
            while (i < lines.length && !isSection(lines[i])) {
                if (!lines[i].startsWith('+')) {
                    throw new PatchError(
                        `line ${i + 1}: every line of an added file must start with '+'`,
                    );
                }
                body.push(lines[i].slice(1));
                i++;
            }
            ops.push({ kind: 'add', path, lines: body, at });
            continue;
        }
        if (line.startsWith(DELETE)) {
            ops.push({ kind: 'delete', path: line.slice(DELETE.length).trim(), at: i + 1 });
            i++;
            continue;
        }
        if (line.startsWith(UPDATE)) {
            const at = i + 1;
            const path = line.slice(UPDATE.length).trim();
            i++;
            let moveTo: string | undefined;
            if (i < lines.length && lines[i].startsWith(MOVE)) {
                moveTo = lines[i].slice(MOVE.length).trim();
                i++;
            }
            const chunks: PatchChunk[] = [];
            let chunk: PatchChunk | undefined;
            const started = (c: PatchChunk): boolean => c.before.length > 0 || c.after.length > 0;
            const open = (): PatchChunk =>
                (chunk ??= { headings: [], before: [], after: [], eof: false, at: i + 1 });

            while (i < lines.length && !isSection(lines[i])) {
                const body = lines[i];
                if (body.startsWith('@@')) {
                    if (chunk && started(chunk)) {
                        chunks.push(chunk);
                        chunk = undefined;
                    }
                    const heading = body.slice(2).trim();
                    if (heading) {
                        open().headings.push(heading);
                    } else {
                        open();
                    }
                } else if (body === EOF_MARKER) {
                    open().eof = true;
                } else if (body === '') {
                    // A blank context line: models drop the leading space.
                    open().before.push('');
                    open().after.push('');
                } else if (body.startsWith('+')) {
                    open().after.push(body.slice(1));
                } else if (body.startsWith('-')) {
                    open().before.push(body.slice(1));
                } else if (body.startsWith(' ')) {
                    open().before.push(body.slice(1));
                    open().after.push(body.slice(1));
                } else {
                    throw new PatchError(
                        `line ${i + 1}: expected a line starting with ' ', '+' or '-': ${body}`,
                    );
                }
                i++;
            }
            if (chunk && started(chunk)) {
                chunks.push(chunk);
            }
            if (chunks.length === 0) {
                throw new PatchError(`${path}: '${UPDATE.trim()}' with nothing to change`);
            }
            ops.push({ kind: 'update', path, moveTo, chunks, at });
            continue;
        }
        throw new PatchError(`line ${i + 1}: unexpected line outside a file section: ${line}`);
    }
    if (!closed) {
        throw new PatchError(`the patch must end with '${END}'`);
    }
    if (ops.length === 0) {
        throw new PatchError('the patch changes nothing');
    }
    return ops;
}

/**
 * Finds `want` as a run of lines at or after `from`. Exact first; then ignoring
 * trailing whitespace; then ignoring indentation entirely. The looser passes
 * exist because a model reproducing context by hand gets whitespace wrong far
 * more often than it gets the code wrong — but each is a whole separate sweep,
 * so an exact match anywhere always beats a sloppy one earlier in the file.
 */
function locate(lines: string[], want: string[], from: number): { index: number; fuzz: number } {
    if (want.length === 0) {
        return { index: from, fuzz: 0 };
    }
    const passes: ((a: string, b: string) => boolean)[] = [
        (a, b) => a === b,
        (a, b) => a.trimEnd() === b.trimEnd(),
        (a, b) => a.trim() === b.trim(),
    ];
    for (const [fuzz, same] of passes.entries()) {
        for (let start = from; start + want.length <= lines.length; start++) {
            let ok = true;
            for (let k = 0; k < want.length; k++) {
                if (!same(lines[start + k], want[k])) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                return { index: start, fuzz };
            }
        }
    }
    return { index: -1, fuzz: 0 };
}

function findHeading(lines: string[], heading: string, from: number): number {
    for (let i = from; i < lines.length; i++) {
        if (lines[i] === heading || lines[i].trim() === heading.trim()) {
            return i;
        }
    }
    return -1;
}

/** Applies one file's chunks to its lines. Throws `PatchError` on a miss. */
function patchLines(
    lines: string[],
    chunks: PatchChunk[],
    file: string,
): { lines: string[]; fuzz: number } {
    const out = lines.slice();
    let cursor = 0;
    let fuzz = 0;
    for (const chunk of chunks) {
        for (const heading of chunk.headings) {
            const at = findHeading(out, heading, cursor);
            if (at < 0) {
                throw new PatchError(
                    `${file}: no line matching '@@ ${heading}' after the previous chunk`,
                );
            }
            cursor = at + 1;
        }
        // An end-of-file chunk is tried against the tail first; failing that it
        // is an ordinary search, because the marker is often optimistic.
        let found = { index: -1, fuzz: 0 };
        if (chunk.eof) {
            const tail = out.length - chunk.before.length;
            if (tail >= cursor) {
                const hit = locate(out.slice(tail), chunk.before, 0);
                if (hit.index === 0) {
                    found = { index: tail, fuzz: hit.fuzz };
                }
            } else if (chunk.before.length === 0) {
                found = { index: out.length, fuzz: 0 };
            }
        }
        if (found.index < 0) {
            found = locate(out, chunk.before, cursor);
        }
        if (found.index < 0) {
            const first = chunk.before[0] ?? '';
            throw new PatchError(
                `${file}: the context of the chunk at patch line ${chunk.at} is not in the file` +
                    (first ? ` — looked for: ${first.trim()}` : ''),
            );
        }
        fuzz += found.fuzz > 0 ? 1 : 0;
        out.splice(found.index, chunk.before.length, ...chunk.after);
        cursor = found.index + chunk.after.length;
    }
    return { lines: out, fuzz };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** The family name config selects the whole set by: `tools: [workspace:*]`. */
const GROUP = 'workspace';

export function workspaceTools<TCtx = unknown>(opts: WorkspaceOptions): AnyTool<TCtx>[] {
    const ws = new Workspace(opts);

    const readFileTool = tool<{ path: string; start_line?: number; end_line?: number }, TCtx>({
        name: 'read_file',
        group: GROUP,
        description:
            'Reads a UTF-8 text file from the workspace. Paths are relative to the workspace ' +
            'root. Give start_line/end_line (1-based, inclusive) to read a range; without them ' +
            'the file is read from the top until the size cap, and `truncated` says whether ' +
            'anything was left. Read before patching: apply_patch matches on the exact text.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path inside the workspace.' },
                start_line: { type: 'integer', description: 'First line to return, 1-based.' },
                end_line: { type: 'integer', description: 'Last line to return, inclusive.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path, start_line, end_line }) => {
            const at = ws.within(path);
            const info = await stat(at);
            if (info.isDirectory()) {
                return { error: `${ws.rel(at)} is a directory`, hint: 'use list_dir' };
            }
            const shape = await inspectFile(at, info.size, false);
            if (shape.format !== 'text') {
                return {
                    error: `${ws.rel(at)} is not a text file`,
                    format: shape.format,
                    bytes: info.size,
                };
            }
            const { body, whole } = await readText(at, info.size);
            const all = toLines(body);
            const total = all.length;
            const from = Math.max(1, Math.trunc(start_line ?? 1));
            const to = Math.min(total, end_line === undefined ? total : Math.trunc(end_line));
            if (from > total) {
                return { path: ws.rel(at), lines: total, error: `file has ${total} lines` };
            }

            // The cap is spent line by line, so a truncated read still ends on a
            // line boundary and can be resumed from `end_line + 1`.
            const taken: string[] = [];
            let used = 0;
            let cut = false;
            for (const line of all.slice(from - 1, to)) {
                if (taken.length > 0 && used + line.length + 1 > MAX_READ) {
                    cut = true;
                    break;
                }
                taken.push(line);
                used += line.length + 1;
            }
            return {
                path: ws.rel(at),
                bytes: info.size,
                lines: total,
                start_line: from,
                end_line: from + taken.length - 1,
                truncated: cut || !whole || to < total || from > 1 ? true : undefined,
                content: taken.join('\n'),
            };
        },
    });

    const listDir = tool<{ path?: string }, TCtx>({
        name: 'list_dir',
        group: GROUP,
        description:
            'Lists a directory in the workspace. Each entry reports its kind, and files also ' +
            'report format (text, binary, image, audio, video, pdf, archive), size in bytes ' +
            'and, for text files that are small enough to scan, their line count.',
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
            const listed: FileInfo[] = [];
            let budget = LIST_SCAN_BUDGET;
            for (const entry of entries.slice(0, MAX_ENTRIES)) {
                if (entry.isDirectory()) {
                    listed.push({ name: entry.name, kind: 'dir' });
                    continue;
                }
                if (entry.isSymbolicLink()) {
                    listed.push({ name: entry.name, kind: 'link' });
                    continue;
                }
                if (!entry.isFile()) {
                    listed.push({ name: entry.name, kind: 'other' });
                    continue;
                }
                // A file can vanish between the readdir and the stat; that is a
                // race, not a failure of the listing.
                try {
                    const info = await stat(join(at, entry.name));
                    const shape = await inspectFile(
                        join(at, entry.name),
                        info.size,
                        info.size <= budget,
                    );
                    budget -= info.size;
                    listed.push({ name: entry.name, kind: 'file', bytes: info.size, ...shape });
                } catch {
                    listed.push({ name: entry.name, kind: 'file' });
                }
            }
            return {
                path: ws.rel(at),
                entries: listed,
                truncated: entries.length > MAX_ENTRIES ? entries.length : undefined,
            };
        },
    });

    const writeFileTool = tool<{ path: string; content: string }, TCtx>({
        name: 'write_file',
        group: GROUP,
        description:
            'Creates or overwrites a UTF-8 text file in the workspace, making parent ' +
            'directories as needed. To change part of an existing file use apply_patch instead.',
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
            return {
                path: ws.rel(at),
                bytes: Buffer.byteLength(content),
                lines: lineCount(content),
                written: true,
            };
        },
    });

    const applyPatch = tool<{ patch: string }, TCtx>({
        name: 'apply_patch',
        group: GROUP,
        description:
            'Applies a patch to the workspace. The patch names the text it changes instead of ' +
            'line numbers, so read the file first and copy the surrounding lines exactly.\n\n' +
            '*** Begin Patch\n' +
            '*** Update File: src/server.ts\n' +
            '@@ class Server\n' +
            '     start() {\n' +
            '-        this.port = 80;\n' +
            '+        this.port = 8080;\n' +
            '     }\n' +
            '*** End Patch\n\n' +
            'Sections: "*** Update File: <path>", optionally followed by "*** Move to: <path>" ' +
            'to rename it; "*** Add File: <path>" with every line of the new file prefixed by ' +
            '"+"; "*** Delete File: <path>". Inside an update, a line starting with a space is ' +
            'context that must already be there, "-" removes a line and "+" adds one. ' +
            '"@@ <text>" names the enclosing block when the same lines occur more than once, ' +
            'and "*** End of File" anchors a chunk to the end. Give at least three lines of ' +
            'context around each change. One patch may touch several files, and the whole of ' +
            'it is checked before anything is written: if any part fails, nothing changes.',
        parameters: {
            type: 'object',
            properties: {
                patch: {
                    type: 'string',
                    description: 'The patch, from *** Begin Patch to *** End Patch.',
                },
            },
            required: ['patch'],
            additionalProperties: false,
        },
        execute: async ({ patch }) => {
            ws.mutable();
            if (typeof patch !== 'string' || patch.trim() === '') {
                return { error: 'patch is required' };
            }
            try {
                return await runPatch(ws, patch);
            } catch (err) {
                if (err instanceof PatchError) {
                    return {
                        error: err.message,
                        hint: 'nothing was written — read the file again and rebuild the patch',
                    };
                }
                throw err;
            }
        },
    });

    const movePath = tool<{ from: string; to: string; overwrite?: boolean }, TCtx>({
        name: 'move_file',
        group: GROUP,
        description:
            'Moves or renames a file or directory inside the workspace, making the ' +
            'destination parent directories as needed. Refuses to clobber an existing ' +
            'destination unless overwrite is set.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Existing path inside the workspace.' },
                to: { type: 'string', description: 'Destination path inside the workspace.' },
                overwrite: {
                    type: 'boolean',
                    description: 'Replace the destination if it exists.',
                },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
        execute: async ({ from, to, overwrite }) => {
            ws.mutable();
            const source = ws.within(from);
            const target = ws.within(to);
            if (source === ws.root) {
                return { error: 'refusing to move the workspace root' };
            }
            if (target === ws.root) {
                return { error: 'refusing to overwrite the workspace root' };
            }
            if (source === target) {
                return { error: 'the source and the destination are the same path' };
            }
            if (target.startsWith(source + sep)) {
                return { error: `cannot move ${ws.rel(source)} into itself` };
            }
            await stat(source); // ENOENT here is the honest error
            if (await statOrNull(target)) {
                if (!overwrite) {
                    return {
                        error: `${ws.rel(target)} already exists`,
                        hint: 'pass overwrite to replace it',
                    };
                }
                // rename() will not replace a non-empty directory on its own.
                await rm(target, { recursive: true, force: true });
            }
            await mkdir(dirname(target), { recursive: true });
            await rename(source, target);
            return { from: ws.rel(source), to: ws.rel(target), moved: true };
        },
    });

    const deleteFile = tool<{ path: string; recursive?: boolean }, TCtx>({
        name: 'delete_file',
        group: GROUP,
        description:
            'Deletes a file from the workspace. A directory is only removed, with everything ' +
            'in it, when recursive is set.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                recursive: {
                    type: 'boolean',
                    description: 'Required to delete a directory and its contents.',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path, recursive }) => {
            ws.mutable();
            const at = ws.within(path);
            if (at === ws.root) {
                return { error: 'refusing to delete the workspace root' };
            }
            const info = await stat(at);
            if (info.isDirectory()) {
                if (!recursive) {
                    return {
                        error: `${ws.rel(at)} is a directory`,
                        hint: 'pass recursive to delete it and everything in it',
                    };
                }
                await rm(at, { recursive: true });
                return { path: ws.rel(at), deleted: true, directory: true };
            }
            await rm(at);
            return { path: ws.rel(at), deleted: true };
        },
    });

    const findFiles = tool<{ pattern: string; path?: string }, TCtx>({
        name: 'find_files',
        group: GROUP,
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
        : [readFileTool, listDir, findFiles, writeFileTool, applyPatch, movePath, deleteFile];
}

// ---------------------------------------------------------------------------
// Applying a patch
//
// Two passes, and the split between them is the whole point: the first resolves
// every path, reads every file and works out what each one should become, in
// memory; the second writes. A patch that fails halfway through validation has
// touched nothing, so the model can be told what went wrong and try again
// against a workspace that still looks exactly as it did when it read it.
// ---------------------------------------------------------------------------

type PatchStep =
    | { kind: 'write'; at: string; content: string }
    | { kind: 'move'; from: string; to: string }
    | { kind: 'delete'; at: string };

async function runPatch(ws: Workspace, patch: string): Promise<unknown> {
    const ops = parsePatch(patch);
    const steps: PatchStep[] = [];
    const touched: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let fuzz = 0;

    for (const op of ops) {
        const at = ws.within(op.path);
        if (at === ws.root) {
            throw new PatchError(`${op.path} is the workspace root`);
        }
        if (seen.has(at)) {
            throw new PatchError(`${ws.rel(at)} appears twice in the patch`);
        }
        seen.add(at);

        if (op.kind === 'delete') {
            const info = await statOrNull(at);
            if (!info) {
                throw new PatchError(`${ws.rel(at)} does not exist`);
            }
            if (info.isDirectory()) {
                throw new PatchError(`${ws.rel(at)} is a directory`);
            }
            steps.push({ kind: 'delete', at });
            touched.push({ path: ws.rel(at), action: 'deleted' });
            continue;
        }

        if (op.kind === 'add') {
            if (await statOrNull(at)) {
                throw new PatchError(
                    `${ws.rel(at)} already exists — update it instead of adding it`,
                );
            }
            const content = op.lines.length > 0 ? op.lines.join('\n') + '\n' : '';
            if (Buffer.byteLength(content) > MAX_WRITE) {
                throw new PatchError(`${ws.rel(at)} would exceed ${MAX_WRITE} bytes`);
            }
            steps.push({ kind: 'write', at, content });
            touched.push({
                path: ws.rel(at),
                action: 'added',
                bytes: Buffer.byteLength(content),
                lines: op.lines.length,
            });
            continue;
        }

        const info = await statOrNull(at);
        if (!info) {
            throw new PatchError(`${ws.rel(at)} does not exist`);
        }
        if (info.isDirectory()) {
            throw new PatchError(`${ws.rel(at)} is a directory`);
        }
        if (info.size > MAX_WRITE) {
            throw new PatchError(`${ws.rel(at)} is too large to patch`);
        }
        const shape = await inspectFile(at, info.size, false);
        if (shape.format !== 'text') {
            throw new PatchError(`${ws.rel(at)} is a ${shape.format} file, not text`);
        }
        const body = await readFile(at, 'utf8');
        const patched = patchLines(toLines(body), op.chunks, ws.rel(at));
        fuzz += patched.fuzz;
        // Whether the file ended in a newline is a property of the file, not of
        // the patch, so it survives the edit.
        const trailing = body === '' || body.endsWith('\n');
        const content =
            patched.lines.length === 0 ? '' : patched.lines.join('\n') + (trailing ? '\n' : '');
        if (Buffer.byteLength(content) > MAX_WRITE) {
            throw new PatchError(`${ws.rel(at)} would exceed ${MAX_WRITE} bytes`);
        }
        steps.push({ kind: 'write', at, content });

        const entry: Record<string, unknown> = {
            path: ws.rel(at),
            action: 'updated',
            chunks: op.chunks.length,
            bytes: Buffer.byteLength(content),
            lines: patched.lines.length,
        };
        if (op.moveTo) {
            const to = ws.within(op.moveTo);
            if (to === ws.root) {
                throw new PatchError('cannot move a file onto the workspace root');
            }
            if (to !== at) {
                if (await statOrNull(to)) {
                    throw new PatchError(`${ws.rel(to)} already exists`);
                }
                steps.push({ kind: 'move', from: at, to });
                entry.action = 'moved';
                entry.to = ws.rel(to);
            }
        }
        touched.push(entry);
    }

    for (const step of steps) {
        switch (step.kind) {
            case 'write':
                await mkdir(dirname(step.at), { recursive: true });
                await writeFile(step.at, step.content, 'utf8');
                break;
            case 'move':
                await mkdir(dirname(step.to), { recursive: true });
                await rename(step.from, step.to);
                break;
            case 'delete':
                await rm(step.at);
                break;
        }
    }
    return {
        applied: touched.length,
        files: touched,
        // Worth reporting: a chunk that only matched once whitespace was
        // ignored landed where the tool thinks it should, not where the patch
        // said, and that is a thing to check.
        fuzzy: fuzz > 0 ? fuzz : undefined,
    };
}

async function statOrNull(at: string): Promise<Stats | null> {
    try {
        return await stat(at);
    } catch {
        return null;
    }
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
