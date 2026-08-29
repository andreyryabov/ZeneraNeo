import { basename, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { KeyStore } from '../keys.ts';
import { Registry } from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    bold,
    count,
    cyan,
    dim,
    green,
    invalidError,
    json,
    red,
    table,
    write,
    writeAll,
    yellow,
} from '../term.ts';
import {
    validateProject,
    type AgentReport,
    type Finding,
    type Report,
    type Severity,
} from '../validate.ts';

const USAGE = 'zen check [dir] [--project <name|dir>] [--strict] [--quiet]';

interface Flags {
    project?: string;
    strict?: boolean;
    quiet?: boolean;
}

// ---------------------------------------------------------------------------
// zen check
//
// Written to be read by a program as much as by a person, because the program
// reading it is usually a model: an agent asked to fix a project needs to know
// what is wrong, where, and what would fix it, without opening six files to
// find out. So every section names its files by path, every finding carries a
// stable code and a fix, and the whole thing goes to stdout — it is the answer,
// not narration.
//
// Nothing here is contacted, started or paid for. That is the point: the check
// has to work on the machine that is not set up yet, which is the machine that
// most needs it.
// ---------------------------------------------------------------------------

export const check: Command = {
    summary: 'Validate agents.yaml and every file it names, and report in full.',
    usage: USAGE,
    details: [
        'Checks the whole project without running anything: the configuration',
        'parses and satisfies the schema, every prompt, skill and catalog it',
        'names is on disk, hand-offs and forks name agents that exist, tool',
        'selectors resolve, skills bind to a catalog that holds them, and the',
        'models it declares have a credential on this machine.',
        '',
        'Unlike a run, it does not stop at the first problem — the report lists',
        'everything it found, each with a code and the fix for it.',
        '',
        'Exit codes: 0 nothing wrong, 3 at least one error (or, with --strict,',
        'at least one warning). --quiet prints the findings and nothing else.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                strict: { type: 'boolean' },
                quiet: { type: 'boolean' },
            },
            USAGE,
        );

        // A bare directory is accepted so an unregistered folder — a checkout,
        // a scaffold in progress — can be checked at all. `--project` goes
        // through the registry, like everywhere else.
        const here = one(positionals, 'directory', USAGE);
        const dir = here
            ? resolve(ctx.cwd, here)
            : await resolveProject({ cwd: ctx.cwd, project: values.project }).then((p) => p.dir);

        // Being listed is the registry's answer, not the directory's, so it is
        // read here and handed to the check rather than looked up inside it.
        const entry = (await Registry.open()).findPath(dir);
        const name = entry?.name ?? basename(dir);

        // Materialised first, so the credential verdicts are the ones a run
        // would reach: a key in the environment and a key in the keyring are
        // the same key by the time the library asks.
        const keys = await KeyStore.open();
        keys.materialize();

        const report = await validateProject({
            dir,
            name,
            registered: entry !== undefined,
            keys,
        });

        if (ctx.json) {
            json(report);
        } else if (values.quiet) {
            writeAll(findingLines(report.findings));
            write(verdict(report, Boolean(values.strict)));
        } else {
            writeAll(render(report));
        }

        const failed =
            report.counts.errors > 0 || (Boolean(values.strict) && report.counts.warnings > 0);
        if (failed) {
            throw invalidError(
                `${name}: ${count(report.counts.errors, 'error')}` +
                    (values.strict ? `, ${count(report.counts.warnings, 'warning')}` : ''),
                'the report above says what to change',
            );
        }
    },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(report: Report): string[] {
    const out: string[] = [];
    const push = (...lines: string[]): void => {
        out.push(...lines);
    };

    push(`${bold('Project')} ${report.project.name ?? dim('(unregistered)')}`);
    push(
        ...table([
            ['  root', report.project.root],
            ['  config', report.project.config ?? red('none found')],
            [
                '  schema version',
                report.project.version === null ? dim('—') : String(report.project.version),
            ],
            ['  entry agent', report.project.entry ?? red('undecided')],
            ['  registered', report.project.registered ? green('yes') : yellow('not in zen list')],
        ]),
    );
    if (report.project.shadowed.length) {
        push(`  ${yellow('also present')} ${dim(report.project.shadowed.join(', '))}`);
    }

    // Files -----------------------------------------------------------------
    push('', `${bold('Files')} ${dim(`${report.files.length} checked`)}`);
    push(
        ...table(
            report.files.map((f) => [
                `  ${f.exists ? green('ok') : f.required ? red('MISSING') : yellow('absent')}`,
                f.path + (f.kind === 'directory' ? '/' : ''),
                dim(f.exists && f.bytes !== undefined ? size(f.bytes) : ''),
                dim(f.from ? `${f.role} — named by ${f.from}` : f.role),
            ]),
        ),
    );

    // Agents ----------------------------------------------------------------
    push(
        '',
        `${bold('Agents')} ${dim(
            `${report.agents.length} declared, entry is ${report.project.entry ?? '—'}`,
        )}`,
    );
    for (const agent of report.agents) {
        push(...agentBlock(agent));
    }

    // Skills ----------------------------------------------------------------
    push(
        '',
        `${bold('Skills')} ${dim(
            report.skills.dirs.length
                ? `${count(report.skills.entries.length, 'skill')} in ${report.skills.dirs.join(', ')}`
                : 'no catalog',
        )}`,
    );
    if (report.skills.entries.length) {
        push(
            ...table(
                report.skills.entries.map((s) => [
                    `  ${s.name}`,
                    dim(s.path),
                    dim(s.tools?.length ? `unlocks ${s.tools.join(' ')}` : ''),
                    dim(s.usedBy.length ? `used by ${s.usedBy.join(', ')}` : 'unused'),
                ]),
            ),
        );
    }

    // Models ----------------------------------------------------------------
    push('', bold('Models'));
    if (report.models.length) {
        push(
            ...table(
                report.models.map((m) => [
                    `  ${m.name}`,
                    dim(m.provider ? `${m.provider} (${m.kind})` : red('unresolved')),
                    dim(m.env ?? ''),
                    credential(m.credential),
                    // Nothing consumes an embedding yet, so `usedBy` would
                    // always read "declared, unused" and say the wrong thing.
                    dim(
                        m.role === 'embedding'
                            ? 'embedding'
                            : m.usedBy.length
                              ? `used by ${m.usedBy.join(', ')}`
                              : 'declared, unused',
                    ),
                ]),
            ),
        );
    } else {
        push(`  ${dim('none declared')}`);
    }
    if (report.providers.length) {
        push(`  ${dim(`providers: ${report.providers.join(', ')}`)}`);
    }

    // Sandbox ---------------------------------------------------------------
    if (report.sandbox.used || report.sandbox.declared) {
        push('', bold('Sandbox'));
        push(
            ...table([
                ['  image', report.sandbox.image ?? dim('the default image')],
                [
                    '  reached by',
                    report.sandbox.used
                        ? 'at least one agent has the shell tools'
                        : dim('nothing — the block is declared but no agent can run a command'),
                ],
                ['  requires', dim('podman on this machine: zen sandbox status')],
            ]),
        );
    }

    // Findings --------------------------------------------------------------
    push('', `${bold('Findings')} ${dim(tallyLine(report))}`);
    const lines = findingLines(report.findings);
    push(...(lines.length ? lines : [`  ${green('nothing to report')}`]));

    push('', verdict(report, false));
    return out;
}

