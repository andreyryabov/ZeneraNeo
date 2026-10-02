import { readProjectConfig } from '@zenera/neo';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { loadProjectEnv } from '../env.ts';
import { ensureHome } from '../home.ts';
import { assertOwner, KeyStore, PROVIDERS, type Provider } from '../keys.ts';
import { probeChat, probeModel } from '../liveness.ts';
import {
    answerBox,
    chooseModel,
    DEFAULT_RESUMES,
    defaultRef,
    editorFiles,
    lastSession,
    launch,
    listPrompts,
    loadPrompt,
    locate,
    masked,
    misspelledProvider,
    MODEL_ENV,
    openLog,
    ORDER,
    PROMPT_DIR,
    providersWarning,
    readMeta,
    RECOMMENDED,
    recordSession,
    RESUME_PROMPT,
    resumeDelayMs,
    sessionTotals,
    SOURCE_LABELS,
    tailSpans,
    Tally,
    transient,
    wire,
    writeMeta,
    type ModelSources,
} from '../meta/index.ts';
import { splitRef } from '../modelref.ts';
import { duration } from '../narrate.ts';
import * as Projects from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    bold,
    choose,
    CliError,
    credentialError,
    cyan,
    dim,
    EXIT,
    green,
    invalidError,
    isInteractive,
    json,
    note,
    progress,
    readStdin,
    table,
    usageError,
    warn,
    write,
    writeAll,
} from '../term.ts';
import { appendUsage, LEDGER_ENV, ledgerPath, META_SESSION_ENV } from '../usage.ts';
import { locate as locateRun } from './inspect.ts';

const USAGE = 'zen meta run [project] [prompt] [options]';

const VERBS = new Set(['model', 'run', 'prompts', 'inspect', 'resume']);

/** A copilot session id, or the 7+ hex prefix of one it also accepts. */
const SESSION_ID = /^[0-9a-f]{7,}(?:-[0-9a-f]+)*$/i;

interface Flags {
    project?: string;
    session?: string;
    run?: string;
    dir?: string;
    provider?: string;
    model?: string;
    prompt?: string;
    agent?: string;
    effort?: string;
    share?: string;
    resume?: string;
    continue?: boolean;
    retries?: string;
    'allow-all'?: boolean;
    'allow-tool'?: string;
    ask?: boolean;
    'add-dir'?: string[];
    'dry-run'?: boolean;
    local?: boolean;
    pick?: boolean;
    clear?: boolean;
    force?: boolean;
}

