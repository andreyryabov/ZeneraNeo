import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { PRESETS, type Vendor } from './models.ts';

// ---------------------------------------------------------------------------
// The launcher behind every `npm run demo:*`
//
// Nothing here is part of the library. The demos pick their model through
// ./models.ts, which reads `DEMO_VENDOR`; this script is the one place that
// *asks* for it. Run a demo without saying which vendor and it offers the
// list; answer once and every child process in the batch inherits the choice,
// so `npm run demo:all` prompts once rather than eight times.
//
//   npm run demo:simple                    # asks, when the terminal can ask
//   DEMO_VENDOR=openai npm run demo:simple # already answered, no prompt
// ---------------------------------------------------------------------------

/** Script name (as spelled in `demo:<name>`) -> the file it runs. */
const DEMOS: Record<string, string> = {
    simple: 'demo.ts',
    fanout: 'fanout.ts',
    triage: 'triage.ts',
    review: 'review.ts',
    inspect: 'inspect.ts',
    handbook: 'handbook.ts',
    locked: 'locked.ts',
    project: 'project.ts',
};

/** The one demo that declares its models in yaml, so asking would decide nothing. */
const OWN_MODELS = new Set(['project']);

const VENDORS = Object.keys(PRESETS) as Vendor[];
const DEFAULT: Vendor = 'gemini';

/**
 * The vendor for this batch: the environment if it already names one, else a
 * question — but only when there is someone to answer it. Piped output or a
 * `DEMO_VENDOR` already in the environment means the caller has decided.
 */
async function ask(asks: boolean): Promise<Vendor> {
    const named = (process.env.DEMO_VENDOR ?? '').trim().toLowerCase();
    if (named) {
        if (!VENDORS.includes(named as Vendor)) {
            throw new Error(
                `unknown DEMO_VENDOR "${named}" — expected one of ${VENDORS.join(', ')}`,
            );
        }
        return named as Vendor;
    }
    if (!asks || !process.stdin.isTTY) return DEFAULT;

    console.log(pc.bold('\n  Which model should the demo run on?\n'));
    for (const [i, v] of VENDORS.entries()) {
        const mark = v === DEFAULT ? pc.green('•') : ' ';
        const id = PRESETS[v].thinking.model;
        console.log(`  ${mark} ${pc.bold(String(i + 1))}. ${v.padEnd(10)} ${pc.dim(id)}`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        for (;;) {
            const answer = (await rl.question(pc.dim(`\n  choice [${DEFAULT}]: `)))
                .trim()
                .toLowerCase();
            if (!answer) return DEFAULT;
            const byIndex = VENDORS[Number(answer) - 1];
            if (byIndex) return byIndex;
            if (VENDORS.includes(answer as Vendor)) return answer as Vendor;
            console.log(pc.yellow(`  not a choice — pick 1-${VENDORS.length} or a name`));
        }
    } finally {
        rl.close();
    }
}

/** Runs one demo in its own process, so a demo that exits does not end the batch. */
function run(file: string, vendor: Vendor): Promise<number> {
    const path = fileURLToPath(new URL(file, import.meta.url));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path], {
            stdio: 'inherit',
            env: { ...process.env, DEMO_VENDOR: vendor },
        });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
    });
}

const requested = process.argv.slice(2);
const names = requested.length === 1 && requested[0] === 'all' ? Object.keys(DEMOS) : requested;
if (names.length === 0) {
    console.error(`usage: node examples/run.ts <${Object.keys(DEMOS).join('|')}|all>`);
    process.exit(2);
}
for (const name of names) {
    if (!(name in DEMOS)) {
        console.error(`unknown demo "${name}" — expected one of ${Object.keys(DEMOS).join(', ')}`);
        process.exit(2);
    }
}

const vendor = await ask(names.some((name) => !OWN_MODELS.has(name)));
for (const name of names) {
    const code = await run(DEMOS[name]!, vendor);
    if (code !== 0) process.exit(code);
}
