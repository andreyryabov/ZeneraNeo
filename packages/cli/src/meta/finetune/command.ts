import { liveHolder } from '@zenera/neo';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editorFiles } from '../editor.ts';
import {
    bold,
    cyan,
    dim,
    green,
    invalidError,
    json,
    note,
    parse,
    red,
    usageError,
    write,
    yellow,
} from '../host.ts';
import { drift } from './dataset/drift.ts';
import { DatasetStore } from './dataset/store.ts';
import { runLoop } from './loop.ts';
import { attemptsOf } from './report.ts';
import { retry } from './retry.ts';
import { resultOf, selection } from './sampler.ts';
import {
    type Config,
    DEFAULTS,
    FAILURES_IN_A_ROW,
    FINETUNE_DIR,
    LEGACY_FINETUNE_DIR,
    spawnZen,
    Tuning,
    type Zen,
} from './tuning.ts';

// ---------------------------------------------------------------------------
// zen meta finetune
// ---------------------------------------------------------------------------

export const FINETUNE_USAGE = 'zen meta finetune <start|status|stop|retry|session> [options]';

export const FINETUNE_HELP = [
    'Tuning:',
    '  zen meta finetune start [options]         train every case: run, analyze, apply, run again',
    '  zen meta finetune [status]                where it stands; the detail is finetune/STATUS.md',
    '  zen meta finetune stop                    finish the steps in flight, then stop',
    '  zen meta finetune retry --difficult       give difficult cases another round, then start',
    "  zen meta finetune session <case>          resume that case's analyze session",
    '',
    '  start: -N <workers> (4), -M <apply at> (= workers), --tries <n> (4), --mem-tries <n> (3),',
    '  --merge-every <k> (3), --seed <n>, --class <c>, --id <glob>, --rubric yes|no, --limit <n>,',
    '  --more <n> (this start only), --force (past drift).',
    '  In a terminal start draws what runs now, the tokens and the log; --plain does not.',
    '  Settings are kept in finetune/loop.json; start again to resume where it stopped.',
];

export const FINETUNE_SUMMARY =
    "Tune the project's prose on its dataset, a case at a time, N cases at once.";

/** The page `zen meta finetune --help` prints. */
export const FINETUNE_DETAILS = [
    'Verbs:',
    '  start                  Train every case: run, analyze, apply, run again. Resumes.',
    '  status                 Where it stands (the default). The detail: finetune/STATUS.md',
    '  stop                   Let the steps in flight finish, then stop the running tuning.',
    '  retry [ids...]         Another round for difficult cases: --difficult takes them all,',
    '                         ids and globs add to it, --class narrows. Run them with start.',
    "  session <case>         Print the command that resumes that case's analyze session.",
    '',
    'Options for start:',
    '  -N, --workers <n>      Cases trained at once. Default 4.',
    '  -M, --apply-at <n>     Apply once this many requests wait. Default: the workers.',
    '  --tries <n>            Tries without memory before a case is difficult. Default 4.',
    '  --mem-tries <n>        Tries with memory. Default 3.',
    '  --merge-every <k>      Merge the kept memories after k more arrive. Default 3.',
    '  --seed <n>             Order of cases inside a class. Default 1.',
    '  --class <c>            Only this class. Repeatable.',
    '  --id <glob>            Only cases whose id matches. Repeatable.',
    '  --rubric yes|no        Only cases with, or without, a rubric.',
    '  --limit <n>            Only the first n cases of the order.',
    '  --more <n>             Begin at most n cases not begun before, then stop. Cases',
    '                         part-way or failed carry on regardless. Not kept.',
    '  --force                Start even though the dataset drifted from its sources.',
    '  --plain                No live view: print a line per start and stop, as in a pipe.',
    '  --project <name|dir>   Which project. Default: the one you are in.',
    '',
    'One case: without memory, run it and /analyze it until the analysis says done -',
    'parking it until the next apply after each try that is not - then the same with',
    'the memory the passing run wrote. Tries used up: the case is difficult.',
    '',
    'No run shares a memory: each try has its own private directory. A case whose',
    'with-memory run passes submits a copy of that memory; every k submissions are',
    'merged, with the last merge, into finetune/memories/merged/mNN - numbered,',
    'never rewritten, each listing the cases it holds.',
    '',
    'A parked case gives its worker back, so another case runs meanwhile; woken cases',
    'take a worker before new ones. Requests are applied in batches by /finetune-apply:',
    'when -M cases are parked, or once nothing is running and no case is left to start.',
    'No run starts during an apply. zen check must pass,',
    'or the edit is undone. Every apply is a new version of agents.yaml + agents/.',
    '',
    'A case is difficult when its tries run out and the analysis still says no; that is',
    'final for its revision until `retry` gives it another round on the prose of the day.',
    'A case fails instead when something outside the prose broke - the sandbox, a',
    'provider, a key: it keeps its tries and carries on from that step at the next start.',
    `After ${FAILURES_IN_A_ROW} failures in a row the tuning stops, and says what broke;`,
    'a container engine that fails stops it at once. A run its analysis finds void -',
    'the network or a service under it down - is set aside and runs again.',
    '',
    'Ctrl-C (or stop) finishes the steps in flight; Ctrl-C again kills them. Start',
    'again to carry on: every step is kept on disk, and nothing finished is repeated.',
    'Settings given to start are kept in finetune/loop.json.',
    '',
    'Examples:',
    '  zen meta finetune start -N 4',
    '  zen meta finetune start --class search --limit 6 -N 2 -M 2',
    '  zen meta finetune start --more 4',
    '  zen meta finetune',
    '  zen meta finetune retry --difficult --class merge',
    '  zen meta finetune session plan-day',
];

