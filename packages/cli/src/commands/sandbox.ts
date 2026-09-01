import { readProjectConfig } from '@zenera/neo';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { resolveBuild, type ResolvedBuild } from '../image.ts';
import { ensurePodmanReady, ownedContainers, podmanStatus, removeContainers } from '../podman.ts';
import { project as findProject } from '../resolve.ts';
import { bold, dim, green, json, note, red, usageError, write, yellow } from '../term.ts';

const USAGE = 'zen sandbox [status|up|pull|clean] [options]';

interface Flags {
    project?: string;
    image?: string;
}

// ---------------------------------------------------------------------------
// The container engine, on its own
//
// Everything here also happens inside `zen run`, and that is the point of
// having it: the slow, one-time, machine-wide half of a run is the half most
// likely to fail, and debugging it should not cost a model call. `up` is what
// you run on a new laptop; `status` is what you read when a run says the engine
// did not answer.
// ---------------------------------------------------------------------------

export const sandbox: Command = {
    summary: 'Check and prepare the container command-line tools run in.',
    usage: USAGE,
    details: [
        '  status                 What is installed, running and pulled. Changes nothing.',
        '  up                     Install if asked, start the machine, pull or build the image.',
        '  pull                   Just the image: pulled, or built from the project\u2019s Dockerfile.',
        '  clean                  Remove every container this CLI created.',
        '',
        '  --project <name|dir>   Which project the image comes from.',
        '  --image <ref>          Use this image instead of the project\u2019s.',
        '',
        'None of this is required. A run does all of it on its own, the first',
        'time an agent that can reach a shell is about to start one.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                image: { type: 'string' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'status';
        if (!['status', 'up', 'pull', 'clean'].includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        if (positionals.length > 1) {
            throw usageError('one subcommand at a time', USAGE);
        }

        const found = values.image ? undefined : await projectSandbox(ctx.cwd, values);
        const image = values.image ?? found?.image;
        const build = found?.build;

        switch (what) {
            case 'status':
                return status(image, build, ctx.json);
            case 'up':
                return up(image, build, ctx.json, ctx.json);
            case 'pull':
                return up(image, build, true, ctx.json, true);
            case 'clean':
                return clean(ctx.json);
        }
    },
};

/**
 * The project's image, when there is a project to ask. `zen sandbox status`
 * run from anywhere at all is still a useful thing, so failing to find one is
 * not a failure — it just means there is no image to report on. Notably this
 * does *not* go through `target`: reading a setting must not create a session.
 */
async function projectSandbox(
    cwd: string,
    values: Flags,
): Promise<{ image?: string; build?: ResolvedBuild } | undefined> {
    try {
        const found = await findProject({ cwd, project: values.project, yes: true });
        const { root, config } = readProjectConfig(found.dir);
        const build = resolveBuild(root, config.sandbox);
        return { image: build?.tag ?? config.sandbox?.image, build };
    } catch {
        return undefined;
    }
}

async function status(
    image: string | undefined,
    build: ResolvedBuild | undefined,
    asJson: boolean,
): Promise<void> {
    const found = await podmanStatus({ image });
    const containers = found.ready ? await ownedContainers(found.engine) : [];

    if (asJson) {
        json({ ...found, dockerfile: build?.dockerfile ?? null, containers });
        return;
    }

    const mark = (ok: boolean): string => (ok ? green('ok') : red('no'));
    write(
        `${bold('engine')}     ${found.engine} ${dim(found.version ?? '')} ${mark(found.installed)}`,
    );
    if (found.machine) {
        const state = found.machine.starting ? yellow('starting') : mark(found.machine.running);
        write(`${bold('machine')}    ${found.machine.name} ${state}`);
    }
    write(`${bold('responds')}   ${mark(found.ready)}`);
    if (found.image) {
        write(`${bold('image')}      ${found.image} ${mark(Boolean(found.imagePresent))}`);
    }
    if (build) {
        write(`${bold('dockerfile')} ${dim(build.dockerfile)}`);
    }
    const listed = containers.map((c) =>
        c.state === 'running' ? `${c.name} ${green('running')}` : `${c.name} ${dim(c.state)}`,
    );
    write(`${bold('containers')} ${listed.length ? listed.join(', ') : dim('none')}`);

    if (!found.installed || !found.ready) {
        note('');
        note(dim('run `zen sandbox up` to fix what can be fixed.'));
    }
}

async function up(
    image: string | undefined,
    build: ResolvedBuild | undefined,
    yes: boolean,
    asJson: boolean,
    rebuild = false,
): Promise<void> {
    await ensurePodmanReady({ image, build, yes, rebuild });
    if (asJson) {
        json({ ready: true, image, dockerfile: build?.dockerfile ?? null });
        return;
    }
    write(`${green('ready')}${image ? ` ${dim(image)}` : ''}`);
}

async function clean(asJson: boolean): Promise<void> {
    const names = (await ownedContainers()).map((c) => c.name);
    await removeContainers(names);
    if (asJson) {
        json({ removed: names });
        return;
    }
    write(names.length ? `removed ${names.length}: ${names.join(', ')}` : dim('nothing to remove'));
}
