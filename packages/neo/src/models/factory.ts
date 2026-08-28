import type Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions as AnthropicOptions } from '@anthropic-ai/sdk';
import type { GoogleGenAI, GoogleGenAIOptions } from '@google/genai';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type OpenAI from 'openai';
import type { ClientOptions as OpenAIOptions } from 'openai';
import type { Model } from '../model.ts';
import { AnthropicModel, type AnthropicModelOptions } from './anthropic.ts';
import { GeminiModel, type GeminiModelOptions } from './gemini.ts';
import { OpenAIModel } from './openai-chat.ts';
import { OpenAIResponsesModel, type OpenAIResponsesModelOptions } from './openai-responses.ts';

// ---------------------------------------------------------------------------
// The vendor SDKs
//
// All three are *optional peer dependencies*: an application installs the one
// vendor it talks to and pays for nothing else — which matters most for
// `@google/genai`, whose own tree carries google-auth-library and protobufjs.
//
// That only holds if importing this library does not reach for all three, so
// nothing above is a value import: the SDKs are pulled in here, when a client
// of that protocol is first built, and never at module scope.
//
// `createRequire` rather than `await import()` because it is synchronous, and
// so `createModel()` and `ModelRegistry.client()` keep handing back a usable
// object instead of a promise — which is also what keeps a bad credential
// throwing at the call that named it rather than at some later request. Every
// one of the three publishes a CommonJS build, so it costs nothing.
// ---------------------------------------------------------------------------

const requirePeer = createRequire(import.meta.url);

interface OpenAIModule {
    OpenAI: new (options: OpenAIOptions) => OpenAI;
}
interface AnthropicModule {
    Anthropic: new (options: AnthropicOptions) => Anthropic;
}
interface GenAIModule {
    GoogleGenAI: new (options: GoogleGenAIOptions) => GoogleGenAI;
}

/**
 * An uninstalled optional peer is a setup mistake, not a bug, so it is reported
 * as the one-line fix rather than as a resolution failure from inside Node.
 */
function sdk<T>(pkg: string, kind: ProviderKind): T {
    try {
        return requirePeer(pkg) as T;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
            throw cause;
        }
        throw new Error(
            `provider kind "${kind}" needs ${pkg}, which is not installed — run: npm i ${pkg}`,
            { cause },
        );
    }
}

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

/**
 * A *provider* is a connection; a *model* is a request shape. They used to be
 * one type, which made "two OpenAI keys" mean repeating credentials on every
 * model that used the second one — and gave every agent its own HTTP client,
 * with its own connection pool and its own retry budget.
 *
 * Separated, credentials are declared once under a name, the client behind that
 * name is built once and shared, and a model spec becomes vendor-neutral: a
 * provider, an id, and knobs.
 */
export type ProviderKind =
    'openai' | 'google' | 'vertex' | 'anthropic' | 'openrouter' | 'openai-compatible';

export type OpenAIApi = 'chat' | 'responses';

/**
 * The request format a kind speaks, which is what picks the adapter — and,
 * incidentally, the SDK. Not the same axis as `ProviderKind`: `openai` and
 * `openai-compatible` are two connections speaking one protocol.
 */
type Protocol = 'openai' | 'anthropic' | 'gemini';

/** The vendor client behind a provider name. */
export type ProviderClient = OpenAI | Anthropic | GoogleGenAI;

/**
 * How to reach a provider. Every field has an env fallback so a spec can stay
 * declarative (and secret-free) in application code.
 */
export interface Credentials {
    /** literal key, or a `${VAR}` reference — wins over any env lookup */
    apiKey?: string;
    /** env var holding the key; defaults to the kind's conventional name */
    apiKeyEnv?: string;
    /** literal base url, or a `${VAR}` reference, for gateways and compatible endpoints */
    baseURL?: string;
    /** env var holding the base url; defaults to the kind's conventional name */
    baseURLEnv?: string;
}

