import { readFile } from 'node:fs/promises';
import boxen from 'boxen';
import OpenAI from 'openai';
import pc from 'picocolors';
import { z } from 'zod';
import { AgentRunner } from '../src/runner.ts';
import type { AgentEvent, RunStream } from '../src/events.ts';
import { InMemoryMemoryStore } from '../src/memory.ts';
import { OpenAIModel } from '../src/model.ts';
import { StaticSkillProvider } from '../src/skills.ts';
import { exportRun, InMemoryPayloadStore, importRun } from '../src/payload.ts';
import { turns, type AgentState, type RunResult } from '../src/state.ts';
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

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Numbered section header, so each demo step is easy to spot. */
function step(n: number, title: string): void {
    console.log(`\n${pc.bgBlue(pc.black(` ${n} `))} ${pc.bold(pc.blue(title))}`);
}

/** Dimmed one-liner for run mechanics (tool calls, handoffs, branches). */
function line(icon: string, text: string): void {
    console.log(pc.dim(`  ${icon} ${text}`));
}

/** Width available to boxes and streamed text, minus the 2-column left margin.
 *  `columns` is undefined when stdout is piped, so `$COLUMNS` is the fallback. */
const COLS = process.stdout.columns || Number(process.env.COLUMNS) || 100;
const WIDTH = Math.max(40, Math.min(COLS - 4, 96));

/**
 * Word-wrapping writer for streamed deltas: text still appears token by token,
 * but every line is prefixed with a gutter and broken at `width` instead of
 * relying on the terminal's soft wrap, which would ignore the gutter.
 */
function wrapWriter(gutter: string, width: number, paint: (s: string) => string) {
    let col = 0;
    // The current word, held back until we know whether it fits on this line.
    let word = '';
    let started = false;
    // True at the start of a line the model asked for, false after a soft wrap:
    // real indentation is kept, wrap-induced leading space is not.
    let ownLine = true;
    const newline = (hard: boolean): void => {
        process.stdout.write(`\n${gutter}`);
        col = 0;
        ownLine = hard;
    };
    const flushWord = (): void => {
        if (!word) {
            return;
        }
        if (col > 0 && col + word.length > width) {
            newline(false);
        }
        process.stdout.write(paint(word));
        col += word.length;
        word = '';
    };
    return {
        write(text: string): void {
            if (!started) {
                process.stdout.write(gutter);
                started = true;
            }
            for (const ch of text) {
                if (ch === '\n') {
                    flushWord();
                    newline(true);
                } else if (ch === ' ' || ch === '\t') {
                    flushWord();
                    // Keep the model's own indentation; drop the space that a
                    // soft wrap would otherwise push to the next line.
                    if (col > 0 || ownLine) {
                        process.stdout.write(ch);
                        col += ch === '\t' ? 4 : 1;
                    }
                } else {
                    word += ch;
                    // A token longer than the line gets a hard break.
                    if (word.length >= width) {
                        flushWord();
                    }
                }
            }
        },
        end(): void {
            flushWord();
            if (started) {
                process.stdout.write('\n');
            }
        },
    };
}

/**
 * Consumes a run's full event stream, printing every event, and returns the
 * result. Deltas stream into a gutter; every checkpoint gets its own row.
 */
