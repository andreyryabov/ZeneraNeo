import { readProjectConfig } from '@zenera/neo';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { loadProjectEnv } from '../env.ts';
import { ensureHome } from '../home.ts';
import { assertOwner, KeyStore, PROVIDERS, type Provider } from '../keys.ts';
import {
    chooseModel,
    defaultRef,
    launch,
    listPrompts,
    loadPrompt,
    locate,
    masked,
    MODEL_ENV,
    ORDER,
    PROMPT_DIR,
    providersWarning,
    readMeta,
    RECOMMENDED,
    SOURCE_LABELS,
    splitRef,
    wire,
    writeMeta,
    type ModelSources,
} from '../meta.ts';
import * as Projects from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    bold,
    choose,
    CliError,
    credentialError,
    dim,
    EXIT,
    green,
    isInteractive,
    json,
    note,
    readStdin,
    table,
    usageError,
    warn,
    write,
    writeAll,
} from '../term.ts';

const USAGE = 'zen meta [project] [prompt] [options]';

interface Flags {
    project?: string;
    provider?: string;
    model?: string;
    prompt?: string;
    agent?: string;
    effort?: string;
    share?: string;
    resume?: string;
    continue?: boolean;
    'allow-all'?: boolean;
    'allow-tool'?: string;
    'add-dir'?: string[];
    'dry-run'?: boolean;
    local?: boolean;
    pick?: boolean;
    clear?: boolean;
}

export const meta: Command = {
    summary: 'Run the meta agent over this project, on your own keys.',
    usage: USAGE,
    details: [
        'Forms:',
        '  zen meta [project] [prompt]              ask it something',
        '  zen meta run [project] /<name> [words]   run a stored prompt',
        '  zen meta prompts [project]               list the stored prompts',
        '  zen meta model [ref]                     show or set the model it uses',
        '',
        'Arguments:',
        '  [project]   Name of a project. Default: the one you are in.',
        '  [prompt]    Your question, in quotes. Also --prompt, or piped in.',
        '  /<name>     A prompt file in .github/prompts/<name>.prompt.md.',
        '  [words]     Appended to that prompt as a final line.',
        '',
        'Options:',
        '  --project <name|dir>   Which project to work in. The agent is rooted there.',
        '  --model <ref>          Model for this run, e.g. vertex/gemini-3.8-flash.',
        '  --provider <name>      Force the key to use. Default: the model ref says.',
        '  --agent <name>         A .github/agents/<name>.agent.md.',
        '  --effort <level>       none, minimal, low, medium, high, xhigh or max.',
        '  --allow-all            Let it use every tool without asking.',
        '  --allow-tool <list>    Narrower: read, shell(git:*), write(README.md).',
        '  --add-dir <dir>        Another directory it may touch. Repeatable.',
        '  --resume <id>          Continue a copilot session. --continue takes the last.',
        '  --share <file>         Write the transcript to a markdown file.',
        '  --dry-run              Print what would run, secrets masked, and stop.',
        '',
        'It always uses your own keys — `zen key add` — and never a coding-agent',
        'subscription. The answer goes to stdout and the progress to stderr, so',
        '`> out.md` keeps the answer alone.',
        '',
        'Nothing it needs is put on a command line: every credential reaches it',
        'through the environment, where other processes cannot read it.',
        '',
        'The model is looked for in this order: --model, ZENERA_META_MODEL in the',
        "shell, ZENERA_META_MODEL in the project's .env, `zen meta model`, then",
        'agents.yaml. With none of them set it uses the best model it knows of for',
        'a provider you hold a key for, and says which on stderr.',
        '',
        'Examples:',
        '  zen meta "what does this project do?"',
        '  zen meta acme "review the last commit" --allow-all',
        '  zen meta prompts',
        '  zen meta run /review-project --allow-all',
        '  zen meta run acme /sync-with-spec agents/triage.md',
        '  git diff | zen meta "what broke?"',
        '  zen meta model vertex/gemini-3.8-flash',
        '  zen meta model --pick',
        '  zen meta --dry-run "hello"',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                prompt: { type: 'string', short: 'p' },
                agent: { type: 'string' },
                effort: { type: 'string' },
                share: { type: 'string' },
                resume: { type: 'string' },
                continue: { type: 'boolean' },
                'allow-all': { type: 'boolean' },
                'allow-tool': { type: 'string' },
                'add-dir': { type: 'string', multiple: true },
                'dry-run': { type: 'boolean' },
                local: { type: 'boolean' },
                pick: { type: 'boolean' },
                clear: { type: 'boolean' },
            },
            USAGE,
        );

        if (positionals[0] === 'model') {
            return await model(ctx, values, positionals.slice(1));
        }
        if (positionals[0] === 'run') {
            return await stored(ctx, values, positionals.slice(1));
        }
        if (positionals[0] === 'prompts') {
            return await prompts(ctx, values, positionals.slice(1));
        }
        return await ask(ctx, values, positionals);
    },
};

