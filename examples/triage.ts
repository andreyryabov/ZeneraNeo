import { z } from 'zod';
import { AgentRunner } from '../src/runner.ts';
import { turns } from '../src/state.ts';
import type { JoinNode } from '../src/trajectory.ts';
import { tool } from '../src/types.ts';
// Live one-pane-per-branch board. See ./board.ts.
import { traceBoard } from './board.ts';
// Which vendor and how much thinking — shared by every demo. See ./models.ts.
import { model as pick } from './models.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import {
    banner,
    box,
    code,
    gantt,
    joinTable,
    loadEnv,
    report,
    secs,
    stats,
    step,
    type Lap,
} from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Multi-step fan-out
//
// ./fanout.ts forks ten branches that each make a single tool call: it is about
// the *shape* of fork/join. This one is about what happens inside a branch.
//
// Every branch runs a four-phase investigation — discover endpoints, measure
// each one, pull the deploy log, and read the errors if the numbers are bad —
// so a branch is half a dozen model turns and as many tool calls, with its own
// reasoning in between. All of it is streamed: `event.branch` tags every delta
// and checkpoint with the branch that produced it, which is exactly what the
// board demultiplexes into panes.
// ---------------------------------------------------------------------------

/** Per-run application context. Every instruction/scope callback receives it. */
interface AppCtx {
    incident: string;
}

/** The services under investigation — one branch each. */
const SERVICES = ['checkout-api', 'search-api', 'billing-worker', 'auth-gateway'] as const;

/**
 * Fixed fixtures rather than random numbers: the demo has a story (two sick
 * services, each with a deploy that explains it) and the story should be the
 * same on every run.
 */
const FLEET: Record<
    string,
    {
        endpoints: Record<string, { p50Ms: number; p99Ms: number; errorRatePct: number }>;
        deploys: string[];
        logs: Record<string, string>;
    }
> = {
    'checkout-api': {
        endpoints: {
            '/cart': { p50Ms: 40, p99Ms: 180, errorRatePct: 0.2 },
            '/checkout': { p50Ms: 120, p99Ms: 980, errorRatePct: 3.4 },
            '/receipt': { p50Ms: 55, p99Ms: 210, errorRatePct: 0.1 },
        },
        deploys: [
            'v482 · 09:12 · "validate promo codes against the coupon service"',
            'v481 · 04:40 · "bump base image"',
        ],
        logs: {
            '/checkout':
                'TimeoutError: coupon-service call exceeded the 2s budget (81% of failed samples); ' +
                'retry storm visible after 09:15',
        },
    },
    'search-api': {
        endpoints: {
            '/query': { p50Ms: 30, p99Ms: 140, errorRatePct: 0.1 },
            '/suggest': { p50Ms: 25, p99Ms: 120, errorRatePct: 0.0 },
            '/index': { p50Ms: 60, p99Ms: 260, errorRatePct: 0.4 },
        },
        deploys: ['v311 · 02:05 · "tokenizer cache"'],
        logs: {},
    },
    'billing-worker': {
        endpoints: {
            '/invoice': { p50Ms: 90, p99Ms: 520, errorRatePct: 1.8 },
            '/refund': { p50Ms: 70, p99Ms: 300, errorRatePct: 0.3 },
            '/ledger': { p50Ms: 45, p99Ms: 190, errorRatePct: 0.1 },
        },
        deploys: [
            'v212 · 09:05 · "swap the invoice PDF renderer"',
            'v211 · 21:30 · "retry policy for the ledger writer"',
        ],
        logs: {
            '/invoice':
                'PdfRenderer: worker pool exhausted, 4 of 4 slots busy; queue depth 60+ since 09:07',
        },
    },
    'auth-gateway': {
        endpoints: {
            '/token': { p50Ms: 20, p99Ms: 95, errorRatePct: 0.05 },
            '/verify': { p50Ms: 18, p99Ms: 88, errorRatePct: 0.02 },
            '/rotate': { p50Ms: 33, p99Ms: 150, errorRatePct: 0.1 },
        },
        deploys: ['v96 · 01:20 · "rotate signing keys"'],
        logs: {},
    },
};

/** Per-tool latency. Slow enough that serial execution would be painful. */
const COST_MS = { list: 400, metrics: 900, deploys: 700, logs: 800 };

/** Live bookkeeping, so the demo can *prove* the branches overlap instead of
 *  asserting it: `peak` is the most tool calls ever in flight at once. */
