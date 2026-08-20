import { mkdir, readFile, writeFile } from 'node:fs/promises';
import boxen from 'boxen';
import pc from 'picocolors';
import type { AgentEvent, RunStream } from '../src/events.ts';
import { renderRunReport } from '../src/inspect.ts';
import type { PayloadResolver } from '../src/payload.ts';
import type { AgentState, RunResult } from '../src/state.ts';
import type { JoinNode } from '../src/trajectory.ts';

// ---------------------------------------------------------------------------
// Shared reporting harness for the examples
//
// Nothing here is part of the library: it is the terminal front-end the demos
// share so each one can be about the feature it demonstrates instead of about
// ANSI codes. `trace()` is the centrepiece — it consumes a run's event stream,
// renders every event, and hands back the result.
// ---------------------------------------------------------------------------

/** Loads the repo-root `.env` (OPENAI_API_KEY and friends), if present. */
export function loadEnv(): void {
    try {
        process.loadEnvFile(new URL('../.env', import.meta.url));
    } catch {
        console.warn('no .env found — copy .env.example to .env');
    }
}

/** Width available to boxes and streamed text, minus the 2-column left margin.
 *  `columns` is undefined when stdout is piped, so `$COLUMNS` is the fallback. */
const COLS = process.stdout.columns || Number(process.env.COLUMNS) || 100;
export const WIDTH = Math.max(40, Math.min(COLS - 4, 96));

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Title card for the top of a demo. */
export function banner(title: string, subtitle?: string): void {
    console.log(
        boxen(pc.bold(title) + (subtitle ? `\n${pc.dim(subtitle)}` : ''), {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: 'double',
            borderColor: 'magenta',
            textAlignment: 'center',
        }),
    );
}

/** Numbered section header, so each demo step is easy to spot. */
export function step(n: number, title: string): void {
    console.log(`\n${pc.bgBlue(pc.black(` ${n} `))} ${pc.bold(pc.blue(title))}`);
}

/** Dimmed one-liner for run mechanics (tool calls, handoffs, branches). */
export function line(icon: string, text: string): void {
    console.log(pc.dim(`  ${icon} ${text}`));
}