export const meta: Command = {
    summary: 'Run the meta agent over this project, on your own keys.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Meta', subtitle: 'Meta Agent', hue: 'cyan' },
    details: [
        'Forms:',
        '  zen meta run [project] "<question>"      ask it something',
        '  zen meta run [project] /<name> [words]   run a stored prompt',
        '  zen meta run [project]                   pick one of its stored prompts',
        '  zen meta prompts [project]               list the stored prompts',
        '  zen meta inspect [project] [run]         audit one run with /inspect',
        '  zen meta resume [project] [session]      carry on a run that stopped',
        '  zen meta model [ref]                     show or set the model it uses',
        '',
        'The project may come before the verb instead: `zen meta acme run`.',
        '',
        'Arguments:',
        '  [project]   Name of a project. Default: the one you are in.',
        '  [prompt]    Your question, in quotes. Also --prompt, or piped in.',
        '  /<name>     A prompt file in .github/prompts/<name>.prompt.md.',
        '  [words]     Appended to that prompt as a final line.',
        '  [run]       A run id or a run directory. At a terminal, omit it to pick one.',
        '',
        'Options:',
        '  --project <name|dir>   Which project to work in. The agent is rooted there.',
        '  --model <ref>          Model for this run, e.g. vertex/gemini-3.8-flash.',
        '  --provider <name>      Force the key to use. Default: the model ref says.',
        '  --agent <name>         A .github/agents/<name>.agent.md.',
        '  --effort <level>       none, minimal, low, medium, high, xhigh or max.',
        '  --allow-tool <list>    Only these: read, shell(git:*), write(README.md).',
        '  --ask                  Have it ask before each tool. Default: it does not.',
        '  --add-dir <dir>        Another directory it may touch. Repeatable.',
        '  --resume <id>          Continue a copilot session. --continue takes the last.',
        `  --retries <n>          Resume after a rate limit or outage. Default ${DEFAULT_RESUMES}, 0 = off.`,
        '  --share <file>         Write the transcript to a markdown file.',
        '  --dry-run              Print what would run, secrets masked, and stop.',
        '  --session <id>         inspect: the session to pick the run from.',
        '  --run <id|dir>         inspect: the run. Same as the [run] argument.',
        '  --dir <run dir>        inspect: the run, by directory.',
        '',
        'It always uses your own keys — `zen key add` — and never a coding-agent',
        'subscription. The answer goes to stdout and the progress to stderr, so',
        '`> out.md` keeps the answer alone.',
        '',
        'It may use every tool without asking, because a prompt written for an',
        'editor expects to read, write and run things, and a terminal has nobody',
        'watching to answer. Narrow it with --allow-tool, or restore the asking',
        'with --ask.',
        '',
        '`zen meta inspect` is `zen meta run /inspect <run dir>` with the run',
        'picked from a list - project, session, then run. Off a terminal, name it.',
        '',
        '`zen meta resume` picks up the last session the project ran - or the one',
        'named - where it stopped. A run that ends any way but success prints it.',
        '',
        'Its tokens are counted as it runs and summed when it ends. In a project with',
        'a .finetune/, every call - and every zen run and inspect ask it makes - is',
        'appended to .finetune/usage/ledger.jsonl, and .finetune/USAGE.md is rewritten.',
        '',
        'Nothing it needs is put on a command line: every credential reaches it',
        'through the environment, where other processes cannot read it.',
        '',
        'The editor files `zen init` writes (.vscode/ and the .github/',
        'tree) are refreshed in the project first, the way `zen open` refreshes',
        'them: the agent is about to read that brief, and it describes this version',
        'of zen. Edits to them do not survive.',
        '',
        'The model is looked for in this order: --model, ZENERA_META_MODEL in the',
        "shell, ZENERA_META_MODEL in the project's .env, `zen meta model`, then",
        'agents.yaml. With none of them set it uses the best model it knows of for',
        'a provider you hold a key for, and says which on stderr.',
        '',
        'Setting one asks the provider a one-word question first, so a model that',
        'will not answer is never stored. --force skips that.',
        '',
        'Examples:',
        '  zen meta run "what does this project do?"',
        '  zen meta run acme "review the last commit"',
        '  zen meta prompts',
        '  zen meta run /project-review',
        '  zen meta run acme /spec-sync-project agents/triage.md',
        '  zen meta inspect',
        '  zen meta inspect acme 20260825-143012-a7f3',
        '  zen meta resume acme',
        '  git diff | zen meta run "what broke?" --allow-tool read',
        '  zen meta model vertex/gemini-3.8-flash',
        '  zen meta model --pick',
        '  zen meta run --dry-run "hello"',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                session: { type: 'string' },
                run: { type: 'string' },
                dir: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                prompt: { type: 'string', short: 'p' },
                agent: { type: 'string' },
                effort: { type: 'string' },
                share: { type: 'string' },
                resume: { type: 'string' },
                continue: { type: 'boolean' },
                retries: { type: 'string' },
                'allow-all': { type: 'boolean' },
                'allow-tool': { type: 'string' },
                ask: { type: 'boolean' },
                'add-dir': { type: 'string', multiple: true },
                'dry-run': { type: 'boolean' },
                local: { type: 'boolean' },
                pick: { type: 'boolean' },
                clear: { type: 'boolean' },
                force: { type: 'boolean' },
            },
            USAGE,
        );

        // `zen meta acme run` is typed at least as often as `zen meta run acme`,
        // and read literally it asks the agent the one-word question "run" —
        // a whole model call spent on a typo, with nothing on screen to say so.
        const [first, second] = positionals;
        const named =
            first !== undefined &&
            second !== undefined &&
            !VERBS.has(first) &&
            VERBS.has(second) &&
            (await Projects.find(first))
                ? first
                : undefined;
        const verb = named ? second : first;
        const args = named ? [named, ...positionals.slice(2)] : positionals.slice(1);

        if (verb === 'model') {
            if (named) {
                throw usageError('the model is not per-project', 'try: zen meta model');
            }
            return await model(ctx, values, args);
        }
        if (verb === 'run') {
            return await stored(ctx, values, args);
        }
        if (verb === 'prompts') {
            return await prompts(ctx, values, args);
        }
        if (verb === 'inspect') {
            return await inspectRun(ctx, values, args);
        }
        if (verb === 'resume') {
            return await resumeRun(ctx, values, args);
        }
        throw usageError(
            first === undefined ? 'nothing to run' : 'a prompt goes through `run`',
            `try: zen meta run ${positionals.map(requote).join(' ') || '"what does this project do?"'}`,
        );
    },
};