const calls = { inFlight: 0, peak: 0, count: 0, serialMs: 0 };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason as Error);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason as Error);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Wraps a fixture lookup as a slow tool body, with the concurrency bookkeeping. */
async function slow<T>(ms: number, signal: AbortSignal | undefined, body: () => T): Promise<T> {
    calls.inFlight++;
    calls.peak = Math.max(calls.peak, calls.inFlight);
    const started = Date.now();
    try {
        await sleep(ms, signal);
        return body();
    } finally {
        calls.serialMs += Date.now() - started;
        calls.count++;
        calls.inFlight--;
    }
}

function service(name: string): (typeof FLEET)[string] {
    const s = FLEET[name];
    if (!s) {
        throw new Error(`unknown service "${name}" — one of: ${Object.keys(FLEET).join(', ')}`);
    }
    return s;
}

// --- the analyst's toolbelt ------------------------------------------------
// Four narrow tools instead of one wide one: that is what forces a branch to
// take several turns, and what makes its per-branch event stream interesting.

const listEndpoints = tool<{ service: string }, AppCtx>({
    name: 'list_endpoints',
    description: 'List the routed endpoints of ONE service. Always the first step of an audit.',
    parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
        additionalProperties: false,
    },
    execute: ({ service: name }, { signal }) =>
        slow(COST_MS.list, signal, () => ({
            service: name,
            endpoints: Object.keys(service(name).endpoints),
        })),
});

const fetchMetrics = tool<{ service: string; endpoint: string }, AppCtx>({
    name: 'fetch_metrics',
    description:
        'Measure ONE endpoint of ONE service over the last 15 minutes. A live measurement: ' +
        `~${(COST_MS.metrics / 1000).toFixed(1)}s per call, and it cannot be batched.`,
    parameters: {
        type: 'object',
        properties: {
            service: { type: 'string' },
            endpoint: { type: 'string', description: 'e.g. "/checkout"' },
        },
        required: ['service', 'endpoint'],
        additionalProperties: false,
    },
    execute: ({ service: name, endpoint }, { signal }) =>
        slow(COST_MS.metrics, signal, () => {
            const m = service(name).endpoints[endpoint];
            if (!m) {
                throw new Error(`no such endpoint "${endpoint}" on ${name}`);
            }
            return { service: name, endpoint, ...m, samples: 5_000 };
        }),
});

const recentDeploys = tool<{ service: string }, AppCtx>({
    name: 'recent_deploys',
    description: 'Deployments of ONE service in the last 24h, newest first.',
    parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
        additionalProperties: false,
    },
    execute: ({ service: name }, { signal }) =>
        slow(COST_MS.deploys, signal, () => ({ service: name, deploys: service(name).deploys })),
});

const readErrorLog = tool<{ service: string; endpoint: string }, AppCtx>({
    name: 'read_error_log',
    description:
        'Sampled error log for ONE endpoint. Expensive — only worth it for an endpoint that ' +
        'already looks unhealthy.',
    parameters: {
        type: 'object',
        properties: { service: { type: 'string' }, endpoint: { type: 'string' } },
        required: ['service', 'endpoint'],
        additionalProperties: false,
    },
    execute: ({ service: name, endpoint }, { signal }) =>
        slow(COST_MS.logs, signal, () => ({
            service: name,
            endpoint,
            excerpt: service(name).logs[endpoint] ?? 'no errors sampled in the window',
        })),
});

