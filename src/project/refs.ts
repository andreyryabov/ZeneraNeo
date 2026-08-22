import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Path references
// ---------------------------------------------------------------------------

/**
 * Every path a project file names goes through here.
 *
 * A project is data someone else may have written, so `system: "../../.ssh/id_rsa"`
 * has to be a load-time error rather than a prompt containing a private key.
 * One chokepoint instead of a check at each call site, because the call sites
 * are where such a check gets forgotten.
 *
 * `file://` is accepted for the spec's sake and normalised away immediately;
 * everything else is read relative to the project root, never to `process.cwd()`,
 * so a project loads the same from any working directory.
 */
export function projectPath(root: string, ref: string, what: string): string {
    const path = resolve(root, unprefix(ref, what));
    const rel = relative(root, path);
    // `relative` gives '' for the root itself, and something starting with '..'
    // for anything above it. An absolute result means a different drive.
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`${what}: "${ref}" resolves outside the project root (${root})`);
    }
    return path;
}

/** As `projectPath`, and the file must exist. */
export function projectFile(root: string, ref: string, what: string): string {
    const path = projectPath(root, ref, what);
    if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`${what}: no such file: ${path}`);
    }
    return path;
}

/** As `projectPath`, and the directory must exist. */
export function projectDir(root: string, ref: string, what: string): string {
    const path = projectPath(root, ref, what);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error(`${what}: no such directory: ${path}`);
    }
    return path;
}

function unprefix(ref: string, what: string): string {
    if (!ref.startsWith('file:')) {
        return ref;
    }
    // `file:///abs/path` is a URL and has percent-encoding to undo; `file://x`
    // names a remote host, which we cannot read and will not pretend to.
    if (ref.startsWith('file:///')) {
        return fileURLToPath(ref);
    }
    if (ref.startsWith('file://')) {
        throw new Error(`${what}: "${ref}" names a host; only local paths are supported`);
    }
    return ref.slice('file:'.length);
}

/**
 * `root` itself, resolved and required to exist — the one path that cannot be
 * checked against the root, since it is the root.
 */
export function projectRoot(dir: string): string {
    const path = resolve(dir);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error(`project root is not a directory: ${path}`);
    }
    return path;
}
