import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './term.ts';

// ---------------------------------------------------------------------------
// The home directory
//
// ~/.zenera/neo holds exactly two kinds of thing: credentials, which belong to
// the machine and never to a project, and an index of where projects are, which
// is a convenience and is allowed to be wrong.
//
// `ZENERA_HOME` moves the whole tree. That is what makes any of this testable
// and what lets CI start from an empty one.
// ---------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function home(): string {
    const override = process.env.ZENERA_HOME?.trim();
    return override ? override : join(homedir(), '.zenera', 'neo');
}

export const paths = {
    home,
    projects: (): string => join(home(), 'projects.json'),
    keys: (): string => join(home(), 'keys.json'),
    keyDir: (): string => join(home(), 'keys'),
    faker: (): string => join(home(), 'faker'),
    /** cached model listings, one file per provider — public data, not secrets */
    catalog: (): string => join(home(), 'catalog'),
};

/** Creates a directory owner-only, and leaves an existing one's mode alone. */
export function ensureDir(dir: string, mode = DIR_MODE): string {
    mkdirSync(dir, { recursive: true, mode });
    return dir;
}

export function ensureHome(): string {
    return ensureDir(home());
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Refuses to read a credential file that anyone else can read, the way `ssh`
 * does. A world-readable key is not a warning-level event: warnings are
 * ignored, and the whole point of the store is that the secret is not lying
 * around in the open.
 *
 * Windows reports a mode that means nothing here, so the check is POSIX-only.
 */
export function assertPrivate(path: string): void {
    if (process.platform === 'win32') {
        return;
    }
    let mode: number;
    try {
        mode = statSync(path).mode;
    } catch {
        return; // absent is fine; it will be created with the right mode
    }
    const open = mode & 0o077;
    if (open !== 0) {
        const octal = (mode & 0o777).toString(8).padStart(3, '0');
        throw new CliError(
            `permissions ${octal} on ${path} are too open`,
            EXIT.credentials,
            `run: chmod 600 ${path}`,
        );
    }
}

// ---------------------------------------------------------------------------
// JSON files
// ---------------------------------------------------------------------------

export async function readJson<T>(path: string, fallback: T): Promise<T> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return fallback;
        }
        throw err;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new CliError(`${path} is not valid JSON`, EXIT.invalid, 'fix or delete the file');
    }
}

/**
 * Write to a sibling and rename. A crash then leaves either the old file or the
 * new one, never a half-written registry — which matters more here than it
 * looks, because the alternative is a corrupt `keys.json` locking someone out
 * of every provider at once.
 *
 * Synchronous on purpose: this is also called from exit paths.
 */
export function writeJson(path: string, value: unknown, mode = FILE_MODE): void {
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
        chmodSync(tmp, mode);
        renameSync(tmp, path);
    } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}