interface Flags {
    project?: string;
    workers?: string;
    'apply-at'?: string;
    tries?: string;
    'mem-tries'?: string;
    'merge-every'?: string;
    seed?: string;
    class?: string[];
    id?: string[];
    rubric?: string;
    limit?: string;
    more?: string;
    force?: boolean;
    plain?: boolean;
    difficult?: boolean;
    yes?: boolean;
}

const OPTIONS = {
    project: { type: 'string' },
    workers: { type: 'string', short: 'N' },
    'apply-at': { type: 'string', short: 'M' },
    tries: { type: 'string' },
    'mem-tries': { type: 'string' },
    'merge-every': { type: 'string' },
    seed: { type: 'string' },
    class: { type: 'string', multiple: true },
    id: { type: 'string', multiple: true },
    rubric: { type: 'string' },
    limit: { type: 'string' },
    more: { type: 'string' },
    force: { type: 'boolean' },
    plain: { type: 'boolean' },
    difficult: { type: 'boolean' },
    yes: { type: 'boolean' },
} as const;

export interface FinetuneContext {
    readonly args: readonly string[];
    readonly json: boolean;
    readonly cwd: string;
}

export function finetuneProjectFlag(args: readonly string[]): string | undefined {
    return parse<Flags>(args, OPTIONS, FINETUNE_USAGE).values.project;
}

export interface FinetuneOptions {
    /** stands in for the `zen` binary - tests */
    zen?: Zen;
    tickMs?: number;
}

export async function runFinetune(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    options: FinetuneOptions = {},
): Promise<void> {
    const { values, positionals } = parse<Flags>(ctx.args, OPTIONS, FINETUNE_USAGE);
    const [verb = 'status', ...rest] = positionals;
    moveLegacyDir(project.dir);
    switch (verb) {
        case 'start':
            return start(ctx, project, values, options);
        case 'status':
            return status(ctx, project);
        case 'stop':
            return stop(project);
        case 'retry':
            return retryCases(ctx, project, values, rest);
        case 'session':
            return session(project, rest);
        default:
            throw usageError(
                `unknown finetune verb: ${verb}`,
                'one of: start, status, stop, retry, session',
            );
    }
}

/**
 * A tuning used to live in `.finetune/`. Moves it to `finetune/` once, so a
 * project tuned before the rename resumes where it stopped. Refuses while a
 * loop of the old version still holds its lock there: renaming its folder out
 * from under it would split one tuning across two directories.
 */
