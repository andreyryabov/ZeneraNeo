import OpenAI from 'openai';
import type { Model } from '../model.ts';
import { OpenAIModel } from './openai-chat.ts';
import { OpenAIResponsesModel, type OpenAIResponsesModelOptions } from './openai-responses.ts';

// ---------------------------------------------------------------------------
// Model factory
// ---------------------------------------------------------------------------

/**
 * How to reach a provider. Every field has an env fallback so a spec can stay
 * declarative (and secret-free) in application code.
 */
export interface Credentials {
    /** literal key — wins over any env lookup */
    apiKey?: string;
    /** env var holding the key; defaults to the provider's conventional name */
    apiKeyEnv?: string;
    /** literal base url, for gateways and OpenAI-compatible endpoints */
    baseURL?: string;
    /** env var holding the base url; defaults to the provider's conventional name */
    baseURLEnv?: string;
}

/**
 * `OpenAIResponsesModelOptions` is the superset of the two adapters' knobs;
 * options that do not apply to the chosen `api` are ignored.
 */
export interface OpenAIModelSpec extends Credentials, OpenAIResponsesModelOptions {
    /**
     * Discriminator. Optional only for OpenAI, which is the default, so the
     * common case stays `{ model: 'gpt-4o' }`.
     */
    kind?: 'openai';
    /** which OpenAI API to speak; defaults to chat completions */
    api?: 'chat' | 'responses';
    model: string;
    /** pre-built client — bypasses credential resolution entirely */
    client?: OpenAI;
}

/**
 * Discriminated on `kind`, so it grows into
 * `OpenAIModelSpec | AnthropicModelSpec | GeminiModelSpec | …` without any
 * member having to know about the others, and `createModel` stays exhaustive.
 */
export type ModelSpec = OpenAIModelSpec;

/**
 * Shorthand: `[kind[/api]:]model`, e.g. `gpt-4o`, `openai:gpt-4o`,
 * `openai/responses:o3`. Anything the shorthand cannot express (keys, base
 * urls, reasoning knobs) needs the object form.
 */
export type ModelRef = ModelSpec | string;

const OPENAI_ENV = { apiKeyEnv: 'OPENAI_API_KEY', baseURLEnv: 'OPENAI_BASE_URL' };

/**
 * One entry point for every provider. Accepts a shorthand string or a full
 * spec, so `createModel('openai/responses:o3')` and
 * `createModel({ model: 'o3', api: 'responses', apiKeyEnv: 'MY_KEY' })` are
 * both valid.
 */
export function createModel(ref: ModelRef): Model {
    const spec = typeof ref === 'string' ? parseRef(ref) : ref;
    switch (spec.kind ?? 'openai') {
        case 'openai':
            return createOpenAIModel(spec);
        default:
            throw new TypeError(`unknown model kind: ${spec.kind as string}`);
    }
}

function createOpenAIModel(spec: OpenAIModelSpec): Model {
    const client = spec.client ?? new OpenAI(clientOptions(spec, OPENAI_ENV));
    return spec.api === 'responses'
        ? new OpenAIResponsesModel(spec.model, client, spec)
        : new OpenAIModel(spec.model, client, spec);
}

function clientOptions(
    creds: Credentials,
    defaults: { apiKeyEnv: string; baseURLEnv: string },
): { apiKey: string; baseURL?: string } {
    const apiKeyEnv = creds.apiKeyEnv ?? defaults.apiKeyEnv;
    const apiKey = creds.apiKey ?? fromEnv(apiKeyEnv);
    if (!apiKey) {
        throw new Error(`no api key: pass \`apiKey\`, or set ${apiKeyEnv}`);
    }
    // An absent base url means "provider default", so it stays undefined.
    return { apiKey, baseURL: creds.baseURL ?? fromEnv(creds.baseURLEnv ?? defaults.baseURLEnv) };
}

function fromEnv(name: string): string | undefined {
    const value = process.env[name];
    return value?.trim() ? value : undefined;
}

function parseRef(ref: string): ModelSpec {
    // Only the first colon separates the prefix: model ids may contain colons.
    const colon = ref.indexOf(':');
    if (colon < 0) {
        return { model: ref };
    }
    const [kind, api] = ref.slice(0, colon).split('/');
    const model = ref.slice(colon + 1);
    if (!model) {
        throw new TypeError(`missing model id in "${ref}"`);
    }
    if (kind !== 'openai') {
        throw new TypeError(`unknown model kind "${kind}" in "${ref}"`);
    }
    if (api !== undefined && api !== 'chat' && api !== 'responses') {
        throw new TypeError(`unknown openai api "${api}" in "${ref}"`);
    }
    return { kind, api, model };
}
