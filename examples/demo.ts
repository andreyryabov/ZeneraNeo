import { z } from 'zod';
import { InMemoryMemoryStore } from '../packages/neo/src/memory-stores/in-memory.ts';
import { InMemoryPayloadStore } from '../packages/neo/src/payload-stores/in-memory.ts';
import { exportRun, importRun } from '../packages/neo/src/payload.ts';
import { AgentRunner } from '../packages/neo/src/runner.ts';
import { StaticSkillProvider } from '../packages/neo/src/skill-providers/static.ts';
import { turns, type AgentState } from '../packages/neo/src/state.ts';
import { tool } from '../packages/neo/src/types.ts';
// Which vendor and how much thinking — shared by every demo. See ./models.ts.
import { model as pick } from './models.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import { banner, box, code, dataUrl, loadEnv, report, stats, step, trace } from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

/** Per-run application context. Every instruction/scope callback receives it. */
interface AppCtx {
    userId: string;
}

// `tool()` binds an argument type and the app context to a JSON-Schema
// declaration; `execute` is called with the parsed args (sync or async).
const getWeather = tool<{ city: string }, AppCtx>({
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
    },
    execute: ({ city }) => ({ city, tempC: 21, sky: 'clear' }),
});

// A Zod schema doubles as the runtime validator and the static result type of
// `runner.run(..., { output: TripPlan })` — see step 4.
const TripPlan = z.object({
    days: z.array(z.object({ day: z.number().int(), plan: z.string() })),
    totalCostEur: z.number(),
});

// ---------------------------------------------------------------------------
// Shared services — declared once, handed to the runner, referenced by id from
// each agent that is allowed to use them.
// ---------------------------------------------------------------------------

/** Large values (images, tool payloads) live here and are referenced by handle;
 *  this is also what `exportRun` walks to build a portable bundle. */
const payloads = new InMemoryPayloadStore('blobs');

/** Long-term memory. One store can hold many scopes — see `scope` below. */
const userMemory = new InMemoryMemoryStore('user-memory');

/** Curated instruction bundles the agent can pull in on demand. */
const travelSkills = new StaticSkillProvider(
    [
        {
            name: 'budget_travel',
            description: 'How to plan a trip on a tight budget.',
            content: 'Prefer trains over flights. Book lodging outside the centre.',
        },
    ],
    'travel',
);

async function test() {
    // The reasoning summaries `trace()` renders are the point of this demo, so
    // it asks for the tier that has them turned up. See ./models.ts.
    const model = pick('deep');

    // The runner owns the shared services (model, payload store, memory stores,
    // skill providers) that every agent declared on it can draw from by name.
    const runner = new AgentRunner<AppCtx>({
        model,
        context: { userId: 'u-1' },
        payloads,
        memory: [userMemory],
        skills: [travelSkills],
        // Keep every request behind its `llm_call` node, so the HTML report
        // written at the end can show exactly what the model was sent.
        recordRequests: true,
    });

    // `runner.agent()` declares an agent: prompt, tools, and which shared
    // services it may use. Nothing runs until the agent is passed to `run()`.
    const planner = runner.agent({
        name: 'planner',
        description: 'Breaks a task into concrete steps and answers with the plan.',
        // Instructions may be a string or a function of the run context.
        instructions: (ctx) =>
            `You are a planner for user ${ctx.userId}. Answer with a concrete day-by-day plan.`,
        tools: [getWeather],
        // 'index' injects the skill list into the prompt; the agent pulls the
        // full body of a skill on demand instead of paying for it up front.
        skills: { provider: travelSkills.id, discovery: 'index' },
        memory: [
            {
                store: userMemory.id,
                // Scope keys partition the store, here one bucket per user.
                scope: (ctx) => `user:${ctx.userId}`,
                access: 'read-write',
                // Recall relevant memories automatically before each turn.
                autoRecall: { query: 'last_user_input', limit: 3 },
            },
        ],
        // Cap on parallel sub-runs this agent may spawn.
        fork: { maxBranches: 3 },
    });

    // Listing `planner` in `handoffs` lets the router transfer the run to it;
    // the handoff shows up as a `handoff` event on the stream below.
    const router = runner.agent({
        name: 'router',
        description: 'Entry point. Answers trivia directly, delegates planning.',
        instructions: 'Route the request: hand off to "planner" for anything multi-step.',
        handoffs: [planner],
    });

    banner('ZeneraNeo demo', `model ${model.id}`);

    // Every step below drives its run through `trace()`, which iterates the
    // handle's event stream — token deltas plus a checkpoint for every llm
    // call, tool call, handoff, fork and join — and then awaits the result.

    // 1. plain text in, answer out
    // `run()` returns a handle: await it (or `.text()`) for the answer, iterate
    // it for events, or await `.final()` once iteration is done.
    step(1, 'Plain text in, answer out');
    const hello = await trace(runner.run(router, 'Say hi in one word.'));
    box('answer', String(hello.output));

    // 2. mixed text + media input, streamed events (deltas + checkpoints)
    // Input can be an array of parts; `{ image }` is shorthand for a media part
    // and accepts a URL or an inline data URL.
    step(2, 'Text + image input, streamed events');
    const result = await trace(
        runner.run(router, [
            'Plan a trip based on this photo and the local weather.',
            { image: await dataUrl('./imgs/coleseum.jpeg', 'image/jpeg'), mimeType: 'image/jpeg' },
        ]),
    );
    box('result', String(result.output));
    stats({
        modelCalls: turns(result.state),
        inputTokens: result.usage?.inputTokens ?? 0,
        cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        reasoningTokens: result.usage?.reasoningTokens ?? 0,
    });

    // 3. follow-up on the same run
    // Passing the previous state back into `send()` continues the conversation
    // with its full history, tool results and memory intact.
    step(3, 'Follow-up on the same run');
    const followUp = await trace(runner.send(result.state, 'Now make it cheaper.'));
    box('follow-up', String(followUp.output));

    // 4. typed result — T comes from the same declaration that validates
    // `output` makes the model emit structured JSON; the result is parsed and
    // validated by `TripPlan`, so `typed.output` is fully typed here.
    step(4, 'Typed output validated by the same schema');
    const typed = await trace(runner.run(planner, 'Plan 3 days in Lisbon.', { output: TripPlan }));
    code('trip plan (parsed JSON)', JSON.stringify(typed.output, null, 2));
    stats({
        totalCostEur: typed.output.totalCostEur,
        days: typed.output.days.length,
    });

    // 5. a run is one portable artifact: state + every blob it references
    // `exportRun` bundles the state together with the payloads it points at;
    // `importRun` rehydrates it against a fresh store (another process, a disk
    // cache, a different machine).
    step(5, 'Export / import the whole run');
    const bundle = await exportRun(typed.state, runner.services.payloads);
    const restored = await importRun<AgentState>(bundle, new InMemoryPayloadStore('restored'));
    stats({ blobs: Object.keys(bundle.blobs).length, phase: restored.phase });

    // 6. the same resolution, for a human: one HTML file per run
    step(6, 'Inspectable HTML report');
    await report('demo', followUp.state, runner, 'Demo · conversation');
    await report('demo-typed', typed.state, runner, 'Demo · typed run');
    console.log();
}

void test().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
