import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Telling a subscriber its file changed
//
// The DIRECTORY is watched, never the file: writers replace a file by renaming
// a temporary over it, and a watch on the old inode hears nothing after the
// first rename. Events only prompt a look - a subscriber is called when the
// file's stamp (inode, size, mtime; for a directory its entries) moved. A slow
// poll backs up `fs.watch`, which drops events on some filesystems.
// ---------------------------------------------------------------------------

export interface WatchOptions {
    debounceMs?: number;
    pollMs?: number;
}

interface Sub {
    abs: string;
    dir: string;
    stamp: string;
    notify: () => void;
}

interface Dir {
    watcher?: FSWatcher;
    subs: Set<Sub>;
}

export function stampOf(abs: string): string {
    try {
        const s = statSync(abs);
        if (!s.isDirectory()) {
            return `${s.ino}:${s.size}:${s.mtimeMs}`;
        }
        return readdirSync(abs)
            .sort()
            .map((name) => {
                try {
                    const e = statSync(join(abs, name));
                    return `${name}:${e.size}:${e.mtimeMs}`;
                } catch {
                    return name;
                }
            })
            .join('/');
    } catch {
        return 'missing';
    }
}

export class Watcher {
    readonly #dirs = new Map<string, Dir>();
    readonly #due = new Set<Sub>();
    readonly #debounceMs: number;
    #timer: NodeJS.Timeout | undefined;
    readonly #poll: NodeJS.Timeout;

    constructor(options: WatchOptions = {}) {
        this.#debounceMs = options.debounceMs ?? 75;
        this.#poll = setInterval(() => this.#check(this.#all()), options.pollMs ?? 2000);
        this.#poll.unref();
    }

    /** Calls `notify` whenever `abs` changes, until the returned function is called. */
    subscribe(abs: string, notify: () => void): () => void {
        const dir = isDir(abs) ? abs : dirname(abs);
        const sub: Sub = { abs, dir, stamp: stampOf(abs), notify };
        let d = this.#dirs.get(dir);
        if (!d) {
            d = { subs: new Set(), ...this.#open(dir) };
            this.#dirs.set(dir, d);
        }
        d.subs.add(sub);
        return () => {
            const at = this.#dirs.get(dir);
            at?.subs.delete(sub);
            this.#due.delete(sub);
            if (at && at.subs.size === 0) {
                at.watcher?.close();
                this.#dirs.delete(dir);
            }
        };
    }

    close(): void {
        clearInterval(this.#poll);
        clearTimeout(this.#timer);
        for (const d of this.#dirs.values()) {
            d.watcher?.close();
        }
        this.#dirs.clear();
        this.#due.clear();
    }

    #open(dir: string): { watcher?: FSWatcher } {
        try {
            const watcher = watch(dir, { persistent: false }, () => this.#schedule(dir));
            // A directory removed under a watch errors; the poll carries on without it.
            watcher.on('error', () => watcher.close());
            return { watcher };
        } catch {
            return {};
        }
    }

    #schedule(dir: string): void {
        for (const sub of this.#dirs.get(dir)?.subs ?? []) {
            this.#due.add(sub);
        }
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
            const due = [...this.#due];
            this.#due.clear();
            this.#check(due);
        }, this.#debounceMs);
        this.#timer.unref();
    }

    #all(): Sub[] {
        return [...this.#dirs.values()].flatMap((d) => [...d.subs]);
    }

    #check(subs: Sub[]): void {
        for (const sub of subs) {
            const stamp = stampOf(sub.abs);
            if (stamp !== sub.stamp) {
                sub.stamp = stamp;
                sub.notify();
            }
        }
    }
}

function isDir(abs: string): boolean {
    try {
        return statSync(abs).isDirectory();
    } catch {
        return false;
    }
}