async function trace<T>(stream: RunStream<T>): Promise<RunResult<T>> {
    // Which kind of delta is mid-flight, so a checkpoint can close it first.
    let open: 'text' | 'thinking' | null = null;
    let writer: ReturnType<typeof wrapWriter> | null = null;
    const flush = (): void => {
        writer?.end();
        writer = null;
        open = null;
    };
    const delta = (kind: 'text' | 'thinking', text: string): void => {
        if (open !== kind) {
            flush();
            writer =
                kind === 'text'
                    ? wrapWriter(pc.dim('  │ '), WIDTH - 4, (s) => s)
                    : wrapWriter(pc.dim('  ┊ '), WIDTH - 4, pc.dim);
            open = kind;
        }
        writer?.write(text);
    };
    /** Branch events are tagged; the trunk is not. */
    const where = (e: AgentEvent): string => (e.branch ? pc.magenta(`[${e.branch.name}] `) : '');

    for await (const event of stream) {
        if (event.type !== 'text_delta' && event.type !== 'thinking_delta') {
            flush();
        }
        const at = where(event);
        switch (event.type) {
            // --- stream deltas -------------------------------------------------
            case 'thinking_delta':
                delta('thinking', event.delta);
                break;
            case 'text_delta':
                delta('text', event.delta);
                break;
            case 'tool_call_detected':
                line('◇', `${at}${pc.bold(event.name)} detected`);
                break;
            case 'tool_args_delta':
                // Arg fragments arrive token by token; the assembled call shows
                // up in `before_tool_call`, so they are dropped here.
                break;
            // --- checkpoints ---------------------------------------------------
            case 'run_created':
                line('○', `${at}run ${event.runId} · agent ${pc.cyan(event.agent)}`);
                break;
            case 'before_llm_call':
                line('↑', `${at}llm call · ${pc.cyan(event.agent)}`);
                break;
            case 'after_llm_call':
                line(
                    '↓',
                    `${at}${event.node.model} · ${event.node.stopReason} · ` +
                        `${event.node.usage.inputTokens} in / ${event.node.usage.outputTokens} out` +
                        (event.node.usage.reasoningTokens
                            ? ` (${event.node.usage.reasoningTokens} reasoning)`
                            : ''),
                );
                break;
            case 'before_tool_call':
                line('→', `${at}${pc.bold(event.call.name)}(${event.call.args.preview})`);
                break;
            case 'after_tool_call':
                line(
                    event.node.isError ? '✕' : '←',
                    `${at}${pc.bold(event.node.name)}: ${event.node.result.preview}`,
                );
                break;
            case 'handoff':
                line('⇄', `${at}handoff ${pc.cyan(event.from)} → ${pc.cyan(event.to)}`);
                break;
            case 'before_fork':
                line(
                    '⑂',
                    `${at}fork ${event.node.branches.map((b) => b.name).join(', ')}`,
                );
                break;
            case 'branch_started':
                line('├', `${at}branch ${pc.magenta(event.child.name)} (${event.child.runId})`);
                break;
            case 'branch_finished':
                line('┤', `${at}branch ${pc.magenta(event.child.name)} ${event.status}`);
                break;
            case 'after_join':
                line('⑃', `${at}join ${event.node.results.length} branches`);
                break;
            case 'run_finished':
                line('●', `${at}run finished`);
                break;
        }
    }
    flush();
    return stream.final();
}

/** Boxed block for anything the user is meant to actually read. */
function box(title: string, body: string): void {
    console.log(
        boxen(body.trim(), {
            title,
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
            margin: { top: 1, bottom: 0, left: 2, right: 0 },
            borderStyle: 'round',
            borderColor: 'cyan',
            width: WIDTH,
        }),
    );
}

/** Compact `key=value` footer, e.g. token usage. */
function stats(entries: Record<string, unknown>): void {
    const line = Object.entries(entries)
        .map(([k, v]) => `${pc.dim(k)}=${pc.bold(String(v))}`)
        .join(pc.dim('  ·  '));
    console.log(`  ${line}`);
}

/**
 * Verbatim block for pre-formatted text such as JSON. `box()` cannot be used:
 * its wrapper trims each line, which would flatten the indentation.
 */
function code(title: string, body: string): void {
    console.log(`\n  ${pc.dim(`┌─ ${title}`)}`);
    for (const l of body.split('\n')) {
        console.log(`  ${pc.dim('│')} ${l}`);
    }
    console.log(`  ${pc.dim('└─')}`);
}

/** Inline a local image as a base64 data URL. */
async function dataUrl(path: string, mimeType: string): Promise<string> {
    const bytes = await readFile(new URL(path, import.meta.url));
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function test() {
    const model = new OpenAIModel('gpt-5.4-mini', new OpenAI(), { reasoningEffort: 'medium' });

    // The runner owns the shared services (model, payload store, memory stores,
    // skill providers) that every agent declared on it can draw from by name.
    const runner = new AgentRunner<AppCtx>({
        model,
        context: { userId: 'u-1' },
        payloads,
        memory: [userMemory],
        skills: [travelSkills],
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

    console.log(
        boxen(`${pc.bold('ZeneraNeo demo')}\n${pc.dim(`model ${model.id}`)}`, {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: 'double',
            borderColor: 'magenta',
            textAlignment: 'center',
        }),
    );

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
    const restored = importRun<AgentState>(bundle, new InMemoryPayloadStore('restored'));
    stats({ blobs: Object.keys(bundle.blobs).length, phase: restored.phase });
    console.log();
}

void test().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
