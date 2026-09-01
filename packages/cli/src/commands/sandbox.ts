import { readProjectConfig } from '@zenera/neo';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { resolveBuild, type ResolvedBuild } from '../image.ts';
import {
    engineDisk,
    ensurePodmanReady,
    ownedContainers,
    podmanStatus,
    removeContainers,
    type EngineDisk,
    type OwnedContainer,
} from '../podman.ts';
import { dirSize, isProjectDir, Registry, sessionIds } from '../projects.ts';
import { project as findProject } from '../resolve.ts';
import {
    ago,
    bold,
    bytes,
    dim,
    green,
    json,
    note,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen sandbox [status|up|pull|clean|disk] [options]';

/** Enough to see the pattern; the rest are a number. */
const LISTED = 6;
/** Under the labels, which is where the eye already is. */
const INDENT = ' '.repeat(11);

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
        '  disk                   What the engine and every known project occupy.',
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
        if (!['status', 'up', 'pull', 'clean', 'disk'].includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        if (positionals.length > 1) {
            throw usageError('one subcommand at a time', USAGE);
        }

        // `clean` and `disk` are machine-wide questions, so asking which
        // project they mean would be asking something they do not use.
        const scoped = what === 'status' || what === 'up' || what === 'pull';
        const found = values.image || !scoped ? undefined : await projectSandbox(ctx.cwd, values);
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
            case 'disk':
                return disk(ctx.json);
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
    writeAll(containerLines(containers));

    if (!found.installed || !found.ready) {
        note('');
        note(dim('run `zen sandbox up` to fix what can be fixed.'));
    }
}

/**
 * One per line rather than one long line, because there is normally more than
 * one and the interesting part — how old, and whether anything is still up —
 * is at the end of a name too long to scan.
 *
 * The trailing note is there because the count surprises people: a container
 * is per *session*, not per project, and `persist: true` is what leaves the
 * stopped ones behind.
 */
function containerLines(containers: readonly OwnedContainer[]): string[] {
    if (containers.length === 0) {
        return [`${bold('containers')} ${dim('none')}`];
    }
    const running = containers.filter((c) => c.state === 'running').length;
    const head = `${bold('containers')} ${containers.length} ${dim(
        running ? `· ${running} running` : '· none running',
    )}`;
    const rows = containers
        .slice(0, LISTED)
        .map((c) => [
            INDENT.slice(2),
            c.name,
            c.state === 'running' ? green('running') : dim(c.state),
            dim(ago(c.createdAt)),
        ]);
    const rest = containers.length - LISTED;
    return [
        head,
        ...table(rows),
        ...(rest > 0 ? [`${INDENT}${dim(`+${rest} more`)}`] : []),
        `${INDENT}${dim('one per session, kept by `persist: true` — see: zen sandbox disk')}`,
    ];
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
    const containers = await ownedContainers(undefined, undefined, { sizes: true });
    const names = containers.map((c) => c.name);
    const freed = containers.reduce((n, c) => n + (c.size ?? 0), 0);
    await removeContainers(names);
    if (asJson) {
        json({ removed: names, freed });
        return;
    }
    if (names.length === 0) {
        write(dim('nothing to remove'));
        return;
    }
    write(`removed ${names.length} ${dim(`· ${bytes(freed)} freed`)}`);
    write(dim('images are left alone — see: zen sandbox disk'));
}

// ---------------------------------------------------------------------------
// Where the disk went
//
// Two questions that look like one. The engine holds images and container
// layers inside its machine; a project holds sessions — workspaces, blobs,
// memory — in its own directory on the host. Removing a container reclaims
// only the first, and a report that added them into one number would suggest
// otherwise.
// ---------------------------------------------------------------------------

interface ProjectDisk {
    name: string;
    path: string;
    present: boolean;
    sessions: number;
    /** the project directory on the host */
    files: number;
    containers: number;
    /** what those containers have written on top of their image */
    layers: number;
}

async function disk(asJson: boolean): Promise<void> {
    const found = await podmanStatus();
    const [usage, containers] = found.ready
        ? await Promise.all([
              engineDisk(found.engine),
              ownedContainers(found.engine, undefined, { sizes: true }),
          ])
        : [undefined, [] as OwnedContainer[]];
    const { projects, loose } = await projectDisk(containers);

    if (asJson) {
        json({ engine: found.engine, ready: found.ready, ...usage, projects, unclaimed: loose });
        return;
    }

    if (usage) {
        write(`${bold('engine')} ${found.engine} ${dim(found.version ?? '')}`);
        writeAll(engineRows(usage));
        write('');
    } else {
        write(dim(`${found.engine} did not answer — projects only`));
        write('');
    }
    writeAll(projectRows(projects, loose));

    if (usage && usage.images.reclaimable > 0) {
        write('');
        write(dim(`zen sandbox clean       every container above`));
        write(dim(`podman image prune -a   ${bytes(usage.images.reclaimable)} of unused images`));
    }
}

function engineRows(usage: EngineDisk): string[] {
    // Dimming an empty cell is not empty: it is two escape codes of nothing,
    // which `table` cannot trim and which leave trailing whitespace behind.
    const hint = (s: string): string => (s ? dim(s) : '');
    const rows = [
        [
            bold('images'),
            String(usage.images.count),
            bytes(usage.images.size),
            hint(usage.images.reclaimable > 0 ? `${bytes(usage.images.reclaimable)} unused` : ''),
        ],
        [
            bold('containers'),
            String(usage.containers.count),
            bytes(usage.containers.size),
            hint(usage.containers.active > 0 ? `${usage.containers.active} running` : ''),
        ],
        [bold('volumes'), String(usage.volumes.count), bytes(usage.volumes.size), ''],
    ];
    if (usage.store) {
        rows.push([
            bold('store'),
            '',
            bytes(usage.store.used),
            hint(`of ${bytes(usage.store.capacity)}`),
        ]);
    }
    if (usage.image) {
        // The one number that is actually gone from this host's disk. It is
        // larger than the store's own `used` because freeing blocks inside the
        // machine does not hand them back until something trims them.
        rows.push([
            bold('on this host'),
            '',
            bytes(usage.image.allocated),
            hint(`${usage.image.name} disk image, which never shrinks on its own`),
        ]);
    }
    return table(rows);
}

function projectRows(projects: readonly ProjectDisk[], loose: readonly OwnedContainer[]): string[] {
    if (projects.length === 0 && loose.length === 0) {
        return [dim('no projects yet')];
    }
    const rows: string[][] = [
        [
            bold('PROJECT'),
            bold('SESSIONS'),
            bold('ON DISK'),
            bold('CONTAINERS'),
            bold('IN PODMAN'),
            '',
        ],
    ];
    for (const p of projects) {
        const style = p.present ? (s: string) => s : dim;
        rows.push([
            style(p.name),
            style(String(p.sessions)),
            style(bytes(p.files)),
            style(p.containers ? String(p.containers) : dim('—')),
            style(p.layers ? bytes(p.layers) : dim('—')),
            p.present ? '' : dim('(missing)'),
        ]);
    }
    if (loose.length > 0) {
        // Containers whose session directory is gone, and faker's, which are
        // labelled the same way and belong to no project at all.
        const size = loose.reduce((n, c) => n + (c.size ?? 0), 0);
        rows.push([
            dim('(unclaimed)'),
            dim('—'),
            dim('—'),
            dim(String(loose.length)),
            dim(bytes(size)),
            dim('no session owns these'),
        ]);
    }
    const total = (pick: (p: ProjectDisk) => number): number =>
        projects.reduce((n, p) => n + pick(p), 0);
    rows.push([
        bold('total'),
        bold(String(total((p) => p.sessions))),
        bold(bytes(total((p) => p.files))),
        bold(String(total((p) => p.containers) + loose.length)),
        bold(bytes(total((p) => p.layers) + loose.reduce((n, c) => n + (c.size ?? 0), 0))),
        '',
    ]);
    return table(rows);
}

/**
 * Containers carry the session id that made them, and a session id is a
 * directory name under a project — so the label is enough to attribute one,
 * with no second index to keep in step with reality.
 */
async function projectDisk(
    containers: readonly OwnedContainer[],
): Promise<{ projects: ProjectDisk[]; loose: OwnedContainer[] }> {
    const registry = await Registry.open();
    const claimed = new Set<string>();
    const projects: ProjectDisk[] = [];

    for (const entry of registry.entries) {
        const present = isProjectDir(entry.path);
        const sessions = new Set(present ? sessionIds(entry.path) : []);
        const mine = containers.filter((c) => c.key !== undefined && sessions.has(c.key));
        for (const c of mine) {
            claimed.add(c.name);
        }
        projects.push({
            name: entry.name,
            path: entry.path,
            present,
            sessions: sessions.size,
            files: present ? dirSize(entry.path) : 0,
            containers: mine.length,
            layers: mine.reduce((n, c) => n + (c.size ?? 0), 0),
        });
    }

    // By the column that is shown, so the order is one a reader can check.
    projects.sort((a, b) => b.files - a.files);
    return { projects, loose: containers.filter((c) => !claimed.has(c.name)) };
}
