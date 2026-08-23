import { AgentRunner } from '../src/runner.ts';
import { turns } from '../src/state.ts';
import { projected, type ForkNode, type JoinNode, type TrajectoryNode } from '../src/trajectory.ts';
import { tool } from '../src/types.ts';
// Which vendor and how much thinking — shared by every demo. See ./models.ts.
import { model as pick } from './models.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import {
    banner,
    box,
    gantt,
    joinTable,
    line,
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
// A fork on the second turn: same agent, inherited context
//
// ./fanout.ts and ./triage.ts both fork *away* — a coordinator with no tools of
// its own hands each branch to a different worker agent, with `context: "none"`,
// because a branch needs its region or its service, not the parent's chatter.
//
// This one is the other half of the design space, and it is shaped like an
// actual session:
//
//   user>      here is the job, plus two constraints written down nowhere
//   assistant> ...fetches the document, reads it, answers...
//   user>      now review it properly
//   assistant> ...forks itself into four lenses, merges, answers...
//
// The fork happens on the SECOND turn, and that is the point. Each branch is
// created with `context: "inherit"`, so it starts from the whole conversation so
// far — the document the trunk already fetched *and* what the user said in turn
// one. Nothing is re-fetched and nothing is pasted into the branch instructions:
// inheritance is the hand-over.
//
// It also forks without a hand-off: the fork call omits "agent", so every branch
// runs the same agent as the trunk, with the same toolbelt. The one thing that
// must differ is the system prompt, and it does, without a second registration —
// `instructions` is `(ctx, state) => string`, so it can read
// `state.spec.forkDepth`, which is 0 on the trunk and 1 inside a branch.
// ---------------------------------------------------------------------------

/** Per-run application context. Every instruction/scope callback receives it. */
interface AppCtx {
    rfc: string;
}

/** The four angles the document is read from — one branch each. */
const LENSES = ['data-model', 'api-contract', 'failure-modes', 'rollout'] as const;

/**
 * The document under review. Fixed text rather than anything generated: the
 * demo has a story — six planted problems, each with a house standard and a
 * past incident that names it — and the story should be the same every run.
 */
const SPEC = `
RFC-118 · Ledger v2 — double-entry rewrite
status: proposed · author: payments · target: next quarter

1. Motivation
   The v1 ledger stores a running balance per account and mutates it in place.
   Reconciliation therefore cannot be re-derived, and three of the last five
   month-end closes needed manual repair.

2. Data model
   New table \`entries\` (append-only, double-entry): id uuid v4 PK, account_id,
   counter_account_id, amount_minor bigint, currency, posted_at, source_ref.
   The \`balances\` table is dropped; a balance becomes SUM(amount_minor) over
   the account's entries, served from a materialized view refreshed every 60s.
   One Postgres primary, no partitioning: 4.2B rows migrated as-is.

3. API
   POST /v2/ledger/entries takes a batch of up to 500 entries and returns 200
   with the created ids. No request headers beyond auth. Clients retry on 5xx
   and on timeout.
   /v1/ledger/* is removed at cutover; partners move to /v2 the same week.

4. Migration
   A single backfill script copies all 4.2B v1 rows into \`entries\` during one
   30-minute maintenance window. No dual-write phase, no shadow reads.

5. Failure modes
   The writer retries a failed post three times and then publishes it to the
   ledger-dlq topic.

6. Rollout
   One global feature flag, flipped for 100% of traffic at cutover. Rollback is
   a re-deploy of v1. Dashboards and alerts land in the following sprint.
`.trim();

/** House engineering standards, looked up per topic by the branches. */
const STANDARDS: Record<string, string> = {
    idempotency:
        'STD-014 — every mutating public endpoint MUST accept an Idempotency-Key header and ' +
        'dedupe on it for 24h. Client-side retry without one is treated as a correctness bug.',
    'schema-migration':
        'STD-021 — tables above 100M rows MUST migrate by dual-write + backfill + shadow-read. ' +
        'One-shot maintenance-window backfills are capped at 50M rows.',
    'api-versioning':
        'STD-003 — a public API version MUST remain available for two quarters after its ' +
        'successor ships, with a deprecation header for the whole period.',
    rollout:
        'STD-009 — any change to money movement MUST ramp 1% → 10% → 50% → 100% with an ' +
        'automatic rollback trigger on the error-budget burn rate.',
    observability:
        'STD-011 — dashboards and alerts MUST exist before the first percent of traffic, ' +
        'never after.',
    'dead-letter':
        'STD-030 — every dead-letter topic MUST have a named consumer and an age alert. ' +
        'A DLQ nobody drains is data loss on a delay.',
    indexing:
        'STD-042 — random primary keys (uuid v4) are not permitted above 1B rows; use a ' +
        'time-ordered key so the index appends instead of fragmenting.',
};

