import { loadProject, readProjectConfig, type AgentProject } from '@zenera/neo';
import { one, parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { envNames, form, KeyStore, PROVIDERS, type Liveness } from '../keys.ts';
import { probeModels, type ModelProbe, type ModelTarget } from '../liveness.ts';
import { duration } from '../narrate.ts';
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
    progress,
    red,
    table,
    writeAll,
    yellow,
} from '../term.ts';
import { availableTools } from '../validate.ts';

const USAGE = 'zen models [name|dir] [--project <name|dir>] [--check]';

interface Flags {
    project?: string;
    check?: boolean;
}

const MARK: Record<Liveness, string> = {
    live: green('live'),
    dead: red('dead'),
    unknown: dim('unknown'),
};

/**
 * Everything a run would resolve, resolved — and, by default, nothing called.
 * Loading a project constructs the model clients, so a config that names an
 * impossible provider or an agent that hands off to nobody fails here, in a
 * command that costs nothing, instead of three seconds into a run that costs
 * money.
 *
 * `--check` is the one thing that spends: a credential that authenticates says
 * nothing about the model id it is spent on, and only the model can answer
 * whether it will serve this account today.
 */
export const models: Command = {
    summary: 'Resolve providers and models and validate the config; --check asks them.',
    usage: USAGE,
    details: [
        'The argument is a registered project name or a directory; with neither,',
        'the project you are standing in, and failing that you are asked.',
        '',
        '--check sends one tiny request to every distinct model and embedding the',
        'project would use — a few tokens apiece, and the only way to learn that a',
        'model id is misspelt, retired, or not granted to this account. A model the',
        'provider refuses is an error; one it never answered for is a warning.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            { project: { type: 'string' }, check: { type: 'boolean' } },
            USAGE,
        );

        const found = await resolveProject({
            cwd: ctx.cwd,
            project: values.project ?? one(positionals, 'project or directory', USAGE),
        });
        const dir = found.dir;

        const store = await KeyStore.open();
        // Asked before materialising, because materialising is exactly what
        // erases the difference between "the environment had it" and "the
        // keyring supplied it".
        const fromEnv = new Set(
            PROVIDERS.filter((p) => envNames(p).some((name) => process.env[name])),
        );
        store.materialize();

        let project: AgentProject;
        try {
            // The same tools a run would register. Without them every
            // `workspace:*` or `sandbox:*` selector in the config resolves
            // against an empty list and the project fails to load with
            // "no tools in group" — a report about this command, not about
            // the project.
            const { config } = readProjectConfig(dir);
            project = await loadProject(dir, { tools: availableTools(dir, config) });
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

        // Resolved through the registry, which proves the ref parses and the
        // provider exists without any call being made.
        const embeddings = Object.keys(project.config.embeddings ?? {})
            .concat(
                project.config.embedding && !project.config.embeddings?.[project.config.embedding]
                    ? [project.config.embedding]
                    : [],
            )
            .map((name) => ({
                name,
                model: project.embedder(name)?.id ?? null,
                default: name === project.config.embedding,
            }));

        const credentials = PROVIDERS.map((p) => ({
            provider: p,
            env: envNames(p).find((name) => process.env[name]) ?? form(p).env,
            source: fromEnv.has(p)
                ? ('environment' as const)
                : store.active(p)
                  ? ('keyring' as const)
                  : ('missing' as const),
        }));

        const checks = values.check
            ? await checkAll(ctx, targetsOf(project, embeddings))
            : undefined;

        if (ctx.json) {
            json({
                project: found.name,
                source: project.source,
                providers: project.models.names(),
                agents,
                embeddings,
                credentials,
                ...(checks ? { checks } : {}),
            });
            return report(checks);
        }

        note(`${bold(found.name)} ${dim(project.source)}`);
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

        if (embeddings.length) {
            note('');
            note(bold('Embeddings'));
            writeAll(
                table(
                    embeddings.map((e) => [
                        `  ${e.default ? green('→') : ' '} ${e.name}`,
                        cyan(e.model ?? dim('unresolved')),
                    ]),
                ),
            );
        }

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

        if (checks) {
            note('');
            note(bold('Checked'));
            writeAll(
                table(
                    checks.map((c) => [
                        `  ${c.ref}`,
                        cyan(c.id),
                        dim(c.kind === 'embedding' ? 'embedding' : ''),
                        MARK[c.check.state],
                        dim(c.check.detail ?? duration(c.ms)),
                    ]),
                ),
            );
        }

        const declared = project.models.names();
        if (declared.length) {
            note('');
            note(`${bold('Providers')} ${dim(declared.join(', '))}`);
        }
        if (credentials.every((c) => c.source === 'missing')) {
            note('');
            note(yellow('nothing can be reached — add a key: zen key add openai'));
        }
        report(checks);
    },
};

/**
 * The distinct things a run would actually call. Two agents sharing a model
 * share the answer too, so the list is by reference rather than by agent —
 * asking the same model twice costs twice and says the same thing.
 */
function targetsOf(project: AgentProject, embeddings: readonly { name: string }[]): ModelTarget[] {
    const found = new Map<string, ModelTarget>();
    const pinned = new Map(project.config.agents.map((a) => [a.name, a.model]));
    for (const agent of project.agents) {
        const ref = pinned.get(agent.name) ?? project.config.model;
        if (agent.model && ref) {
            found.set(`model:${ref}`, { ref, kind: 'model', model: agent.model });
        }
    }
    for (const { name } of embeddings) {
        const embedder = project.embedder(name);
        if (embedder) {
            found.set(`embedding:${name}`, { ref: name, kind: 'embedding', embedder });
        }
    }
    return [...found.values()];
}

/** A round trip apiece, so it says which ones have come back. */
async function checkAll(ctx: Context, targets: readonly ModelTarget[]): Promise<ModelProbe[]> {
    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`asking ${targets.length} model${targets.length === 1 ? '' : 's'} …`));
    try {
        return await probeModels(targets, (target, done, total) =>
            bar?.update(dim(`asked ${target.ref} … ${done}/${total}`)),
        );
    } finally {
        bar?.done();
    }
}

/**
 * A refusal is the project's problem, so it is an error; silence is the
 * network's, so it is a warning — the same distinction the probe itself draws,
 * carried through to the exit code.
 */
function report(checks: ModelProbe[] | undefined): void {
    if (!checks) {
        return;
    }
    const refused = checks.filter((c) => c.check.state === 'dead');
    if (refused.length) {
        throw invalidError(
            `${refused.map((c) => c.ref).join(', ')} — refused by the provider`,
            'fix the model reference in agents.yaml, or the credential behind it',
        );
    }
    if (checks.some((c) => c.check.state === 'unknown')) {
        note(yellow('some models could not be reached'));
    }
}
