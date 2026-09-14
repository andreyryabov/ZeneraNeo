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
//     to bill. What it does spend is UPLOAD, so each vendor is sent the
//     smallest prompt ITS OWN window refuses rather than one prompt big enough
//     for all three — 20MB, 3MB and 1.5MB, not 100MB three times over.
//   - No such model: a routing failure, sent as three words.
//
// Neither is free of risk in the sense that matters more than money: a request
// large enough to be refused is also large enough to be slow, so both run with
// a long timeout and neither is in the default suite (`--exclude '**/live-*'`).
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 300_000;

/**
 * Set to make every vendor use one size; otherwise each uses `Vendor.overTokens`
 * below. The escape hatch for the day a window grows and a prompt gets answered.
 */
const OVERRIDE_TOKENS = Number(process.env.LIVE_OVERSIZE_TOKENS) || 0;

/**
 * Worst case, and Anthropic's: it counted 1,541,124 tokens in 7,500,020
 * characters of the filler below, so 4.87. Gemini packs the same filler nearer
 * SEVEN characters to the token — a budget in tokens is therefore nominal, and
 * the per-vendor margins below are what actually make each prompt overflow.
 * Erring high costs upload; erring low costs money, because a prompt that comes
 * in under the window is not refused, it is answered and billed.
 */
const CHARS_PER_TOKEN = 5;

/** Nothing a tokenizer packs efficiently, and nothing a cache can already hold. */
const FILLER = 'quantifiable ledger anomalies were reconciled against the prior quarter. ';

const START = Date.now();

/** Instrumentation: a refusal that arrives late is indistinguishable from a hang without it. */
function log(...parts: unknown[]): void {
    const at = ((Date.now() - START) / 1000).toFixed(1).padStart(6);
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
    const mem = process.memoryUsage();
    process.stderr.write(
        `[live-failures ${at}s rss=${mb(mem.rss)} heap=${mb(mem.heapUsed)}] ${parts.join(' ')}\n`,
    );
}

/** Logs every `everyMs` until the returned function is called, so a hang is visible as it happens. */
function heartbeat(what: string, everyMs = 5_000): () => void {
    const timer = setInterval(() => log('...still in', what), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

let filled: string | undefined;

/** One buffer, built at the largest size any vendor asks for and sliced for the rest. */
function oversized(tokens: number): string {
    if (filled === undefined) {
        const most =
            OVERRIDE_TOKENS ||
            Math.max(...VENDORS.filter((v) => v.enabled).map((v) => v.overTokens));
        const chars = Math.ceil((most * CHARS_PER_TOKEN) / FILLER.length);
        log(`building filler: ${most} tokens -> ${chars} repeats`);
        const stop = heartbeat('String.repeat');
        try {
            filled = FILLER.repeat(chars);
        } finally {
            stop();
        }
        log(`filler built: ${filled.length} chars`);
    }
    return filled.slice(0, (OVERRIDE_TOKENS || tokens) * CHARS_PER_TOKEN);
}

interface Vendor {
    label: string;
    ref: ModelRef;
    /** the SDK call the message must name */
    api: string;
    /** the smallest prompt this model refuses, with margin — see each entry */
    overTokens: number;
    enabled: boolean;
}

const VENDORS: Vendor[] = [
    {
        label: 'gemini',
        ref: { provider: 'vertex', model: 'gemini-3.5-flash-lite', maxTokens: 64 },
        api: 'models.generateContentStream',
        // Window is 1,048,576, which the refusal itself states. The margin is
        // wide because Gemini's tokenizer is the efficient one on this filler:
        // 7.5MB of it went UNDER the window and was answered, so this asks for
        // four million nominal tokens (20MB) to land near three million real.
        overTokens: 4_000_000,
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
        /** Half again over the nano context window of 400k. */
        overTokens: 600_000,
        enabled: Boolean(process.env.OPENAI_API_KEY),
    },
    {
        label: 'anthropic',
        ref: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 64 },
        api: 'messages.stream',
        /** Half again over the Haiku context window of 200k. */
        overTokens: 300_000,
        enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    },
];

function ask(prompt: string): ModelRequest {
    const messages: Message[] = [{ role: 'user', content: [text(prompt)] }];
    return { messages, tools: [] };
}

/** Runs `model.stream`, which is the path the runtime takes and the one that reported this. */
async function refused(model: Model, request: ModelRequest): Promise<unknown> {
    const prompt = request.messages[0]?.content[0];
    const size =
        typeof prompt === 'object' && prompt !== null && 'text' in prompt
            ? String(prompt.text).length
            : 0;
    log(`stream: calling, prompt=${size} chars`);
    const stop = heartbeat('model.stream');
    let chunks = 0;
    try {
        return await model
            .stream!.call(model, request, () => {
                if (chunks++ === 0)
                    log('stream: FIRST CHUNK — the prompt was answered, not refused');
            })
            .then(() => {
                log(`stream: resolved without error after ${chunks} chunks`);
                return undefined;
            })
            .catch((err: unknown) => {
                log(
                    `stream: rejected with ${(err as Error)?.constructor?.name}:`,
                    String((err as Error)?.message).slice(0, 200),
                );
                return err;
            });
    } finally {
        stop();
    }
}

log(
    `config: ${
        VENDORS.filter((v) => v.enabled)
            .map((v) => `${v.label}=${OVERRIDE_TOKENS || v.overTokens}tok`)
            .join(' ') || 'no vendors enabled'
    }`,
);

for (const { label, ref, api, overTokens, enabled } of VENDORS) {
    const live = enabled ? describe : describe.skip;

    live(`${label} live refusals`, () => {
        it(
            'names the call, the model and the reason when the prompt is over the window',
            async () => {
                log(`=== ${label}: oversize prompt ===`);
                const model = createModel(ref);
                log(`${label}: model created`);
                const request = ask(oversized(overTokens));
                log(`${label}: request built`);
                const err = await refused(model, request);
                log(`${label}: oversize done`);

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
                log(`=== ${label}: missing model ===`);
                const missing =
                    typeof ref === 'string'
                        ? 'no-such-model-2999'
                        : { ...ref, model: 'no-such-model-2999' };
                const err = await refused(createModel(missing), ask('hello'));
                log(`${label}: missing-model done`);

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