/** Post-mortems, looked up per component by the branches. */
const INCIDENTS: Record<string, string> = {
    ledger:
        'INC-2291 — a retry storm double-posted 41k entries; the endpoint had no idempotency ' +
        'key, so every retry created a new row. 6 days of manual reconciliation.',
    'payments-api':
        'INC-3104 — removing /v1 on the announced date broke 3 partner integrations for 9 ' +
        'days; two of them had never read the deprecation notice.',
    migrations:
        'INC-2870 — a 600M-row backfill overran its 45-minute window by 6 hours and held a ' +
        'table lock for the whole overrun.',
    reconciler:
        'INC-3350 — ledger-dlq accumulated 1.2M unprocessed messages over 5 weeks; nothing ' +
        'consumed the topic and no alert covered its age.',
    'feature-flags':
        'INC-2604 — a global flag flip on a money path took 22 minutes to roll back because ' +
        'rollback meant a re-deploy. Every payment in the window was affected.',
};

/**
 * Two facts that exist only in the conversation: they are in no fixture, so no
 * tool can recover them. A branch can weigh them only if it really inherited
 * turn one — which is what step 3 checks.
 */
const TURN_ONE_CONSTRAINTS =
    'Two constraints before you start, neither of them written down anywhere: we are under a ' +
    'partner integration freeze until Q3, so no partner may be asked to change code before ' +
    'then, and the payments on-call rota is down to two people.';

/** Matches a verdict that leaned on one of those facts. */
const CONVERSATION_ONLY = /freeze|q3|on-call|rota|two people/i;

/** Per-tool latency. Slow enough that serial reviews would be painful. */
const COST_MS = { spec: 700, standard: 650, incident: 600 };

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

// --- the reviewer's toolbelt ------------------------------------------------
// One agent owns all three. The branches are that same agent, so they inherit
// the toolbelt as well as the conversation — there is no worker agent to give
// tools to, and nothing to keep in sync between two prompts.

const fetchSpec = tool<{ id: string }, AppCtx>({
    name: 'fetch_spec',
    description:
        'Fetch the full text of ONE RFC. Slow; the document does not change during a review.',
    parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'e.g. "RFC-118"' } },
        required: ['id'],
        additionalProperties: false,
    },
    execute: ({ id }, { signal }) => slow(COST_MS.spec, signal, () => ({ id, text: SPEC })),
});

const lookupStandard = tool<{ topic: string }, AppCtx>({
    name: 'lookup_standard',
    description:
        'The house engineering standard for ONE topic. Topics: ' +
        `${Object.keys(STANDARDS).join(', ')}.`,
    parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
        additionalProperties: false,
    },
    execute: ({ topic }, { signal }) =>
        slow(COST_MS.standard, signal, () => {
            const text = STANDARDS[topic];
            if (!text) {
                throw new Error(
                    `no standard for "${topic}" — one of: ${Object.keys(STANDARDS).join(', ')}`,
                );
            }
            return { topic, standard: text };
        }),
});

const incidentHistory = tool<{ component: string }, AppCtx>({
    name: 'incident_history',
    description:
        'Past post-mortems touching ONE component. Components: ' +
        `${Object.keys(INCIDENTS).join(', ')}.`,
    parameters: {
        type: 'object',
        properties: { component: { type: 'string' } },
        required: ['component'],
        additionalProperties: false,
    },
    execute: ({ component }, { signal }) =>
        slow(COST_MS.incident, signal, () => ({
            component,
            incident: INCIDENTS[component] ?? 'no incidents on record for this component',
        })),
});

// --- prompts ---------------------------------------------------------------
// Two roles, one agent. `instructions` is `(ctx, state) => string`, and
// `state.spec.forkDepth` is 0 on the trunk and 1 inside a branch, so the same
// registration renders the conversation prompt for the trunk and the lens
// prompt for the branches. The branch also gets the trunk's whole history
// underneath it, so its prompt can *refer* to the conversation instead of
// restating any of it.

