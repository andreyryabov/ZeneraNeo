import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXA_API_KEY_ENV } from '@zenera/neo';
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

interface ProviderShape {
    /** whether this is somewhere a model lives, or something a tool calls */
    kind: 'model' | 'service';
    /** environment variable the library reads */
    env: string;
    /** what the value is: a secret string, or a path to a credentials file */
    holds: 'secret' | 'file';
    label: string;
    /** where to get one, printed when there is none */
    where: string;
}

/**
 * Vertex is the odd one. The GenAI SDK resolves Application Default
 * Credentials itself, so what is stored is a service-account *file* and what is
 * exported is a path — not a key. Pretending otherwise would mean inventing a
 * credential shape Google does not have.
 */
export const SHAPES: Record<KeyOwner, ProviderShape> = {
    openai: {
        kind: 'model',
        env: 'OPENAI_API_KEY',
        holds: 'secret',
        label: 'OpenAI',
        where: 'https://platform.openai.com/api-keys',
    },
    anthropic: {
        kind: 'model',
        env: 'ANTHROPIC_API_KEY',
        holds: 'secret',
        label: 'Anthropic',
        where: 'https://console.anthropic.com/settings/keys',
    },
    google: {
        kind: 'model',
        env: 'GEMINI_API_KEY',
        holds: 'secret',
        label: 'Google AI Studio',
        where: 'https://aistudio.google.com/apikey',
    },
    vertex: {
        kind: 'model',
        env: 'GOOGLE_APPLICATION_CREDENTIALS',
        holds: 'file',
        label: 'Vertex AI',
        where: 'a service-account JSON key from the GCP console',
    },
    openrouter: {
        kind: 'model',
        env: 'OPENROUTER_API_KEY',
        holds: 'secret',
        label: 'OpenRouter',
        where: 'https://openrouter.ai/settings/keys',
    },
    exa: {
        kind: 'service',
        env: EXA_API_KEY_ENV,
        holds: 'secret',
        label: 'Exa',
        where: 'https://dashboard.exa.ai/api-keys',
    },
};

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
     */
    add(provider: KeyOwner, name: string, raw: string): KeyEntry {
        if (!NAME.test(name)) {
            throw usageError(`"${name}" is not a usable key name`, 'letters, digits, - and _ only');
        }
        const shape = SHAPES[provider];
        const entry: KeyEntry = {
            provider,
            name,
            holds: shape.holds,
            value: shape.holds === 'file' ? this.#absorb(provider, name, raw) : raw,
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

    /** Absolute path behind a file-shaped entry. */
    fileOf(entry: KeyEntry): string {
        return join(paths.keyDir(), entry.value);
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
            const { env: name } = SHAPES[provider];
            if (process.env[name]) {
                continue;
            }
            env[name] = this.reveal(entry);
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
        (p) => process.env[SHAPES[p].env] || store.active(p) !== undefined,
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
