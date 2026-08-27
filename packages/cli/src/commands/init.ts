import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { ensureHome } from '../home.ts';
import { KeyStore, PROVIDERS, SHAPES } from '../keys.ts';
import { META, Registry, nextVersion, readMeta, writeMeta } from '../projects.ts';
import { copilotInstructions, editorSettings, scaffold } from '../scaffold.ts';
import { bold, cyan, dim, green, invalidError, json, note, usageError, write } from '../term.ts';

const USAGE = 'zen init [dir] [--name <name>] [--model <ref>] [--force]';

interface Flags {
    name?: string;
    model?: string;
    force?: boolean;
}

/**
 * A default that works on the machine it is run on. Guessing OpenAI when only
 * an Anthropic key exists produces a project that scaffolds cleanly and fails
 * on its first run, which is the worst possible moment to find out.
 */
function suggestModel(store: KeyStore): string {
    const reachable = PROVIDERS.find(
        (p) => process.env[SHAPES[p].env] || store.active(p) !== undefined,
    );
    switch (reachable) {
        case 'anthropic':
            return 'claude-sonnet-4-5';
        case 'google':
        case 'vertex':
            return 'gemini-2.5-flash';
        default:
            return 'gpt-5';
    }
}

export const init: Command = {
    summary: 'Create a project here, or in <dir>, and register it.',
    usage: USAGE,
    details: [
        'Writes AGENTS.md, agents.yaml and agents/ into v1, then records the',
        'directory so `zen list` and `zen go` can find it by name. Editor files',
        '(.vscode/settings.json, .github/copilot-instructions.md) are written',
        'alongside, and never overwritten.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                name: { type: 'string' },
                model: { type: 'string' },
                force: { type: 'boolean' },
            },
            USAGE,
        );

        const dir = resolve(ctx.cwd, one(positionals, 'directory', USAGE) ?? '.');
        const name = values.name ?? basename(dir);

        if (await readMeta(dir)) {
            throw invalidError(`${dir} is already a project`, 'add a version with: zen fork');
        }
        if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) {
            throw usageError(`${dir} is not empty`, 'pass --force to write into it anyway');
        }

        ensureHome();
        const store = await KeyStore.open();
        const version = nextVersion(dir);
        const versionDir = join(dir, version);
        const written = scaffold({ dir: versionDir, model: values.model ?? suggestModel(store) });
        writeMeta(dir, { version: 1, name, activeVersion: version });

        // A second copy at the top, for `zen open --root` and for anyone who
        // opens the project rather than the version: the editor only reads the
        // settings and instructions of the folder it was opened on.
        const files = [META, ...written.map((f) => join(version, f))];
        const root = [editorSettings(dir), copilotInstructions(dir)].filter((f) => f !== undefined);
        files.splice(1, 0, ...root);

        const registry = await Registry.open();
        registry.add(name, dir);
        registry.save();

        if (ctx.json) {
            json({ name, path: dir, version, files });
            return;
        }

        note(`${green('created')} ${bold(name)} ${dim(dir)}`);
        for (const file of files) {
            note(`  ${dim(file)}`);
        }
        note();
        note(`Next: ${cyan(`cd ${dir}`)} then ${cyan('zen run')}`);
        write(dir);
    },
};