const trunkPrompt = (rfc: string): string =>
    [
        `You are the reviewer of record for ${rfc}, working with a colleague over several messages.`,
        '',
        'Ground every claim in a tool call — `fetch_spec` for the document, `lookup_standard` for',
        'house rules, `incident_history` for past post-mortems — and never fetch the same thing',
        'twice: this conversation is your working memory.',
        '',
        'When, and only when, you are asked for a full review, look nothing up yourself: your very',
        'next action must be `fork`, called exactly once, with exactly',
        `${LENSES.length} branches, one per lens: ${LENSES.join(', ')}.`,
        '  • "name" is the lens',
        '  • do NOT set "agent": every branch is you, re-reading the same document from another',
        '    angle, with the same tools',
        '  • "context" is "inherit": the branches continue THIS conversation, so they already have',
        '    the spec you fetched and everything that has been said about it — never repeat any of',
        '    it in the instructions',
        '  • "instructions" say only which lens the branch owns',
        '',
        'The per-lens standards and incidents are the branches\u2019 work, not yours. They review in',
        'parallel and rejoin as one tool result holding every verdict. Merge them — a finding',
        'backed by both a standard and a past incident outranks one backed by neither — and answer',
        'with a merge decision (approve / approve-with-changes / request-changes), the blocking',
        'issues, and what to do about each. Keep it under 20 lines.',
    ].join('\n');

const branchPrompt = (rfc: string): string =>
    [
        `You are reviewing ${rfc} on ONE assigned lens. The \`fork\` result above names it, names`,
        'the lenses running beside you, and says what becomes of your answer.',
        '',
        'Everything before that is a conversation you inherited: the full text of the RFC is',
        'already in it, and so are constraints your colleague stated that appear in no document',
        'and in no tool. Both are binding. Do not call `fetch_spec` again — scroll up and read it.',
        '',
        'Work only your lens — a sibling owns each of the others — and never assert a rule from',
        'memory:',
        '  • `lookup_standard` for every house rule your lens touches (one call per topic)',
        '  • `incident_history` for every component it touches (one call per component)',
        '',
        'Then answer with exactly one line and nothing else:',
        '<lens>: verdict=<blocker|concern|ok> finding=<short phrase> standard=<STD-nnn|none> ' +
            'incident=<INC-nnnn|none> constraint=<what the freeze or the on-call limit implies ' +
            'for this lens, or none>',
    ].join('\n');

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

/** How many times a tool was called across a set of nodes. */
function countCalls(nodes: TrajectoryNode[], name: string): number {
    return nodes.reduce(
        (n, node) => n + (node.type === 'tool_call' && node.name === name ? 1 : 0),
        0,
    );
}

