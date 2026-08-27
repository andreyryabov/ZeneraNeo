import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptFile } from '../packages/neo/src/prompt.ts';
import { AgentRunner } from '../packages/neo/src/runner.ts';
import { FileSkillProvider } from '../packages/neo/src/skill-providers/file.ts';
import { turns } from '../packages/neo/src/state.ts';
import { tool } from '../packages/neo/src/types.ts';
// Which vendor and how much thinking — shared by every demo. See ./models.ts.
import { model as pick } from './models.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import { banner, box, line, loadEnv, report, stats, step } from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Prompts on disk
//
// Every other demo writes its instructions as string literals in the source.
// This one keeps nothing in the source: both agents are assembled from files
// under ./assets/handbook, and so are their skills.
//
//   assets/handbook/AGENTS.md                     shared by both agents
//   assets/handbook/triage.md                     one agent's own brief
//   assets/handbook/resolver.md                   the other's
//   assets/handbook/skills/shipping_delays.md     a flat skill
//   assets/handbook/skills/refund_policy/         a folder skill, with resources
//
// That layout is the point. When the answer is wrong, somebody has to know
// which of those files to edit — and "somebody" includes the non-engineer who
// owns the refund policy. So the run records it: `promptFile` puts each file's
// path and content on the `system_prompt` node, and a file-backed skill
// provider puts the skill's path on the `load_skills` node. The HTML report at
// the end shows both, per node, next to the text they contributed.
// ---------------------------------------------------------------------------

const ASSETS = fileURLToPath(new URL('./assets/handbook/', import.meta.url));

/** Absolute path of a handbook document. */
function doc(name: string): string {
    return join(ASSETS, name);
}

/** Paths are absolute on the node; the terminal only needs the tail. */
function short(path: string): string {
    return relative(ASSETS, path);
}

// ---------------------------------------------------------------------------

/**
 * A skill can carry instructions in markdown but not code, so `refund_policy`
 * names this tool in its frontmatter and the provider resolves the name. The
 * tool is unlocked by loading the skill, not by being on the agent.
 */
const refundQuote = tool<{
    orderTotalEur: number;
    daysSinceDelivery: number;
    faulty?: boolean;
}>({
    name: 'refund_quote',
    description: 'Computes the refund a customer is owed. The system of record for amounts.',
    parameters: {
        type: 'object',
        properties: {
            orderTotalEur: { type: 'number' },
            daysSinceDelivery: { type: 'integer' },
            faulty: { type: 'boolean' },
        },
        required: ['orderTotalEur', 'daysSinceDelivery'],
        additionalProperties: false,
    },
    execute: ({ orderTotalEur, daysSinceDelivery, faulty = false }) => {
        if (faulty || daysSinceDelivery <= 30) {
            return { kind: 'refund', amountEur: orderTotalEur, feeEur: 0 };
        }
        if (daysSinceDelivery <= 90) {
            const feeEur = Math.round(orderTotalEur * 0.1 * 100) / 100;
            return { kind: 'store_credit', amountEur: orderTotalEur - feeEur, feeEur };
        }
        return { kind: 'repair', amountEur: 0, feeEur: 0 };
    },
});

/**
 * Both layouts in one directory: `shipping_delays.md` is a flat skill,
 * `refund_policy/` is a folder whose sibling files become `resources`. Either
 * way the provider records the file it read, which is what the report shows.
 */
const handbookSkills = new FileSkillProvider({
    dir: join(ASSETS, 'skills'),
    id: 'handbook',
    tools: [refundQuote],
});

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    banner('Prompts on disk', 'two agents, one shared AGENTS.md, skills from files');

    // Read once, used by both agents. Same bytes, same content hash, so the
    // report shows one document feeding two prompts rather than two copies.
    const house = promptFile(doc('AGENTS.md'), 'house_rules');

    const runner = new AgentRunner({
        model: pick('thinking'),
        skills: [handbookSkills],
        // Keeps the full request behind each model call, not just its digest —
        // so the report can show the assembled prompt exactly as it was sent.
        recordRequests: true,
    });

    // Instructions are a list of parts. A `promptFile` part contributes its
    // text *and* its provenance; a second argument wraps it in a named
    // section, because the model reads the markers too.
    runner.agent({
        name: 'resolver',
        description: 'Decides refund and shipping cases from the written policies.',
        instructions: [house, promptFile(doc('resolver.md'), 'your_role')],
        // `index` renders the skill names and descriptions into the prompt, so
        // the agent can see what exists and pull the one it needs.
        skills: { provider: 'handbook', discovery: 'index' },
    });

    const triage = runner.agent({
        name: 'triage',
        description: 'Classifies an incoming message and routes it.',
        instructions: [house, promptFile(doc('triage.md'), 'your_role')],
        handoffs: ['resolver'],
    });

    step(1, 'Running');
    const stream = runner.run(
        triage,
        'I bought a coffee grinder for 240 EUR and it arrived 45 days ago. It works, I just ' +
            'do not use it. Can I send it back for a refund?',
    );
    for await (const event of stream) {
        if (event.type === 'handoff') {
            line('⇄', `${event.from} → ${event.to}`);
        } else if (event.type === 'before_tool_call') {
            // `call.args` is a payload handle, not a string — `preview` is
            // there so a log line does not need a round trip to the store.
            line('→', `${event.call.name}(${event.call.args.preview ?? ''})`);
        }
    }
    const res = await stream.final();
    box('Answer', res.output);
    stats({ turns: turns(res.state), nodes: res.state.trajectory.length, ...res.usage });

    // The provenance, straight off the trajectory. There is no API for this
    // because there does not need to be — it is a walk over two public fields,
    // and the same two fields are what the report renders.
    step(2, 'Which files produced this run');
    for (const n of res.state.trajectory) {
        if (n.type === 'system_prompt') {
            for (const s of n.sources ?? []) {
                line('◦', `${n.agent} · prompt · ${short(s.path)}`);
            }
        } else if (n.type === 'load_skills') {
            for (const s of n.skills) {
                line('◦', `${n.agent} · skill "${s.name}" · ${s.file ? short(s.file) : 'in code'}`);
            }
        }
    }

    step(3, 'Writing the report');
    await report('handbook', res.state, runner, `Handbook · ${res.state.runId}`);
    line(' ', 'open a "system prompt" node to see each file beside the text it contributed,');
    line(' ', 'and the "skills" node to see the file each skill was loaded from.');
}

await main();