/** A named connection to a vendor. One client is built per registered name. */
export interface ProviderSpec extends Credentials {
    /** which vendor this speaks; defaults to `openai` */
    kind?: ProviderKind;
    /**
     * vertex only: GCP project id. Falls back to `GOOGLE_CLOUD_PROJECT`, then
     * to the `project_id` inside the service-account key file named by
     * `GOOGLE_APPLICATION_CREDENTIALS`.
     */
    project?: string;
    /** vertex only: a region, or `global` (env: `GOOGLE_CLOUD_LOCATION`, default `global`) */
    location?: string;
    /**
     * Returns a bearer token, once per request, so a short-lived credential can
     * be refreshed without rebuilding the client. Azure AD and gateways that
     * mint their own grants are the cases; Vertex is not, because the GenAI SDK
     * already resolves and refreshes Application Default Credentials. Code
     * only: a function is not something yaml can hold.
     */
    token?: () => string | Promise<string>;
    /** sent on every request — gateway routing, attribution, api versions */
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRetries?: number;
    /**
     * Pre-built client — bypasses credential resolution entirely. The seam for
     * auth no configuration can express: Vertex service accounts, Bedrock
     * signing, or a stub in tests.
     */
    client?: ProviderClient;
}

/**
 * What to ask for, and of whom. Vendor differences live in the *provider*, so
 * there is nothing here to discriminate on: the option interfaces are unioned
 * and the knobs that do not apply to the chosen vendor are ignored.
 *
 * `Credentials` are still accepted inline, for a one-off model that does not
 * warrant a declared provider. Using them opts out of the shared client.
 */
export interface ModelSpec
    extends Credentials, OpenAIResponsesModelOptions, AnthropicModelOptions, GeminiModelOptions {
    /**
     * Registered provider name. The built-in providers are named after their
     * kind, so `provider: 'google'` works with nothing declared. Defaults to
     * the registry's default provider.
     */
    provider?: string;
    /** which API to speak; defaults to the vendor's usual one */
    api?: OpenAIApi;
    model: string;
    /** pre-built client — bypasses provider resolution entirely */
    client?: ProviderClient;
}

/**
 * Shorthand: `[provider[/api]:]model`, e.g. `gpt-4o`, `openai:gpt-4o`,
 * `openai/responses:o3`, `gemini-eu:gemini-2.5-pro`.
 *
 * Only the *first* colon separates, so a fine-tuned id keeps its own — it just
 * has to name its provider: `openai:ft:gpt-4o:acme::a1b2`. Anything the
 * shorthand cannot express (keys, base urls, reasoning knobs) needs the object
 * form.
 */
export type ModelRef = ModelSpec | string;

/**
 * What a ref *would* connect with. `model()` answers the same question by
 * building a client — which needs the very credential a caller wanting to
 * report on credentials does not have. This resolves the same precedence rules
 * and stops there, so a CLI can say which model is unreachable before anything
 * throws three frames deeper.
 */
export interface ModelRequirement {
    /** the provider name the ref resolves to, declared or built-in */
    provider: string;
    kind: ProviderKind;
    /** env var consulted when the spec carries no `apiKey` of its own */
    apiKeyEnv: string;
    /** a client could be built as things stand */
    satisfied: boolean;
    /** the SDK authenticates without a key, so `satisfied` says little */
    keyOptional: boolean;
}

interface KindDefaults {
    /** the request format, and so the adapter and the client to build */
    protocol: Protocol;
    apiKeyEnv: string;
    baseURLEnv: string;
    /** vendor default, used when neither the spec nor the env names one */
    baseURL?: string;
    /** which OpenAI APIs this vendor speaks; the first is the default. empty = another protocol */
    apis: readonly OpenAIApi[];
    /** the SDK can authenticate without a key — ambient credentials, a metadata server */
    keyOptional?: boolean;
}

