import { loadProject, type AgentProject } from 'zenera-neo';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { KeyStore, PROVIDERS, SHAPES } from '../keys.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    bold,
    credentialError,
    cyan,
    dim,
    green,
    invalidError,
    json,
    note,
    red,
    table,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen models [--project <name|dir>]';

interface Flags {
    project?: string;
}

/**
 * Everything a run would resolve, resolved — and nothing called. Loading a
 * project constructs the model clients, so a config that names an impossible
 * provider or an agent that hands off to nobody fails here, in a command that
 * costs nothing, instead of three seconds into a run that costs money.
 */
export const models: Command = {
    summary: 'Resolve providers and models and validate the config, calling nothing.',
    usage: USAGE,
    run: async (ctx) => {
        const { values } = parse<Flags>(ctx.args, { project: { type: 'string' } }, USAGE);

        const found = await resolveProject({ cwd: ctx.cwd, project: values.project });
        const dir = found.dir;

        const store = await KeyStore.open();
        // Asked before materialising, because materialising is exactly what
        // erases the difference between "the environment had it" and "the
        // keyring supplied it".
        const fromEnv = new Set(PROVIDERS.filter((p) => process.env[SHAPES[p].env]));
        store.materialize();

        let project: AgentProject;
        try {
            project = await loadProject(dir);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Constructing a client needs a credential, so a keyless machine
            // cannot get far enough to validate anything. Saying "invalid
            // project" there would be a lie about whose fault it is.
            if (!fromEnv.size && !PROVIDERS.some((p) => store.active(p))) {
                throw credentialError(message, 'add a key: zen key add openai');
            }
            throw invalidError(message, dir);
        }

        const agents = project.agents.map((a) => ({
            name: a.name,
            entry: a.name === project.entry,
            model: a.model?.id ?? project.config.model ?? null,
            tools: a.tools.map((t) => t.name),
            handoffs: a.handoffs,
        }));

        const credentials = PROVIDERS.map((p) => ({
            provider: p,
            env: SHAPES[p].env,
            source: fromEnv.has(p)
                ? ('environment' as const)
                : store.active(p)
                  ? ('keyring' as const)
                  : ('missing' as const),
        }));

        if (ctx.json) {
            json({
                project: found.meta.name,
                source: project.source,
                providers: project.models.names(),
                agents,
                credentials,
            });
            return;
        }

        note(`${bold(found.meta.name)} ${dim(project.source)}`);
        note('');
        note(bold('Agents'));
        writeAll(
            table(
                agents.map((a) => [
                    `  ${a.entry ? green('→') : ' '} ${a.name}`,
                    cyan(a.model ?? dim('inherited')),
                    dim(a.tools.length ? a.tools.join(' ') : 'no tools'),
                    dim(a.handoffs.length ? `→ ${a.handoffs.join(', ')}` : ''),
                ]),
            ),
        );

        note('');
        note(bold('Credentials'));
        writeAll(
            table(
                credentials.map((c) => [
                    `  ${c.provider}`,
                    dim(c.env),
                    c.source === 'missing' ? red('missing') : green(c.source),
                ]),
            ),
        );

        const declared = project.models.names();
        if (declared.length) {
            note('');
            note(`${bold('Providers')} ${dim(declared.join(', '))}`);
        }
        if (credentials.every((c) => c.source === 'missing')) {
            note('');
            note(yellow('nothing can be reached — add a key: zen key add openai'));
        }
    },
};