/** The trunk's structured answer, merged from the four branch reports. */
const TriageReport = z.object({
    suspects: z.array(
        z.object({
            service: z.string(),
            endpoint: z.string(),
            p99Ms: z.number(),
            likelyCause: z.string(),
        }),
    ),
    healthy: z.array(z.string()),
    nextStep: z.string(),
    summary: z.string(),
});

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Vendor and tiers come from ./models.ts, so `DEMO_VENDOR=openai` (or
    // `anthropic`) runs this same demo elsewhere without an edit here.
    const model_thinking = pick('thinking');
    const model_fast = pick('fast');
    const model = model_thinking;

    const runner = new AgentRunner<AppCtx>({
        model,
        context: { incident: 'INC-4417' },
        // Keep every request behind its `llm_call` node, so the HTML report
        // written at the end can show exactly what each branch was sent.
        recordRequests: true,
    });

    // The worker. Multi-step by construction: its tools are deliberately narrow,
    // so a full audit is a sequence of decisions, not one call.
    const analyst = runner.agent({
        name: 'analyst',
        description: 'Audits exactly one service end to end and reports a one-line verdict.',
        instructions: (ctx) =>
            [
                `You are on-call for incident ${ctx.incident} and you own exactly ONE service.`,
                'Work it in four phases, one tool call at a time — never guess a number you',
                'have not measured:',
                '  1. `list_endpoints` for your service.',
                '  2. `fetch_metrics` once for EVERY endpoint it returned. One call per endpoint.',
                '  3. `recent_deploys` for your service.',
                '  4. Only if an endpoint has p99 > 400ms or errors > 1%: `read_error_log` for the',
                '     worst one.',
                '',
                'Then answer with exactly one line and nothing else:',
                '<service>: verdict=<healthy|degraded> worst=<endpoint> p99=<ms>ms errors=<pct>% cause=<short phrase or none>',
            ].join('\n'),
        tools: [listEndpoints, fetchMetrics, recentDeploys, readErrorLog],
    });

    // The coordinator owns none of those tools. Its only way to get the work
    // done is the built-in `fork` tool, restricted to `analyst` branches.
    const coordinator = runner.agent({
        name: 'coordinator',
        description: 'Fans an incident triage out over one branch per service and merges findings.',
        instructions: (ctx) =>
            [
                `You are the incident commander for ${ctx.incident}. Four services are suspect:`,
                SERVICES.join(', '),
                '',
                'Auditing one service takes several slow, single-target tool calls that you do not',
                'have, and you must not audit anything yourself.',
                '',
                `Call the \`fork\` tool exactly once, with exactly ${SERVICES.length} branches — one per service:`,
                '  • "name" is the service name',
                '  • "agent" is "analyst" for every branch',
                '  • "instructions" name the one service that branch owns',
                '  • "context" is "none": a branch needs its service, not this conversation',
                '',
                'The branches investigate in parallel and rejoin as a single tool result holding',
                'all four verdicts. Correlate them — a shared deploy window is worth more than any',
                'single verdict — then deliver the answer with `final_output`.',
            ].join('\n'),
        fork: { agents: [analyst.name], maxBranches: SERVICES.length },
    });

    banner(
        'ZeneraNeo — multi-step branches, live',
        `model ${model.id} · ${SERVICES.length} services · 4-phase audit each`,
    );

    step(1, 'Fan out: every branch runs its own multi-step investigation');
    console.log(
        `  \x1b[2mone pane per branch · steps are model turns · → out / ← back is a tool call · ✻ is reasoning\x1b[0m\n`,
    );
    const laps: Lap[] = [];
    let joined: JoinNode | undefined;
    const started = Date.now();
    const result = await traceBoard(
        runner.run(coordinator, 'Triage the incident and tell me what to look at first.', {
            output: TriageReport,
            // Branches must not fork again: at depth 1 the fork tool is no
            // longer offered, which bounds the tree structurally.
            maxForkDepth: 1,
        }),
        { laps, onJoin: (node) => (joined = node) },
    );
    const elapsed = Date.now() - started;

    step(2, 'What the parallelism bought');
    gantt(laps, elapsed);
    // A branch is a whole investigation, so the honest unit of saving is branch
    // wall clock, not tool time: four of them overlapped inside `elapsed`.
    const branchMs = laps.reduce((n, l) => n + ((l.end ?? elapsed) - l.start), 0);
    stats({
        wallClock: secs(elapsed),
        branchTimeTotal: secs(branchMs),
        speedup: `${(branchMs / elapsed).toFixed(1)}×`,
        toolCalls: calls.count,
        serialToolTime: secs(calls.serialMs),
        peakConcurrentCalls: calls.peak,
    });

    step(3, 'The join, as the parent sees it');
    // A branch spent a dozen events getting there; the parent's history gains
    // one fork tool call and one tool result. The branch's own nodes hang off
    // its row of the join: there for audit, out of the parent's prompt.
    if (joined) {
        await joinTable(joined, runner.services.payloads);
        stats({
            branchInputTokens: joined.usage.inputTokens,
            branchOutputTokens: joined.usage.outputTokens,
            parentMessagesAdded: 2,
            branchNodesOnRecord: joined.branches.reduce((n, b) => n + b.nodes.length, 0),
        });
    }

    step(4, 'Merged, typed answer');
    code('triage report (parsed JSON)', JSON.stringify(result.output, null, 2));
    box('summary', result.output.summary);
    stats({
        // `turns` counts the parent's own calls; the branches' are their own.
        modelCalls: turns(result.state),
        // `state.usage` is a flat sum over the whole trajectory, so it already
        // covers every token spent inside the fork.
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
    });

    step(5, 'Inspectable HTML report');
    await report('triage', result.state, runner, 'Triage · INC-4417');
    console.log();
}

void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
