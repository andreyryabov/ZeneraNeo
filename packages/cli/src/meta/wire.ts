import { existsSync } from 'node:fs';
import {
    credentialError,
    envOf,
    invokedAs,
    yellow,
    type KeyEntry,
    type KeyStore,
    type Provider,
} from './host.ts';

// ---------------------------------------------------------------------------
// Wiring
//
// A zen model ref and a zen key entry go in, copilot's `COPILOT_*` environment
// comes out. Everything reaches the child through its environment: a key on an
// argv is readable by every process on the machine, and the whole point of the
// keyring is that it is not.
// ---------------------------------------------------------------------------

/** What `copilot help providers` accepts. There is no google or vertex type. */
type CopilotType = 'openai' | 'anthropic';

const TYPES: Record<Provider, CopilotType> = {
    openai: 'openai',
    anthropic: 'anthropic',
    google: 'openai',
    vertex: 'openai',
    openrouter: 'openai',
};

const BASE_URLS: Partial<Record<Provider, string>> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Copilot offers its tools as OpenAI *custom* tools, which the completions API
 * rejects outright — `400 Invalid value: 'custom'`. Only the responses API
 * takes them, and only the reasoning models serve it, so the wire API follows
 * the model rather than being a flag nobody would know to set. Older models are
 * listed rather than newer ones, so each new generation works without a release.
 */
export function wireApi(provider: Provider, id: string): string | undefined {
    return provider === 'openai' && !/^(gpt-4|gpt-3\.5|chatgpt-)/.test(id)
        ? 'responses'
        : undefined;
}

export interface Wiring {
    provider: Provider;
    /** what the model is called on the wire */
    model: string;
    /** every `COPILOT_*` name and value, ready to hand to the child */
    env: Record<string, string>;
    /** names whose values are secret, for `--secret-env-vars` and for masking */
    secret: string[];
    /** anything true but unwelcome: a location that will be slow, a stale default */
    warnings: string[];
}

/**
 * Turns a zen key entry and a model id into copilot's environment.
 *
 * `COPILOT_PROVIDER_BASE_URL` is what activates BYOK at all, so every provider
 * gets one — including OpenAI, whose url copilot would otherwise have reached
 * through a GitHub account we are deliberately not using.
 */
export function wire(store: KeyStore, entry: KeyEntry, id: string): Wiring {
    const provider = entry.provider as Provider;
    const env: Record<string, string> = {};
    const secret: string[] = [];
    const warnings: string[] = [];

    env.COPILOT_PROVIDER_TYPE = TYPES[provider];
    env.COPILOT_MODEL = id;

    if (provider === 'vertex') {
        const project = store.projectOf(entry)?.id;
        if (!project) {
            throw credentialError(
                `no GCP project on ${entry.provider}/${entry.name}`,
                'set one: zen key add vertex --project <id>',
            );
        }
        const location = entry.location?.trim() || 'global';
        if (location === 'global') {
            warnings.push('location `global` adds about ten seconds of cold start');
        }
        env.COPILOT_PROVIDER_BASE_URL = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi`;
        // Vertex speaks publisher names on the wire and knows nothing of zen's
        // provider prefix; the bare id stays as the model *id* so copilot can
        // still match its catalogue for token limits and tool support.
        env.COPILOT_PROVIDER_WIRE_MODEL = id.includes('/') ? id : `google/${id}`;
        env.COPILOT_PROVIDER_MODEL_ID = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    } else {
        const url = BASE_URLS[provider];
        if (!url) {
            throw credentialError(`no BYOK endpoint known for ${provider}`);
        }
        env.COPILOT_PROVIDER_BASE_URL = url;
    }

    const api = wireApi(provider, id);
    if (api) {
        env.COPILOT_PROVIDER_WIRE_API = api;
    }

    if (entry.holds === 'file') {
        // A Google access token is good for an hour and a session is not, so
        // copilot is told how to mint one rather than handed one that will be
        // stale by the time it matters.
        env.COPILOT_PROVIDER_API_KEY_COMMAND = `${invokedAs('zen')} key token ${entry.provider}`;
        env[envOf(entry)] = store.fileOf(entry);
    } else {
        env.COPILOT_PROVIDER_API_KEY = store.reveal(entry);
        secret.push('COPILOT_PROVIDER_API_KEY');
    }

    return { provider, model: env.COPILOT_PROVIDER_WIRE_MODEL ?? id, env, secret, warnings };
}

/** Values a `--dry-run` may print. A key is four characters and an apology. */
export function masked(env: Record<string, string>, secret: readonly string[]): string[] {
    return Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${secret.includes(name) ? '••••' : value}`);
}

/** Non-fatal, said once, because a competing file is a silent override. */
export function providersWarning(): string | undefined {
    const configured = process.env.COPILOT_PROVIDERS_CONFIG;
    const path = configured ?? `${process.env.HOME ?? ''}/.copilot/providers.json`;
    return existsSync(path)
        ? yellow(`${path} may override the provider zen just wired`)
        : undefined;
}
