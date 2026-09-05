import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { KeyStore } from '../keys.ts';
import { duration } from '../narrate.ts';
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
    progress,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';
import {
    validateProject,
    type AgentReport,
    type Finding,
    type ModelReport,
    type Report,
    type Severity,
} from '../validate.ts';

const USAGE =
    'zen check [name|dir] [--project <name|dir>] [--no-sandbox] [--no-models] [--strict] [--quiet]';

interface Flags {
    project?: string;
    'no-sandbox'?: boolean;
    'no-models'?: boolean;
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
// Almost nothing is contacted or paid for. The two exceptions earn their keep.
// The sandbox: the project's image is built and one command is executed in it,
// because a Dockerfile that does not build is a broken project and nothing
// short of building it says so. It happens against a temporary directory, the
// container is removed on the way out, and `--no-sandbox` skips it. And the
// models: each one that has a credential is asked to answer once, because a key
// that authenticates says nothing about the id it is spent on, and a misspelt or
// retired model is invisible to every reading of the files. That costs a few
// tokens and `--no-models` skips it — so the report is still worth having on the
// machine that has no container engine and no key at all.
// ---------------------------------------------------------------------------

export const check: Command = {
    summary: 'Validate agents.yaml and every file it names, and ask its models.',
    usage: USAGE,
    details: [
        'Checks the whole project: the configuration parses and satisfies the',
        'schema, every prompt, skill and catalog it names is on disk, hand-offs',
        'and forks name agents that exist, every hand-off has a way back, tool',
        'selectors resolve, skills bind to a catalog that holds them, and the',
        'models it declares have a credential on this machine.',
        '',
        'It also builds the sandbox image and runs one command in it, against a',
        'temporary directory rather than your workspace, and --no-sandbox skips',
        'it. No container engine is a warning, not an error.',
        '',
        'It also asks every model it holds a credential for to answer once — a few',
        'tokens apiece, and the only way to learn that a model id is misspelt,',
        'retired, or not granted to this account. A refusal is an error; a model',
        'that never answered is a warning. --no-models skips it.',
        '',
        'Unlike a run, it does not stop at the first problem — the report lists',
        'everything it found, each with a code and the fix for it.',
        '',
        'The argument is a directory if one is there and a registered project',
        'name otherwise; with neither, the project you are standing in.',
        '',
        'Exit codes: 0 nothing wrong, 3 at least one error (or, with --strict,',
        'at least one warning). --quiet prints the findings and nothing else.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                'no-sandbox': { type: 'boolean' },
                'no-models': { type: 'boolean' },
                strict: { type: 'boolean' },
                quiet: { type: 'boolean' },
            },
            USAGE,
        );

        const here = one(positionals, 'project or directory', USAGE);
        const dir = here
            ? await locate(ctx.cwd, here)
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

        const bar = progress();
        const report = await validateProject({
            dir,
            name,
            registered: entry !== undefined,
            keys,
            sandbox: {
                enabled: !values['no-sandbox'],
                onProgress: (what) => bar.update(dim(what)),
            },
            models: {
                enabled: !values['no-models'],
                onProgress: (what) => bar.update(dim(what)),
            },
        });
        bar.done();

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

/**
 * What a bare argument means: a directory when one is there, a registered name
 * otherwise. A directory is tried first, and it does not have to be a project
 * yet — an unregistered folder, a checkout, a scaffold in progress is exactly
 * what there is to check.
 *
 * A word that is neither is a usage error and stops here. The check itself
 * would answer it too, but it would answer at the length of a full report, and
 * a page of empty sections about a directory that does not exist buries the one
 * line that matters: there is nothing by that name.
 */
async function locate(cwd: string, arg: string): Promise<string> {
    const at = resolve(cwd, arg);
    if (existsSync(at) && statSync(at).isDirectory()) {
        return at;
    }
    const entry = (await Registry.open()).find(arg);
    if (!entry) {
        throw usageError(
            `no project or directory named "${arg}"`,
            'see what is registered: zen list',
        );
    }
    const path = resolve(entry.path);
    if (!existsSync(path)) {
        throw usageError(
            `project "${entry.name}" is registered at ${path}, which is gone`,
            'forget it: zen list --prune',
        );
    }
    return path;
}

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
        // A folder skill's own files travel with it: they are mounted at
        // /skills/<folder> and the body may point the model straight at them,
        // so say what is there and under which name.
        const rows = table(
            report.skills.entries.map((s) => [
                `  ${s.name}`,
                dim(s.path),
                dim(s.tools?.length ? `unlocks ${s.tools.join(' ')}` : ''),
                dim(s.usedBy.length ? `used by ${s.usedBy.join(', ')}` : 'unused'),
            ]),
        );
        report.skills.entries.forEach((s, i) => {
            push(rows[i] ?? '');
            if (s.files?.length) {
                const at = basename(dirname(s.path));
                push(dim(`    /skills/${at}/  ${s.files.join('  ')}`));
            }
        });
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
                    answer(m),
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
                ...(report.sandbox.dockerfile
                    ? [['  built from', report.sandbox.dockerfile] as [string, string]]
                    : []),
                [
                    '  reached by',
                    report.sandbox.used
                        ? 'at least one agent has the shell tools'
                        : dim('nothing — the block is declared but no agent can run a command'),
                ],
                [
                    '  tried',
                    report.sandbox.probed
                        ? green('built, started, and a command ran in it')
                        : dim('no — nothing was built or started'),
                ],
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

/** What the provider said when the model itself was asked, if it was. */
function answer(m: ModelReport): string {
    if (!m.check) {
        return dim('not asked');
    }
    if (m.check.state === 'live') {
        return `${green('answers')} ${dim(duration(m.check.ms))}`;
    }
    if (m.check.state === 'blocked') {
        return yellow('blocked');
    }
    return m.check.state === 'dead' ? red('refused') : yellow('no answer');
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
