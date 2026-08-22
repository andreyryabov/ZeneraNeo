import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel } from '../src/models/factory.ts';
import { hash, type PayloadResolver } from '../src/payload.ts';
import { AgentRunner } from '../src/runner.ts';
import { FileSkillProvider } from '../src/skill-providers/file.ts';
import type { AgentState } from '../src/state.ts';
import { turns } from '../src/state.ts';
import { tool } from '../src/types.ts';
// Terminal rendering — the harness every example shares. See ./ui.ts.
import { banner, box, line, loadEnv, report, stats, step } from './ui.ts';

loadEnv();

// ---------------------------------------------------------------------------
// Locked tools
//
// A skill can unlock a tool. The obvious way to implement that is to append the
// tool to the array once the skill loads — and it is the wrong way, because a
// request serializes as [tool schemas][system prompt][messages]. Growing the
// array puts the first differing token near offset 0, so the provider's cache
// matches nothing and the whole transcript is re-read, at exactly the turn
// where the transcript is longest.
//
// So nothing is appended. Every tool the catalog can unlock is declared from
// turn 1 and never withdrawn; only *execution* is gated. A call whose skill is
// not loaded comes back as an error that says which skill to load, and the
// model recovers on its own.
//
// This demo runs a customs desk with `discovery: 'none'` — no skill index in
// the system prompt, no `skill_search`. The model's only route to a skill name
// is a tool description and the refusal it gets back. Two shapes show up:
//
//   hs_code_lookup   unlocked by exactly one skill    → the error is an instruction
//   duty_quote       unlocked by either of two        → the error is a choice
//
// A note on the prompt below: each locked tool's description already says which
// skill unlocks it, so a capable model reads that and calls `skill_load` first,
// never seeing a refusal at all. That is the intended happy path and it is what
// this agent does if you let it. The instructions deliberately forbid it, so
// that the recovery path — the guarantee underneath the hint — shows up in the
// trace. In production the refusal is the safety net for the cases no hint
// covers: a compaction that drops the activation, or a handoff to an agent that
// never loaded the skill, since activations are agent-scoped.
//
// The last section is the point of the whole design: the tool schemas hashed
// per turn, unchanged, while the set of active skills underneath them grows.
// ---------------------------------------------------------------------------

const ASSETS = fileURLToPath(new URL('./assets/locked/', import.meta.url));

// ---------------------------------------------------------------------------
// The tools the skills unlock
//
// Skills carry markdown, not code, so each `SKILL.md` names its tool in
// frontmatter and the provider resolves the name to one of these. Neither tool
// is on the agent: the agent has none at all.
// ---------------------------------------------------------------------------

const HS_CODES: Record<string, { code: string; rate: number; note: string }> = {
    bracket: { code: '7326.90', rate: 0.027, note: 'other articles of iron or steel' },
    bicycle: { code: '8714.99', rate: 0.042, note: 'parts and accessories of bicycles' },
    coffee: { code: '0901.21', rate: 0.075, note: 'coffee, roasted, not decaffeinated' },
    grinder: { code: '8509.40', rate: 0.022, note: 'food grinders, electromechanical' },
};

const hsCodeLookup = tool<{ goods: string }>({
    name: 'hs_code_lookup',
    description: 'Resolves a plain description of goods to its Harmonized System code.',
    parameters: {
        type: 'object',
        properties: { goods: { type: 'string' } },
        required: ['goods'],
        additionalProperties: false,
    },
    execute: ({ goods }) => {
        const key = Object.keys(HS_CODES).find((k) => goods.toLowerCase().includes(k));
        return key
            ? { goods, ...HS_CODES[key] }
            : { goods, error: 'no matching heading; describe the material and the function' };
    },
});

const dutyQuote = tool<{
    hsCode: string;
    customsValueEur: number;
    regime: 'standard' | 'preferential';
}>({
    name: 'duty_quote',
    description: 'Computes duty owed on a shipment. The system of record for the amount.',
    parameters: {
        type: 'object',
        properties: {
            hsCode: { type: 'string' },
            customsValueEur: { type: 'number' },
            regime: { type: 'string', enum: ['standard', 'preferential'] },
        },
        required: ['hsCode', 'customsValueEur', 'regime'],
        additionalProperties: false,
    },
    execute: ({ hsCode, customsValueEur, regime }) => {
        const entry = Object.values(HS_CODES).find((c) => c.code === hsCode);
        const rate = regime === 'preferential' ? 0 : (entry?.rate ?? 0.035);
        const dutyEur = Math.round(customsValueEur * rate * 100) / 100;
        return { hsCode, regime, rate, dutyEur, vatBaseEur: customsValueEur + dutyEur };
    },
});

/**
 * Three skills, two tools. `duty_quote` is declared by *both* duty skills, so
 * it is offered once and either owner unlocks it — which is why its refusal has
 * to state a choice rather than an instruction.
 */