/** Boxed block for anything the user is meant to actually read. */
export function box(title: string, body: string): void {
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
export function stats(entries: Record<string, unknown>): void {
    const row = Object.entries(entries)
        .map(([k, v]) => `${pc.dim(k)}=${pc.bold(String(v))}`)
        .join(pc.dim('  ·  '));
    console.log(`  ${row}`);
}

/**
 * Verbatim block for pre-formatted text such as JSON. `box()` cannot be used:
 * its wrapper trims each line, which would flatten the indentation.
 */
export function code(title: string, body: string): void {
    console.log(`\n  ${pc.dim(`┌─ ${title}`)}`);
    for (const l of body.split('\n')) {
        console.log(`  ${pc.dim('│')} ${l}`);
    }
    console.log(`  ${pc.dim('└─')}`);
}

export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Inlines a local file as a base64 data URL, resolved against `examples/`. */
export async function dataUrl(path: string, mimeType: string): Promise<string> {
    const bytes = await readFile(new URL(path, import.meta.url));
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Scratch output, gitignored: `npm run clean` takes it away. */
const OUT_DIR = new URL('../.out/', import.meta.url);

/**
 * Writes the run's HTML report and says where it landed. Every demo ends with
 * one: the terminal trace shows what happened, the report shows *why* — every
 * prompt, every payload and, when the runner was built with `recordRequests`,
 * the exact request behind each model call.
 */
export async function report(
    name: string,
    state: AgentState,
    payloads: PayloadResolver,
    title?: string,
): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });
    const file = new URL(`${name}.html`, OUT_DIR);
    const html = await renderRunReport(state, payloads, { title: title ?? name });
    await writeFile(file, html, 'utf8');
    line('◈', `report → .out/${name}.html  (${(html.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Branch lanes
// ---------------------------------------------------------------------------

/** A wide fork needs distinguishable lanes; the palette simply cycles. */
const PALETTE: ((s: string) => string)[] = [
    pc.magenta,
    pc.cyan,
    pc.green,
    pc.yellow,
    pc.blue,
    pc.red,
    (s) => pc.bold(pc.magenta(s)),
    (s) => pc.bold(pc.cyan(s)),
    (s) => pc.bold(pc.green(s)),
    (s) => pc.bold(pc.yellow(s)),
];
const assigned = new Map<string, (s: string) => string>();

/** Stable colour for a branch name, assigned on first sight. */
export function lane(name: string): (s: string) => string {
    let p = assigned.get(name);
    if (!p) {
        p = PALETTE[assigned.size % PALETTE.length] as (s: string) => string;
        assigned.set(name, p);
    }
    return p;
}

/** One branch's wall-clock span, collected by `trace({ laps })`. */
export interface Lap {
    name: string;
    /** ms since the traced run started */
    start: number;
    end?: number;
    status?: 'ok' | 'error' | 'aborted';
}

/** Gantt chart of the branches: overlap is the whole point, so draw it. */
export function gantt(laps: Lap[], total: number): void {
    if (!laps.length) {
        return;
    }
    const bar = Math.max(20, WIDTH - 26);
    const label = Math.max(...laps.map((l) => l.name.length));
    console.log(`\n  ${pc.dim(`branch timeline · ${secs(total)} wall clock`)}`);
    for (const l of laps) {
        const end = l.end ?? total;
        const lead = Math.round((l.start / total) * bar);
        const span = Math.max(1, Math.round(((end - l.start) / total) * bar));
        const paint = lane(l.name);
        console.log(
            `  ${paint(l.name.padEnd(label))} ${pc.dim('▏')}${' '.repeat(lead)}` +
                `${paint('█'.repeat(span))}${' '.repeat(Math.max(0, bar - lead - span))}` +
                `${pc.dim(`▕ ${secs(end - l.start)}`)}`,
        );
    }
}

/**
 * What the parent actually sees for a fork: one row per branch, in declared
 * order. The full branch histories stay in the trajectory as tagged nodes, but
 * never enter the parent's prompt.
 */
export async function joinTable(node: JoinNode, payloads: PayloadResolver): Promise<void> {
    const label = Math.max(...node.branches.map((b) => b.name.length));
    console.log();
    for (const b of node.branches) {
        const text = (await payloads.get(b.output)).trim().split('\n')[0] ?? '';
        const mark = b.status === 'ok' ? pc.green('✓') : pc.red('✕');
        console.log(`  ${mark} ${lane(b.name)(b.name.padEnd(label))}  ${text}`);
    }
}

// ---------------------------------------------------------------------------
// Streaming writer
// ---------------------------------------------------------------------------

/**
 * Word-wrapping writer for streamed deltas: text still appears token by token,
 * but every line is prefixed with a gutter and broken at `width` instead of
 * relying on the terminal's soft wrap, which would ignore the gutter.
 */
export function wrapWriter(gutter: string, width: number, paint: (s: string) => string) {
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

// ---------------------------------------------------------------------------
// trace()
// ---------------------------------------------------------------------------

export interface TraceOptions {
    /** stream reasoning summaries as their own labelled block (default: true) */
    thinking?: boolean;
    /**
     * stream token deltas produced *inside* branches (default: true). Set false
     * for wide forks: a dozen interleaved token streams are unreadable, and the
     * distilled form of each branch arrives at the join anyway.
     */
    branchText?: boolean;
    /** prefix every line with elapsed wall-clock time (default: false) */
    elapsed?: boolean;
    /** filled with one entry per branch — feed it to `gantt()` */
    laps?: Lap[];
    /** called with each join node as it lands */
    onJoin?: (node: JoinNode) => void;
}

/**
 * Consumes a run's full event stream, printing every event, and returns the
 * result. Deltas stream into a gutter; every checkpoint gets its own row. All
 * output is demultiplexed through `event.branch`, so a fork tree stays legible.
 */
export async function trace<T>(
    stream: RunStream<T>,
    opts: TraceOptions = {},
): Promise<RunResult<T>> {
    const { thinking = true, branchText = true, elapsed = false, laps, onJoin } = opts;
    const t0 = Date.now();
    const at = (): string =>
        elapsed ? pc.dim(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s `) : '';
    /** Branch events are tagged with a coloured lane; the trunk is not. */
    const where = (e: AgentEvent): string =>
        e.branch ? lane(e.branch.name)(`▌${e.branch.name} `) : '';

    // Which delta stream is mid-flight (kind + originating run), so a checkpoint
    // or a switch of speaker can close it first.
    let open: string | null = null;
    let writer: ReturnType<typeof wrapWriter> | null = null;
    const flush = (): void => {
        writer?.end();
        writer = null;
        open = null;
    };
    const delta = (e: AgentEvent, kind: 'text' | 'thinking', text: string): void => {
        const key = `${kind}:${e.branch?.name ?? ''}`;
        if (open !== key) {
            flush();
            const tint = e.branch ? lane(e.branch.name) : (s: string) => pc.dim(s);
            if (kind === 'text') {
                writer = wrapWriter(tint('  │ '), WIDTH - 4, (s) => s);
            } else {
                // Reasoning is labelled and coloured so it never reads as part
                // of the answer, which shares the gutter directly below it.
                console.log(pc.yellow(`  ✻ ${where(e)}${pc.italic('thinking')}`));
                writer = wrapWriter(pc.yellow('  ┊ '), WIDTH - 4, (s) => pc.yellow(pc.italic(s)));
            }
            open = key;
        }
        writer?.write(text);
    };

    for await (const event of stream) {
        if (event.type !== 'text_delta' && event.type !== 'thinking_delta') {
            flush();
        }
        const tag = `${at()}${where(event)}`;
        switch (event.type) {
            // --- stream deltas -------------------------------------------------
            case 'thinking_delta':
                if (thinking && (branchText || !event.branch)) {
                    delta(event, 'thinking', event.delta);
                }
                break;
            case 'text_delta':
                if (branchText || !event.branch) {
                    delta(event, 'text', event.delta);
                }
                break;
            case 'tool_call_detected':
                line('◇', `${tag}${pc.bold(event.name)} detected`);
                break;
            case 'tool_args_delta':
                // Arg fragments arrive token by token; the assembled call shows
                // up in `before_tool_call`, so they are dropped here.
                break;
            // --- checkpoints ---------------------------------------------------
            case 'run_created':
                line('○', `${tag}run ${event.runId} · agent ${pc.cyan(event.agent)}`);
                break;
            case 'before_llm_call':
                line('↑', `${tag}llm call · ${pc.cyan(event.agent)}`);
                break;
            case 'after_llm_call':
                line(
                    '↓',
                    `${tag}${event.node.model} · ${event.node.stopReason} · ` +
                        `${event.node.usage.inputTokens} in / ${event.node.usage.outputTokens} out` +
                        (event.node.usage.reasoningTokens
                            ? ` (${event.node.usage.reasoningTokens} reasoning)`
                            : ''),
                );
                break;
            case 'before_tool_call':
                line('→', `${tag}${pc.bold(event.call.name)}(${event.call.args.preview ?? ''})`);
                break;
            case 'after_tool_call':
                line(
                    event.node.isError ? '✕' : '←',
                    `${tag}${pc.bold(event.node.name)}` +
                        (event.node.durationMs ? pc.dim(` ${event.node.durationMs}ms`) : '') +
                        `: ${event.node.result.preview ?? ''}`,
                );
                break;
            case 'handoff':
                line('⇄', `${tag}handoff ${pc.cyan(event.from)} → ${pc.cyan(event.to)}`);
                break;
            case 'before_fork':
                line(
                    '⑂',
                    `${tag}fork into ${pc.bold(String(event.node.branches.length))} branches ` +
                        `(context: ${event.node.contextMode}) · ` +
                        event.node.branches.map((b) => lane(b.name)(b.name)).join(pc.dim(', ')),
                );
                break;
            case 'branch_started':
                laps?.push({ name: event.child.name, start: Date.now() - t0 });
                line('├', `${tag}branch ${lane(event.child.name)(event.child.name)} started`);
                break;
            case 'branch_finished': {
                const lap = laps?.find((l) => l.name === event.child.name && l.end === undefined);
                if (lap) {
                    lap.end = Date.now() - t0;
                    lap.status = event.status;
                }
                line(
                    '┤',
                    `${tag}branch ${lane(event.child.name)(event.child.name)} ${event.status}`,
                );
                break;
            }
            case 'after_join':
                onJoin?.(event.node);
                line('⑃', `${tag}join ${event.node.branches.length} branches`);
                break;
            case 'run_finished':
                line('●', `${tag}run finished`);
                break;
        }
    }
    flush();
    return stream.final();
}
