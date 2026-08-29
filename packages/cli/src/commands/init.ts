import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { ensureHome } from '../home.ts';
import { isProvider, keyId, KeyStore, PROVIDERS, SHAPES, type Provider } from '../keys.ts';
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
    progress,
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

interface ModelChoice {
    ref: string;
    /** extra lines for the scaffolded model configuration */
    options?: string;
}

/**
 * The model each provider gets scaffolded with, when it is the one chosen.
 *
 * Every ref names its provider. A bare id is not a vendor hint — the shorthand
 * reads the first segment as a *provider name*, so an unprefixed
 * `gemini-3.5-flash` resolves to the default provider and the project asks
 * OpenAI for a Google model.
 *
 * Only OpenAI carries options, because it is the only vendor whose reasoning is
 * silent unless asked for: Gemini's `includeThoughts` is on by default and
 * Anthropic streams nothing to summarise. Without them a gpt-5 project sits
 * there showing no progress while the model thinks, which reads as a hang.
 */
const DEFAULT_MODEL: Record<Provider, ModelChoice> = {
    openai: {
        ref: 'openai:gpt-5.4-mini',
        options: [
            '# Reasoning and tools only meet on the responses API — chat',
            '# completions, which is the default, rejects the two together.',
            'api: responses',
            '# gpt-5 models reason whether or not you ask. `reasoningSummary` is',
            '# what makes that visible while it happens; drop it for silence, or',
            '# lower the effort for shorter, cheaper turns.',
            'reasoningEffort: medium',
            'reasoningSummary: auto',
        ].join('\n'),
    },
    anthropic: { ref: 'anthropic:claude-sonnet-4-5' },
    google: { ref: 'google:gemini-3.5-flash' },
    vertex: { ref: 'vertex:gemini-3.5-flash' },
    openrouter: { ref: 'openrouter:inclusionai/ling-3.0-flash-fin:free' },
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

    const bar = progress();
    const checks = await probeAll(store, active, (entry, index, total) =>
        bar.update(dim(`checking ${keyId(entry)} … ${index + 1}/${total}`)),
    );
    bar.done();
    for (const [entry, check] of checks) {
        store.record(entry, check);
    }
    store.save();

    const chosen =
        checks.find(([, c]) => c.state === 'live') ?? checks.find(([, c]) => c.state === 'unknown');
    // `active` was built from PROVIDERS, so this only ever holds a model
    // provider; the guard says so to the type system rather than a cast
    // asserting it, which would survive `SERVICES` growing into this list.
    const provider = chosen?.[0].provider;
    return provider !== undefined && isProvider(provider) ? provider : undefined;
}

/**
 * Whether this machine can reach the web tools.
 *
 * Presence, not liveness: unlike the model, nothing about the project depends
 * on the key working — an agent with a dead Exa key is an agent one tool call
 * poorer, not one that cannot run — so it is not worth a round trip during
 * `init`.
 */
function hasExa(store: KeyStore): boolean {
    return Boolean(process.env[SHAPES.exa.env]) || store.active('exa') !== undefined;
}

export const init: Command = {
    summary: 'Create a project here, or in <dir>, and register it.',
    usage: USAGE,
    details: [
        'Writes INSTRUCTIONS.md, agents.yaml and agents/, then records the',
        'directory so `zen list` and `zen open` can find it by name. Editor files',
        '(.vscode/settings.json, .github/copilot-instructions.md) are written',
        'alongside, replacing any already there.',
        '',
        'The default agent gets the file tools and a sandboxed shell, plus',
        '`exa:*` when the keyring holds an Exa key. Without --model, the',
        'keyring is checked and the model is picked from a credential the',
        'provider accepts.',
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
        // An explicit --model is taken as written, options and all: guessing at
        // knobs for a model nobody here has heard of is how a scaffold breaks.
        const choice: ModelChoice = values.model
            ? { ref: values.model }
            : DEFAULT_MODEL[provider ?? 'openai'];
        const model = choice.ref;
        const web = hasExa(store);
        const files = scaffold({ dir, model, modelOptions: choice.options, web });

        const registry = await Registry.open();
        registry.add(name, dir);
        registry.save();

        if (ctx.json) {
            json({ name, path: dir, model, files, credential: provider ?? null, web });
            return;
        }

        note(`${green('created')} ${bold(name)} ${dim(dir)}`);
        for (const file of files) {
            note(`  ${dim(file)}`);
        }
        note();
        if (web) {
            note(`${green('exa key found')} ${dim('— the default agent gets web search')}`);
            note();
        }
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