// ---------------------------------------------------------------------------
// Which project
//
// `zen meta acme "…"` is what gets typed before anyone finds --project, and a
// project name is a bare word where a prompt is a sentence — the same reading
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

// ---------------------------------------------------------------------------
// zen meta [project] [prompt]
// ---------------------------------------------------------------------------

async function ask(ctx: Context, values: Flags, positionals: string[]): Promise<void> {
    const { project, rest } = await where(ctx, values.project, positionals);
    const piped = await readStdin();
    const prompt = (values.prompt ?? rest.join(' ')).trim() || piped;
    if (!prompt) {
        throw usageError('nothing to ask', `try: zen meta "what does this project do?"`);
    }
    await go(ctx, values, project, prompt);
}

// ---------------------------------------------------------------------------
// zen meta run [project] /<name> [words...]
//
// The leading slash is a marker, not decoration: with it there is nothing to
// guess, because the project is whatever came before and the extra words are
// whatever came after, even when a project and a prompt share a name.
// ---------------------------------------------------------------------------

async function stored(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const slash = args.findIndex((a) => a.startsWith('/'));
    let head: string[];
    let name: string | undefined;
    let extra: string[];
    if (slash >= 0) {
        head = args.slice(0, slash);
        name = args[slash];
        extra = args.slice(slash + 1);
    } else if (args.length > 1 && (await Projects.find(args[0]))) {
        head = [args[0]];
        name = args[1];
        extra = args.slice(2);
    } else {
        head = [];
        name = args[0];
        extra = args.slice(1);
    }

    const { project } = await where(ctx, values.project, head);
    if (!name) {
        name = await pickPrompt(ctx, project.dir);
    }
    const found = await loadPrompt(project.dir, name);
    if (found.description) {
        note(dim(found.description));
    }
    const prompt = extra.length > 0 ? `${found.body}\n\n${extra.join(' ')}` : found.body;
    await go(ctx, values, project, prompt);
}

async function pickPrompt(ctx: Context, dir: string): Promise<string> {
    const names = await listPrompts(dir);
    if (names.length === 0) {
        throw usageError('no stored prompts here', 'put one in .github/prompts/');
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
    const entry = store.active(owner);
    if (!entry) {
        throw credentialError(`no ${owner} key`, `add one: zen key add ${owner}`);
    }

    const wiring = wire(store, entry, id);
    const binary = locate();
    const args = argv(values, project.dir, prompt, wiring.secret);

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
    note(dim(`${owner} · ${wiring.model} · ${project.name}`));

    const outcome = await launch({
        binary,
        args,
        env: wiring.env,
        cwd: project.dir,
    });

    if (ctx.json) {
        json({
            project: project.dir,
            provider: owner,
            model: chosen.ref,
            sessionId: outcome.sessionId,
            exitCode: outcome.exitCode,
            usage: outcome.usage,
            answer: outcome.answer,
        });
    } else if (outcome.answer) {
        write(outcome.answer);
    }

    if (outcome.exitCode !== 0) {
        throw new CliError(
            `the meta agent exited ${outcome.exitCode}`,
            EXIT.failed,
            binary.from === 'npx' ? 'install it: npm i -g @github/copilot' : undefined,
        );
    }
}

/** Copilot's own flags, assembled once. Nothing secret goes on this line. */
function argv(values: Flags, dir: string, prompt: string, secret: string[]): string[] {
    const args = ['-C', dir, '-p', prompt, '--output-format', 'json', '--no-color'];
    if (values['allow-all']) {
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
    }
    if (values.continue) {
        args.push('--continue');
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
