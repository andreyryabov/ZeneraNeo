import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { paths, readJson, writeJson } from './home.ts';
import { isStamp } from './ids.ts';
import { invalidError, usageError } from './term.ts';

// ---------------------------------------------------------------------------
// Projects
//
// The directory is the truth, and what makes a directory a project is the one
// file the runtime cannot do without: `agents.yaml`. There is no marker file
// beside it — that would be a second thing to keep in sync, holding a name the
// directory already has.
//
// `~/.zenera/neo/projects.json` is an index so that `zen list` and `zen go` do
// not have to search the filesystem, and it is allowed to be wrong: every entry
// can be rebuilt by pointing `zen` at the directory again, and an entry whose
// path has vanished is reported, not fatal.
// ---------------------------------------------------------------------------

/**
 * The loader's own names, in its own order — `packages/neo/src/project/load.ts`.
 * Anything the library would load, `zen` finds.
 */
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];

/** Whether a directory is a project: whether the loader has something to read. */
export function isProjectDir(dir: string): boolean {
    return CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

/** A project resolved on disk. */
export interface Project {
    dir: string;
    /** what it is called: the registry's name, or the directory's own */
    name: string;
}

// ---------------------------------------------------------------------------
// The project directory
// ---------------------------------------------------------------------------

/**
 * What a project answers to. The registry is asked first, so one registered
 * under a name of its own keeps it; the directory's name answers for a project
 * that was never registered — which is a working project, just not a listed one.
 */
async function nameOf(dir: string): Promise<string> {
    return (await Registry.open()).findPath(dir)?.name ?? basename(dir);
}

// ---------------------------------------------------------------------------
// Finding one
// ---------------------------------------------------------------------------

/** Walks up from `start` looking for a project configuration. */
export async function findUp(start: string): Promise<Project | undefined> {
    let dir = resolve(start);
    for (;;) {
        if (isProjectDir(dir)) {
            return { dir, name: await nameOf(dir) };
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

export async function openDir(dir: string): Promise<Project> {
    const at = resolve(dir);
    if (!isProjectDir(at)) {
        throw invalidError(`${at} is not a project`, `no ${CONFIG_NAMES[0]} — run: zen init`);
    }
    return { dir: at, name: await nameOf(at) };
}

/**
 * A name from the registry, or a path. A value that looks like either is tried
 * as both, path first, because a directory that exists is unambiguous evidence
 * and a stale registry entry is not.
 */
export async function open(nameOrDir: string): Promise<Project> {
    if (isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || existsSync(nameOrDir)) {
        return openDir(nameOrDir);
    }
    const entry = (await Registry.open()).find(nameOrDir);
    if (!entry) {
        throw usageError(`no project named "${nameOrDir}"`, 'see: zen list');
    }
    return openDir(entry.path);
}

/**
 * `open` where a miss is an answer rather than an error. It exists for the one
 * place a word might be a project name and might be something else entirely —
 * `zen run <project>` against `zen run <prompt>` — and the difference decides
 * how the rest of the line is read.
 */
export async function find(nameOrDir: string): Promise<Project | undefined> {
    if (isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || existsSync(nameOrDir)) {
        const dir = resolve(nameOrDir);
        return isProjectDir(dir) ? { dir, name: await nameOf(dir) } : undefined;
    }
    const entry = (await Registry.open()).find(nameOrDir);
    return entry ? openDir(entry.path) : undefined;
}

/** The project a bare command means: the one you are standing in. */
export async function current(cwd = process.cwd()): Promise<Project | undefined> {
    return findUp(cwd);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface RegistryEntry {
    name: string;
    path: string;
    addedAt: string;
}

interface RegistryFile {
    version: 1;
    projects: RegistryEntry[];
}

export class Registry {
    readonly #file: RegistryFile;

    private constructor(file: RegistryFile) {
        this.#file = file;
    }

    static async open(): Promise<Registry> {
        const file = await readJson<RegistryFile>(paths.projects(), {
            version: 1,
            projects: [],
        });
        return new Registry({ version: 1, projects: file.projects ?? [] });
    }

    get entries(): readonly RegistryEntry[] {
        return this.#file.projects;
    }

    find(name: string): RegistryEntry | undefined {
        return this.#file.projects.find((p) => p.name === name);
    }

    findPath(dir: string): RegistryEntry | undefined {
        const at = resolve(dir);
        return this.#file.projects.find((p) => resolve(p.path) === at);
    }

    /** Idempotent: re-registering the same directory refreshes it in place. */
    add(name: string, dir: string): RegistryEntry {
        const path = resolve(dir);
        const existing = this.find(name);
        if (existing && resolve(existing.path) !== path) {
            throw usageError(
                `a different project is already named "${name}"`,
                `it lives at ${existing.path} — use --name`,
            );
        }
        const byPath = this.findPath(path);
        if (byPath) {
            byPath.name = name;
            return byPath;
        }
        const entry: RegistryEntry = { name, path, addedAt: new Date().toISOString() };
        this.#file.projects.push(entry);
        return entry;
    }

    remove(name: string): boolean {
        const at = this.#file.projects.findIndex((p) => p.name === name);
        if (at < 0) {
            return false;
        }
        this.#file.projects.splice(at, 1);
        return true;
    }

    /** Drops entries whose directory is gone. Returns what it dropped. */
    prune(): RegistryEntry[] {
        const gone = this.#file.projects.filter((p) => !isProjectDir(p.path));
        this.#file.projects = this.#file.projects.filter((p) => !gone.includes(p));
        return gone;
    }

    save(): void {
        writeJson(paths.projects(), this.#file, 0o600);
    }
}

// ---------------------------------------------------------------------------
// Summaries, for `zen list`
// ---------------------------------------------------------------------------

export interface ProjectSummary {
    name: string;
    path: string;
    /** false when the directory has gone away since it was registered */
    present: boolean;
    sessions: number;
    runs: number;
    lastRunAt?: string;
    /** a session currently held by a live process */
    busy: boolean;
}

export async function summarize(entry: RegistryEntry): Promise<ProjectSummary> {
    const base: ProjectSummary = {
        name: entry.name,
        path: entry.path,
        present: false,
        sessions: 0,
        runs: 0,
        busy: false,
    };
    if (!isProjectDir(entry.path)) {
        return base;
    }

    const summary: ProjectSummary = { ...base, present: true };

    for (const session of sessionIds(entry.path)) {
        summary.sessions++;
        const dir = join(entry.path, 'sessions', session);
        if (isBusy(dir)) {
            summary.busy = true;
        }
        const ids = runIds(dir);
        summary.runs += ids.length;
        const newest = ids.at(-1);
        if (newest && (!summary.lastRunAt || newest > summary.lastRunAt)) {
            summary.lastRunAt = newest;
        }
    }
    return summary;
}

// ---------------------------------------------------------------------------
// Sessions and runs
//
// Kept here rather than in session.ts because listing them is a read-only
// question about a directory, and `zen list` must be able to ask it without
// pulling in the runtime.
// ---------------------------------------------------------------------------

export const sessionsDir = (projectDir: string): string => join(projectDir, 'sessions');

/** Session ids, oldest first. Only well-formed stamps count as sessions. */
export function sessionIds(projectDir: string): string[] {
    return stampedChildren(sessionsDir(projectDir));
}

export function runIds(sessionDir: string): string[] {
    return stampedChildren(join(sessionDir, 'runs'));
}

function stampedChildren(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isStamp(e.name))
        .map((e) => e.name)
        .sort();
}

/** True when a session's lock names a process that is still alive. */
export function isBusy(sessionDir: string): boolean {
    const path = join(sessionDir, '.lock');
    try {
        const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
        return typeof pid === 'number' && alive(pid);
    } catch {
        // Absent, unreadable or malformed: nothing is holding it.
        return false;
    }
}

/**
 * `kill(pid, 0)` sends no signal and only asks whether the process exists.
 * EPERM means it exists and belongs to someone else, which still counts.
 */
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function projectName(dir: string): string {
    return basename(resolve(dir));
}
