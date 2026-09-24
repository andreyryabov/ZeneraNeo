import {
    assertState,
    buildRunReport,
    FilePayloadStore,
    memoryDir,
    MemoryStore,
    PayloadResolver,
    readProjectConfig,
    renderReportHtml,
    type AgentState,
} from '@zenera/neo';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { sessionIds } from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    display,
    listRuns,
    listSessions,
    newestRun,
    requireSession,
    runPaths,
    sessionPaths,
    type RunPaths,
    type SessionPaths,
} from '../session.ts';

import {
    ago,
    bold,
    choose,
    cyan,
    dim,
    invalidError,
    isInteractive,
    json,
    note,
    write,
} from '../term.ts';

const USAGE = 'zen inspect [run] [--session <id>] [--open] [--rebuild]';

interface Flags {
    project?: string;
    session?: string;
    memory?: string;
    open?: boolean;
    rebuild?: boolean;
}

export const inspect: Command = {
    summary: "Open or rebuild a run's report.html.",
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Inspect', subtitle: 'Run Trajectory', hue: 'indigo' },
    details: [
        'With no arguments: asks which session and run, or takes the newest of',
        'each when there is nothing to ask on.',
        '--memory <dir> reads that memory instead of the project’s, for a run',
        'that was given `zen run --memory`.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                session: { type: 'string' },
                memory: { type: 'string' },
                open: { type: 'boolean' },
                rebuild: { type: 'boolean' },
            },
            USAGE,
        );

        const found = await resolveProject({ cwd: ctx.cwd, project: values.project });
        const dir = found.dir;
        // Asking is only possible at a terminal, and only honest when the
        // answer is not being parsed by something.
        const asking = isInteractive() && !ctx.json;
        const session = await pickSession(dir, values.session, positionals[0], asking);
        const run = await pickRun(session, positionals[0], asking);

        if (values.rebuild || !existsSync(run.report)) {
            await rebuild(session, run, await memory(dir, values.memory, ctx.cwd));
        }

        if (ctx.json) {
            json({ session: session.id, run: run.id, report: run.report });
            return;
        }

        write(run.report);
        note(`${bold(run.id)} ${dim(display(run.report, ctx.cwd))}`);
        if (values.open) {
            reveal(`file://${run.report}`);
        } else {
            note(dim(`open it: ${cyan('zen inspect --open')}`));
        }
    },
};

// ---------------------------------------------------------------------------
// Choosing what to show
// ---------------------------------------------------------------------------

/**
 * Which session to read. With nothing named and a terminal to ask on, the
 * person picks: "the newest" is a guess about which of a dozen runs they meant,
 * and a wrong guess looks the same as a broken command.
 */
async function pickSession(
    dir: string,
    asked: string | undefined,
    run: string | undefined,
    asking: boolean,
): Promise<SessionPaths> {
    if (asked) {
        return requireSession(dir, asked);
    }
    if (sessionIds(dir).length === 0) {
        throw invalidError('nothing has been run here yet', 'start one: zen run');
    }
    // A named run answers the question itself: it is in whichever session holds it.
    if (!asking || run) {
        return newestWorked(dir, run);
    }
    const worked = (await listSessions(dir)).filter((s) => s.runs > 0);
    if (worked.length === 0) {
        throw invalidError('no runs yet — every session is empty', 'start one: zen run');
    }
    return await choose(
        'Which session?',
        worked.map((s) => ({
            label: s.id,
            detail: [
                s.title,
                `${s.runs} run${s.runs === 1 ? '' : 's'}`,
                ago(s.lastRunAt ?? s.createdAt),
                s.busy ? 'running' : '',
            ]
                .filter(Boolean)
                .join('  '),
            value: sessionPaths(dir, s.id),
        })),
    );
}

/**
 * The newest session that has a report to show — not simply the newest. A
 * session exists before its first run and outlives one that never recorded
 * anything, so the newest is routinely empty and picking it blindly answers
 * "has no runs" about a project full of them.
 */
function newestWorked(dir: string, run?: string): SessionPaths {
    for (const id of sessionIds(dir).reverse()) {
        const session = sessionPaths(dir, id);
        if (run ? existsSync(runPaths(session, run).dir) : newestRun(session)) {
            return session;
        }
    }
    throw invalidError(
        run ? `no run ${run} in any session` : 'no runs yet — every session is empty',
        run ? 'see: zen list --sessions' : 'start one: zen run',
    );
}

async function pickRun(
    session: SessionPaths,
    asked: string | undefined,
    asking: boolean,
): Promise<RunPaths> {
    if (!asked && asking) {
        const runs = await listRuns(session);
        if (runs.length === 0) {
            throw invalidError(`session ${session.id} has no runs`);
        }
        // One run is not a question.
        return await choose(
            `Which run of ${session.id}?`,
            runs.map((r) => ({
                label: r.id,
                detail: [
                    r.agent,
                    r.error ? 'failed' : r.stopReason,
                    ago(r.finishedAt ?? r.startedAt),
                ]
                    .filter(Boolean)
                    .join('  '),
                value: runPaths(session, r.id),
            })),
        );
    }
    const id = asked ?? newestRun(session);
    if (!id) {
        throw invalidError(`session ${session.id} has no runs`);
    }
    const run = runPaths(session, id);
    if (!existsSync(run.dir)) {
        throw invalidError(`no run ${id} in session ${session.id}`);
    }
    return run;
}

/**
 * A report is derived, so it can always be thrown away and remade from the run
 * state — which is what makes `--rebuild` safe and what makes an old run
 * readable by a newer renderer.
 */
async function rebuild(session: SessionPaths, run: RunPaths, store?: MemoryStore): Promise<void> {
    if (!existsSync(run.state)) {
        throw invalidError(`run ${run.id} has no state to rebuild from`);
    }
    let state: AgentState;
    try {
        state = assertState(JSON.parse(await readFile(run.state, 'utf8')));
    } catch (err) {
        throw invalidError(`${run.state}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const payloads = new PayloadResolver(new FilePayloadStore({ dir: session.blobs, id: 'file' }));
    const report = await buildRunReport(state, payloads, { title: run.id, memory: store });
    await writeFile(run.report, renderReportHtml(report), 'utf8');
}

/**
 * The project's memory, unlocked, when it has one. Without it the memory view
 * has the shape of what the run recalled but not a word of it; a run that
 * never touched memory pays nothing, because the report asks for no node.
 */
async function memory(
    dir: string,
    override: string | undefined,
    cwd: string,
): Promise<MemoryStore | undefined> {
    const { config } = readProjectConfig(dir);
    const at = memoryDir(dir, config, override && resolve(cwd, override));
    if (!at || !existsSync(join(at, 'manifest.json'))) {
        return undefined;
    }
    try {
        return await MemoryStore.open(at, { lock: false });
    } catch {
        return undefined;
    }
}

/**
 * Handing a URL to the platform opener. `spawn` without a shell, so the path
 * is an argument rather than something a shell gets to interpret.
 */
function reveal(target: string): void {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    spawn(command, [target], { stdio: 'ignore', detached: true }).unref();
}
