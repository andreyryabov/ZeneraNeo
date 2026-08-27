import { parse } from '../args.ts';
import type { Command } from '../command.ts';
// Run ids are timestamps by construction, so the newest id *is* the last-run
// time — no file has to be opened to learn it.
import { stampInstant } from '../ids.ts';
import { openDir, Registry, summarize, type ProjectSummary } from '../projects.ts';
import { listSessions } from '../session.ts';
import { ago, bold, count, dim, json, note, table, write, writeAll, yellow } from '../term.ts';

const USAGE = 'zen list [--sessions] [--prune]';

interface Flags {
    sessions?: boolean;
    prune?: boolean;
}

export const list: Command = {
    summary: 'Every known project: sessions, last run, whether one is live.',
    usage: USAGE,
    details: [
        'The registry is an index, not the truth. An entry whose directory has',
        'gone away is shown dimmed rather than hidden; --prune forgets them.',
    ],
    run: async (ctx) => {
        const { values } = parse<Flags>(
            ctx.args,
            { sessions: { type: 'boolean' }, prune: { type: 'boolean' } },
            USAGE,
        );

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

        if (ctx.json) {
            json(values.sessions ? await withSessions(summaries) : summaries);
            return;
        }

        if (summaries.length === 0) {
            note('no projects yet');
            note(dim('create one: zen init'));
            return;
        }

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

        if (values.sessions) {
            for (const s of summaries.filter((p) => p.present)) {
                write('');
                write(bold(s.name));
                writeAll(await sessionRows(s));
            }
        }
    },
};

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