export function moveLegacyDir(projectDir: string): void {
    const legacy = join(projectDir, LEGACY_FINETUNE_DIR);
    const current = join(projectDir, FINETUNE_DIR);
    if (!existsSync(legacy)) {
        return;
    }
    if (existsSync(current)) {
        note(
            yellow(
                `both ${LEGACY_FINETUNE_DIR}/ and ${FINETUNE_DIR}/ exist; using ${FINETUNE_DIR}/ - remove ${LEGACY_FINETUNE_DIR}/ once nothing in it is wanted`,
            ),
        );
        return;
    }
    const holder = liveHolder(join(legacy, 'loop.lock'));
    if (holder) {
        throw invalidError(
            `a tuning is still running in ${LEGACY_FINETUNE_DIR}/ (pid ${holder.pid})`,
            `let it finish or stop that process, then run this again to move it to ${FINETUNE_DIR}/`,
        );
    }
    renameSync(legacy, current);
    note(dim(`moved ${LEGACY_FINETUNE_DIR}/ to ${FINETUNE_DIR}/`));
}

function whole(text: string | undefined, flag: string, min = 1): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < min) {
        throw usageError(`${flag} takes a whole number of at least ${min}`, `got "${text}"`);
    }
    return n;
}

const configFile = (dir: string): string => join(dir, FINETUNE_DIR, 'loop.json');

export function readConfig(dir: string): Config {
    try {
        return {
            ...DEFAULTS,
            ...(JSON.parse(readFileSync(configFile(dir), 'utf8')) as Partial<Config>),
        };
    } catch {
        return { ...DEFAULTS };
    }
}

function configFrom(dir: string, v: Flags): Config {
    const saved = readConfig(dir);
    const workers = whole(v.workers, '-N') ?? saved.workers;
    if (v.rubric !== undefined && v.rubric !== 'yes' && v.rubric !== 'no') {
        throw usageError('--rubric takes yes or no');
    }
    const config: Config = {
        ...saved,
        workers,
        applyAt: whole(v['apply-at'], '-M') ?? (v.workers ? workers : saved.applyAt),
        tries: whole(v.tries, '--tries') ?? saved.tries,
        memTries: whole(v['mem-tries'], '--mem-tries') ?? saved.memTries,
        mergeEvery: whole(v['merge-every'], '--merge-every') ?? saved.mergeEvery,
        seed: whole(v.seed, '--seed', 0) ?? saved.seed,
        ...(v.class ? { classes: v.class } : {}),
        ...(v.id ? { ids: v.id } : {}),
        ...(v.rubric ? { rubric: v.rubric === 'yes' } : {}),
        ...(v.limit ? { limit: whole(v.limit, '--limit') } : {}),
    };
    mkdirSync(join(dir, FINETUNE_DIR), { recursive: true });
    writeFileSync(configFile(dir), `${JSON.stringify(config, null, 2)}\n`);
    return config;
}

async function start(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    values: Flags,
    options: FinetuneOptions,
): Promise<void> {
    const store = DatasetStore.open(project.dir);
    if (!store.exists()) {
        throw invalidError('there is no dataset to tune on', 'build one: zen meta run /dataset');
    }
    const report = drift(store);
    if (!report.clean && !values.force) {
        throw invalidError(
            `the dataset has drifted from its sources (${report.cases.length} case(s), ${report.uncovered.length} section(s))`,
            'refresh it: zen meta run /dataset - or start with --force',
        );
    }
    const more = whole(values.more, '--more');
    const config = configFrom(project.dir, values);
    const children = new Set<ChildProcess>();
    const t = new Tuning(
        project.dir,
        config,
        options.zen ?? spawnZen(project.dir, children),
        options.tickMs,
    );
    t.more = more;
    if (!options.zen) {
        editorFiles(project.dir);
    }

    let interrupts = 0;
    let drawing = false;
    const onInterrupt = (): void => {
        interrupts++;
        if (interrupts === 1) {
            if (!drawing) {
                note(
                    yellow(
                        'stopping: the steps in flight finish first - Ctrl-C again to kill them',
                    ),
                );
            }
            t.stop('interrupted');
            return;
        }
        for (const child of children) {
            try {
                process.kill(-child.pid!, 'SIGTERM');
            } catch {
                // Already gone.
            }
        }
        process.exit(130);
    };
    process.on('SIGINT', onInterrupt);
    note(
        `${bold('tuning')} ${project.name} · ${config.workers} workers · apply at ${config.applyAt}`,
    );
    note(dim(`follow it: file://${join(t.dir, 'STATUS.html')}`));
    let close: (() => void) | undefined;
    if (!ctx.json && !values.plain && !options.zen && process.stderr.isTTY && process.stdin.isTTY) {
        const { watch } = await import('./tui.tsx');
        close = await watch(t, onInterrupt);
        drawing = true;
    }
    try {
        await runLoop(t);
    } finally {
        close?.();
        process.off('SIGINT', onInterrupt);
    }
    if (!ctx.json) {
        await status(ctx, project);
    }
}

