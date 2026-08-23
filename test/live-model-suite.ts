import { describe, expect, it } from 'vitest';
import type { StreamDelta } from '../src/events.ts';
import type { Model, ModelRequest } from '../src/model.ts';
import { createModel, type ModelRef } from '../src/models/factory.ts';
import { text, type Message, type ToolSchema } from '../src/types.ts';

// ---------------------------------------------------------------------------
// One conformance suite, run once per vendor
// ---------------------------------------------------------------------------

/**
 * These tests exercise a `Model` *directly* — no runner, no agent, no state.
 * The point is the adapter: does the vendor's wire format survive the trip out
 * and back for the three things every provider has to do (generate, stream,
 * call a tool and be told the answer)?
 *
 * Running the same expectations against all three vendors is deliberate: an
 * adapter that only satisfies its own test file is free to invent its own
 * meaning for `stopReason` or `usage`, and the runtime above it cannot tell
 * the difference.
 */

const TIMEOUT_MS = 120_000;

const WEATHER_TOOL: ToolSchema = {
    name: 'get_temperature',
    description: 'Returns the current temperature in a city, in degrees Celsius.',
    parameters: {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City name, e.g. "Lisbon"' },
        },
        required: ['city'],
        additionalProperties: false,
    },
};

/** A value no model would produce on its own, so the answer has to come from the tool. */
const FAKE_TEMPERATURE = -273;

export interface LiveModelSuite {
    /** shown in the test name */
    label: string;
    /** what to hand `createModel` */
    ref: ModelRef;
    /** false when the vendor's credentials are absent — the suite then skips */
    enabled: boolean;
}

function user(prompt: string): Message {
    return { role: 'user', content: [text(prompt)] };
}

function request(over: Partial<ModelRequest> & Pick<ModelRequest, 'messages'>): ModelRequest {
    return { tools: [], ...over };
}

export function liveModelSuite({ label, ref, enabled }: LiveModelSuite): void {
    const live = enabled ? describe : describe.skip;

    live(`${label} live model`, () => {
        // One instance for the whole suite: the Gemini adapter caches thought
        // signatures on the model, so rebuilding it between turns of a tool
        // round trip would quietly change what is being tested.
        let model: Model;

        function get(): Model {
            model ??= createModel(ref);
            return model;
        }

        it(
            'generates text and reports usage',
            async () => {
                const res = await get().generate(
                    request({
                        system: 'Answer with one word and no punctuation.',
                        messages: [user('What is the capital of France?')],
                    }),
                );

                expect(res.text.toLowerCase()).toContain('paris');
                expect(res.toolCalls).toEqual([]);
                expect(res.stopReason).toBe('stop');
                expect(res.usage?.inputTokens).toBeGreaterThan(0);
                expect(res.usage?.outputTokens).toBeGreaterThan(0);
            },
            TIMEOUT_MS,
        );

        it(
            'streams the same text it returns',
            async () => {
                const stream = get().stream;
                expect(stream).toBeTypeOf('function');

                const deltas: StreamDelta[] = [];
                const res = await stream!.call(
                    get(),
                    request({
                        system: 'Answer with one short sentence.',
                        messages: [user('Name the largest planet in the solar system.')],
                    }),
                    (d) => deltas.push(d),
                );

                const streamed = deltas
                    .filter((d) => d.type === 'text_delta')
                    .map((d) => d.delta)
                    .join('');

                expect(streamed).not.toBe('');
                expect(streamed).toBe(res.text);
                expect(res.text.toLowerCase()).toContain('jupiter');
            },
            TIMEOUT_MS,
        );

        it(
            'calls a tool and answers from its result',
            async () => {
                const messages: Message[] = [
                    user('What is the current temperature in Lisbon? Report the exact number.'),
                ];
                const system =
                    'You have no weather knowledge of your own. ' +
                    'Call get_temperature, then state the number it returned.';

                const first = await get().generate(
                    request({ system, messages, tools: [WEATHER_TOOL], toolChoice: 'auto' }),
                );

                expect(first.stopReason).toBe('tool_calls');
                expect(first.toolCalls).toHaveLength(1);

                const call = first.toolCalls[0]!;
                expect(call.name).toBe('get_temperature');
                expect(call.id).not.toBe('');
                expect(JSON.parse(call.args)).toMatchObject({ city: expect.any(String) });

                messages.push(
                    { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
                    {
                        role: 'tool',
                        callId: call.id,
                        name: call.name,
                        content: JSON.stringify({ celsius: FAKE_TEMPERATURE }),
                    },
                );

                const second = await get().generate(
                    request({ system, messages, tools: [WEATHER_TOOL] }),
                );

                expect(second.toolCalls).toEqual([]);
                expect(second.text).toContain(String(FAKE_TEMPERATURE));
            },
            TIMEOUT_MS,
        );
    });
}
