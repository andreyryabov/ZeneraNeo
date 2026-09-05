import {
    bold,
    CliError,
    CURATED,
    cyan,
    dim,
    ensureHome,
    envNames,
    form,
    KeyStore,
    note,
    PROVIDERS,
    table,
    usageError,
    type Provider,
} from '@zenera/cli/lib';
import { createEmbedder, defaultModels, type Embedder, type EmbeddingRef } from '@zenera/neo';

// ---------------------------------------------------------------------------
// Getting an embedder, and saying what the choices are when there is none
//
// The keyring is materialised here, and only here. The `zen` frame does not do
// it, and a command that forgets to looks exactly like a machine with no key:
// `zen key ls` shows the credential live and the command still says the
// environment variable is not set. Real env always wins, so a shell that names
// a key is never overridden by one on disk.
//
// Nothing in here is about a particular index. Which model made the vectors is
// recorded in the manifest and enforced on every later search, so this only has
// to turn a reference into an embedder — or, given none, into a list worth
// choosing from.
// ---------------------------------------------------------------------------

/**
 * What a shorthand ref cannot say. Both are ceilings on what the embedder would
 * otherwise work out for itself from the model and from what the provider
 * refuses, so leaving them unset is the normal case.
 */
export interface EmbedderTuning {
    maxBatch?: number;
}

export async function resolveEmbedder(
    ref: string | undefined,
    tuning?: EmbedderTuning,
): Promise<Embedder> {
    ensureHome();
    const keys = await KeyStore.open();
    // Asked before materialising, because materialising is what erases the
    // difference between "the environment had it" and "the keyring supplied it".
    const fromEnv = new Set(PROVIDERS.filter((p) => envNames(p).some((n) => process.env[n])));
    keys.materialize();

    if (!ref) {
        throw choices(keys, fromEnv);
    }
    if (tuning?.maxBatch === undefined) {
        return createEmbedder(ref as EmbeddingRef);
    }
    return createEmbedder({ ...defaultModels.parseEmbedding(ref), ...tuning });
}

/**
 * Well-known embedding models per provider, read off the CLI's catalog table so
 * there is one list rather than two that drift. Any ref the registry can parse
 * works; these are the ones worth typing. Anthropic has none because it
 * publishes no embeddings API at all.
 */
const embeddingsOf = (provider: Provider): string[] =>
    CURATED[provider].filter((m) => m.roles.includes('embedding')).map((m) => m.id);

/** What could be passed, with the ones this machine can actually use first. */
function choices(keys: KeyStore, fromEnv: ReadonlySet<Provider>): CliError {
    const rows: string[][] = [];
    const rest: string[][] = [];

    for (const provider of PROVIDERS) {
        for (const model of embeddingsOf(provider)) {
            const source = fromEnv.has(provider)
                ? 'environment'
                : keys.active(provider)
                  ? 'keyring'
                  : '';
            const row = [`  ${cyan(`${provider}:${model}`)}`, dim(source || form(provider).env)];
            (source ? rows : rest).push(row);
        }
    }

    note(bold('Embeddings'));
    for (const line of table([...rows, ...rest])) {
        note(line);
    }
    note('');
    if (rows.length === 0) {
        note(dim('  no provider on this machine has a credential — try: zen key add openai'));
        note('');
    }
    // `pick` is the one that ends the question rather than restating it: it
    // tries them and prints the first that answers.
    return usageError(
        'no embedder named',
        'pass --embedding <ref>, or run: zen models pick --embedding',
    );
}
