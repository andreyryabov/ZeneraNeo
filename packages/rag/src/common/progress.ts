import { CliError, EXIT } from '@zenera/cli/lib';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// A build that says what it is doing
//
// Indexing a large corpus is minutes of silence with a directory slowly
// filling up, and the directory is the only thing a second person — or a second
// process, or an agent reading the tree — ever sees. So the build writes two
// files into it and keeps them true:
//
//   .lock       who is building this, right now. Gone when nothing is.
//   README.md   a progress report while it runs, and a description of what the
//               index holds once it does not.
//
// Nothing in either file is an absolute path. A project's `assets/` directory
// is mounted at `/assets` inside an agent's sandbox, so an index built there is
// read under a name this process never sees; a host path would be a lie there.
//
// What is here is the mechanics — the lock, the throttle, the atomic rewrite.
// The words belong to whatever is being indexed, so they arrive as a `Report`.
// ---------------------------------------------------------------------------

export const LOCK_FILE = '.lock';
export const README_FILE = 'README.md';

/** The floor on how often README.md is rewritten. */
export const INTERVAL_MS = 5000;

export interface Building<S> {
    documents: readonly string[];
    embedding: string;
    started: number;
    now: number;
    /** the current phase, as it should be said out loud */
    step: string;
    done: number;
    total: number;
    /** what the documents turned out to hold, once they have been read */
    summary: S | undefined;
}

export interface Completed<M> {
    dir: string;
    manifest: M;
    ms: number;
}

export interface Failed {
    documents: readonly string[];
    step: string;
    reason: unknown;
    started: number;
}

/** The three states a README can be in, written by whoever knows the subject. */
export interface Report<S, M> {
    building(state: Building<S>): string;
    complete(state: Completed<M>): string;
    failed(state: Failed): string;
}

export interface BuildPlan<S, M, P extends string> {
    /** where the index goes */
    dir: string;
    files: readonly string[];
    /** the embedding reference as it was typed */
    embedding: string;
    indexer: string;
    /** every phase, in order; the first is where a build starts */
    phases: Readonly<Record<P, string>>;
    report: Report<S, M>;
}

export interface Journal<S, M, P extends string> {
    phase(name: P): void;
    read(summary: S, total: number): void;
    progress(done: number, total: number): void;
    finish(manifest: M): void;
    fail(reason: unknown): void;
}

interface Lock {
    pid: number;
    host: string;
    startedAt: string;
    indexer: string;
    embedding: string;
    documents: string[];
}

/**
 * Takes the directory, or refuses it. Two builds writing one index would
 * interleave their store writes and leave one that neither of them describes.
 */
export function beginBuild<S, M, P extends string>(plan: BuildPlan<S, M, P>): Journal<S, M, P> {
    const documents = plan.files.map((file) => basename(file));
    const started = Date.now();
    const lock: Lock = {
        pid: process.pid,
        host: hostname(),
        startedAt: new Date(started).toISOString(),
        indexer: plan.indexer,
        embedding: plan.embedding,
        documents,
    };

    mkdirSync(plan.dir, { recursive: true });
    claim(join(plan.dir, LOCK_FILE), lock);

    let phase = Object.keys(plan.phases)[0] as P;
    let summary: S | undefined;
    let done = 0;
    let total = 0;
    let wroteAt = 0;
    let closed = false;

    const write = (body: string): void => {
        // Through a temp name, so a reader never catches half a file.
        const target = join(plan.dir, README_FILE);
        const temp = `${target}.tmp`;
        writeFileSync(temp, body);
        renameSync(temp, target);
        wroteAt = Date.now();
    };

    const report = (): void =>
        write(
            plan.report.building({
                documents,
                embedding: plan.embedding,
                started,
                now: Date.now(),
                step: plan.phases[phase],
                done,
                total,
                summary,
            }),
        );

    const maybe = (): void => {
        if (!closed && Date.now() - wroteAt >= INTERVAL_MS) {
            report();
        }
    };

    // The first embedding request can block for ten seconds or more, so a purely
    // event-driven throttle would leave the elapsed line frozen through it.
    const ticker = setInterval(maybe, INTERVAL_MS);
    ticker.unref();

    const close = (body: string): void => {
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(ticker);
        write(body);
        rmSync(join(plan.dir, LOCK_FILE), { force: true });
    };

    report();

    return {
        phase(name) {
            phase = name;
            maybe();
        },
        read(seen, count) {
            summary = seen;
            total = count;
            maybe();
        },
        progress(at, of) {
            done = at;
            total = of;
            maybe();
        },
        finish(manifest) {
            close(plan.report.complete({ dir: plan.dir, manifest, ms: Date.now() - started }));
        },
        fail(reason) {
            close(plan.report.failed({ documents, step: plan.phases[phase], reason, started }));
        },
    };
}

/**
 * `wx` makes the create and the check one operation, so two builds racing for
 * the same directory cannot both win. A lock whose process is gone is stale by
 * definition and is taken rather than respected — a crashed build must not make
 * a directory permanently unbuildable.
 */
function claim(path: string, lock: Lock): void {
    const body = `${JSON.stringify(lock, null, 4)}\n`;
    try {
        writeFileSync(path, body, { flag: 'wx' });
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }
    const held = readLock(path);
    if (held && held.host === hostname() && alive(held.pid)) {
        throw new CliError(
            `this index is already being built (pid ${held.pid}, since ${held.startedAt})`,
            EXIT.failed,
            `wait for it, or build elsewhere with --out`,
        );
    }
    writeFileSync(path, body);
}

function readLock(path: string): Lock | undefined {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Lock;
    } catch {
        return undefined;
    }
}

/**
 * `kill(pid, 0)` sends no signal and only asks whether the process exists.
 * EPERM means it exists and belongs to someone else, which still counts.
 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}
