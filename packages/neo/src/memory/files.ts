import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { FILES_DIR } from './store.ts';
import { MemoryError, type MemoryFile } from './types.ts';

// ---------------------------------------------------------------------------
// Remembered files
//
// An agent that writes a working script should be able to run it again next
// week, and a summary of a script is not a script. So the bytes are copied out
// of the workspace — which is disposable, and may be a container that is about
// to be discarded — into the memory directory, under the id of the node that
// describes them. The copy is the point: a reference to a workspace path would
// dangle the moment the run ends.
//
// The tree is mounted read-only at /memory. Nothing writes there through the
// file tools, so every file under it has a node that explains what it is, and
// the graph cannot acquire orphans that no recollection can ever surface.
// ---------------------------------------------------------------------------

/** Where remembered files appear in the agent's namespace. */
export const MEMORY_MOUNT = '/memory';

/**
 * Big enough for any script or config worth re-running, small enough that the
 * memory directory cannot become a place where build outputs go to hide.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Extensions are for `run_command` and syntax hints, not a type system. */
const MAX_FORMAT_LEN = 16;

export interface RememberOptions {
    maxBytes?: number;
}

/**
 * Copy `source` into the memory directory under `id` and describe it.
 *
 * The bytes are read once and both hashed and written from that one buffer, so
 * the digest provably belongs to the copy that was kept — re-reading the source
 * to hash it would leave a window for it to change in between.
 */
export async function rememberFile(
    dir: string,
    source: string,
    id: string,
    opts: RememberOptions = {},
): Promise<MemoryFile> {
    const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
    const info = await describe(source);
    if (!info.isFile()) {
        throw new MemoryError(
            `${source} is not a regular file`,
            'only files can be remembered; write a `fact` node describing a directory instead',
        );
    }
    if (info.size > maxBytes) {
        throw new MemoryError(
            `${source} is ${info.size} bytes, over the ${maxBytes} byte limit for a remembered file`,
            'keep the artifact in the workspace and remember a `snippet` of the part that matters',
        );
    }

    const bytes = await readFile(source);
    if (bytes.byteLength > maxBytes) {
        throw new MemoryError(`${source} grew past the ${maxBytes} byte limit while being read`);
    }

    const format = formatOf(source);
    const name = id + (format ? `.${format}` : '');
    await mkdir(join(dir, FILES_DIR), { recursive: true });
    await writeFile(join(dir, FILES_DIR, name), bytes);

    return {
        path: `${MEMORY_MOUNT}/${name}`,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        format,
    };
}

/** The host path of a remembered file, for reading it back or deleting it. */
export function hostPath(dir: string, file: MemoryFile): string {
    // Through `basename` so a stored path can never climb out of the tree.
    return join(dir, FILES_DIR, basename(file.path));
}

/** Drop the bytes of a forgotten node. Missing is success — the goal is absence. */
export async function forgetFile(dir: string, file: MemoryFile): Promise<void> {
    await rm(hostPath(dir, file), { force: true });
}

async function describe(source: string) {
    try {
        return await stat(source);
    } catch {
        throw new MemoryError(
            `${source} does not exist`,
            'remember a file the run actually wrote, by the path the file tools use',
        );
    }
}

/**
 * The extension drives how the file is run and rendered, so it is kept, but it
 * becomes part of a filename this module chooses — hence the character class.
 */
function formatOf(source: string): string {
    const ext = extname(source).slice(1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) && ext.length <= MAX_FORMAT_LEN ? ext : '';
}
