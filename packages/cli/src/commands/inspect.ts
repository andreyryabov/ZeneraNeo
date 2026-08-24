import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import {
    assertState,
    buildRunReport,
    FilePayloadStore,
    PayloadResolver,
    renderReportHtml,
    type AgentState,
} from 'zenera-neo';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { versionDir } from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    display,
    newestRun,
    newestSession,
    requireSession,
    runPaths,
    sessionPaths,
    type RunPaths,
    type SessionPaths,
} from '../session.ts';
import { bold, cyan, dim, invalidError, json, note, write } from '../term.ts';

const USAGE = 'zn inspect [run] [--session <id>] [--open] [--rebuild] [--serve [port]]';

interface Flags {
    project?: string;
    'version-dir'?: string;
    session?: string;
    open?: boolean;
    rebuild?: boolean;
    serve?: string;
}

export const inspect: Command = {
    summary: "Open or rebuild a run's report.html.",
    usage: USAGE,
    details: [
        'With no arguments: the newest run of the newest session.',
        '--serve starts a local server, which the report needs for its assets.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                'version-dir': { type: 'string' },
                session: { type: 'string' },
                open: { type: 'boolean' },
                rebuild: { type: 'boolean' },
                serve: { type: 'string' },
            },
            USAGE,
        );

        const found = await resolveProject({ cwd: ctx.cwd, project: values.project });
        const dir = versionDir(found, values['version-dir']);
        const session = pickSession(dir, values.session);
        const run = pickRun(session, positionals[0]);

        if (values.rebuild || !existsSync(run.report)) {
            await rebuild(session, run);
        }

        if (ctx.json) {
            json({ session: session.id, run: run.id, report: run.report });
            return;
        }

        if (values.serve !== undefined) {
            await serve(run, Number(values.serve) || 0, Boolean(values.open));
            return;
        }

        write(run.report);
        note(`${bold(run.id)} ${dim(display(run.report, ctx.cwd))}`);
        if (values.open) {
            reveal(`file://${run.report}`);
        } else {
            note(dim(`open it: ${cyan('zn inspect --open')}`));
        }
    },
};

// ---------------------------------------------------------------------------
// Choosing what to show
// ---------------------------------------------------------------------------

function pickSession(dir: string, asked?: string): SessionPaths {
    if (asked) {
        return requireSession(dir, asked);
    }
    const newest = newestSession(dir);
    if (!newest) {
        throw invalidError('nothing has been run here yet', 'start one: zn run');
    }
    return sessionPaths(dir, newest);
}

function pickRun(session: SessionPaths, asked?: string): RunPaths {
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
async function rebuild(session: SessionPaths, run: RunPaths): Promise<void> {
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
    const report = await buildRunReport(state, payloads, { title: run.id });
    await writeFile(run.report, renderReportHtml(report), 'utf8');
}

// ---------------------------------------------------------------------------
// Serving
//
// `file://` is enough for the report itself, but not for anything it fetches:
// browsers treat every local file as its own origin. A server exists only so
// those requests resolve, and so it binds to the loopback address — a run
// report is a transcript of everything the model was sent.
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

async function serve(run: RunPaths, port: number, open: boolean): Promise<void> {
    const root = resolve(run.dir);

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const rel = decodeURIComponent(url.pathname);
        const path = rel === '/' ? run.report : resolve(root, `.${normalize(rel)}`);

        // Containment, not obscurity: anything resolving outside the run
        // directory is refused, so a crafted path cannot walk to $HOME.
        if (path !== root && !path.startsWith(root + sep)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        if (!existsSync(path)) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
        createReadStream(path).pipe(res);
    });

    await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
    const address = server.address();
    const at = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/` : '';

    write(at);
    note(`${bold('serving')} ${dim(display(run.dir))}`);
    note(dim('ctrl-c to stop'));
    if (open) {
        reveal(at);
    }

    await new Promise<void>((done) => {
        const stop = (): void => {
            server.close(() => done());
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
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
