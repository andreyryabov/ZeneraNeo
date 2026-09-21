import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import * as Engine from '../engine.ts';
import { duration, Narrator, stopMark, summary } from '../narrate.ts';
import * as Projects from '../projects.ts';
import { target, type Target } from '../resolve.ts';
import { display } from '../session.ts';
import { bold, cyan, dim, json, note, readStdin, usageError, write } from '../term.ts';
import { parseChoice } from '../tui/theme.ts';

const USAGE = 'zen run [project] [prompt] [options]';

interface Flags {
    project?: string;
    session?: string;
    new?: boolean;
    workspace?: string;
    memory?: string;
    model?: string;
    image?: string;
    'no-keys'?: boolean;
    'read-only'?: boolean;
    yes?: boolean;
    plain?: boolean;
    theme?: string;
    out?: string;
}

export const run: Command = {
    summary: 'Run the project — the TUI on a terminal, one shot otherwise.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Neo', subtitle: 'Agentic Runtime', hue: 'orange' },
    details: [
        'Arguments:',
        '  [project]   Name of a project. Default: the one you are in.',
        '  [prompt]    Your question, in quotes. Without one, the TUI opens.',
        '',
        'Options:',
        '  --project <name|dir>   Which project to run. Default: the one you are in.',
        '  --session <id>         Continue this session.',
        '  --new                  Start a new session without asking which one.',
        '  --workspace <dir>      Directory the agent can read and write.',
        '  --memory <dir>         Directory the agents remember into.',
        '  --model <ref>          Use this model instead of the default.',
        '  --image <ref>          Use this container image to run commands in.',
        '  --read-only            Take away every tool that can write.',
        '  --no-keys              Do not pass API keys into the container.',
        '  --plain                Never open the TUI. Needs a prompt.',
        '  --theme <dark|light>   Colours for the TUI. Default: auto.',
        '  --out <file>           Put the answer in this file instead of on screen.',
        '  --yes                  Answer yes to every question.',
        '',
        'The first word is the project when it names one, otherwise the prompt.',
        'The answer goes to stdout and the progress to stderr, so `> out.md` keeps',
        'the answer alone and `2>/dev/null` hides the progress.',
        '',
        'A prompt always starts a new session, so --new is for the TUI, where the',
        'alternative is being asked which session to continue.',
        '',
        'Examples:',
        '  zen run                               open the TUI in this project',
        '  zen run acme                          open the TUI in the acme project',
        '  zen run "what changed?"               ask that, print the answer, exit',
        '  git diff | zen run                    take the prompt from stdin',
        '  zen run "what changed?" > out.md      redirect the answer into a file',
        '  zen run --out out.md "what changed?"  write the answer to out.md only',
        '  zen run --read-only "what changed?"   let it read but not write',
        '  zen run --memory ./mem                remember into ./mem, not the project',
        '  zen run --new                         open the TUI in a new session',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                session: { type: 'string' },
                new: { type: 'boolean' },
                workspace: { type: 'string' },
                memory: { type: 'string' },
                model: { type: 'string' },
                image: { type: 'string' },
                'no-keys': { type: 'boolean' },
                'read-only': { type: 'boolean' },
                yes: { type: 'boolean' },
                plain: { type: 'boolean' },
                theme: { type: 'string' },
                out: { type: 'string' },
            },
            USAGE,
        );

        const piped = await readStdin();

        // `zen run acme` is what everyone types before finding --project, and a
        // project name is a bare word where a prompt is a sentence. So the
        // first positional is read as a project when it names one and as the
        // first word of the prompt when it does not — which also makes
        // `zen run acme "what changed?"` mean what it looks like. --project is
        // there for the day a project is called "why".
        const [head, ...rest] = positionals;
        const named = !values.project && head ? await Projects.find(head) : undefined;
        const prompt = (named ? rest : positionals).join(' ').trim() || piped;

        if (values.theme !== undefined && !parseChoice(values.theme)) {
            throw usageError(`unknown theme: ${values.theme}`, 'dark, light or auto');
        }

        // A prompt on the command line is a request for an answer, not a
        // conversation to pick up. So it answers the three questions itself:
        // a fresh session, the directory it was typed in as the workspace,
        // and no confirmation for it — `zen run acme "what changed?"` should
        // read the code that is right there. Every flag still wins, and the
        // TUI, where there is someone to ask, still asks.
        const shot = Boolean(prompt);

        const where = await target({
            cwd: ctx.cwd,
            project: values.project ?? (named ? head : undefined),
            session: values.session,
            fresh: values.new || (shot && !values.session),
            workspace: values.workspace ?? (shot ? ctx.cwd : undefined),
            yes: values.yes || shot,
        });

        const engine = await Engine.open({
            project: where.project,
            session: where.session,
            readOnly: values['read-only'],
            model: values.model,
            image: values.image,
            // Relative to where it was typed, like every other path on the line
            // — the project root is not the cwd.
            memoryDir: values.memory ? resolve(ctx.cwd, values.memory) : undefined,
            keys: values['no-keys'] ? false : undefined,
            yes: values.yes || ctx.json,
        });

        try {
            // The TUI is for the case it is actually good at: a person at a
            // terminal, with nothing to say yet. A prompt on the command line
            // is a request for an answer, and drawing a full-screen interface
            // over it would be worse than not drawing one.
            const drawing =
                !prompt &&
                !values.plain &&
                !ctx.json &&
                Boolean(process.stdout.isTTY && process.stdin.isTTY);

            if (drawing) {
                const { start } = await import('../tui/app.tsx');
                await start(engine, {
                    readOnly: Boolean(values['read-only']),
                    theme: values.theme,
                    started: { created: where.created, freshWorkspace: where.freshWorkspace },
                });
                return;
            }

            if (!prompt) {
                throw usageError('nothing to ask', 'give a prompt, or pipe one in');
            }
            await once(engine, prompt, values, ctx.json, ctx.cwd, where);
        } finally {
            await engine.close();
        }
    },
};

