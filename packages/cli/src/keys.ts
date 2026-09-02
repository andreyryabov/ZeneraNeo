import { EXA_API_KEY_ENV } from '@zenera/neo';
import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { assertPrivate, ensureDir, paths, readJson, writeJson } from './home.ts';
import { CliError, EXIT, credentialError, usageError } from './term.ts';

// ---------------------------------------------------------------------------
// The keyring
//
// The library reads credentials from the environment and from `${VAR}`
// expansion in `agents.yaml`, and it will keep doing so. This store is a CLI
// feature the library never learns about: before any command touches
// `loadProject`, the selected credentials are materialized into `process.env`.
//
// That single decision buys three things. Nothing downstream changes.
// `${OPENAI_API_KEY}` in a config keeps working. And a project checked out on a
// machine that has never seen `zen` still runs, because the environment is
// still the interface.
// ---------------------------------------------------------------------------

/** The vendors a *model* can come from — the library's provider kinds, verbatim. */
export const PROVIDERS = ['openai', 'anthropic', 'google', 'vertex', 'openrouter'] as const;

export type Provider = (typeof PROVIDERS)[number];

/**
 * Credentials that are not a way to reach a model.
 *
 * A tool can need a key as much as a model can, and the reasons a keyring
 * exists — one place, 0600, materialised into the environment before a run —
 * do not care which. What does care is everything that reasons about *models*:
 * a machine holding nothing but an Exa key cannot run an agent, and saying it
 * can would move the failure from `zen run`'s first line to its first turn.
 * Hence two lists rather than one longer one, and `kind` on the shape so the
 * few places that must tell them apart are made to say which they mean.
 */
export const SERVICES = ['exa'] as const;

export type Service = (typeof SERVICES)[number];

/** Anything the keyring can hold a credential for. */
export const OWNERS = [...PROVIDERS, ...SERVICES] as const;

export type KeyOwner = Provider | Service;

/**
 * One way a credential can arrive.
 *
 * A provider that accepts two accepts two of these, and they agree about
 * nothing: not the variable, not whether the value is the secret or a path to
 * it, not where you go to get one. So the alternative is a whole form rather
 * than a wider `holds`.
 */
export interface CredentialForm {
    /** what the value is: a secret string, or a path to a credentials file */
    holds: 'secret' | 'file';
    /** environment variable the library reads */
    env: string;
    /** where to get one, printed when there is none */
    where: string;
}

interface ProviderShape {
    /** whether this is somewhere a model lives, or something a tool calls */
    kind: 'model' | 'service';
    label: string;
    /** the ways in, first being the one this provider is usually reached by */
    forms: [CredentialForm, ...CredentialForm[]];
}

/**
 * Vertex is the odd one, and it is odd twice.
 *
 * Its usual credential is not a key at all: the GenAI SDK resolves Application
 * Default Credentials itself, so what is stored is a service-account *file* and
 * what is exported is a path. But it also accepts an express-mode api key,
 * which is an ordinary secret under an entirely different variable. The two are
 * alternatives — express mode addresses no project — so which form a credential
 * is gets decided per entry rather than per provider.
 */
export const SHAPES: Record<KeyOwner, ProviderShape> = {
    openai: {
        kind: 'model',
        label: 'OpenAI',
        forms: [
            {
                holds: 'secret',
                env: 'OPENAI_API_KEY',
                where: 'https://platform.openai.com/api-keys',
            },
        ],
    },
    anthropic: {
        kind: 'model',
        label: 'Anthropic',
        forms: [
            {
                holds: 'secret',
                env: 'ANTHROPIC_API_KEY',
                where: 'https://console.anthropic.com/settings/keys',
            },
        ],
    },
    google: {
        kind: 'model',
        label: 'Google AI Studio',
        forms: [
            {
                holds: 'secret',
                env: 'GEMINI_API_KEY',
                where: 'https://aistudio.google.com/apikey',
            },
        ],
    },
    vertex: {
        kind: 'model',
        label: 'Vertex AI',
        forms: [
            {
                holds: 'file',
                env: 'GOOGLE_APPLICATION_CREDENTIALS',
                where: 'a service-account JSON key from the GCP console',
            },
            {
                holds: 'secret',
                env: 'VERTEX_API_KEY',
                where: 'an express-mode key from https://console.cloud.google.com/vertex-ai',
            },
        ],
    },
    openrouter: {
        kind: 'model',
        label: 'OpenRouter',
        forms: [
            {
                holds: 'secret',
                env: 'OPENROUTER_API_KEY',
                where: 'https://openrouter.ai/settings/keys',
            },
        ],
    },
    exa: {
        kind: 'service',
        label: 'Exa',
        forms: [
            {
                holds: 'secret',
                env: EXA_API_KEY_ENV,
                where: 'https://dashboard.exa.ai/api-keys',
            },
        ],
    },
};