/** Words the shell would have split are shown back the way they were typed. */
const requote = (s: string): string => (/\s/.test(s) ? JSON.stringify(s) : s);

// ---------------------------------------------------------------------------
// Which project
//
// `zen meta run acme "…"` is what gets typed before anyone finds --project, and
// a project name is a bare word where a prompt is a sentence — the same reading
// `zen run` gives its first positional, for the same reason.
// ---------------------------------------------------------------------------

async function where(
    ctx: Context,
    flag: string | undefined,
    positionals: string[],
): Promise<{ project: Projects.Project; rest: string[] }> {
    const [head, ...tail] = positionals;
    const named = !flag && head ? await Projects.find(head) : undefined;
    const project = await resolveProject({
        cwd: ctx.cwd,
        project: flag ?? (named ? head : undefined),
    });
    return { project, rest: named ? tail : positionals };
}

/**
 * The editor's files, rewritten before the agent reads them — the same refresh
 * `zen open` does, for the same reason. `.github/` is the brief this agent works
 * from and the prompts it is offered, and it describes the version of `zen` in
 * hand; a project scaffolded by an older one would otherwise be briefed on a
 * runtime that has moved. A failure is narrated, not raised: a read-only
 * checkout is no reason to refuse to answer a question.
 */
function refresh(project: Projects.Project): void {
    try {
        const written = editorFiles(project.dir);
        note(dim(`refreshed ${written.length} editor files in ${project.name}`));
    } catch (err) {
        warn(`could not refresh the editor files — ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// zen meta run [project] [/<name>|<question>] [words...]
//
// The leading slash is a marker, not decoration: with it there is nothing to
// guess, because the project is whatever came before and the extra words are
// whatever came after, even when a project and a prompt share a name. Without
// one the words are the question itself.
// ---------------------------------------------------------------------------

async function stored(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const slash = args.findIndex((a) => a.startsWith('/'));
    let head: string[];
    let name: string | undefined;
    let rest: string[];
    if (slash >= 0) {
        head = args.slice(0, slash);
        name = args[slash];
        rest = args.slice(slash + 1);
    } else if (args[0] !== undefined && (await Projects.find(args[0]))) {
        head = [args[0]];
        rest = args.slice(1);
    } else {
        head = [];
        rest = args;
    }

    const { project } = await where(ctx, values.project, head);
    refresh(project);
    if (name) {
        return await runPrompt(ctx, values, project, name, rest);
    }
    const question = (values.prompt ?? rest.join(' ')).trim() || (await readStdin());
    if (question) {
        return await go(ctx, values, project, question);
    }
    // Nothing said and nothing piped: the stored prompts are what is left to offer.
    return await runPrompt(ctx, values, project, await pickPrompt(ctx, project), []);
}

async function runPrompt(
    ctx: Context,
    values: Flags,
    project: Projects.Project,
    name: string,
    extra: string[],
): Promise<void> {
    const found = await loadPrompt(project.dir, name);
    if (found.description) {
        note(dim(found.description));
    }
    const prompt = extra.length > 0 ? `${found.body}\n\n${extra.join(' ')}` : found.body;
    await go(ctx, values, project, prompt);
}

async function pickPrompt(ctx: Context, project: Projects.Project): Promise<string> {
    const names = await listPrompts(project.dir);
    if (names.length === 0) {
        throw usageError(
            'nothing to run',
            `try: zen meta run ${project.name} "what does this project do?"`,
        );
    }
    if (!isInteractive() || ctx.json) {
        throw usageError('which prompt?', `try: ${names.map((n) => `/${n}`).join(', ')}`);
    }
    return await choose(
        'Which prompt?',
        names.map((n) => ({ label: `/${n}`, value: n })),
    );
}

// ---------------------------------------------------------------------------
// zen meta prompts [project]
//
// A slash command is only discoverable inside an editor, where a menu drops
// down as you type it. On a terminal the same files have to be asked for.
// ---------------------------------------------------------------------------

async function prompts(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const { project } = await where(ctx, values.project, args);
    refresh(project);
    const names = await listPrompts(project.dir);
    const found = await Promise.all(names.map((name) => loadPrompt(project.dir, name)));

    if (ctx.json) {
        return json(found.map(({ name, description, path }) => ({ name, description, path })));
    }
    if (found.length === 0) {
        note(dim(`no prompts in ${project.name}/${PROMPT_DIR}`));
        return;
    }
    writeAll(table(found.map((p) => [`/${p.name}`, p.description ? dim(p.description) : ''])));
    note();
    note(dim(`run one: zen meta run /${found[0].name}`));
}

// ---------------------------------------------------------------------------
// zen meta inspect [project] [run id | run dir]
//
// `zen meta run /inspect <run dir>` with the run chosen for you. The prompt is
// the whole behaviour; this only finds the one word it needs, so the two forms
// send the same bytes.
// ---------------------------------------------------------------------------

async function inspectRun(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const [head, ...tail] = args;
    const named = !values.project && head ? await Projects.find(head) : undefined;
    const rest = named ? tail : args;
    if (rest.length > 1) {
        throw usageError('inspect takes one run', 'zen meta inspect [project] [run id | run dir]');
    }
    const handle = rest[0] ?? values.run;
    const asking = isInteractive() && !ctx.json;
    // Off a terminal "the newest" would be a guess nobody confirmed.
    if (!handle && !values.dir && !asking) {
        throw usageError(
            'which run?',
            'name one: zen meta inspect --run <id|dir>, or run it at a terminal to pick',
        );
    }
    const at = await locateRun(
        ctx.cwd,
        { project: named?.dir ?? values.project, session: values.session, dir: values.dir },
        handle,
        asking,
    );
    if (!existsSync(at.run.state)) {
        throw invalidError(
            `run ${at.run.id} has no state.json`,
            'only a run that got far enough to save state can be inspected',
        );
    }
    const project = await Projects.openDir(at.project);
    note(`${bold(at.run.id)} ${dim(at.run.dir)}`);
    refresh(project);
    await runPrompt(ctx, values, project, 'inspect', [at.run.dir]);
}

// ---------------------------------------------------------------------------
// zen meta resume [project] [session id] [words...]
//
// A long run stops for reasons nobody chose - a refused request, a closed
// laptop, Ctrl-C. Copilot keeps the session; this hands it back, by default the
// last one the project ran, with the words (or a plain "continue") as the turn.
// ---------------------------------------------------------------------------

async function resumeRun(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const { project, rest } = await where(ctx, values.project, args);
    const named = rest[0] !== undefined && SESSION_ID.test(rest[0]) ? rest[0] : undefined;
    const words = named ? rest.slice(1) : rest;
    const session = named ?? values.resume ?? lastSession(project.dir);
    if (!session) {
        throw usageError(
            `no meta session recorded in ${project.name}`,
            `name one: zen meta resume ${project.name} <session id>`,
        );
    }
    note(dim(`resuming session ${session}`));
    refresh(project);
    const message = (values.prompt ?? words.join(' ')).trim() || RESUME_PROMPT;
    await go(ctx, { ...values, resume: session, continue: false }, project, message);
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

async function go(
    ctx: Context,
    values: Flags,
    project: Projects.Project,
    prompt: string,
): Promise<void> {
    const shell = process.env[MODEL_ENV];
    loadProjectEnv(project.dir);
    ensureHome();
    const store = await KeyStore.open();
    store.materialize();

    const only = values.provider ? asProvider(values.provider) : undefined;
    const chosen = chooseModel({
        flag: values.model,
        shell,
        env: process.env[MODEL_ENV],
        stored: (await readMeta()).model,
        project: projectModel(project.dir),
        fallback: defaultRef(store, only),
    });
    if (!chosen) {
        if (only) {
            throw credentialError(`no ${only} key`, `add one: zen key add ${only}`);
        }
        throw credentialError(
            'no model for the meta agent',
            store.entries.length === 0
                ? 'add a key: zen key add openai'
                : 'set one: zen meta model <provider>/<id>',
        );
    }

    const { provider, id } = splitRef(chosen.ref);
    const owner = only ?? provider ?? 'openai';
    const meant = misspelledProvider(chosen.ref);
    if (meant && !only) {
        warn(`${chosen.ref} names no provider — did you mean ${meant}/${id}?`);
    }
    const entry = store.active(owner);
    if (!entry) {
        throw credentialError(`no ${owner} key`, `add one: zen key add ${owner}`);
    }

    const wiring = wire(store, entry, id);
    const binary = locate();
    // Named up front, so a run killed before copilot reports its id can still be resumed.
    let session = values.resume ?? (values.continue ? undefined : randomUUID());
    const args = argv(values, project.dir, prompt, wiring.secret, session);
    const retries = count(values.retries, '--retries') ?? DEFAULT_RESUMES;

    if (values['dry-run']) {
        const lines = masked(wiring.env, wiring.secret);
        if (ctx.json) {
            return json({
                project: project.dir,
                provider: owner,
                model: chosen.ref,
                from: SOURCE_LABELS[chosen.from],
                command: [binary.command, ...binary.args, ...args],
                env: Object.fromEntries(lines.map((l) => l.split('=', 2) as [string, string])),
            });
        }
        write(`${binary.command} ${[...binary.args, ...args].join(' ')}`);
        writeAll(lines.map((l) => dim(l)));
        note(dim(`model ${chosen.ref} from ${SOURCE_LABELS[chosen.from]}`));
        return;
    }

    for (const line of wiring.warnings) {
        warn(line);
    }
    const competing = providersWarning();
    if (competing) {
        warn(competing);
    }
    if (chosen.from === 'default') {
        note(dim(`no model set — using ${chosen.ref}, the best ${owner} model zen knows of`));
        note(dim('set another: zen meta model <provider>/<id>'));
    }
    note(cyan(`${owner} · ${wiring.model} · ${project.name}`));

    const log = openLog(project.dir);
    note(`log  ${log.path}`);
    const elided = args.map((a, i) => (args[i - 1] === '-p' ? '<prompt>' : a));
    log.line(`zen meta ${new Date().toISOString()}`);
    log.line(`project ${project.name} ${project.dir}`);
    log.line(`model   ${chosen.ref} from ${SOURCE_LABELS[chosen.from]}`);
    log.line(`command ${[binary.command, ...binary.args, ...elided].join(' ')}`);
    if (session) {
        recordSession(project.dir, session);
        log.line(`session ${session}`);
    }
    log.line('');
    log.line('--- prompt ---');
    log.line(prompt);
    log.line('');
    log.line('--- run ---');

    const resumeHint = (): string | undefined =>
        session ? `resume it: zen meta resume ${project.name} ${session}` : undefined;

    // Every zen command the agent runs inherits these, so a batch it starts or
    // an ask it makes lands in the same ledger, tagged with this session.
    const spans = log.path.replace(/\.log$/, '.otel.jsonl');
    const ledger = ledgerPath(project.dir);
    const env: Record<string, string> = {
        ...wiring.env,
        COPILOT_OTEL_FILE_EXPORTER_PATH: spans,
        ...(ledger ? { [LEDGER_ENV]: ledger } : {}),
        ...(ledger && session ? { [META_SESSION_ENV]: session } : {}),
    };
    const tally = new Tally();
    const tail = tailSpans(spans, (call) => {
        tally.add(call);
        appendUsage(project.dir, {
            kind: 'meta.call',
            ts: new Date(Date.parse(call.startedAt) + call.durationMs).toISOString(),
            ...call,
            session: call.session ?? session,
        });
    });
    const reporter = usageReporter(project.dir);
    const tokens = (): string => {
        tail.stop();
        return tally.toString();
    };

    // A run that dies still has to leave a readable file behind.
    try {
        let resumes = 0;
        const run = async (argList: string[]) => {
            const launchedAt = new Date();
            const outcome = await launch({
                binary,
                args: argList,
                env,
                cwd: project.dir,
                log,
                status: () => (tally.calls > 0 ? tally.toString() : ''),
            });
            if (outcome.sessionId && outcome.sessionId !== session) {
                session = outcome.sessionId;
                recordSession(project.dir, session);
            }
            const models = session ? sessionTotals(session) : undefined;
            if (session && models) {
                appendUsage(project.dir, {
                    kind: 'meta.session',
                    ts: new Date().toISOString(),
                    session,
                    models,
                    exitCode: outcome.exitCode,
                    resumes,
                    startedAt: launchedAt.toISOString(),
                    durationMs: Date.now() - launchedAt.getTime(),
                });
            }
            return outcome;
        };
        let outcome = await run(args);
        for (let reason = transient(outcome); reason && resumes < retries;) {
            const wait = resumeDelayMs(resumes);
            resumes += 1;
            const said = `${reason}: resuming in ${duration(wait)} (${resumes}/${retries})`;
            warn(said);
            log.line('');
            log.line(`--- resume ${resumes}: ${said} ---`);
            await pause(wait, resumeHint());
            const again = { ...values, resume: session, continue: false };
            outcome = await run(argv(again, project.dir, RESUME_PROMPT, wiring.secret));
            reason = transient(outcome);
        }

        log.line('');
        log.line('--- answer ---');
        log.line(outcome.answer);
        if (outcome.answer) {
            log.saveAnswer(outcome.answer);
        }
        const spent = tokens();
        log.line('');
        log.line(`tokens  ${spent}`);

        if (ctx.json) {
            json({
                project: project.dir,
                provider: owner,
                model: chosen.ref,
                sessionId: outcome.sessionId,
                exitCode: outcome.exitCode,
                resumes,
                usage: outcome.usage,
                tokens: { calls: tally.calls, ...tally.usage },
                answer: outcome.answer,
                answerFile: outcome.answer ? log.answerPath : undefined,
            });
        } else if (outcome.answer) {
            writeAll(answerBox(outcome.answer));
            // After the answer, not before: it is the thing you click once you
            // have read enough to want it in an editor.
            note(cyan(log.answerPath));
        }
        if (!ctx.json && tally.calls > 0) {
            note(dim(`tokens  ${spent}`));
        }

        if (outcome.exitCode !== 0) {
            throw new CliError(
                `the meta agent exited ${outcome.exitCode}`,
                EXIT.failed,
                resumeHint() ??
                    (binary.from === 'npx' ? 'install it: npm i -g @github/copilot' : undefined),
            );
        }
    } catch (err) {
        const hint = resumeHint();
        if (hint && !(err instanceof CliError)) {
            note(dim(hint));
        }
        throw err;
    } finally {
        tail.stop();
        reporter.stop();
        log.close();
    }
}

/** How often a running meta agent rewrites the fine-tuning's usage report. */
const REPORT_EVERY_MS = 5 * 60_000;

/**
 * Rewrites `.finetune/USAGE.md` on a timer and once more at the end, when the
 * project is being tuned. Detached and silent: the report is a by-product, and
 * neither its time nor its failure belongs to the run.
 */
function usageReporter(dir: string): { stop(): void } {
    const script = join(dir, '.github/skills/zen-finetune/scripts/usage.mjs');
    if (!existsSync(join(dir, '.finetune')) || !existsSync(script)) {
        return { stop: () => undefined };
    }
    let running = false;
    const refresh = (): void => {
        if (running) {
            return;
        }
        running = true;
        const child = spawn(process.execPath, [script, '-q'], {
            cwd: dir,
            stdio: 'ignore',
            detached: true,
        });
        child.on('exit', () => (running = false));
        child.on('error', () => (running = false));
        child.unref();
    };
    const timer = setInterval(refresh, REPORT_EVERY_MS);
    timer.unref();
    return {
        stop: (): void => {
            clearInterval(timer);
            running = false;
            refresh();
        },
    };
}

/** The wait before a resume, cut short by Ctrl-C - which still says how to resume. */
async function pause(ms: number, hint: string | undefined): Promise<void> {
    const stop = new AbortController();
    const onInt = (): void => stop.abort();
    process.once('SIGINT', onInt);
    try {
        await sleep(ms, undefined, { signal: stop.signal });
    } catch {
        throw new CliError('interrupted', EXIT.failed, hint);
    } finally {
        process.off('SIGINT', onInt);
    }
}

/** Copilot's own flags, assembled once. Nothing secret goes on this line. */
function argv(
    values: Flags,
    dir: string,
    prompt: string,
    secret: string[],
    fresh?: string,
): string[] {
    const args = ['-C', dir, '-p', prompt, '--output-format', 'json', '--no-color'];
    // A prompt written for an editor expects to read, write and run things, and
    // there is nobody at a `-p` run to answer the question. Naming tools is the
    // narrower answer and wins; --ask is the way back to being asked.
    if (values['allow-all'] || (!values.ask && !values['allow-tool'])) {
        args.push('--allow-all-tools');
    }
    if (values['allow-tool']) {
        args.push('--allow-tool', values['allow-tool']);
    }
    for (const extra of values['add-dir'] ?? []) {
        args.push('--add-dir', extra);
    }
    if (values.agent) {
        args.push('--agent', values.agent);
    }
    if (values.effort) {
        args.push('--reasoning-effort', values.effort);
    }
    if (values.share) {
        args.push('--share', values.share);
    }
    if (values.resume) {
        args.push('--resume', values.resume);
    } else if (values.continue) {
        args.push('--continue');
    } else if (fresh) {
        args.push('--session-id', fresh);
    }
    if (secret.length > 0) {
        args.push('--secret-env-vars', secret.join(','));
    }
    return args;
}

/** The project's own `model:`, with a `models:` alias resolved to what it names. */
function projectModel(dir: string): string | undefined {
    try {
        const { config } = readProjectConfig(dir);
        const top = typeof config.model === 'string' ? config.model : undefined;
        const alias = top ? config.models?.[top] : undefined;
        if (!alias) {
            return top;
        }
        if (typeof alias === 'string') {
            return alias;
        }
        const owner = PROVIDERS.find((p) => p === alias.provider);
        return owner ? `${owner}/${alias.model}` : alias.model;
    } catch {
        return undefined;
    }
}

function count(text: string | undefined, flag: string): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
        throw usageError(`${flag} takes a whole number, 0 or more`, `got "${text}"`);
    }
    return value;
}

function asProvider(name: string): Provider {
    const owner = assertOwner(name);
    if (owner === 'exa') {
        throw usageError(`${name} is not a model provider`);
    }
    return owner;
}

// ---------------------------------------------------------------------------
// zen meta model
//
// Bare, it answers the question that actually gets asked, which is not "what
// model" but "why that one" — so the chain is printed with the winner marked,
// the same way `zen key ls` marks the key a run would use.
// ---------------------------------------------------------------------------

async function model(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const project = await Projects.current(ctx.cwd);
    const shell = process.env[MODEL_ENV];
    if (project) {
        loadProjectEnv(project.dir);
    }
    ensureHome();

    if (values.clear) {
        return clear(values, project);
    }
    const ref = values.pick ? await pickModel(ctx) : args[0];
    if (ref) {
        return set(ctx, values, project, ref);
    }

    const sources: ModelSources = {
        flag: undefined,
        shell,
        env: process.env[MODEL_ENV],
        stored: (await readMeta()).model,
        project: project ? projectModel(project.dir) : undefined,
        fallback: defaultRef(await KeyStore.open()),
    };
    const chosen = chooseModel(sources);
    const at: Record<string, string | undefined> = {
        flag: sources.flag,
        shell: sources.shell,
        env: sources.shell ? undefined : sources.env,
        store: sources.stored,
        project: sources.project,
        default: sources.fallback,
    };

    if (ctx.json) {
        return json({
            model: chosen?.ref,
            from: chosen ? SOURCE_LABELS[chosen.from] : undefined,
            sources: Object.fromEntries(ORDER.map((s) => [SOURCE_LABELS[s], at[s] ?? null])),
        });
    }
    if (chosen) {
        write(chosen.ref);
    }
    note();
    for (const source of ORDER) {
        const value = at[source];
        const mark = chosen?.from === source ? green('*') : ' ';
        note(`  ${mark} ${SOURCE_LABELS[source].padEnd(26)} ${value ?? dim('not set')}`);
    }
    if (!chosen) {
        note();
        note(dim('set one: zen meta model <provider>/<id>'));
    }
}

async function set(
    ctx: Context,
    values: Flags,
    project: Projects.Project | undefined,
    ref: string,
): Promise<void> {
    if (!values.force) {
        await vet(ctx, ref);
    }
    if (values.local) {
        if (!project) {
            throw usageError('--local needs a project', 'run it inside one, or drop --local');
        }
        await writeLocal(project.dir, ref);
        if (!ctx.json) {
            note(dim(`${MODEL_ENV}=${ref} in ${project.name}/.env`));
        }
    } else {
        const file = await readMeta();
        writeMeta({ ...file, model: ref });
    }
    if (ctx.json) {
        json({ model: ref, where: values.local ? '.env' : 'meta.json' });
    } else {
        write(ref);
    }
}

// ---------------------------------------------------------------------------
// Vetting a ref
//
// Naming a model is a deliberate act and the run that follows is not free, so
// the provider is asked one cheap question now. Without it a slip of the hand
// is stored happily and surfaces much later as a 404 from a vendor nobody
// named — `vertes/…` has no known prefix, so it would be sent whole to OpenAI.
// ---------------------------------------------------------------------------

async function vet(ctx: Context, ref: string): Promise<void> {
    const meant = misspelledProvider(ref);
    if (meant) {
        const [head, ...rest] = ref.split('/');
        throw usageError(
            `no provider called "${head}"`,
            `did you mean ${meant}/${rest.join('/')}?`,
        );
    }
    const { provider, id } = splitRef(ref);
    const owner = provider ?? 'openai';
    const store = await KeyStore.open();
    if (!store.active(owner)) {
        throw credentialError(`no ${owner} key to try ${id} with`, `add one: zen key add ${owner}`);
    }
    store.materialize();

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`asking ${owner} about ${id} …`));
    const probe = await probeModel({
        // The colon form, so a refusal suggests `zen models ls <provider>`.
        ref: `${owner}:${id}`,
        kind: 'model',
        model: probeChat(owner, id),
    });
    bar?.done();

    if (probe.check.state !== 'live') {
        const why = probe.check.detail ? ` — ${probe.check.detail}` : '';
        const fix = probe.check.fix ?? `see what it serves: zen models ls ${owner}`;
        throw credentialError(`${owner} did not answer to ${id}${why}`, `${fix}, or --force`);
    }
    if (!ctx.json) {
        note(dim(`${owner} answered in ${(probe.ms / 1000).toFixed(1)}s`));
    }
}

async function clear(values: Flags, project: Projects.Project | undefined): Promise<void> {
    if (values.local) {
        if (!project) {
            throw usageError('--local needs a project');
        }
        await writeLocal(project.dir, undefined);
    } else {
        const file = await readMeta();
        delete file.model;
        writeMeta(file);
    }
    note(dim('cleared'));
}

async function writeLocal(dir: string, ref: string | undefined): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = `${dir}/.env`;
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    } catch {
        text = '';
    }
    const line = new RegExp(`^${MODEL_ENV}=.*$`, 'm');
    const next = line.test(text)
        ? text.replace(line, ref ? `${MODEL_ENV}=${ref}` : '')
        : ref
          ? `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${MODEL_ENV}=${ref}\n`
          : text;
    await writeFile(path, next, { mode: 0o600 });
}

async function pickModel(ctx: Context): Promise<string> {
    if (!isInteractive() || ctx.json) {
        throw usageError('--pick needs a terminal', 'name the model instead');
    }
    const store = await KeyStore.open();
    const known = store.entries
        .filter((e) => e.provider !== 'exa')
        .map((e) => e.provider as Provider);
    if (known.length === 0) {
        throw credentialError('no keys to choose from', 'add one: zen key add openai');
    }
    const suggestions = [...new Set(known)].flatMap((p) =>
        (RECOMMENDED[p] ?? []).map((id) => `${p}/${id}`),
    );
    note(dim(bold('Models zen knows how to wire, for providers you hold a key for')));
    return await choose(
        'Which model?',
        suggestions.map((ref) => ({ label: ref, value: ref })),
    );
}