function counts(dir: string): Record<string, number> & { total: number } {
    const t = new Tuning(dir, readConfig(dir), async () => ({ code: 1, stdout: '' }));
    const out = { total: 0, queued: 0, stopped: 0, completed: 0, difficult: 0, failed: 0 };
    for (const c of selection(t)) {
        out.total++;
        const r = resultOf(t, c);
        if (r) {
            out[r.state]++;
        } else if (attemptsOf(t, c).length > 0) {
            out.stopped++;
        } else {
            out.queued++;
        }
    }
    return out;
}

function status(ctx: FinetuneContext, project: { dir: string; name: string }): void {
    const dir = join(project.dir, FINETUNE_DIR);
    if (!DatasetStore.open(project.dir).exists()) {
        throw invalidError('there is no dataset to tune on', 'build one: zen meta run /dataset');
    }
    const holder = liveHolder(join(dir, 'loop.lock'));
    const c = counts(project.dir);
    if (ctx.json) {
        return json({
            running: Boolean(holder),
            ...c,
            status: join(dir, 'STATUS.md'),
            html: join(dir, 'STATUS.html'),
        });
    }
    write(
        `${bold(project.name)}  ${holder ? green(`running (pid ${holder.pid})`) : dim('not running')}`,
    );
    write(
        `${c.total} cases: ${green(`${c.completed} completed`)}, ${yellow(`${c.difficult} difficult`)}, ${c.failed ? `${red(`${c.failed} failed`)}, ` : ''}${c.stopped} part-way, ${c.queued} not started`,
    );
    if (!holder && c.queued + c.stopped + c.failed > 0) {
        note(
            dim(
                `${c.stopped + c.failed > 0 ? 'resume it' : 'start it'}: ${cyan(`zen meta ${project.name} finetune start`)} [-N <workers>] - see zen meta finetune --help`,
            ),
        );
    }
    if (!holder && c.difficult > 0) {
        note(
            dim(
                `another round for the difficult ones: ${cyan(`zen meta ${project.name} finetune retry --difficult`)}`,
            ),
        );
    }
    if (existsSync(join(dir, 'STATUS.md'))) {
        note(
            dim(
                `the detail: ${cyan(join(dir, 'STATUS.md'))} · ${cyan(`file://${join(dir, 'STATUS.html')}`)}`,
            ),
        );
    }
}

function stop(project: { dir: string }): void {
    const dir = join(project.dir, FINETUNE_DIR);
    if (!liveHolder(join(dir, 'loop.lock'))) {
        note('no tuning is running here');
        return;
    }
    writeFileSync(join(dir, 'stop'), `${new Date().toISOString()}\n`);
    note('asked it to stop: the steps in flight finish first');
}

async function retryCases(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    values: Flags,
    ids: string[],
): Promise<void> {
    const t = new Tuning(project.dir, readConfig(project.dir), async () => ({
        code: 1,
        stdout: '',
    }));
    const plan = await retry(t, {
        difficult: values.difficult,
        classes: values.class,
        ids: [...ids, ...(values.id ?? [])],
        yes: values.yes,
    });
    if (ctx.json) {
        json({ retried: plan.take.map((c) => c.id), skipped: plan.skip, tokens: plan.tokens });
    }
}

function session(project: { dir: string; name: string }, rest: string[]): void {
    const [id] = rest;
    if (!id) {
        throw usageError('session of which case?', 'zen meta finetune session <case>');
    }
    const c = DatasetStore.open(project.dir).get(id);
    if (!c) {
        throw invalidError(`no case ${id}`);
    }
    const file = join(project.dir, FINETUNE_DIR, 'cases', id, `r${c.rev}`, 'session');
    if (!existsSync(file)) {
        throw invalidError(`${id} has not been analyzed yet at revision ${c.rev}`);
    }
    write(`zen meta resume ${project.name} ${readFileSync(file, 'utf8').trim()}`);
}
