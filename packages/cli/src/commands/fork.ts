import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { nextVersion, versionDir, versions, writeMeta } from '../projects.ts';
import { project as resolveProject } from '../resolve.ts';
import { bold, cyan, dim, green, json, note, usageError, write } from '../term.ts';

const USAGE = 'zn fork [--from <vN>] [--project <name|dir>] [--keep-active]';

interface Flags {
    from?: string;
    project?: string;
    'keep-active'?: boolean;
}

/**
 * Prompts and skills are copied; sessions are not. A version is a definition of
 * how the agents behave, and a session is a conversation that happened under a
 * particular definition — carrying one into the other would produce a history
 * that no longer matches the thing that produced it.
 */
const SKIP = new Set(['sessions']);

export const fork: Command = {
    summary: 'Copy the active version to the next one and make it active.',
    usage: USAGE,
    details: [
        'Copies AGENTS.md, agents.yaml and .agents/ into the next vN.',
        'Sessions stay with the version that produced them.',
    ],
    run: async (ctx) => {
        const { values } = parse<Flags>(
            ctx.args,
            {
                from: { type: 'string' },
                project: { type: 'string' },
                'keep-active': { type: 'boolean' },
            },
            USAGE,
        );

        const project = await resolveProject({ cwd: ctx.cwd, project: values.project });
        const from = versionDir(project, values.from);
        const name = nextVersion(project.dir);
        const to = join(project.dir, name);

        if (existsSync(to)) {
            throw usageError(
                `${name} already exists`,
                `versions: ${versions(project.dir).join(', ')}`,
            );
        }

        try {
            cpSync(from, to, {
                recursive: true,
                // A copy is a new definition, not a snapshot of a moment: a
                // dangling link in the source must not become a dangling link
                // in something that is about to be edited.
                dereference: true,
                filter: (src) => !SKIP.has(src.slice(from.length + 1).split('/')[0]),
            });
        } catch (err) {
            rmSync(to, { recursive: true, force: true });
            throw err;
        }

        if (!values['keep-active']) {
            writeMeta(project.dir, { ...project.meta, activeVersion: name });
        }

        if (ctx.json) {
            json({
                project: project.meta.name,
                from: values.from ?? project.meta.activeVersion,
                to: name,
                path: to,
                active: values['keep-active'] ? project.meta.activeVersion : name,
            });
            return;
        }

        note(
            `${green('forked')} ${bold(project.meta.name)} ${dim(`${values.from ?? project.meta.activeVersion} → ${name}`)}`,
        );
        if (!values['keep-active']) {
            note(`${name} is now active`);
        }
        note(dim(`edit it: ${cyan(`zn go ${project.meta.name}`)}`));
        write(to);
    },
};
