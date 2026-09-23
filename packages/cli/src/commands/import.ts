import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
    ENV_EXAMPLE,
    extractArchive,
    readManifest,
    safeName,
    type ArchiveManifest,
} from '../archive.ts';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { ENV_FILE } from '../env.ts';
import { isProjectDir, Registry } from '../projects.ts';
import {
    bold,
    count,
    cyan,
    dim,
    green,
    bytes as human,
    invalidError,
    json,
    note,
    progress,
    usageError,
    warn,
} from '../term.ts';

const USAGE = 'zen import <file.zip> [dir] [--name <name>] [--force] [--no-register]';

interface Flags {
    name?: string;
    force?: boolean;
    'no-register'?: boolean;
}

// ---------------------------------------------------------------------------
// zen import
//
// The other half of `zen export`, and the half that has to be suspicious. An
// archive is a file somebody sent, and everything in it is a claim: the paths
// it says to write, the sizes it says they unpack to, the modes it says they
// carry. The checks for all three live in archive.ts, next to the code that
// writes them, because a guard that lives apart from the thing it guards is a
// guard that drifts.
//
// The rule this command is built on: nothing in the archive is executed. It
// carries a `scripts/` tree, a Dockerfile and a `.github/` tree, and every one
// of those is something a machine could be talked into running on arrival.
// So this writes files, registers a name, and prints the commands you would
// type next — which you can read first, because they are on your screen and
// not in somebody else's zip.
// ---------------------------------------------------------------------------

export const unpack: Command = {
    summary: 'Unpack a project archive written by zen export.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Import', subtitle: 'Project Archive', hue: 'violet' },
    details: [
        'Unpacks into ./<project> unless a directory is named. A directory',
        'that already has something in it is refused; --force writes over it.',
        '',
        'The project is registered under the name in the archive, so `zen list`',
        'and `zen open` find it straight away. --name registers it under a',
        'different one, which is also what to use when that name is taken.',
        '--no-register unpacks and leaves the registry alone.',
        '',
        `Credentials are not in the archive. ${ENV_EXAMPLE} names what the`,
        `project needs: copy it to ${ENV_FILE} and fill it in.`,
        '',
        'Nothing in the archive is run — not the setup script, not the',
        'Dockerfile, not a single line of the .github/ tree. The commands to',
        'run next are printed for you to read and type.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                name: { type: 'string' },
                force: { type: 'boolean' },
                'no-register': { type: 'boolean' },
            },
            USAGE,
        );
        if (positionals.length === 0) {
            throw usageError('no archive named', USAGE);
        }
        if (positionals.length > 2) {
            throw usageError(
                `expected an archive and a directory, got ${positionals.length}`,
                USAGE,
            );
        }

        const file = at(ctx.cwd, positionals[0]);
        if (!existsSync(file)) {
            throw usageError(`no such file: ${file}`);
        }
        const manifest = await readManifest(file);
        const name = named(values.name, manifest);
        const into = positionals[1] ? at(ctx.cwd, positionals[1]) : join(ctx.cwd, name);

        empty(into, values.force === true);

        const bar = ctx.json ? undefined : progress();
        let done = 0;
        const taken = await extractArchive({
            file,
            into,
            root: manifest.root,
            onFile: (rel) => {
                done += 1;
                bar?.update(`unpacking ${done}/${manifest.files} ${dim(rel)}`);
            },
        });
        bar?.done();

        if (!isProjectDir(into)) {
            warn(`${into} has no agents.yaml — the archive did not hold a whole project`);
        }

        const registered = values['no-register'] !== true && (await register(name, into, ctx.json));

        if (ctx.json) {
            json({
                dir: into,
                name,
                files: taken.files,
                bytes: taken.bytes,
                registered,
                from: {
                    project: manifest.name,
                    exportedAt: manifest.exportedAt,
                    cli: manifest.cli,
                },
                vectors: manifest.vectors,
                memory: manifest.memory,
            });
            return;
        }
        report(name, into, taken.files, taken.bytes, registered, manifest);
    },
};

// ---------------------------------------------------------------------------
// Where it lands
// ---------------------------------------------------------------------------

const at = (cwd: string, path: string): string =>
    resolve(isAbsolute(path) ? path : join(cwd, path));

/**
 * The name it is registered under. `--name` wins, because the archive's own
 * may already belong to something on this machine — and because it arrived
 * from elsewhere, it is checked before it becomes a directory or a key.
 */
function named(wanted: string | undefined, manifest: ArchiveManifest): string {
    const name = safeName(wanted ?? manifest.name);
    if (!name) {
        throw usageError(`"${wanted}" is not a usable project name`, USAGE);
    }
    return name;
}

/**
 * A target with files in it is refused rather than merged. Unpacking over a
 * project leaves a tree that is neither archive nor original — every file the
 * archive holds replaced, every file it does not still there — and there is no
 * reading of that which is useful. `--force` is the way to say you meant it.
 */
function empty(into: string, force: boolean): void {
    if (!existsSync(into)) {
        return;
    }
    const held = readdirSync(into).filter((entry) => entry !== '.DS_Store');
    if (held.length === 0 || force) {
        return;
    }
    throw invalidError(
        `${into} is not empty`,
        'name another directory, or overwrite what is there with --force',
    );
}

/** Registration is a convenience; a name already taken is not a failed import. */
async function register(name: string, dir: string, quiet: boolean): Promise<boolean> {
    try {
        const registry = await Registry.open();
        registry.add(name, dir);
        registry.save();
        return true;
    } catch (err) {
        if (!quiet) {
            warn(
                `${(err as Error).message} — the project is on disk, ` +
                    `register it with: zen init ${dir} --name <other>`,
            );
        }
        return false;
    }
}

// ---------------------------------------------------------------------------
// What to do next
// ---------------------------------------------------------------------------

function report(
    name: string,
    into: string,
    files: number,
    size: number,
    registered: boolean,
    manifest: ArchiveManifest,
): void {
    note(`${green('unpacked')} ${bold(name)} ${dim(into)}`);
    note(dim(`${count(files, 'file')}, ${human(size)}, exported by zen ${manifest.cli}`));
    if (!registered) {
        note(dim('not registered — reach it by path'));
    }
    note();
    note(bold('next'));
    if (existsSync(join(into, ENV_EXAMPLE))) {
        note(`  ${cyan(`cp ${ENV_EXAMPLE} ${ENV_FILE}`)} ${dim('and fill in the credentials')}`);
    }
    if (!manifest.vectors) {
        note(
            `  ${cyan('zen rag <subject> restore')} ` +
                dim('— the vectors did not travel, and nothing searches until they are back'),
        );
    }
    note(`  ${cyan(`zen check ${name}`)} ${dim('— what this machine is still missing')}`);
    note(`  ${cyan(`zen open ${name}`)}`);
    note();
    note(dim('nothing in the archive has been run. scripts/ and .github/ are worth a read.'));
}
