import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { readJson, writeJson } from './home.ts';
import { isStamp, stamp } from './ids.ts';
import { alive, isBusy, runIds, sessionIds, sessionsDir } from './projects.ts';
import { CliError, EXIT, invalidError, usageError } from './term.ts';

// ---------------------------------------------------------------------------
// Sessions and runs
//
// A **session** is a context that persists: one workspace, one memory, one blob
// store, one accumulating trajectory. A **run** is one turn inside it.
//
// None of this invents a runtime concept. The session directory is the
// arguments to `FilePayloadStore` and `FileMemoryStore`, and the session state
// is the `AgentState` the runner already serializes. The layout is a place to
// put things the library already produces.
// ---------------------------------------------------------------------------

export interface SessionPaths {
    id: string;
    dir: string;
    /** what the agent can see and write */
    workspace: string;
    data: string;
    /** the live, resumable state — rewritten after every run */
    state: string;
    memory: string;
    blobs: string;
    runs: string;
    lock: string;
    meta: string;
}

export function sessionPaths(versionDir: string, id: string): SessionPaths {
    if (!isStamp(id)) {
        throw usageError(`"${id}" is not a session id`, 'ids look like 20260825-143012-a7f3');
    }
    const dir = join(sessionsDir(versionDir), id);
    const data = join(dir, '.data');
    return {
        id,
        dir,
        workspace: join(dir, 'workspace'),
        data,
        state: join(data, 'state.json'),
        memory: join(data, 'memory'),
        blobs: join(data, 'blobs'),
        runs: join(dir, 'runs'),
        lock: join(dir, '.lock'),
        meta: join(data, 'session.json'),
    };
}

export interface SessionMeta {
    version: 1;
    id: string;
    createdAt: string;
    /**
     * Absolute path the agent's file tools are rooted at. Recorded so resuming
     * never re-asks and never silently moves — a session that quietly changed
     * what "the workspace" meant between turns would be unexplainable.
     */
    workspace: string;
    lastRunAt?: string;
    title?: string;
}

// ---------------------------------------------------------------------------
// Creating and finding
// ---------------------------------------------------------------------------

export function createSession(versionDir: string, id: string, workspace: string): SessionPaths {
    const p = sessionPaths(versionDir, id);
    mkdirSync(p.data, { recursive: true });
    mkdirSync(p.runs, { recursive: true });
    mkdirSync(resolve(workspace), { recursive: true });
    const meta: SessionMeta = {
        version: 1,
        id: p.id,
        createdAt: new Date().toISOString(),
        workspace: resolve(workspace),
    };
    writeJson(p.meta, meta, 0o644);
    return p;
}

export async function readSessionMeta(p: SessionPaths): Promise<SessionMeta> {
    const meta = await readJson<Partial<SessionMeta>>(p.meta, {});
    return {
        version: 1,
        id: p.id,
        createdAt: meta.createdAt ?? new Date().toISOString(),
        // Sessions from before the workspace was recorded fall back to their
        // own directory, which is where it would have been.
        workspace: meta.workspace ?? p.workspace,
        lastRunAt: meta.lastRunAt,
        title: meta.title,
    };
}

export function writeSessionMeta(p: SessionPaths, meta: SessionMeta): void {
    writeJson(p.meta, meta, 0o644);
}

export interface SessionSummary {
    id: string;
    createdAt?: string;
    runs: number;
    lastRunAt?: string;
    busy: boolean;
    title?: string;
}

/** Newest first — the order a picker wants. */
export async function listSessions(versionDir: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const id of sessionIds(versionDir).reverse()) {
        const p = sessionPaths(versionDir, id);
        const meta = await readSessionMeta(p);
        const ids = runIds(p.dir);
        out.push({
            id,
            createdAt: meta.createdAt,
            runs: ids.length,
            lastRunAt: meta.lastRunAt,
            busy: isBusy(p.dir),
            title: meta.title,
        });
    }
    return out;
}

export function newestSession(versionDir: string): string | undefined {
    return sessionIds(versionDir).at(-1);
}

export function requireSession(versionDir: string, id: string): SessionPaths {
    const p = sessionPaths(versionDir, id);
    if (!existsSync(p.dir)) {
        throw invalidError(`no session ${id}`, 'see: zn list --sessions');
    }
    return p;
}

// ---------------------------------------------------------------------------
// Locking
//
// There is no daemon, so "is this session running" is answered by a file that
// names a process. A lock whose process is gone is stale by definition and is
// taken rather than respected — the alternative is a crashed run making its
// session permanently unusable.
// ---------------------------------------------------------------------------

interface Lock {
    pid: number;
    host: string;
    startedAt: string;
}

export interface Held {
    release(): void;
}

export function acquire(p: SessionPaths): Held {
    const lock: Lock = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
    const body = `${JSON.stringify(lock, null, 2)}\n`;
    try {
        // 'wx' fails when the file exists — the create and the check are one
        // operation, so two `zn run`s racing cannot both win.
        writeFileSync(p.lock, body, { flag: 'wx' });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
        const held = current(p);
        if (held && alive(held.pid) && held.host === hostname()) {
            throw new CliError(
                `session ${p.id} is already running (pid ${held.pid})`,
                EXIT.failed,
                'wait for it, or start another with --new',
            );
        }
        // Stale, or from another machine's run that cannot be verified here.
        writeFileSync(p.lock, body);
    }

    let released = false;
    const release = (): void => {
        if (released) {
            return;
        }
        released = true;
        rmSync(p.lock, { force: true });
    };
    return { release };
}

function current(p: SessionPaths): Lock | undefined {
    try {
        return JSON.parse(readFileSync(p.lock, 'utf8')) as Lock;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunPaths {
    id: string;
    dir: string;
    input: string;
    output: string;
    state: string;
    report: string;
    meta: string;
}

export function runPaths(session: SessionPaths, id: string): RunPaths {
    if (!isStamp(id)) {
        throw usageError(`"${id}" is not a run id`);
    }
    const dir = join(session.runs, id);
    return {
        id,
        dir,
        input: join(dir, 'input.md'),
        output: join(dir, 'output.md'),
        state: join(dir, 'state.json'),
        report: join(dir, 'report.html'),
        meta: join(dir, 'meta.json'),
    };
}

export function createRun(session: SessionPaths): RunPaths {
    const p = runPaths(session, stamp());
    mkdirSync(p.dir, { recursive: true });
    return p;
}

export interface RunMeta {
    version: 1;
    id: string;
    session: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    agent: string;
    stopReason: string;
    turns: number;
    usage: unknown;
    workspace: string;
    error?: string;
}

export function writeRunMeta(p: RunPaths, meta: RunMeta): void {
    writeJson(p.meta, meta, 0o644);
}

export function newestRun(session: SessionPaths): string | undefined {
    return runIds(session.dir).at(-1);
}

/** A path to show a human: relative when that is shorter, absolute otherwise. */
export function display(path: string, from = process.cwd()): string {
    const rel = relative(from, path);
    return !rel.startsWith('..') && rel.length < path.length ? rel || '.' : path;
}
