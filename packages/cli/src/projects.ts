import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { paths, readJson, writeJson } from './home.ts';
import { isStamp } from './ids.ts';
import { invalidError, usageError } from './term.ts';

// ---------------------------------------------------------------------------
// Projects
//
// The directory is the truth. `~/.zenera/neo/projects.json` is an index so that
// `zen list` and `zen go` do not have to search the filesystem, and it is allowed
// to be wrong: every entry can be rebuilt by pointing `zen` at the directory
// again, and an entry whose path has vanished is reported, not fatal.
// ---------------------------------------------------------------------------

export const META = 'zenera.json';

export interface ProjectMeta {
    version: 1;
    name: string;
    /** directory name of the version a bare `zen run` uses */
    activeVersion: string;
}

/** A project resolved on disk. */
export interface Project {
    dir: string;
    meta: ProjectMeta;
}

const VERSION = /^v(\d+)$/;

export function versionNumber(name: string): number | undefined {
    const m = VERSION.exec(name);
    return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// The project directory
// ---------------------------------------------------------------------------

export async function readMeta(dir: string): Promise<ProjectMeta | undefined> {
    const path = join(dir, META);
    if (!existsSync(path)) {
        return undefined;
    }
    const meta = await readJson<Partial<ProjectMeta>>(path, {});
    if (!meta.name || !meta.activeVersion) {
        throw invalidError(`${path} is missing "name" or "activeVersion"`);
    }
    return { version: 1, name: meta.name, activeVersion: meta.activeVersion };
}

export function writeMeta(dir: string, meta: ProjectMeta): void {
    writeJson(join(dir, META), meta, 0o644);
}

/** Version directories, oldest first. Anything not `v<n>` is not one. */
export function versions(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && VERSION.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => (versionNumber(a) ?? 0) - (versionNumber(b) ?? 0));
}

export function nextVersion(dir: string): string {
    const highest = versions(dir).reduce((max, v) => Math.max(max, versionNumber(v) ?? 0), 0);
    return `v${highest + 1}`;
}

/**
 * Resolves a version name to a directory, rejecting anything that is not one.
 * The value reaches here from `--version-dir` and becomes a path segment.
 */
export function versionDir(project: Project, name?: string): string {
    const chosen = name ?? project.meta.activeVersion;
    if (!VERSION.test(chosen)) {
        throw usageError(`"${chosen}" is not a version`, 'versions are named v1, v2, …');
    }
    const dir = join(project.dir, chosen);
    if (!existsSync(dir)) {
        const known = versions(project.dir);
        throw invalidError(
            `${project.meta.name} has no ${chosen}`,
            known.length ? `it has ${known.join(', ')}` : 'run: zen init',
        );
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Finding one
// ---------------------------------------------------------------------------

/** Walks up from `start` looking for `zenera.json`. */
export async function findUp(start: string): Promise<Project | undefined> {
    let dir = resolve(start);
    for (;;) {
        const meta = await readMeta(dir);
        if (meta) {
            return { dir, meta };
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
    const meta = await readMeta(at);
    if (!meta) {
        throw invalidError(`${at} is not a project`, `no ${META} — run: zen init`);
    }
    return { dir: at, meta };
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
        const meta = await readMeta(dir);
        return meta ? { dir, meta } : undefined;
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
        const gone = this.#file.projects.filter((p) => !existsSync(join(p.path, META)));
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
    activeVersion?: string;
    versions: number;
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
        versions: 0,
        sessions: 0,
        runs: 0,
        busy: false,
    };
    let meta: ProjectMeta | undefined;
    try {
        meta = await readMeta(entry.path);
    } catch {
        return base;
    }
    if (!meta) {
        return base;
    }

    const all = versions(entry.path);
    const summary: ProjectSummary = {
        ...base,
        present: true,
        activeVersion: meta.activeVersion,
        versions: all.length,
    };

    for (const v of all) {
        for (const session of sessionIds(join(entry.path, v))) {
            summary.sessions++;
            const dir = join(entry.path, v, 'sessions', session);
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

export const sessionsDir = (versionDir: string): string => join(versionDir, 'sessions');

/** Session ids, oldest first. Only well-formed stamps count as sessions. */
export function sessionIds(versionDir: string): string[] {
    return stampedChildren(sessionsDir(versionDir));
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
