import { z } from 'zod';
import { createModel } from '../src/models/factory.ts';
import { AgentRunner } from '../src/runner.ts';
import { turns } from '../src/state.ts';
import type { JoinNode } from '../src/trajectory.ts';
import { tool } from '../src/types.ts';
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
    trace,
    type Lap,
} from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Fan-out demo
//
// One agent, one expensive tool, ten independent units of work. The point is
// that the *model* decides to parallelize: it is told the tool is slow and
// single-item, and the only way out is the built-in `fork` tool. Ten child runs
// then execute concurrently — real overlapping model calls and real overlapping
// tool executions — and rejoin as a single tool result on the trunk.
// ---------------------------------------------------------------------------

/** Per-run application context. Every instruction/scope callback receives it. */
interface AppCtx {
    tenant: string;
}

const REGIONS = [
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'eu-central-1',
    'ap-south-1',
    'ap-northeast-1',
    'ap-southeast-2',
    'sa-east-1',
    'af-south-1',
    'me-central-1',
] as const;

/** How long a single probe pretends to take. Big enough to see the speed-up. */
const PROBE_MS = 1_400;

/**
 * Live bookkeeping for the tool, so the demo can *prove* the branches overlap
 * instead of asserting it: `peak` is the highest number of probes that were
 * simultaneously in flight, `serialMs` is what the same work would have cost
 * back to back.
 */
const probes = { inFlight: 0, peak: 0, count: 0, serialMs: 0 };

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

/** Stable pseudo-random metrics: the same region always reports the same numbers. */
function hash32(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/**
 * The expensive tool. It handles exactly one region per call and takes ~1.4 s,
 * which is what makes serial execution obviously wrong and gives the model a
 * reason to fork.
 */
const probeRegion = tool<{ region: string }, AppCtx>({
    name: 'probe_region',
    description:
        'Run a full latency and error-rate probe against ONE region. The probe is a live ' +
        `measurement: it takes about ${(PROBE_MS / 1000).toFixed(1)} seconds, handles a ` +
        'single region per call, and cannot be batched.',
    parameters: {
        type: 'object',
        properties: { region: { type: 'string', description: 'e.g. "eu-west-1"' } },
        required: ['region'],
        additionalProperties: false,
    },
    execute: async ({ region }, { signal }) => {
        probes.inFlight++;
        probes.peak = Math.max(probes.peak, probes.inFlight);
        const started = Date.now();
        try {
            await sleep(PROBE_MS, signal);
            const h = hash32(region);
            const p50Ms = 35 + (h % 70);
            return {
                region,
                p50Ms,
                p99Ms: p50Ms * 3 + ((h >>> 8) % 400),
                errorRatePct: Number((((h >>> 16) % 450) / 100).toFixed(2)),
                samples: 5_000,
            };
        } finally {
            probes.serialMs += Date.now() - started;
            probes.count++;
            probes.inFlight--;
        }
    },
});

/** The trunk's structured answer, merged from the ten branch reports. */
const FleetReport = z.object({
    worst: z.object({ region: z.string(), p99Ms: z.number() }),
    healthy: z.array(z.string()),
    degraded: z.array(z.object({ region: z.string(), reason: z.string() })),
    summary: z.string(),
});

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const model = createModel({
        model: 'gpt-5.4-mini',
        api: 'responses',
        reasoningEffort: 'low',
    });

    // No `joinPolicy` is given: the default summarizes a branch as its final
    // text, which is exactly the one-line report each prober is asked for, and
    // lets a failed branch be data rather than an exception (`continue`).
    const runner = new AgentRunner<AppCtx>({
        model,
        context: { tenant: 'acme' },
        // Keep every request behind its `llm_call` node, so the HTML report
        // written at the end can show exactly what each branch was sent.
        recordRequests: true,
    });

    // The worker. It owns the slow tool and nothing else: no fork option, so it
    // structurally cannot fan out again.
    const prober = runner.agent({
        name: 'prober',
        description: 'Probes exactly one region and reports its numbers.',
        instructions:
            'You audit a single region. Call `probe_region` exactly once, for the region you ' +
            'were given, and nothing else. Then answer with one compact line:\n' +
            '<region>: p50=<ms>ms p99=<ms>ms errors=<pct>% verdict=<healthy|degraded>\n' +
            'Call it degraded when p99 exceeds 400ms or the error rate exceeds 1%.',
        tools: [probeRegion],
    });

    // The coordinator has no probe tool at all. Its only way to get the work
    // done is the built-in `fork` tool, restricted to `prober` branches.
    const coordinator = runner.agent({
        name: 'coordinator',
        description: 'Fans a fleet audit out over one branch per region and merges the findings.',
        instructions: (ctx) =>
            [
                `You run the latency audit for tenant "${ctx.tenant}" across ${REGIONS.length} regions:`,
                REGIONS.join(', '),
                '',
                `Probing one region takes ~${(PROBE_MS / 1000).toFixed(1)}s and \`probe_region\` handles`,
                `exactly one region per call, so doing them in sequence would take ~${secs(
                    REGIONS.length * PROBE_MS,
                )}.`,
                'You do not have that tool, and you must not audit anything yourself.',
                '',
                `Call the \`fork\` tool exactly once, with exactly ${REGIONS.length} branches — one per region:`,
                '  • "name" is the region id',
                '  • "agent" is "prober" for every branch',
                '  • "instructions" name the one region that branch must probe',
                '  • "context" is "none": a branch needs its region, not this conversation',
                '',
                'The branches run in parallel and rejoin as a single tool result holding all',
                `${REGIONS.length} reports. Merge them, then deliver the answer with \`final_output\`.`,
            ].join('\n'),
        fork: { agents: [prober.name], maxBranches: REGIONS.length },
    });

    banner(
        'ZeneraNeo — fork / join',
        `model ${model.id} · ${REGIONS.length} regions · ${PROBE_MS}ms per probe`,
    );

    step(1, `Fan out over ${REGIONS.length} regions, then join`);
    const laps: Lap[] = [];
    let joined: JoinNode | undefined;
    const started = Date.now();
    const result = await trace(
        runner.run(
            coordinator,
            'Audit the fleet and tell me which regions are degraded right now.',
            {
                output: FleetReport,
                // Branches must not fork again: at depth 1 the fork tool is no
                // longer offered, which bounds the tree structurally.
                maxForkDepth: 1,
            },
        ),
        {
            // A dozen interleaved token streams are unreadable, and each branch's
            // distilled report arrives at the join anyway.
            branchText: false,
            elapsed: true,
            laps,
            onJoin: (node) => (joined = node),
        },
    );
    const elapsed = Date.now() - started;

    step(2, 'What the parallelism bought');
    gantt(laps, elapsed);
    stats({
        wallClock: secs(elapsed),
        serialToolTime: secs(probes.serialMs),
        probes: probes.count,
        peakConcurrentProbes: probes.peak,
        speedup: `${(probes.serialMs / elapsed).toFixed(1)}×`,
    });

    step(3, 'The join, as the parent sees it');
    // The parent's history contains one fork tool call and one tool result —
    // sequential semantics, parallel execution. Each branch's own nodes hang
    // off its row of the join: there for audit, structurally out of the
    // parent's scope and out of its prompt.
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
    code('fleet report (parsed JSON)', JSON.stringify(result.output, null, 2));
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
    await report('fanout', result.state, runner.services.payloads, 'Fan-out · fleet audit');
    console.log();
}

void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