/**
 * The form a provider is usually reached by — for the questions that have to
 * have one answer, like which variable to name when nothing is set yet.
 */
export function form(provider: KeyOwner): CredentialForm {
    return SHAPES[provider].forms[0];
}

/** Every variable a provider's credential could arrive in, usual one first. */
export function envNames(provider: KeyOwner): string[] {
    return SHAPES[provider].forms.map((f) => f.env);
}

/** The variable this particular credential occupies. */
export function envOf(entry: Pick<KeyEntry, 'provider' | 'holds' | 'env'>): string {
    if (entry.env) {
        return entry.env;
    }
    // Entries written before a provider had two forms carry no `env` of their own.
    const forms = SHAPES[entry.provider].forms;
    return (forms.find((f) => f.holds === entry.holds) ?? forms[0]).env;
}

export function isProvider(name: string): name is Provider {
    return (PROVIDERS as readonly string[]).includes(name);
}

export function isOwner(name: string): name is KeyOwner {
    return (OWNERS as readonly string[]).includes(name);
}

export function assertOwner(name: string): KeyOwner {
    if (!isOwner(name)) {
        throw usageError(`unknown provider "${name}"`, `known providers: ${OWNERS.join(', ')}`);
    }
    return name;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type Liveness = 'live' | 'dead' | 'unknown';

export interface KeyCheck {
    state: Liveness;
    at: string;
    /** the provider's own words when it said no, or ours when we could not ask */
    detail?: string;
}

export interface KeyEntry {
    provider: KeyOwner;
    /** unique within a provider; `default` unless the user says otherwise */
    name: string;
    holds: 'secret' | 'file';
    /** the secret itself, or a path relative to the key directory */
    value: string;
    /** the variable it is exported as; absent on entries written before providers had two */
    env?: string;
    /** vertex, file-shaped only: what the library would otherwise have to be told twice */
    project?: string;
    location?: string;
    addedAt: string;
    check?: KeyCheck;
}

interface KeyFile {
    version: 1;
    entries: KeyEntry[];
    /** provider → chosen entry name */
    active: Partial<Record<KeyOwner, string>>;
}

const EMPTY: KeyFile = { version: 1, entries: [], active: {} };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const keyId = (e: Pick<KeyEntry, 'provider' | 'name'>): string => `${e.provider}/${e.name}`;

/**
 * `provider` or `provider/name`. Returned separately rather than as a string so
 * callers cannot accidentally re-split it, and so a name that is not a legal
 * path segment is rejected here, once, before it can become a filename.
 */
export function parseRef(ref: string): { provider: KeyOwner; name?: string } {
    const [head, ...rest] = ref.split('/');
    if (rest.length > 1) {
        throw usageError(`"${ref}" is not a key reference`, 'use provider or provider/name');
    }
    const provider = assertOwner(head);
    const name = rest[0];
    if (name !== undefined && !NAME.test(name)) {
        throw usageError(`"${name}" is not a usable key name`, 'letters, digits, - and _ only');
    }
    return { provider, name };
}

/** Which of a provider's forms a raw value is, decided by the value itself. */
function formOf(provider: KeyOwner, raw: string): CredentialForm {
    const { forms } = SHAPES[provider];
    if (forms.length === 1) {
        return forms[0];
    }
    const wanted = raw.length < 4096 && existsSync(resolve(raw)) ? 'file' : 'secret';
    return forms.find((f) => f.holds === wanted) ?? forms[0];
}

/** What a credential cannot say about itself. */
export interface KeyMeta {
    /** GCP project id, for a Vertex service account */
    project?: string;
    /** GCP region, or `global` */
    location?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class KeyStore {
    readonly #file: KeyFile;

    private constructor(file: KeyFile) {
        this.#file = file;
    }

    static async open(): Promise<KeyStore> {
        const path = paths.keys();
        assertPrivate(path);
        const file = await readJson<KeyFile>(path, EMPTY);
        return new KeyStore({ ...EMPTY, ...file });
    }

    get entries(): readonly KeyEntry[] {
        return this.#file.entries;
    }

    /** Every entry for a provider, the active one first. */
    for(provider: KeyOwner): KeyEntry[] {
        const active = this.#file.active[provider];
        return this.#file.entries
            .filter((e) => e.provider === provider)
            .sort((a, b) => Number(b.name === active) - Number(a.name === active));
    }

    find(provider: KeyOwner, name: string): KeyEntry | undefined {
        return this.#file.entries.find((e) => e.provider === provider && e.name === name);
    }

    /** The entry a run would use, or undefined when the provider has none. */
    active(provider: KeyOwner): KeyEntry | undefined {
        const chosen = this.#file.active[provider];
        if (chosen) {
            const hit = this.find(provider, chosen);
            if (hit) {
                return hit;
            }
        }
        return this.#file.entries.find((e) => e.provider === provider);
    }

    isActive(entry: KeyEntry): boolean {
        return this.active(entry.provider)?.name === entry.name;
    }

    /**
     * Adds or replaces. A file-shaped credential is *copied* into the key
     * directory: the point of a store is that the credential survives the
     * original being moved, renamed or cleaned up, and a stored path that
     * silently stops resolving is worse than no store at all.
     *
     * Which form a value is, when the provider accepts two, is read off the
     * value: a path that is there is a credentials file, and anything else is a
     * secret. Asking would be a flag to get wrong, and a service-account key
     * and an api key are not mistakable for one another.
     */
    add(provider: KeyOwner, name: string, raw: string, meta: KeyMeta = {}): KeyEntry {
        if (!NAME.test(name)) {
            throw usageError(`"${name}" is not a usable key name`, 'letters, digits, - and _ only');
        }
        const form = formOf(provider, raw);
        const entry: KeyEntry = {
            provider,
            name,
            holds: form.holds,
            value: form.holds === 'file' ? this.#absorb(provider, name, raw) : raw,
            env: form.env,
            // Express mode addresses no project, so carrying one would only ever
            // be a way to build the combination the service refuses.
            ...(form.holds === 'file' && meta.project ? { project: meta.project } : {}),
            ...(form.holds === 'file' && meta.location ? { location: meta.location } : {}),
            addedAt: new Date().toISOString(),
        };
        const at = this.#file.entries.findIndex((e) => e.provider === provider && e.name === name);
        if (at >= 0) {
            this.#file.entries[at] = entry;
        } else {
            this.#file.entries.push(entry);
        }
        this.#file.active[provider] ??= name;
        return entry;
    }

    remove(provider: KeyOwner, name: string): boolean {
        const at = this.#file.entries.findIndex((e) => e.provider === provider && e.name === name);
        if (at < 0) {
            return false;
        }
        this.#file.entries.splice(at, 1);
        if (this.#file.active[provider] === name) {
            delete this.#file.active[provider];
            const next = this.#file.entries.find((e) => e.provider === provider);
            if (next) {
                this.#file.active[provider] = next.name;
            }
        }
        return true;
    }

    use(provider: KeyOwner, name: string): KeyEntry {
        const entry = this.find(provider, name);
        if (!entry) {
            throw usageError(`no key ${provider}/${name}`, 'see: zen key ls');
        }
        this.#file.active[provider] = name;
        return entry;
    }

    record(entry: KeyEntry, check: KeyCheck): void {
        const hit = this.find(entry.provider, entry.name);
        if (hit) {
            hit.check = check;
        }
    }

    save(): void {
        ensureDir(paths.home());
        writeJson(paths.keys(), this.#file);
    }

    /**
     * Absolute path behind a file-shaped entry. Stored entries name a file in
     * the key directory; an ambient one already knows where it is.
     */
    fileOf(entry: KeyEntry): string {
        return isAbsolute(entry.value) ? entry.value : join(paths.keyDir(), entry.value);
    }

    /** The plaintext an entry stands for — the only way out of the store. */
    reveal(entry: KeyEntry): string {
        return entry.holds === 'file' ? this.fileOf(entry) : entry.value;
    }

    /**
     * What the library would see. Real environment variables win, so CI,
     * `docker run -e` and a one-off `OPENAI_API_KEY=… zen run` all behave
     * exactly as they did before the store existed.
     *
     * Services are included by default, because a tool reads its key from the
     * environment for exactly the same reason a model adapter does.
     */
    environment(only?: KeyOwner[]): Record<string, string> {
        const env: Record<string, string> = {};
        for (const provider of only ?? OWNERS) {
            const entry = this.active(provider);
            if (!entry) {
                continue;
            }
            // Either variable being set means this provider is already answered
            // for, so the stored alternative must not be exported alongside it.
            if (envNames(provider).some((name) => process.env[name])) {
                continue;
            }
            env[envOf(entry)] = this.reveal(entry);
            if (entry.project && !process.env.GOOGLE_CLOUD_PROJECT) {
                env.GOOGLE_CLOUD_PROJECT = entry.project;
            }
            if (entry.location && !process.env.GOOGLE_CLOUD_LOCATION) {
                env.GOOGLE_CLOUD_LOCATION = entry.location;
            }
        }
        return env;
    }

    /** Applies `environment()` to this process. Returns what it set. */
    materialize(only?: KeyOwner[]): Record<string, string> {
        const env = this.environment(only);
        Object.assign(process.env, env);
        return env;
    }

    #absorb(provider: KeyOwner, name: string, raw: string): string {
        const source = resolve(raw);
        if (!existsSync(source) || !statSync(source).isFile()) {
            throw usageError(
                `${SHAPES[provider].label} credentials must be a file`,
                `no such file: ${source}`,
            );
        }
        const target = `${provider}-${name}.json`;
        ensureDir(paths.keyDir());
        const path = join(paths.keyDir(), target);
        copyFileSync(source, path);
        // copyFile keeps the source's mode, which may well be group-readable.
        chmodSync(path, 0o600);
        return target;
    }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Enough of a secret to recognise it, never enough to use it. Short values are
 * hidden outright rather than half-shown — a twelve-character secret with eight
 * characters visible is not masked, it is inconvenienced.
 */
export function mask(secret: string): string {
    if (secret.length <= 12) {
        return '•'.repeat(8);
    }
    return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export function describe(store: KeyStore, entry: KeyEntry): string {
    return entry.holds === 'file' ? store.fileOf(entry) : mask(entry.value);
}

// ---------------------------------------------------------------------------
// Ambient
// ---------------------------------------------------------------------------

/**
 * A credential the keyring does not hold but the libraries will nonetheless
 * find: a variable already in the environment, or the file `gcloud auth
 * application-default login` writes.
 *
 * These have to be listed, because they are the reason a provider works when
 * `zen key ls` says there is nothing for it — and the reason one keeps working
 * after its entry is removed.
 */
export interface Ambient {
    provider: KeyOwner;
    /** the variable it arrived in; absent when it was found where the SDK looks */
    env?: string;
    holds: 'secret' | 'file';
    value: string;
}

/** How an ambient credential is named on the command line: it has no key name. */
export function ambientId(cred: Ambient): string {
    return cred.env ? `${cred.provider}/$${cred.env}` : `${cred.provider}/adc`;
}

/**
 * Where `gcloud auth application-default login` leaves its credentials. The
 * GenAI SDK reads this without being told to, so it counts even though nothing
 * in the environment mentions it.
 */
export function gcloudAdc(): string | undefined {
    const dir = process.env.CLOUDSDK_CONFIG ?? join(homedir(), '.config', 'gcloud');
    const path = join(dir, 'application_default_credentials.json');
    return existsSync(path) ? path : undefined;
}

export function ambient(store: KeyStore, only?: KeyOwner[]): Ambient[] {
    const found: Ambient[] = [];
    for (const provider of only ?? OWNERS) {
        for (const form of SHAPES[provider].forms) {
            const value = process.env[form.env];
            if (!value) {
                continue;
            }
            // `materialize()` puts the store's own entries here. Reporting one
            // of those as ambient would double-count it, and would claim the
            // environment as a source that would survive removing the entry.
            const active = store.active(provider);
            if (active && envOf(active) === form.env && store.reveal(active) === value) {
                continue;
            }
            found.push({ provider, env: form.env, holds: form.holds, value });
        }
    }
    const adc = (only ?? OWNERS).includes('vertex') ? gcloudAdc() : undefined;
    if (adc && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        found.push({ provider: 'vertex', holds: 'file', value: adc });
    }
    return found;
}

/**
 * Every credential variable this process is carrying, whatever put it there.
 *
 * Read off the environment rather than off the store, and deliberately: by the
 * time anyone asks, `materialize()` has already run, so the environment is the
 * union of the keyring and whatever the shell brought — which is exactly the
 * set of credentials the run is actually using.
 */
export function credentials(): { env: string; holds: 'secret' | 'file'; value: string }[] {
    const found: { env: string; holds: 'secret' | 'file'; value: string }[] = [];
    for (const provider of OWNERS) {
        for (const form of SHAPES[provider].forms) {
            const value = process.env[form.env];
            if (value) {
                found.push({ env: form.env, holds: form.holds, value });
            }
        }
    }
    return found;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
/**
 * Called before a run: says plainly that there is no way to reach a model,
 * rather than letting the SDK raise it three frames deeper as a 401.
 *
 * Only model providers count. A keyring holding nothing but an Exa key can
 * search the web and cannot think, and reporting that as usable would trade
 * one clear error here for an obscure one on the first turn.
 */
export function assertUsable(store: KeyStore): void {
    const reachable = PROVIDERS.filter(
        (p) => envNames(p).some((name) => process.env[name]) || store.active(p) !== undefined,
    );
    if (reachable.length === 0) {
        throw credentialError(
            'no credentials for any provider',
            'add one with: zen key add openai',
        );
    }
}

export function assertNotEmpty(store: KeyStore): void {
    if (store.entries.length === 0) {
        throw new CliError('the keyring is empty', EXIT.credentials, 'add one: zen key add openai');
    }
}
