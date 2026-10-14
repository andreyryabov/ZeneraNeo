import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// From a URL path to a file under the root, or nothing
//
// The root is the whole of what the server will read. A path is decoded once,
// split, and refused on `..`, a NUL or a backslash before it is joined; then the
// result is realpath'd - the nearest existing ancestor, for a file not written
// yet - so a symlink inside the root cannot lead out of it.
// ---------------------------------------------------------------------------

/** Secrets and repository internals: never served, even with hidden files on. */
const NEVER = /^\.(env|git|npmrc|netrc)(\.|$)/i;

export interface Located {
    abs: string;
    /** the canonical URL path, `/` for the root */
    path: string;
}

export function isHidden(name: string, hidden: boolean): boolean {
    return name.startsWith('.') && (!hidden || NEVER.test(name));
}

export function locate(root: string, urlPath: string, hidden = false): Located | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return undefined;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
        return undefined;
    }
    const parts = decoded.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.some((p) => p === '..' || isHidden(p, hidden))) {
        return undefined;
    }
    const abs = join(root, ...parts);
    if (!inside(root, real(abs))) {
        return undefined;
    }
    return { abs, path: `/${parts.join('/')}` };
}

/** The real path, resolving the nearest ancestor that exists. */
function real(abs: string): string {
    let at = abs;
    const rest: string[] = [];
    while (!existsSync(at)) {
        const up = dirname(at);
        if (up === at) {
            return abs;
        }
        rest.unshift(basename(at));
        at = up;
    }
    return join(realpathSync(at), ...rest);
}

export function inside(root: string, abs: string): boolean {
    const rel = relative(root, abs);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