/**
 * Only three of these need no adapter of their own.
 *
 * `openai-compatible` is the shim kind — vLLM, a self-hosted gateway — and the
 * OpenAI client is exactly right for it. Everything else gets its vendor's own
 * SDK, because the compatibility endpoints each vendor publishes are porting
 * aids: Google's drops thinking budgets, thought signatures and cached-content
 * accounting, Anthropic's drops cache accounting and extended thinking. Those
 * are the things this runtime is built around, so paying for two more
 * dependencies is the cheaper trade.
 *
 * `openrouter` is that shim with the two constants filled in. It speaks chat
 * completions verbatim, so it earns no adapter and no fourth SDK — what it
 * earns is a name, which is the difference between four lines of base url and
 * key env in every project and none. Its own SDK is ESM-only and would force
 * `createRequire` above to become an `await import`, for a wire format the
 * OpenAI client already produces byte for byte.
 *
 * `google` and `vertex` differ only in how the client authenticates and which
 * backend it addresses; both speak the same API through the same adapter.
 */
const KINDS: Record<ProviderKind, KindDefaults> = {
    openai: {
        protocol: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        baseURLEnv: 'OPENAI_BASE_URL',
        apis: ['chat', 'responses'],
    },
    google: {
        protocol: 'gemini',
        apiKeyEnv: 'GEMINI_API_KEY',
        baseURLEnv: 'GEMINI_BASE_URL',
        apis: [],
    },
    vertex: {
        // Vertex authenticates with Application Default Credentials, which the
        // GenAI SDK resolves itself — so unlike every other kind this one
        // usually has no key at all. `VERTEX_API_KEY` covers express mode.
        protocol: 'gemini',
        apiKeyEnv: 'VERTEX_API_KEY',
        baseURLEnv: 'VERTEX_BASE_URL',
        apis: [],
        keyOptional: true,
    },
    anthropic: {
        protocol: 'anthropic',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        baseURLEnv: 'ANTHROPIC_BASE_URL',
        apis: [],
    },
    openrouter: {
        protocol: 'openai',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        baseURLEnv: 'OPENROUTER_BASE_URL',
        baseURL: 'https://openrouter.ai/api/v1',
        apis: ['chat'],
    },
    'openai-compatible': {
        protocol: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        baseURLEnv: 'OPENAI_BASE_URL',
        apis: ['chat', 'responses'],
    },
};

export const providerKinds = Object.keys(KINDS) as ProviderKind[];

export function isProviderKind(name: string): name is ProviderKind {
    return Object.hasOwn(KINDS, name);
}

// ---------------------------------------------------------------------------
// Environment references
// ---------------------------------------------------------------------------

// `${VAR}` and `${VAR:-fallback}`. Chosen over a bare `env.VAR` token because a
// literal secret never contains `${`, so there is no rule to remember about
// which strings are magic — and because it composes inside a longer value,
// which a whole-value token cannot: `https://${GATEWAY}/v1`.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Substitutes `${VAR}` references. An unset variable with no fallback is an
 * error naming both the variable and where it was written, because the
 * alternative is an empty api key and a 401 three layers away.
 */
export function expandEnv(value: string, where: string): string {
    return value.replace(ENV_REF, (_match, name: string, fallback?: string) => {
        const found = fromEnv(name);
        if (found !== undefined) {
            return found;
        }
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error(`${where}: \${${name}} is not set`);
    });
}

function fromEnv(name: string): string | undefined {
    const value = process.env[name];
    return value?.trim() ? value : undefined;
}

