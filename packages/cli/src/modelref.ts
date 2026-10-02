import type { Provider } from './keys.ts';

// ---------------------------------------------------------------------------
// Model refs as people type them
//
// `vertex/gemini-3.8-flash` from a person, `openai:gpt-5.6-sol` from
// `agents.yaml`. Read by `zen inspect ask` and by `zen meta`, so it lives with
// neither.
// ---------------------------------------------------------------------------

export const PROVIDER_NAMES: ReadonlySet<string> = new Set([
    'openai',
    'anthropic',
    'google',
    'vertex',
    'openrouter',
]);

/**
 * `vertex/gemini-3.8-flash` splits; `gpt-5.6-sol` does not. Only a known provider
 * counts as a prefix, because `google/gemini-3.8-flash` is also a perfectly good
 * bare id on an endpoint that speaks publisher names.
 *
 * The colon form is the library's own — `openai:gpt-5.6-sol`, and with an api
 * selector `openai/responses:gpt-5.6-sol` — which is what arrives when the ref
 * came from `agents.yaml`.
 */
export function splitRef(ref: string): { provider?: Provider; id: string } {
    const colon = ref.indexOf(':');
    if (colon > 0) {
        const head = ref.slice(0, colon).split('/')[0];
        if (PROVIDER_NAMES.has(head)) {
            return { provider: head as Provider, id: ref.slice(colon + 1) };
        }
    }
    const slash = ref.indexOf('/');
    if (slash < 0) {
        return { id: ref };
    }
    const head = ref.slice(0, slash);
    return PROVIDER_NAMES.has(head)
        ? { provider: head as Provider, id: ref.slice(slash + 1) }
        : { id: ref };
}