const customs = new FileSkillProvider({
    dir: join(ASSETS, 'skills'),
    id: 'customs',
    tools: [hsCodeLookup, dutyQuote],
});

// ---------------------------------------------------------------------------
// Reading the trajectory afterwards
// ---------------------------------------------------------------------------

/** The tool schemas and active-skill count as of each model call. */
async function perTurn(state: AgentState, payloads: PayloadResolver) {
    const rows: { turn: number; tools: string[]; digest: string; active: string[] }[] = [];
    const active: string[] = [];
    let turn = 0;
    for (const n of state.trajectory) {
        if (n.type === 'load_skills') {
            active.push(...n.skills.map((s) => s.name));
            continue;
        }
        if (n.type !== 'llm_call' || !n.request) {
            continue;
        }
        const req = JSON.parse(await payloads.get(n.request)) as {
            tools?: { name: string }[];
        };
        const tools = (req.tools ?? []).map((t) => t.name);
        rows.push({
            turn: ++turn,
            tools,
            // The bytes the provider caches on. Names alone would hide a
            // description that shifted, so the whole schema is hashed.
            digest: hash(JSON.stringify(req.tools ?? [])).slice(0, 12),
            active: [...active],
        });
    }
    return rows;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    banner('Locked tools', 'declared from turn 1, executable only once their skill is loaded');

    const runner = new AgentRunner({
        model: createModel({ model: 'gpt-5.4-mini', api: 'responses' }),
        skills: [customs],
        // Keeps the full request behind each model call, which is what the
        // per-turn table below reads.
        recordRequests: true,
    });

    const desk = runner.agent({
        name: 'customs_desk',
        description: 'Quotes duty on inbound shipments.',
        instructions: [
            'You are a customs desk. Answer with the HS code, the duty in EUR, and one',
            'sentence on why that regime applies.',
            '',
            'Work strictly reactively, so that the desk logs which skill each answer',
            'actually depended on:',
            '',
            '- Call the tool you need. Call it even if its description warns you that a',
            '  skill is required; that hint is not authorisation, and you must not act on',
            '  it in advance.',
            '- Only after a tool result tells you a skill is missing may you call',
            '  skill_load. Read what the result offers, decide which skill actually fits',
            '  this shipment, load that one, and retry the call that failed.',
            '- Never compute duty yourself; the tool is the system of record.',
        ].join('\n'),
        // No index in the prompt and no search tool: the tool descriptions and
        // the refusals are the entire discovery surface.
        skills: { provider: 'customs', discovery: 'none' },
    });

    step(1, 'Running');
    const stream = runner.run(
        desk,
        'A pallet of steel brackets for bicycle frames is arriving from Vietnam. Invoice ' +
            '18,400 EUR, freight and insurance to the border 1,100 EUR. The exporter has ' +
            'given us a statement on origin. What do we owe?',
    );
    for await (const event of stream) {
        if (event.type === 'before_tool_call') {
            line('→', `${event.call.name}(${event.call.args.preview ?? ''})`);
        } else if (event.type === 'after_tool_call') {
            const node = event.node;
            const text = await runner.services.payloads.get(node.result);
            if (node.isError) {
                // The refusal, as the model sees it.
                line('⨯', text.split('\n')[0]);
            } else if (node.name === 'skill_load') {
                line('⚿', text);
            }
        }
    }
    const res = await stream.final();
    box('Answer', res.output);
    stats({ turns: turns(res.state), nodes: res.state.trajectory.length, ...res.usage });

    step(2, 'What the model was sent, turn by turn');
    const rows = await perTurn(res.state, runner.services.payloads);
    for (const r of rows) {
        line(
            ' ',
            `turn ${r.turn}  tools=${String(r.tools.length).padEnd(2)} sha=${r.digest}  ` +
                `active=[${r.active.join(', ')}]`,
        );
    }
    const stable = rows.every((r) => r.digest === rows[0].digest);
    line(
        stable ? '✓' : '✗',
        stable
            ? 'the tool schemas never changed — every turn after the first is a cache hit'
            : 'the tool schemas changed mid-run; the prompt cache was thrown away',
    );
    // Not an assertion about the design, just the receipt: a provider only
    // reports cached input when it matched a prefix it had already read.
    line(
        ' ',
        `the provider read ${res.usage.cachedInputTokens} of ${res.usage.inputTokens} input ` +
            'tokens from its cache',
    );

    step(3, 'Which tools were locked, and by what');
    for (const summary of await customs.list()) {
        for (const name of summary.toolNames ?? []) {
            line('◦', `${name} ← ${summary.name}`);
        }
    }
    line(' ', 'duty_quote appears twice: two skills unlock it, either one is enough.');

    step(4, 'Writing the report');
    await report(
        'locked',
        res.state,
        runner.services.payloads,
        `Locked tools · ${res.state.runId}`,
    );
    line(' ', 'open the failed tool_result to see the refusal the model recovered from,');
    line(' ', 'and any llm_call to see the tool array it was sent — identical on every turn.');
}

await main();