// ---------------------------------------------------------------------------
// One shot
// ---------------------------------------------------------------------------

async function once(
    engine: Engine.Engine,
    prompt: string,
    values: Flags,
    asJson: boolean,
    cwd: string,
    where: Target,
): Promise<void> {
    const narrator = new Narrator({
        quiet: asJson,
        live: Boolean(process.stderr.isTTY),
    });

    // Ctrl-C asks the run to stop rather than killing the process, so the turn
    // still lands on disk and the session stays resumable.
    const stopping = new AbortController();
    const onInterrupt = (): void => stopping.abort();
    process.once('SIGINT', onInterrupt);

    if (!asJson) {
        // Two questions were just answered, possibly without being asked. Say
        // which way they went: a run that quietly resumed the wrong session, or
        // wrote into the directory you were standing in, is only explainable
        // afterwards, and this is the one line where it is cheap to say.
        note(
            `${bold(engine.name)} ${dim(where.created ? 'new session' : 'continuing')} ` +
                `${dim(engine.session.id)}`,
        );
        note(
            dim(
                `${where.freshWorkspace ? 'new directory' : 'workspace'} ` +
                    `${display(engine.workspace, cwd)}`,
            ),
        );
    }

    let outcome: Engine.RunOutcome;
    try {
        outcome = await Engine.run(engine, prompt, narrator.handle, stopping.signal);
    } finally {
        narrator.done();
        process.off('SIGINT', onInterrupt);
    }

    if (values.out) {
        await writeFile(values.out, `${outcome.text}\n`, 'utf8');
    }

    if (asJson) {
        json({
            session: { id: engine.session.id, dir: engine.session.dir },
            run: {
                id: outcome.run.id,
                dir: outcome.run.dir,
                input: outcome.run.input,
                output: outcome.run.output,
                state: outcome.run.state,
                meta: outcome.run.meta,
                ...(outcome.report ? { report: outcome.report } : {}),
            },
            mounts: Engine.mounts(engine),
            agent: outcome.result.agent,
            stopReason: outcome.result.stopReason,
            durationMs: outcome.durationMs,
            usage: outcome.result.usage,
            output: outcome.text,
        });
        return;
    }

    // --out is a destination, not a copy: the answer goes there instead of to
    // stdout, so a redirect and a file cannot both end up holding it.
    if (values.out) {
        note(dim(`answer: ${cyan(values.out)}`));
    } else {
        write(outcome.text);
    }

    note('');
    note(
        `${stopMark(outcome.result.stopReason)} ${dim(duration(outcome.durationMs))}  ` +
            dim(summary(outcome.result.usage)),
    );
    if (outcome.report) {
        note(dim(`report: ${cyan(display(outcome.report, cwd))}`));
    }
}