function agentBlock(agent: AgentReport): string[] {
    const head = `  ${bold(agent.name)}${agent.entry ? ` ${green('(entry)')}` : ''}`;
    const rows: string[][] = [];
    if (agent.description) {
        rows.push(['    description', agent.description]);
    }
    rows.push([
        '    model',
        agent.model
            ? `${cyan(agent.model)} ${dim(`(${agent.modelSource === 'project' ? 'inherited from the project' : 'pinned here'})`)}`
            : yellow('none — needs `model:` or --model'),
    ]);
    rows.push([
        '    instructions',
        agent.instructions.length ? agent.instructions.join(' + ') : yellow('none'),
    ]);
    rows.push([
        '    tools',
        agent.toolSelectors.length
            ? `${agent.toolSelectors.join(' ')} ${dim(`→ ${agent.tools.length}: ${agent.tools.join(' ') || 'nothing'}`)}`
            : dim('none'),
    ]);
    if (agent.handoffs.length) {
        rows.push(['    handoffs', `→ ${agent.handoffs.join(', ')}`]);
    }
    if (agent.skills) {
        const bits = [`provider "${agent.skills.provider}"`, `discovery ${agent.skills.discovery}`];
        if (agent.skills.allow) {
            bits.push(`allow: ${agent.skills.allow.join(', ')}`);
        }
        if (agent.skills.preload) {
            bits.push(`preload: ${agent.skills.preload.join(', ')}`);
        }
        rows.push(['    skills', bits.join(', ')]);
    }
    if (agent.fork) {
        const bits = [
            agent.fork.agents ? `branches run ${agent.fork.agents.join(', ')}` : 'any agent',
        ];
        if (agent.fork.maxBranches) {
            bits.push(`at most ${agent.fork.maxBranches}`);
        }
        rows.push(['    fork', bits.join(', ')]);
    }
    if (agent.ownSandbox) {
        rows.push(['    sandbox', 'overrides the project container']);
    }
    return [head, ...table(rows)];
}

/**
 * One finding, three lines at most: what and where, then why, then the fix.
 * The code is printed because it is the part a script — or a model asked to
 * fix this — can match on without parsing prose.
 */
function findingLines(findings: readonly Finding[]): string[] {
    const out: string[] = [];
    for (const f of order(findings)) {
        out.push(`  ${label(f.severity)} ${bold(f.where)} ${dim(`[${f.code}]`)}`);
        out.push(`          ${f.message}`);
        if (f.fix) {
            out.push(`          ${dim(`fix: ${f.fix}`)}`);
        }
    }
    return out;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

function order(findings: readonly Finding[]): Finding[] {
    return [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

function label(severity: Severity): string {
    if (severity === 'error') {
        return red('error  ');
    }
    return severity === 'warning' ? yellow('warning') : dim('note   ');
}

function credential(state: string): string {
    if (state === 'present') {
        return green('present');
    }
    if (state === 'missing') {
        return red('missing');
    }
    return state === 'rejected' ? red('rejected') : dim('unchecked');
}

function tallyLine(report: Report): string {
    const { errors, warnings, notes } = report.counts;
    return `${count(errors, 'error')}, ${count(warnings, 'warning')}, ${count(notes, 'note')}`;
}

/** The one line a caller that reads nothing else should read. */
function verdict(report: Report, strict: boolean): string {
    if (report.counts.errors > 0) {
        return red(
            `${count(report.counts.errors, 'error')} — this project will not load. ` +
                'Fix them and run `zen check` again.',
        );
    }
    if (strict && report.counts.warnings > 0) {
        return yellow(
            `${count(report.counts.warnings, 'warning')} — the project loads, but --strict ` +
                'treats these as failures.',
        );
    }
    if (report.counts.warnings > 0) {
        return yellow(
            `The project loads. ${count(report.counts.warnings, 'warning')} worth reading above.`,
        );
    }
    return green('The project loads, and nothing about it looks wrong.');
}

function size(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
