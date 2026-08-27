import { writeFile } from 'node:fs/promises';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import * as Engine from '../engine.ts';
import { duration, Narrator, stopMark, summary } from '../narrate.ts';
import * as Projects from '../projects.ts';
import { target } from '../resolve.ts';
import { display } from '../session.ts';
import { bold, cyan, dim, json, note, readStdin, usageError, write } from '../term.ts';
import { parseChoice } from '../tui/theme.ts';

const USAGE = 'zen run [project] [prompt] [options]';

interface Flags {
    project?: string;
    session?: string;
    new?: boolean;
    workspace?: string;
    model?: string;
    image?: string;
    'read-only'?: boolean;
    yes?: boolean;
    quiet?: boolean;
    plain?: boolean;
    theme?: string;
    out?: string;
}

export const run: Command = {
    summary: 'Run the project — the TUI on a terminal, one shot otherwise.',
    usage: USAGE,
    details: [
        '  --project <name|dir>   Which project. Inferred from the directory.',
        '  --session <id>         Continue a particular session.',
        '  --new                  Start a fresh one.',
        '  --workspace <dir>      What the agent can read and write.',
        '  --model <ref>          Override the default model.',
        '  --image <ref>          Override the sandbox image commands run in.',
        '  --read-only            Give the agent no way to write.',
        '  --quiet                Answer only; no narration.',
        '  --plain                One shot, even on a terminal.',
        '  --theme <dark|light>   Force the palette. Detected otherwise; $ZENERA_THEME.',
        '  --out <file>           Write the answer here as well as to stdout.',
        '  --yes                  Accept the questions this would otherwise ask.',
        '',
        'The first word is the project when it names one, as in `zen run acme`,',
        'and the first word of the prompt when it does not. --project settles it.',
        '',
        'The prompt comes from the argument, or stdin, or the TUI. There is no',
        '`resume`: a session continues itself, because its state is what it is.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                session: { type: 'string' },
                new: { type: 'boolean' },
                workspace: { type: 'string' },
                model: { type: 'string' },
                image: { type: 'string' },
                'read-only': { type: 'boolean' },
                yes: { type: 'boolean' },
                quiet: { type: 'boolean' },
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

        const where = await target({
            cwd: ctx.cwd,
            project: values.project ?? (named ? head : undefined),
            session: values.session,
            fresh: values.new,
            workspace: values.workspace,
            yes: values.yes,
        });

        const engine = await Engine.open({
            project: where.project,
            session: where.session,
            readOnly: values['read-only'],
            model: values.model,
            image: values.image,
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
                !values.quiet &&
                !ctx.json &&
                Boolean(process.stdout.isTTY && process.stdin.isTTY);

            if (drawing) {
                const { start } = await import('../tui/app.tsx');
                await start(engine, {
                    readOnly: Boolean(values['read-only']),
                    theme: values.theme,
                });
                return;
            }

            if (!prompt) {
                throw usageError('nothing to ask', 'give a prompt, or pipe one in');
            }
            await once(engine, prompt, values, ctx.json, ctx.cwd);
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
): Promise<void> {
    const narrator = new Narrator({
        quiet: Boolean(values.quiet) || asJson,
        live: Boolean(process.stderr.isTTY),
    });

    // Ctrl-C asks the run to stop rather than killing the process, so the turn
    // still lands on disk and the session stays resumable.
    const stopping = new AbortController();
    const onInterrupt = (): void => stopping.abort();
    process.once('SIGINT', onInterrupt);

    if (!values.quiet && !asJson) {
        note(
            `${bold(engine.name)} ${dim(engine.session.id)} ` + dim(display(engine.workspace, cwd)),
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
            session: engine.session.id,
            run: outcome.run.id,
            agent: outcome.result.agent,
            stopReason: outcome.result.stopReason,
            durationMs: outcome.durationMs,
            usage: outcome.result.usage,
            output: outcome.text,
            report: outcome.run.report,
        });
        return;
    }

    write(outcome.text);

    if (!values.quiet) {
        note('');
        note(
            `${stopMark(outcome.result.stopReason)} ${dim(duration(outcome.durationMs))}  ` +
                dim(summary(outcome.result.usage)),
        );
        if (outcome.report) {
            note(dim(`report: ${cyan(display(outcome.report, cwd))}`));
        }
    }
}
