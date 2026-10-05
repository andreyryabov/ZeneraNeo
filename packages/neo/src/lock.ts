import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

// ---------------------------------------------------------------------------
// A directory claimed by a process
//
// There is no daemon, so "is somebody using this" is answered by a file that
// names a process. A lock whose process is gone is stale by definition and is
// taken rather than respected — a crashed run must not make what it held
// permanently unusable. Memory graphs, sessions and rag indexes all lock this
// way; this is the one implementation.
// ---------------------------------------------------------------------------

export interface Lock {
    pid: number;
    host: string;
    startedAt: string;
}

/** A lock body for this process, with whatever else the holder wants to say. */
export function ownLock<T extends object>(extra?: T): Lock & T {
    return {
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        ...(extra as T),
    };
}

/**
 * `kill(pid, 0)` sends no signal and only asks whether the process exists.
 * EPERM means it exists and belongs to someone else, which still counts.
 */
export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The lock file as written, or undefined when absent or unreadable. */
export function readLock<T extends Lock = Lock>(path: string): T | undefined {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/**
 * Who holds a lock right now, if anyone. Read-only: it never claims the lock
 * and never clears a stale one. A lock from another host cannot be verified
 * here, so it is not reported as held.
 */
export function liveHolder<T extends Lock = Lock>(path: string): T | undefined {
    const held = readLock<T>(path);
    return held && held.host === hostname() && pidAlive(held.pid) ? held : undefined;
}

/**
 * Writes `lock` to `path`, or calls `refuse` with the live holder and throws
 * what it returns. `wx` makes the create and the check one operation, so two
 * processes racing for the same directory cannot both win.
 */
export function claimLock<T extends Lock>(
    path: string,
    lock: T,
    refuse: (held: T) => Error,
    indent = 4,
): void {
    const body = `${JSON.stringify(lock, null, indent)}\n`;
    try {
        writeFileSync(path, body, { flag: 'wx' });
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }
    const held = liveHolder<T>(path);
    if (held) {
        throw refuse(held);
    }
    // Stale, or from another machine's run that cannot be verified here.
    writeFileSync(path, body);
}
