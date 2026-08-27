import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { stamp } from './ids.ts';
import * as Projects from './projects.ts';
import {
    createSession,
    listSessions,
    newestSession,
    requireSession,
    sessionPaths,
    type SessionPaths,
} from './session.ts';
import { ago, choose, confirm, dim, isInteractive, usageError, warn, yellow } from './term.ts';

// ---------------------------------------------------------------------------
// Resolution
//
// Three questions — which project, which session, which workspace — each
// answered from a flag, then from context, then by asking. Off a terminal the
// asking step is an error instead, so a script fails with a message naming the
// flag it wants rather than hanging on a prompt nobody will answer.
// ---------------------------------------------------------------------------

export interface Wanted {
    project?: string;
    session?: string;
    fresh?: boolean;
    workspace?: string;
    yes?: boolean;
    cwd: string;
}

export interface Target {
    project: Projects.Project;
    session: SessionPaths;
    /** true when this call created the session */
    created: boolean;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export async function project(want: Wanted): Promise<Projects.Project> {
    if (want.project) {
        return Projects.open(want.project);
    }
    const here = await Projects.current(want.cwd);
    if (here) {
        return here;
    }
    const registry = await Projects.Registry.open();
    const known = registry.entries.filter((e) => existsSync(e.path));
    if (known.length === 0) {
        throw usageError('not inside a project, and none are registered', 'create one: zen init');
    }
    if (!isInteractive()) {
        throw usageError('not inside a project', 'name one with --project');
    }
    const chosen = await choose(
        'Which project?',
        known.map((e) => ({ label: e.name, detail: e.path, value: e })),
    );
    return Projects.openDir(chosen.path);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function target(want: Wanted): Promise<Target> {
    const found = await project(want);
    const dir = found.dir;

    if (want.session && want.fresh) {
        throw usageError('--session and --new contradict each other');
    }
    if (want.session) {
        return {
            project: found,
            session: requireSession(dir, want.session),
            created: false,
        };
    }
    if (!want.fresh) {
        const existing = await pickExisting(dir);
        if (existing) {
            return { project: found, session: existing, created: false };
        }
    }
    return { project: found, session: await create(dir, want), created: true };
}

/**
 * Resuming is the default: the common case is continuing what you were doing.
 * With one session it is taken without asking; with several, the others are
 * offered, because "the most recent" is only usually what you meant.
 */
async function pickExisting(projectDir: string): Promise<SessionPaths | undefined> {
    const sessions = await listSessions(projectDir);
    if (sessions.length === 0) {
        return undefined;
    }
    if (!isInteractive()) {
        const newest = newestSession(projectDir);
        return newest ? sessionPaths(projectDir, newest) : undefined;
    }
    const choice = await choose<string | undefined>('Session', [
        ...sessions.map((s) => ({
            label: s.title ?? s.id,
            detail:
                `${s.id}  ${ago(s.lastRunAt ?? s.createdAt)}  ` +
                `${s.runs} run${s.runs === 1 ? '' : 's'}${s.busy ? yellow('  running') : ''}`,
            value: s.id as string | undefined,
        })),
        { label: dim('New session…'), value: undefined },
    ]);
    return choice ? sessionPaths(projectDir, choice) : undefined;
}

/**
 * The id is minted before anything is written, so the workspace question can be
 * asked against the real paths — and so a cancelled answer leaves no directory
 * behind.
 */
async function create(projectDir: string, want: Wanted): Promise<SessionPaths> {
    const id = stamp();
    const planned = sessionPaths(projectDir, id);
    const workspace = await chooseWorkspace(planned, want);
    return createSession(projectDir, id, workspace);
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * The workspace is what the agent can read and write, so pointing it outside
 * the session is the useful case and the dangerous one. It is confirmed once,
 * explicitly, naming the path — and a script has to say `--yes` to skip that.
 * An agent with file tools rooted at `$HOME` should take more than one
 * keystroke to arrange.
 */
export async function chooseWorkspace(session: SessionPaths, want: Wanted): Promise<string> {
    const own = resolve(session.workspace);
    if (want.workspace) {
        const at = resolve(want.cwd, want.workspace);
        await approve(at, session, want);
        return at;
    }
    if (!isInteractive()) {
        return own;
    }
    const chosen = await choose('Workspace — what the agent can read and write', [
        { label: 'A fresh, empty directory', detail: own, value: own },
        { label: 'The directory you started in', detail: want.cwd, value: want.cwd },
    ]);
    await approve(chosen, session, want);
    return chosen;
}

async function approve(at: string, session: SessionPaths, want: Wanted): Promise<void> {
    if (contains(session.dir, at)) {
        return;
    }
    warn(`the agent will be able to read and write ${at}`);
    if (want.yes) {
        return;
    }
    if (!isInteractive()) {
        throw usageError(
            'refusing a workspace outside the session without confirmation',
            'pass --yes if that is what you meant',
        );
    }
    if (!(await confirm('Continue?'))) {
        throw usageError('cancelled');
    }
}

function contains(parent: string, child: string): boolean {
    const from = resolve(parent);
    const to = resolve(child);
    return from === to || !relative(from, to).startsWith(`..${sep}`);
}
