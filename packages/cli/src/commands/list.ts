import { join } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
// Run ids are timestamps by construction, so the newest id *is* the last-run
// time — no file has to be opened to learn it.
import { stampInstant } from '../ids.ts';
import {
    openDir,
    Registry,
    runIds,
    sessionIds,
    sessionsDir,
    summarize,
    type ProjectSummary,
} from '../projects.ts';
import { listSessions, readRunMeta, runPaths, sessionPaths, type RunSummary } from '../session.ts';
import {
    ago,
    bold,
    count,
    cyan,
    dim,
    json,
    note,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen list [--sessions] [--runs] [--limit <n>] [--prune]';

/** Recent runs shown before `--limit` is asked for. */
const RECENT = 20;

interface Flags {
    sessions?: boolean;
    runs?: boolean;
    limit?: string;
    prune?: boolean;
}

export const list: Command = {
    summary: 'Every known project: sessions, last run, whether one is live.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Projects', subtitle: 'Project Registry', hue: 'sky' },
    details: [
        "  --sessions             Also list each project's sessions.",
        '  --runs                 The most recent runs, newest first, across every project.',
        '  --limit <n>            Runs to list. Default 20.',
        '  --prune                Forget entries whose directory has gone away.',
        '',
        '--runs answers "what ran last", which is not a question about one',
        'project, so on its own it replaces the table rather than following it.',
        '',
        'The registry is an index, not the truth. An entry whose directory has',
        'gone away is shown dimmed rather than hidden; --prune forgets them.',
    ],
    run: async (ctx) => {
        const { values } = parse<Flags>(
            ctx.args,
            {
                sessions: { type: 'boolean' },
                runs: { type: 'boolean' },
                limit: { type: 'string' },
                prune: { type: 'boolean' },
            },
            USAGE,
        );
        const limit = number(values.limit, '--limit') ?? RECENT;

        const registry = await Registry.open();
        if (values.prune) {
            const gone = registry.prune();
            registry.save();
            if (!ctx.json) {
                note(gone.length ? `forgot ${count(gone.length, 'project')}` : 'nothing to prune');
            }
        }

        const summaries: ProjectSummary[] = [];
        for (const entry of registry.entries) {
            summaries.push(await summarize(entry));
        }
        summaries.sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));

        // `--runs` asks a question about runs, so on its own it *replaces* the
        // project table rather than following thirty rows of it. Asked together
        // with `--sessions`, both are wanted and both are printed.
        const projectTable = !values.runs || values.sessions;

        if (ctx.json) {
            const runs = values.runs ? await recent(summaries, limit).runs : undefined;
            if (!projectTable) {
                json(runs);
                return;
            }
            const projects = values.sessions ? await withSessions(summaries) : summaries;
            json(runs ? { projects, runs } : projects);
            return;
        }

        if (summaries.length === 0) {
            note('no projects yet');
            note(dim('create one: zen init'));
            return;
        }

        if (projectTable) {
            const rows: string[][] = [
                [bold('NAME'), bold('SESSIONS'), bold('RUNS'), bold('LAST'), bold('PATH')],
            ];
            for (const s of summaries) {
                const style = s.present ? (x: string) => x : dim;
                rows.push([
                    style(s.name) + (s.busy ? yellow(' •') : ''),
                    style(String(s.sessions)),
                    style(String(s.runs)),
                    style(ago(s.lastRunAt ? stampInstant(s.lastRunAt) : undefined)),
                    dim(s.present ? s.path : `${s.path} (missing)`),
                ]);
            }
            writeAll(table(rows));
        }

        if (values.sessions) {
            for (const s of summaries.filter((p) => p.present)) {
                write('');
                write(bold(s.name));
                writeAll(await sessionRows(s));
            }
        }

        if (values.runs) {
            if (projectTable) {
                write('');
            }
            await writeRuns(summaries, limit);
        }
    },
};

// ---------------------------------------------------------------------------
// Recent runs
//
// The question is "what ran last", which is not a question about one project,
// so the runs of every project are merged into one list. Run ids are stamps,
// so newest-first is a sort of directory names and only the few runs that will
// actually be shown have their `meta.json` opened.
// ---------------------------------------------------------------------------

interface RecentRun extends RunSummary {
    project: string;
    session: string;
    dir: string;
}

function keys(
    summaries: readonly ProjectSummary[],
): { project: ProjectSummary; session: string; id: string }[] {
    const out: { project: ProjectSummary; session: string; id: string }[] = [];
    for (const project of summaries) {
        if (!project.present) {
            continue;
        }
        for (const session of sessionIds(project.path)) {
            for (const id of runIds(join(sessionsDir(project.path), session))) {
                out.push({ project, session, id });
            }
        }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
}

function recent(
    summaries: readonly ProjectSummary[],
    limit: number,
): { runs: Promise<RecentRun[]>; found: number } {
    const all = keys(summaries);
    const runs = Promise.all(
        all.slice(0, limit).map(async (k) => {
            const run = runPaths(sessionPaths(k.project.path, k.session), k.id);
            const meta = await readRunMeta(run);
            return {
                id: k.id,
                project: k.project.name,
                session: k.session,
                dir: run.dir,
                startedAt: meta.startedAt ?? stampInstant(k.id),
                finishedAt: meta.finishedAt,
                agent: meta.agent,
                stopReason: meta.stopReason,
                error: meta.error,
            } satisfies RecentRun;
        }),
    );
    return { runs, found: all.length };
}

async function writeRuns(summaries: readonly ProjectSummary[], limit: number): Promise<void> {
    const { runs, found } = recent(summaries, limit);
    const rows = await runs;
    if (rows.length === 0) {
        note('no runs yet');
        note(dim('start one: zen run'));
        return;
    }
    writeAll(
        table([
            [
                bold('RUN'),
                bold('PROJECT'),
                bold('SESSION'),
                bold('AGENT'),
                bold('OUTCOME'),
                bold('WHEN'),
            ],
            ...rows.map((r) => [
                r.id,
                cyan(r.project),
                dim(r.session),
                r.agent ?? dim('—'),
                r.error ? red('failed') : (r.stopReason ?? dim('—')),
                ago(r.finishedAt ?? r.startedAt),
            ]),
        ]),
    );
    if (found > rows.length) {
        note('');
        note(dim(`${found - rows.length} more — raise --limit to see them`));
    }
}

function number(text: string | undefined, flag: string): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
        throw usageError(`${flag} takes a whole number of at least 1`, `got "${text}"`);
    }
    return value;
}

/**
 * Run ids are timestamps by construction, so the newest id *is* the last-run
 * time — no file has to be opened to learn it.
 */
function stampToIso(id: string): string | undefined {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
    if (!m) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s] = m;
    return new Date(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
    ).toISOString();
}

async function sessionRows(summary: ProjectSummary): Promise<string[]> {
    const project = await openDir(summary.path);
    const sessions = await listSessions(project.dir);
    if (sessions.length === 0) {
        return [dim('  no sessions')];
    }
    return table(
        sessions.map((s) => [
            `  ${s.id}`,
            s.title ?? dim('—'),
            String(s.runs),
            ago(s.lastRunAt ?? s.createdAt),
            s.busy ? yellow('running') : '',
        ]),
    );
}

async function withSessions(summaries: ProjectSummary[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of summaries) {
        if (!s.present) {
            out.push({ ...s, sessionList: [] });
            continue;
        }
        const project = await openDir(s.path);
        out.push({ ...s, sessionList: await listSessions(project.dir) });
    }
    return out;
}
