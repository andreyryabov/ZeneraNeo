import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { ensureHome } from '../home.ts';
import { KeyStore, PROVIDERS, SHAPES, type Provider } from '../keys.ts';
import { probeAll } from '../liveness.ts';
import { isProjectDir, Registry } from '../projects.ts';
import { scaffold } from '../scaffold.ts';
import {
    bold,
    cyan,
    dim,
    green,
    invalidError,
    json,
    note,
    usageError,
    write,
    yellow,
} from '../term.ts';

const USAGE = 'zen init [dir] [--name <name>] [--model <ref>] [--force]';

interface Flags {
    name?: string;
    model?: string;
    force?: boolean;
}

/** The model each provider gets scaffolded with, when it is the one chosen. */
const DEFAULT_MODEL: Record<Provider, string> = {
    openai: 'gpt-5.4-mini',
    anthropic: 'claude-sonnet-4-5',
    google: 'gemini-3.5-flash',
    vertex: 'gemini-3.5-flash',
    openrouter: 'openrouter:inclusionai/ling-3.0-flash-fin:free',
};

/**
 * The provider this machine can actually reach.
 *
 * Holding a key is not the same as holding a working one, so stored
 * credentials are asked rather than counted: guessing OpenAI when only a
 * revoked OpenAI key exists produces a project that scaffolds cleanly and
 * fails on its first run, which is the worst possible moment to find out. A
 * key that came from the environment is taken at its word — the user set it
 * deliberately, and there is no entry to record a verdict against.
 *
 * `dead` is a verdict; `unknown` only means the provider could not be asked, so
 * it is still worth scaffolding around rather than refusing to choose because
 * the wifi is down.
 */
async function reachableProvider(store: KeyStore): Promise<Provider | undefined> {
    const fromEnv = PROVIDERS.find((p) => process.env[SHAPES[p].env]);
    if (fromEnv) {
        return fromEnv;
    }

    const active = PROVIDERS.map((p) => store.active(p)).filter((e) => e !== undefined);
    if (active.length === 0) {
        return undefined;
    }

    const checks = await probeAll(store, active);
    for (const [entry, check] of checks) {
        store.record(entry, check);
    }
    store.save();

    const chosen =
        checks.find(([, c]) => c.state === 'live') ?? checks.find(([, c]) => c.state === 'unknown');
    return chosen?.[0].provider;
}

export const init: Command = {
    summary: 'Create a project here, or in <dir>, and register it.',
    usage: USAGE,
    details: [
        'Writes INSTRUCTIONS.md, agents.yaml and agents/, then records the',
        'directory so `zen list` and `zen go` can find it by name. Editor files',
        '(.vscode/settings.json, .github/copilot-instructions.md) are written',
        'alongside, and never overwritten.',
        '',
        'The default agent gets the file tools and a sandboxed shell. Without',
        '--model, the keyring is checked and the model is picked from a',
        'credential the provider accepts.',
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

        if (isProjectDir(dir)) {
            throw invalidError(`${dir} is already a project`);
        }
        if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) {
            throw usageError(`${dir} is not empty`, 'pass --force to write into it anyway');
        }

        ensureHome();
        const store = await KeyStore.open();
        const provider = values.model ? undefined : await reachableProvider(store);
        const model = values.model ?? DEFAULT_MODEL[provider ?? 'openai'];
        const files = scaffold({ dir, model });

        const registry = await Registry.open();
        registry.add(name, dir);
        registry.save();

        if (ctx.json) {
            json({ name, path: dir, model, files, credential: provider ?? null });
            return;
        }

        note(`${green('created')} ${bold(name)} ${dim(dir)}`);
        for (const file of files) {
            note(`  ${dim(file)}`);
        }
        note();
        // Said once, here, rather than left for the first run to discover: the
        // project names a model, and nothing on this machine can pay for it.
        if (!values.model && !provider) {
            note(`${yellow('no working key')} ${dim(`— ${model} will not run yet`)}`);
            note(`  ${cyan('zen key add openai')} ${dim('(or anthropic, google, vertex)')}`);
            note();
        }
        note(`Next: ${cyan(`cd ${dir}`)} then ${cyan('zen run')}`);
        write(dir);
    },
};
