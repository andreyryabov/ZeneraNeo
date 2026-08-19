import { z } from 'zod';
import { AgentRunner } from '../src/runner.ts';
import { InMemoryMemoryStore } from '../src/memory.ts';
import { OpenAIModel } from '../src/model.ts';
import { StaticSkillProvider } from '../src/skills.ts';
import { exportRun, InMemoryPayloadStore, importRun } from '../src/payload.ts';
import { turns, type AgentState } from '../src/state.ts';
import { tool } from '../src/types.ts';

// Load OPENAI_API_KEY (and friends) from the repo-root .env, if present.
try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
    console.warn('no .env found — copy .env.example to .env');
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

interface AppCtx {
    userId: string;
}

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

const TripPlan = z.object({
    days: z.array(z.object({ day: z.number().int(), plan: z.string() })),
    totalCostEur: z.number(),
});

const blobs = new InMemoryPayloadStore();

async function test() {
    const runner = new AgentRunner<AppCtx>({
        model: new OpenAIModel('gpt-4o-mini'),
        context: { userId: 'u-1' },
        payloads: blobs,
        memory: [new InMemoryMemoryStore('mem')],
        skills: [
            new StaticSkillProvider([
                {
                    name: 'budget_travel',
                    description: 'How to plan a trip on a tight budget.',
                    content: 'Prefer trains over flights. Book lodging outside the centre.',
                },
            ]),
        ],
    });

    const planner = runner.agent({
        name: 'planner',
        description: 'Breaks a task into concrete steps and answers with the plan.',
        instructions: (ctx) =>
            `You are a planner for user ${ctx.userId}. Answer with a concrete day-by-day plan.`,
        tools: [getWeather],
        skills: { provider: 'static', discovery: 'index' },
        memory: [
            {
                store: 'mem',
                scope: (ctx) => `user:${ctx.userId}`,
                access: 'read-write',
                autoRecall: { query: 'last_user_input', limit: 3 },
            },
        ],
        fork: { maxBranches: 3 },
    });

    const router = runner.agent({
        name: 'router',
        description: 'Entry point. Answers trivia directly, delegates planning.',
        instructions: 'Route the request: hand off to "planner" for anything multi-step.',
        handoffs: [planner],
    });

    // 1. plain text in, answer out
    console.log(await runner.run(router, 'Say hi in one word.').text());

    // 2. mixed text + media input, streamed events (deltas + checkpoints)
    const stream = runner.run(router, [
        'Plan a trip based on this photo and the local weather.',
        { image: 'https://example.com/photo.jpg' },
    ]);
    for await (const event of stream) {
        switch (event.type) {
            case 'text_delta':
                process.stdout.write(event.delta);
                break;
            case 'before_tool_call':
                console.log(`\n[${event.agent}] -> ${event.call.name}`);
                break;
            case 'after_tool_call':
                console.log(`[${event.agent}] <- ${event.node.name}: ${event.node.result.preview}`);
                break;
            case 'handoff':
                console.log(`handoff ${event.from} -> ${event.to}`);
                break;
            case 'branch_started':
                console.log(`branch ${event.child.name} started (${event.child.runId})`);
                break;
            default:
                break;
        }
    }
    const result = await stream.final();
    console.log('\n', result.output, result.usage, `${turns(result.state)} model calls`);

    // 3. follow-up on the same run
    const followUp = await runner.send(result.state, 'Now make it cheaper.');
    console.log(followUp.output);

    // 4. typed result — T comes from the same declaration that validates
    const typed = await runner.run(planner, 'Plan 3 days in Lisbon.', { output: TripPlan });
    console.log(typed.output.totalCostEur, typed.output.days.length);

    // 5. a run is one portable artifact: state + every blob it references
    const bundle = await exportRun(typed.state, runner.services.payloads);
    const restored = importRun<AgentState>(bundle, new InMemoryPayloadStore('mem'));
    console.log(`exported ${Object.keys(bundle.blobs).length} blobs, phase ${restored.phase}`);
}

void test().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
