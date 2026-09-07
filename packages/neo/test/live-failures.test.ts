import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/failure.ts';
import type { Model, ModelRequest } from '../src/model.ts';
import { createModel, type ModelRef } from '../src/models/factory.ts';
import { text, type Message } from '../src/types.ts';

// ---------------------------------------------------------------------------
// What a real refusal says
//
// Every other live suite asks whether a provider answers. This one asks
// whether it can be understood when it does not — the sentence a person is
// left holding when a turn dies at three in the morning. Stubs cannot settle
// that: the whole difficulty is that each vendor buries its own reason in its
// own shape, and the shapes are only knowable by being told one.
//
// COST. Both refusals here are rejected at the front door, before a token is
// generated:
//
//   - Over the context window: the request is validated against the window and
//     refused. Nothing is inferred, no `usage` comes back, and there is nothing
//     to bill. What it does spend is UPLOAD — several megabytes per run, per
//     vendor, which is why the size is the smallest that still overflows and
//     why `LIVE_OVERSIZE_TOKENS` exists to shrink it further.
//   - No such model: a routing failure, sent as three words.
//
// Neither is free of risk in the sense that matters more than money: a request
// large enough to be refused is also large enough to be slow, so both run with
// a long timeout and neither is in the default suite (`--exclude '**/live-*'`).
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 300_000;

/**
 * Enough tokens to overflow the widest window any of these models has (Gemini's
 * million), since one prompt is sent to all of them. Deliberately not the ten
 * million the question started at: the refusal is the same either way, and the
 * difference is tens of megabytes uploaded once per vendor.
 */
const OVERSIZE_TOKENS = Number(process.env.LIVE_OVERSIZE_TOKENS ?? 20_000_000);

/**
 * Over-estimated: ordinary prose runs nearer four characters to the token, and
 * a prompt that comes in UNDER the window is not refused — it is answered, and
 * billed. Erring high costs upload; erring low costs money.
 */
const CHARS_PER_TOKEN = 5;

/** Nothing a tokenizer packs efficiently, and nothing a cache can already hold. */
const FILLER = 'quantifiable ledger anomalies were reconciled against the prior quarter. ';

let filled: string | undefined;

function oversized(): string {
    filled ??= FILLER.repeat(Math.ceil((OVERSIZE_TOKENS * CHARS_PER_TOKEN) / FILLER.length));
    return filled;
}

interface Vendor {
    label: string;
    ref: ModelRef;
    /** the SDK call the message must name */
    api: string;
    enabled: boolean;
}

const VENDORS: Vendor[] = [
    {
        label: 'gemini',
        ref: { provider: 'vertex', model: 'gemini-3.5-flash-lite', maxTokens: 64 },
        api: 'models.generateContentStream',
        enabled: Boolean(
            process.env.GOOGLE_CLOUD_PROJECT ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            process.env.VERTEX_API_KEY,
        ),
    },
    {
        label: 'openai',
        ref: { provider: 'openai', api: 'responses', model: 'gpt-5.4-nano' },
        api: 'responses.create',
        enabled: Boolean(process.env.OPENAI_API_KEY),
    },
    {
        label: 'anthropic',
        ref: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 64 },
        api: 'messages.stream',
        enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    },
];

function ask(prompt: string): ModelRequest {
    const messages: Message[] = [{ role: 'user', content: [text(prompt)] }];
    return { messages, tools: [] };
}

/** Runs `model.stream`, which is the path the runtime takes and the one that reported this. */
async function refused(model: Model, request: ModelRequest): Promise<unknown> {
    return model
        .stream!.call(model, request, () => {})
        .then(() => undefined)
        .catch((err: unknown) => err);
}

for (const { label, ref, api, enabled } of VENDORS) {
    const live = enabled ? describe : describe.skip;

    live(`${label} live refusals`, () => {
        it(
            'names the call, the model and the reason when the prompt is over the window',
            async () => {
                const err = await refused(createModel(ref), ask(oversized()));

                expect(
                    err,
                    'the prompt was answered rather than refused, which is the one ' +
                        'outcome here that costs money — raise LIVE_OVERSIZE_TOKENS',
                ).toBeInstanceOf(ProviderError);
                const failure = err as ProviderError;

                // The half the vendor never says.
                expect(failure.site.doing).toBe('llm streaming');
                expect(failure.site.api).toBe(api);
                expect(failure.message).toContain(failure.site.model);
                expect(failure.message).toContain(api);

                // And the half it does, unwrapped: a sentence, not the JSON
                // document it arrived inside, and short enough to be a line.
                expect(failure.detail).not.toMatch(/^\s*\{/);
                expect(failure.detail.length).toBeLessThan(600);
                expect(failure.detail).toMatch(/token|context|too long|exceed|large/i);
                expect(failure.status).toBeGreaterThanOrEqual(400);

                // Whatever the wrapper made of it, the original is still there
                // for anything that wants to look harder.
                expect(failure.cause).toBeDefined();
            },
            TIMEOUT_MS,
        );

        it(
            'names the model that does not exist',
            async () => {
                const missing =
                    typeof ref === 'string'
                        ? 'no-such-model-2999'
                        : { ...ref, model: 'no-such-model-2999' };
                const err = await refused(createModel(missing), ask('hello'));

                expect(err).toBeInstanceOf(ProviderError);
                const failure = err as ProviderError;
                expect(failure.message).toContain('no-such-model-2999');
                expect(failure.message).toContain(api);
                expect(failure.detail).not.toMatch(/^\s*\{/);
                expect(failure.status).toBeGreaterThanOrEqual(400);
            },
            TIMEOUT_MS,
        );
    });
}