function expand(value: string | undefined, where: string): string | undefined {
    return value === undefined ? undefined : expandEnv(value, where);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Named providers, and the clients behind them.
 *
 * The clients are why this is an object rather than a function: one `OpenAI`
 * per provider name, built on first use and shared by every model and every
 * agent that names it. A registry is also the seam a host uses to point a name
 * at different credentials, or at a stub — neither of which should mean
 * touching a `switch`.
 */
export class ModelRegistry {
    readonly #providers = new Map<string, ProviderSpec>();
    readonly #clients = new Map<string, ProviderClient>();
    #default = 'openai';

    /** Declares (or replaces) a provider. Nothing is contacted until it is used. */
    provider(name: string, spec: ProviderSpec = {}): this {
        if (spec.kind !== undefined && !isProviderKind(spec.kind)) {
            throw new TypeError(
                `provider "${name}": unknown kind "${spec.kind}" ` +
                    `(known: ${providerKinds.join(', ')})`,
            );
        }
        this.#providers.set(name, spec);
        // Re-declaring after a client was handed out would otherwise leave the
        // old credentials in service for the rest of the process.
        this.#clients.delete(name);
        return this;
    }

    /** Names the provider a bare model id belongs to. */
    setDefault(name: string): this {
        if (!this.has(name)) {
            throw new Error(
                `default provider "${name}" is not declared (known: ${this.names().join(', ')})`,
            );
        }
        this.#default = name;
        return this;
    }

    get defaultProvider(): string {
        return this.#default;
    }

    /** Declared here, or a built-in kind usable with no declaration at all. */
    has(name: string): boolean {
        return this.#providers.has(name) || isProviderKind(name);
    }

    names(): string[] {
        return [...new Set([...this.#providers.keys(), ...providerKinds])];
    }

    /** The shared client for a provider, built on first use. */
    client(name: string): ProviderClient {
        const existing = this.#clients.get(name);
        if (existing) {
            return existing;
        }
        const spec = this.#spec(name);
        const built = spec.client ?? buildClient(name, this.kindOf(name), spec, spec);
        this.#clients.set(name, built);
        return built;
    }

    /** Turns a shorthand or a spec into a `Model`. */
    model(ref: ModelRef): Model {
        const spec = typeof ref === 'string' ? this.parse(ref) : ref;
        const name = spec.provider ?? this.#default;
        const provider = this.#spec(name);
        const kind = this.kindOf(name);
        const defaults = KINDS[kind];

        // Inline credentials opt out of the shared client: they describe a
        // different connection, and handing back the memoized one would
        // silently ignore them.
        const client =
            spec.client ??
            (hasCredentials(spec) ? buildClient(name, kind, spec, provider) : this.client(name));

        // Every protocol but OpenAI's has exactly one API, so naming one is a
        // mistake worth reporting rather than a field to ignore.
        if (defaults.protocol !== 'openai') {
            if (spec.api) {
                throw new TypeError(
                    `provider "${name}" (${kind}) has one api, so "${spec.api}" means nothing here`,
                );
            }
            return defaults.protocol === 'anthropic'
                ? new AnthropicModel(spec.model, client as Anthropic, spec)
                : new GeminiModel(spec.model, client as GoogleGenAI, spec);
        }

        const api = spec.api ?? defaults.apis[0];
        if (!defaults.apis.includes(api)) {
            throw new TypeError(
                `provider "${name}" (${kind}) does not speak the "${api}" api ` +
                    `(supported: ${defaults.apis.join(', ')})`,
            );
        }
        return api === 'responses'
            ? new OpenAIResponsesModel(spec.model, client as OpenAI, spec)
            : new OpenAIModel(spec.model, client as OpenAI, spec);
    }

    /**
     * What a ref needs to reach its vendor, resolved but not contacted. An
     * unknown provider still throws: that is a broken config, not a missing
     * credential, and the two want different words.
     */
    requirement(ref: ModelRef): ModelRequirement {
        const spec = typeof ref === 'string' ? this.parse(ref) : ref;
        const name = spec.provider ?? this.#default;
        const provider = this.#spec(name);
        const kind = this.kindOf(name);
        const defaults = KINDS[kind];
        const creds: Credentials = hasCredentials(spec) ? spec : provider;
        const apiKeyEnv = creds.apiKeyEnv ?? defaults.apiKeyEnv;

        // An unset `${VAR}` is precisely the absent credential being asked
        // about, so it answers the question rather than interrupting it.
        let apiKey: string | undefined;
        try {
            apiKey = expand(creds.apiKey, `provider "${name}": apiKey`) ?? fromEnv(apiKeyEnv);
        } catch {
            apiKey = undefined;
        }

        return {
            provider: name,
            kind,
            apiKeyEnv,
            satisfied: Boolean(
                apiKey ??
                provider.token ??
                (spec.client || provider.client) ??
                defaults.keyOptional,
            ),
            keyOptional: Boolean(defaults.keyOptional),
        };
    }

    /** `[provider[/api]:]model` → spec. Exposed so a caller can validate a ref. */
    parse(ref: string): ModelSpec {
        // Only the first colon separates the prefix: model ids may contain colons.
        const colon = ref.indexOf(':');
        if (colon < 0) {
            return { model: ref };
        }
        const [provider, api] = ref.slice(0, colon).split('/');
        const model = ref.slice(colon + 1);
        if (!model) {
            throw new TypeError(`missing model id in "${ref}"`);
        }
        if (!provider || !this.has(provider)) {
            throw new TypeError(
                `unknown provider "${provider}" in "${ref}" ` +
                    `(known: ${this.names().join(', ')}; a model id that itself contains a ` +
                    `colon must name its provider, e.g. "openai:${ref}")`,
            );
        }
        if (api !== undefined && api !== 'chat' && api !== 'responses') {
            throw new TypeError(`unknown api "${api}" in "${ref}" (expected chat or responses)`);
        }
        return { provider, api, model };
    }

    #spec(name: string): ProviderSpec {
        const declared = this.#providers.get(name);
        if (declared) {
            return declared;
        }
        if (isProviderKind(name)) {
            return { kind: name };
        }
        throw new Error(
            `unknown provider "${name}" (known: ${this.names().join(', ')}; ` +
                `declare it under \`providers:\` or in ProjectOptions.providers)`,
        );
    }

    /** A declared kind wins; otherwise a built-in name is its own kind. */
    kindOf(name: string): ProviderKind {
        const declared = this.#providers.get(name)?.kind;
        return declared ?? (isProviderKind(name) ? name : 'openai');
    }
}

/**
 * Credential resolution, in one place so a `${VAR}` reference behaves the same
 * whether it came from yaml or from application code. `creds` may be a model
 * spec overriding the connection; `opts` always carries the provider's
 * transport settings, which an override does not get to reinvent.
 */
function buildClient(
    name: string,
    kind: ProviderKind,
    creds: Credentials,
    opts: ProviderSpec,
): ProviderClient {
    const where = `provider "${name}"`;
    const defaults = KINDS[kind];

    // A token callback replaces the key rather than supplementing it: the
    // header is rewritten per request, so whatever the SDK was constructed with
    // never reaches the wire.
    const apiKeyEnv = creds.apiKeyEnv ?? defaults.apiKeyEnv;
    const apiKey = expand(creds.apiKey, `${where}: apiKey`) ?? fromEnv(apiKeyEnv);
    if (!apiKey && !opts.token && !defaults.keyOptional) {
        throw new Error(`${where}: no api key — set \`apiKey\`, or set ${apiKeyEnv}`);
    }
    // An absent base url means "vendor default", so it may stay undefined.
    const baseURL =
        expand(creds.baseURL, `${where}: baseURL`) ??
        fromEnv(creds.baseURLEnv ?? defaults.baseURLEnv) ??
        defaults.baseURL;
    const headers = expandHeaders(opts.headers, where);

    if (defaults.protocol === 'gemini') {
        return buildGenAI(kind, apiKey, baseURL, headers, opts, where);
    }

    const common = {
        apiKey: apiKey ?? OAUTH_PLACEHOLDER,
        baseURL,
        defaultHeaders: headers,
        timeout: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        ...(opts.token ? { fetch: bearerFetch(opts.token) } : {}),
    };
    if (defaults.protocol === 'anthropic') {
        const { Anthropic } = sdk<AnthropicModule>('@anthropic-ai/sdk', kind);
        return new Anthropic(common);
    }
    const { OpenAI } = sdk<OpenAIModule>('openai', kind);
    return new OpenAI(common);
}

/**
 * The GenAI client is configured by *backend* rather than by url: `vertexai`
 * selects the Gemini Enterprise endpoint and the SDK derives the address from
 * the project and region, so there is no base url to assemble here.
 *
 * Authentication differs the same way. The Gemini API takes a key; Vertex
 * normally takes none, because the SDK resolves Application Default
 * Credentials — a service account, a workload identity, `gcloud auth
 * application-default login` — and refreshes them itself. That is why `vertex`
 * is `keyOptional`, and why it needs none of the bearer-token machinery the
 * OpenAI protocol uses for the same job.
 */
function buildGenAI(
    kind: ProviderKind,
    apiKey: string | undefined,
    baseURL: string | undefined,
    headers: Record<string, string> | undefined,
    opts: ProviderSpec,
    where: string,
): GoogleGenAI {
    const { GoogleGenAI } = sdk<GenAIModule>('@google/genai', kind);
    const httpOptions = { baseUrl: baseURL, headers, timeout: opts.timeoutMs };
    if (kind !== 'vertex') {
        return new GoogleGenAI({ apiKey, httpOptions });
    }
    const project =
        expand(opts.project, `${where}: project`) ??
        fromEnv('GOOGLE_CLOUD_PROJECT') ??
        projectFromKeyFile();
    if (!project && !apiKey) {
        throw new Error(
            `${where}: vertex needs \`project\`, or GOOGLE_CLOUD_PROJECT ` +
                `(or \`apiKey\` for express mode)`,
        );
    }
    return new GoogleGenAI({
        vertexai: true,
        apiKey,
        project,
        location:
            expand(opts.location, `${where}: location`) ??
            fromEnv('GOOGLE_CLOUD_LOCATION') ??
            'global',
        httpOptions,
    });
}

/**
 * `project_id` out of a service-account key file, when one is named.
 *
 * The GenAI SDK resolves Application Default Credentials itself but takes the
 * project only from its constructor or `GOOGLE_CLOUD_PROJECT` — so a key file
 * that already states which project it belongs to still has to have that
 * repeated in the environment. Reading it here removes the second variable for
 * the common case.
 *
 * Only that one route carries a project id: credentials from `gcloud auth
 * application-default login` do not, and a metadata server answers a different
 * endpoint entirely. Both still need the project named, which is why a
 * failure to read anything here is not an error — the caller's own check is.
 */
function projectFromKeyFile(): string | undefined {
    const path = fromEnv('GOOGLE_APPLICATION_CREDENTIALS');
    if (!path) {
        return undefined;
    }
    try {
        const key: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const id = (key as { project_id?: unknown }).project_id;
        return typeof id === 'string' && id.trim() ? id : undefined;
    } catch {
        // An unreadable or malformed file is the SDK's to report, at the point
        // where it tries to authenticate with it and can say so precisely.
        return undefined;
    }
}

// Both SDKs refuse to construct without a key. When a token callback owns the
// Authorization header this value is never sent, so it only has to be non-empty.
const OAUTH_PLACEHOLDER = 'oauth';

/**
 * Rewrites `Authorization` on every request from a callback, so a credential
 * that expires — an Azure AD token, a gateway's short-lived grant — is
 * refreshed without the client, and its connection pool, being rebuilt. Vertex
 * has no need of it: its SDK does the same job from ambient credentials.
 */
function bearerFetch(token: () => string | Promise<string>): typeof fetch {
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${await token()}`);
        return fetch(input, { ...init, headers });
    };
}

function expandHeaders(
    headers: Record<string, string> | undefined,
    where: string,
): Record<string, string> | undefined {
    if (!headers) {
        return undefined;
    }
    return Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, expandEnv(v, `${where}: headers.${k}`)]),
    );
}

function hasCredentials(spec: ModelSpec): boolean {
    return Boolean(spec.apiKey || spec.apiKeyEnv || spec.baseURL || spec.baseURLEnv);
}

// ---------------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------------

/**
 * The registry behind the bare `createModel`. An application that never
 * declares a provider still gets shared clients through it, because the
 * built-in names (`openai`, `google`, …) resolve without declaration.
 */
export const defaultModels = new ModelRegistry();

/**
 * One entry point for every provider. Accepts a shorthand string or a full
 * spec, so `createModel('openai/responses:o3')` and
 * `createModel({ model: 'o3', api: 'responses', apiKeyEnv: 'MY_KEY' })` are
 * both valid.
 */
export function createModel(ref: ModelRef, registry: ModelRegistry = defaultModels): Model {
    return registry.model(ref);
}