async function main(): Promise<void> {
    const model = pick('thinking');

    const runner = new AgentRunner<AppCtx>({
        model,
        context: { rfc: 'RFC-118' },
        // Keep every request behind its `llm_call` node, so the HTML report
        // written at the end can show exactly what each branch was sent —
        // including the inherited prefix.
        recordRequests: true,
    });

    // One agent, one registration. `fork.agents` names itself: branches may run
    // this agent and nothing else, which is the structural version of "this
    // fork widens the work, it does not hand it off".
    const reviewer = runner.agent({
        name: 'reviewer',
        description: 'Reviews an RFC, either as the trunk of a conversation or as one lens of it.',
        instructions: (ctx, spec) =>
            spec.forkDepth === 0 ? trunkPrompt(ctx.rfc) : branchPrompt(ctx.rfc),
        tools: [fetchSpec, lookupStandard, incidentHistory],
        fork: { agents: ['reviewer'], maxBranches: LENSES.length },
    });

    banner(
        'ZeneraNeo — a fork on the second turn',
        `model ${model.id} · one agent · ${LENSES.length} lenses on one conversation`,
    );

    // --- turn one ----------------------------------------------------------
    // An ordinary exchange. No fork: the agent is only asked to read. What it
    // builds here — the fetched spec, plus the two constraints the user just
    // stated — is the context the branches inherit two messages later.
    step(1, 'Turn 1 — the agent reads the document');
    const first = await trace(
        runner.run(
            reviewer,
            `${TURN_ONE_CONSTRAINTS}\n\nNow pull RFC-118 and tell me, in a few lines, what it ` +
                'actually changes.',
            {
                // Branches must not fork again, and the bound has to be declared
                // here: `spec` is fixed when the run is created, and `send()`
                // continues that same run. It matters more than in a hand-off
                // fork — a branch *is* the forking agent, so without a bound the
                // tree would be free to recurse.
                maxForkDepth: 1,
            },
        ),
    );
    box('assistant · turn 1', first.output);

    // --- turn two ----------------------------------------------------------
    // `send()` appends a user message to the *same* state and drives it on. The
    // fork happens here, and inherits everything above it.
    step(2, 'Turn 2 — the same agent forks itself into four lenses');
    const laps: Lap[] = [];
    let joined: JoinNode | undefined;
    const started = Date.now();
    const result = await trace(
        runner.send(
            first.state,
            'Good. Now review it properly: four lenses in parallel, one verdict each, then give ' +
                'me your merge decision.',
        ),
        {
            // Four interleaved token streams are unreadable, and each lens's
            // one-line verdict arrives at the join anyway.
            branchText: false,
            elapsed: true,
            laps,
            onJoin: (node) => (joined = node),
        },
    );
    const elapsed = Date.now() - started;

    step(3, 'What the branches inherited');
    const fork = result.state.trajectory.find((n): n is ForkNode => n.type === 'fork');
    // A branch is seeded with the run's projected history up to the fork: system
    // prompt, both user messages, the fetched spec, the turn-one answer.
    const prefix = fork ? projected(result.state.trajectory).findIndex((n) => n.id === fork.id) : 0;
    if (fork) {
        // Same agent everywhere: the fork call omitted "agent", so the kernel
        // defaulted each branch to the caller.
        const agents = [...new Set(fork.branches.map((b) => b.agent))];
        line('⑂', `context=${fork.contextMode} · branch agents: ${agents.join(', ')}`);
        line(
            '⑂',
            `each branch started from the first ${prefix} nodes of this run, copied as real nodes`,
        );
    }
    const branchNodes = joined?.branches.flatMap((b) => b.nodes) ?? [];
    const verdicts = joined
        ? await Promise.all(
              joined.branches.map(async (b) =>
                  (await runner.services.payloads.get(b.output)).trim(),
              ),
          )
        : [];
    // Two halves of the same claim. The expensive document was fetched once, on
    // turn one, and read by four reviews — and a constraint stated only in that
    // turn reached a branch no tool could ever have told it to.
    stats({
        specFetchesOnTrunk: countCalls(result.state.trajectory, 'fetch_spec'),
        specFetchesInBranches: countCalls(branchNodes, 'fetch_spec'),
        verdictsUsingTurn1Facts: `${verdicts.filter((v) => CONVERSATION_ONLY.test(v)).length}/${verdicts.length}`,
        // `prefixLength` on the child state: inherited nodes belong to the
        // parent, so only what a branch adds after them is its own history.
        inheritedNodesPerBranch: prefix,
        addedByBranches: branchNodes.length,
    });

    step(4, 'What the parallelism bought');
    gantt(laps, elapsed);
    const branchMs = laps.reduce((n, l) => n + ((l.end ?? elapsed) - l.start), 0);
    stats({
        wallClock: secs(elapsed),
        branchTimeTotal: secs(branchMs),
        speedup: `${(branchMs / elapsed).toFixed(1)}×`,
        toolCalls: calls.count,
        serialToolTime: secs(calls.serialMs),
        peakConcurrentCalls: calls.peak,
    });

    step(5, 'The join, as the parent sees it');
    // Inheritance is one-way. A branch reads the conversation, but what comes
    // back is only its output: turn two gains one fork tool call and one tool
    // result, and the branch's own nodes hang off its row of the join.
    if (joined) {
        await joinTable(joined, runner.services.payloads);
        stats({
            branchInputTokens: joined.usage.inputTokens,
            branchOutputTokens: joined.usage.outputTokens,
            parentMessagesAdded: 2,
        });
    }

    step(6, 'The merged answer');
    box('assistant · turn 2', result.output);
    stats({
        // `turns` counts the trunk's own calls, across both turns; the branches'
        // are their own.
        modelCalls: turns(result.state),
        // `state.usage` is a flat sum over the whole trajectory, so it already
        // covers every token spent inside the fork.
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
    });

    step(7, 'Inspectable HTML report');
    // One report for the whole session: both turns, the fork, and every branch.
    await report('review', result.state, runner.services.payloads, 'Review · RFC-118');
    console.log();
}

void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
