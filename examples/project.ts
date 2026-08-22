import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { loadProject } from '../src/project/index.ts';
import { turns } from '../src/state.ts';
import { tool } from '../src/types.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import { banner, box, line, loadEnv, report, stats, step } from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// A project is a folder
//
// ./handbook.ts assembles two agents from files, but the assembly itself is
// still code: it names the prompts, wires the provider, registers the agents.
// This demo has none of that. It points `loadProject` at a directory and runs
// what it finds:
//
//   assets/project/AGENTS.md                      house rules, every agent
//   assets/project/agents.yaml                    who exists, what they reach for
//   assets/project/.agents/prompts/<name>.md      one agent's own brief
//   assets/project/.agents/skills/<name>/SKILL.md the catalog
//
// Two things are worth watching in the trace.
//
// The first is `preload`. The adjuster's `house_style` skill is activated by
// the runner before the first model call, so it is never something the model
// has to think to ask for — and because the activation lands at the head of
// the transcript and never moves, it sits inside the cached prefix rather than
// being appended after the first reply.
//
// The second is that the whole system is one immutable object. Nothing about a
// conversation lives on it, so the same project serves every chat in the
// process — and since the tool schemas are fixed at load, every one of those
// chats opens with a byte-identical prefix. Step 3 runs a second, unrelated
// case through the same object to show that neither run can see the other.
//
// The only thing config cannot hold is code, so the two tools are passed in.
// That is the entire seam between "a folder someone edits" and "a program".
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('./assets/project/', import.meta.url));

/** Paths are absolute on the node; the terminal only needs the tail. */
function short(path: string): string {
    return relative(ROOT, path);
}

// ---------------------------------------------------------------------------
// The code half
// ---------------------------------------------------------------------------

const POLICIES: Record<string, { holder: string; perils: string[]; sinceYear: number }> = {
    'NM-448127': { holder: 'R. Okonkwo', perils: ['storm', 'water', 'fire'], sinceYear: 2019 },
    'NM-771034': { holder: 'A. Lindqvist', perils: ['water', 'fire'], sinceYear: 2023 },
};

/** Named by `agents.yaml` under the intake agent — an ordinary agent tool. */
const policyLookup = tool<{ reference: string }>({
    name: 'policy_lookup',
    description: 'Looks up a policy by its NM- claim reference.',
    parameters: {
        type: 'object',
        properties: { reference: { type: 'string' } },
        required: ['reference'],
        additionalProperties: false,
    },
    execute: ({ reference }) => POLICIES[reference] ?? { error: 'no such policy', reference },
});

/**
 * Named by `storm_damage`'s frontmatter, not by any agent. It is declared to
 * the provider from turn 0 — the schema never changes — but it refuses to run
 * until that skill is active.
 */
const damageEstimate = tool<{
    repairCostEur: number;
    roofAgeYears: number;
    priorStormClaim?: boolean;
}>({
    name: 'damage_estimate',
    description: 'Settles a storm claim: applies depreciation, then the excess.',
    parameters: {
        type: 'object',
        properties: {
            repairCostEur: { type: 'number' },
            roofAgeYears: { type: 'integer' },
            priorStormClaim: { type: 'boolean' },
        },
        required: ['repairCostEur', 'roofAgeYears'],
        additionalProperties: false,
    },
    execute: ({ repairCostEur, roofAgeYears, priorStormClaim = false }) => {
        const depreciation = Math.min(0.4, Math.max(0, roofAgeYears - 5) * 0.02);
        const excessEur = priorStormClaim ? 1000 : 500;
        const depreciated = Math.round(repairCostEur * (1 - depreciation) * 100) / 100;
        return {
            repairCostEur,
            depreciationPct: Math.round(depreciation * 100),
            excessEur,
            settlementEur: Math.max(0, Math.round((depreciated - excessEur) * 100) / 100),
        };
    },
});

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    banner('A project is a folder', 'agents.yaml, AGENTS.md and .agents/ — loaded, not written');

    step(1, 'Loading');
    // One store for both runners below, so the two chats' payloads land in the
    // same place and the report can resolve either of them.
    const payloads = new InMemoryPayloadStore();
    const project = await loadProject(ROOT, {
        // The seam: config names a tool, code supplies it.
        tools: [policyLookup, damageEstimate],
        payloads,
    });
    line('◦', `config    ${short(project.source)}`);
    line('◦', `entry     ${project.entry}`);
    line('◦', `agents    ${project.registry.names().join(', ')}`);
    for (const a of project.agents) {
        const b = a.skills;
        line(
            '◦',
            `  ${a.name.padEnd(9)} model=${a.model ? 'set' : 'inherited'} ` +
                `tools=${a.tools.length} handoffs=[${a.handoffs.join(', ')}] ` +
                (b
                    ? `skills=${b.discovery} preload=[${(b.preload ?? []).join(', ')}]`
                    : 'skills=—'),
        );
    }

    // A load is I/O and validation only. Nothing has been sent anywhere yet,
    // and every path, tool name, hand-off target and skill name in the config
    // has already been checked against what is actually on disk.
    step(2, 'Running a storm claim');
    // A fresh runner because this chat wants the full request kept behind each
    // model call; everything else — agents, providers, payload store — is the
    // project's, unchanged.
    const runner = project.runner({ recordRequests: true });
    const stream = runner.run(
        project.entry,
        'Claim NM-448127. A gust took half the roof tiles off on Tuesday night — the met ' +
            'office recorded 68 mph. The roofer quotes 8,400 EUR. The roof went on in 2011 and ' +
            'we have not claimed for a storm before. Water got into the loft as well.',
    );
    for await (const event of stream) {
        if (event.type === 'handoff') {
            line('⇄', `${event.from} → ${event.to}`);
        } else if (event.type === 'before_tool_call') {
            line('→', `${event.call.name}(${event.call.args.preview ?? ''})`);
        }
    }
    const res = await stream.final();
    box('Answer', res.output);
    stats({ turns: turns(res.state), nodes: res.state.trajectory.length, ...res.usage });

    // The provenance, straight off the trajectory: which file on disk produced
    // each part of this run. `preload` is visible here as a `load_skills` node
    // the model never asked for.
    step(3, 'Which files produced this run');
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

    // Same project object, unrelated claim, and a policy that does not carry
    // the storm peril at all. If the two runs shared anything, this is where it
    // would show.
    step(4, 'A second chat on the same project');
    const other = await project
        .run(
            'Claim NM-771034. A pipe under the kitchen sink let go while we were away for three ' +
                'weeks. The house was empty and the heating was off.',
        )
        .final();
    box('Answer', other.output);
    line('◦', `run ids differ: ${res.state.runId !== other.state.runId}`);
    line('◦', `first run untouched: ${res.state.trajectory.length} nodes`);

    step(5, 'Writing the report');
    await report('project', res.state, runner.services.payloads, `Project · ${res.state.runId}`);
    line(' ', 'the first "skills" node is the preload — nothing in the transcript asked for it.');
}

await main();
