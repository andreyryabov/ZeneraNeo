import { InMemoryPayloadStore } from '../packages/neo/src/payload-stores/in-memory.ts';
import { AgentRunner } from '../packages/neo/src/runner.ts';
import { turns } from '../packages/neo/src/state.ts';
import { tool } from '../packages/neo/src/types.ts';
// Which vendor and how much thinking — shared by every demo. See ./models.ts.
import { model as pick } from './models.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import { banner, line, loadEnv, report, stats, step } from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Run inspection
//
// The other demos show a run as it happens. This one is about the autopsy: it
// runs a small fan-out and then writes the whole thing — trajectory, prompts,
// tool traffic, branch histories and the exact requests that went to the model
// — into one HTML file you can open, mail, or attach to a bug report.
//
// Every demo ends with a report (see `report()` in ./ui.ts); this one is about
// nothing else. The single line that makes it useful is `recordRequests: true`
// on the runner: without it the trajectory keeps only a digest of each request,
// which proves divergence but does not explain it.
// ---------------------------------------------------------------------------

const readMetrics = tool<{ service: string }>({
    name: 'read_metrics',
    description: 'Latency and error rate for a service.',
    parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
        additionalProperties: false,
    },
    execute: ({ service }) => ({
        service,
        p99Ms: service === 'checkout-api' ? 980 : 160,
        errorRatePct: service === 'checkout-api' ? 3.4 : 0.2,
    }),
});

const readDeploys = tool<{ service: string }>({
    name: 'read_deploys',
    description: 'Recent deploys for a service, newest first.',
    parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
        additionalProperties: false,
    },
    execute: ({ service }) => ({
        service,
        deploys: ['v482 · 09:12 · validate promo codes', 'v481 · 04:40 · bump base image'],
    }),
});

async function main(): Promise<void> {
    banner('Run inspection', 'one run in, one self-contained HTML report out');

    const payloads = new InMemoryPayloadStore('blobs');
    const runner = new AgentRunner({
        model: pick('thinking'),
        payloads,
        // The whole point of this demo: keep every request, not just its hash.
        recordRequests: true,
    });

    const investigator = runner.agent({
        name: 'investigator',
        description: 'Investigates one service and reports what it found.',
        instructions:
            'Investigate the services named in your instructions. Read their metrics, and pull ' +
            'the deploy list for anything that looks unhealthy. Answer with the cause.',
        tools: [readMetrics, readDeploys],
        // Two branches, so the report has a fork/join to draw.
        fork: { maxBranches: 2 },
    });

    step(1, 'Running');
    const stream = runner.run(
        investigator,
        'Checkout is slow. Investigate checkout-api and search-api in parallel, then tell me ' +
            'which one is at fault and why.',
    );
    for await (const event of stream) {
        if (event.type === 'before_tool_call') {
            line('→', `${event.call.name}(${event.call.args})`);
        }
    }
    const res = await stream.final();
    stats({ turns: turns(res.state), nodes: res.state.trajectory.length, ...res.usage });

    step(2, 'Writing the report');
    await report('inspect', res.state, runner, `Investigation · ${res.state.runId}`);
    line(' ', 'open it and click a node in the graph to see exactly what the model was sent.');
}

await main();
