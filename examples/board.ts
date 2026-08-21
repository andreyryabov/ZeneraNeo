import pc from 'picocolors';
import type { AgentEvent, RunStream } from '../src/events.ts';
import type { RunResult } from '../src/state.ts';
import type { JoinNode } from '../src/trajectory.ts';
import { lane, secs, WIDTH, type Lap } from './ui.ts';

// ---------------------------------------------------------------------------
// Live branch board
//
// `trace()` in ./ui.ts is a log: one line per event, in arrival order. That is
// the right shape for a single thread of work and the wrong one for a fan-out —
// interleaved lines from eight concurrent branches read as noise.
//
// This is the same event stream demultiplexed by `event.branch` into one pane
// per branch, redrawn in place. Nothing here needs a UI library: a frame is an
// array of strings, and "redraw" is cursor-up + erase-down. The only reason to
// reach for `ink`/`blessed` would be input handling or layout we do not need.
// ---------------------------------------------------------------------------

const TTY = process.stdout.isTTY === true;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Activity rows kept visible inside a pane; older entries scroll off. */
const ROWS = 6;
/** Redraw cadence. Independent of events, so spinners and clocks keep moving. */
const FRAME_MS = 80;

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

type Status = 'pending' | 'running' | 'ok' | 'error' | 'aborted';

/** One activity row. `live` marks a row still being streamed into. */
interface Entry {
    icon: string;
    text: string;
    tint?: (s: string) => string;
    live?: 'text' | 'thinking';
}

interface Pane {
    name: string;
    agent: string;
    status: Status;
    start?: number;
    end?: number;
    /** model calls (`before_llm_call`) — the "steps" of a multi-step branch */
    turns: number;
    tools: number;
    inTok: number;
    outTok: number;
    log: Entry[];
}

function makePane(name: string, agent: string): Pane {
    return { name, agent, status: 'pending', turns: 0, tools: 0, inTok: 0, outTok: 0, log: [] };
}

function push(p: Pane, e: Entry): void {
    p.log.push(e);
    // Only the tail is ever drawn; keeping a little more than that is enough
    // for the final frame and costs nothing.
    if (p.log.length > ROWS * 3) {
        p.log.splice(0, p.log.length - ROWS * 3);
    }
}

/** Appends to the open stream row of `kind`, opening one if needed. */
function streamInto(p: Pane, kind: 'text' | 'thinking', delta: string): void {
    const last = p.log.at(-1);
    if (last?.live === kind) {
        last.text += delta;
        return;
    }
    push(
        p,
        kind === 'thinking'
            ? { icon: '✻', text: delta, tint: (s) => pc.yellow(pc.italic(s)), live: 'thinking' }
            : { icon: '│', text: delta, live: 'text' },
    );
}

/** Freezes any open stream row, so the next delta starts a new one. */
function seal(p: Pane): void {
    const last = p.log.at(-1);
    if (last?.live) {
        last.live = undefined;
        // A finished reasoning block is only interesting as a trace of what the
        // branch was doing; the join carries the substance.
        last.text = last.text.replace(/\s+/g, ' ').trim();
    }
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

interface Seg {
    t: string;
    c?: (s: string) => string;
}

/** Lays segments into exactly `width` visible columns: clip, then pad.
 *  Colour is applied per segment *after* clipping, so widths stay honest. */
function row(segs: Seg[], width: number): string {
    let out = '';
    let used = 0;
    for (const s of segs) {
        if (used >= width) {
            break;
        }
        const t = s.t.slice(0, width - used);
        out += s.c ? s.c(t) : t;
        used += t.length;
    }
    return out + ' '.repeat(Math.max(0, width - used));
}

const glyph = (s: Status, spin: string): Seg =>
    s === 'running'
        ? { t: spin, c: pc.cyan }
        : s === 'ok'
          ? { t: '✓', c: pc.green }
          : s === 'error'
            ? { t: '✕', c: pc.red }
            : s === 'aborted'
              ? { t: '⊘', c: pc.yellow }
              : { t: '·', c: pc.dim };

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Renders one pane as a fixed-size box: `[title, meta, ...rows, bottom]`. */
function paneBox(p: Pane, width: number, spin: string, now: number, rows = ROWS): string[] {
    const paint = lane(p.name);
    const iw = width - 4; // borders + one space of padding on each side
    const title = ` ${p.name} `;
    const agent = p.agent ? `· ${p.agent} ` : '';
    const dashes = Math.max(0, width - 3 - title.length - agent.length);
    const lines = [
        pc.dim('╭─') + paint(title) + pc.dim(agent + '─'.repeat(dashes) + '╮'),
        pc.dim('│ ') +
            row(
                [
                    glyph(p.status, spin),
                    { t: `  ${p.turns} steps  ${p.tools} tools`, c: pc.dim },
                    {
                        t: p.start === undefined ? '' : `  ${secs((p.end ?? now) - p.start)}`,
                        c: pc.dim,
                    },
                    { t: p.outTok ? `  ${tokens(p.inTok + p.outTok)} tok` : '', c: pc.dim },
                ],
                iw,
            ) +
            pc.dim(' │'),
    ];
    const tail = p.log.slice(-rows);
    for (let i = 0; i < rows; i++) {
        const e = tail[i];
        if (!e) {
            lines.push(pc.dim('│ ') + ' '.repeat(iw) + pc.dim(' │'));
            continue;
        }
        // A row still being streamed shows its tail, so the text scrolls
        // leftwards like a ticker instead of freezing at the first clip.
        const body = e.text.replace(/\s+/g, ' ');
        const max = iw - 2;
        const shown = e.live && body.length > max ? `…${body.slice(-(max - 1))}` : body;
        lines.push(
            pc.dim('│ ') +
                row(
                    [
                        { t: `${e.icon} `, c: e.tint ?? pc.dim },
                        { t: shown, c: e.tint },
                    ],
                    iw,
                ) +
                pc.dim(' │'),
        );
    }
    lines.push(pc.dim('╰' + '─'.repeat(width - 2) + '╯'));
    return lines;
}

/** Lays panes out in a grid and zips each band of boxes into terminal rows. */
function grid(panes: Pane[], width: number, spin: string, now: number): string[] {
    const cols = width >= 76 ? 2 : 1;
    const cw = Math.floor((width - (cols - 1)) / cols);
    const out: string[] = [];
    for (let i = 0; i < panes.length; i += cols) {
        const band = panes.slice(i, i + cols).map((p) => paneBox(p, cw, spin, now));
        const height = Math.max(...band.map((b) => b.length));
        for (let r = 0; r < height; r++) {
            out.push(band.map((b) => b[r] ?? ' '.repeat(cw)).join(' '));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Frame writer
// ---------------------------------------------------------------------------

/** In-place redraw: remember how tall the last frame was, walk back up over it
 *  and erase forwards. Falls back to doing nothing when stdout is not a TTY. */
class Frame {
    #height = 0;

    render(lines: string[]): void {
        if (!TTY) {
            return;
        }
        const buf =
            (this.#height ? `\x1b[${this.#height}A` : '') + '\x1b[0J' + lines.join('\n') + '\n';
        process.stdout.write(buf);
        this.#height = lines.length;
    }
}

// ---------------------------------------------------------------------------
// traceBoard()
// ---------------------------------------------------------------------------

export interface BoardOptions {
    /** filled with one entry per branch — feed it to `gantt()` */
    laps?: Lap[];
    /** called with each join node as it lands */
    onJoin?: (node: JoinNode) => void;
}

/**
 * Consumes a run's event stream and renders it as a live board — one pane for
 * the trunk, one per branch — then returns the result. Every pane is driven by
 * the same events `trace()` prints: `before_llm_call` bumps the step counter,
 * `thinking_delta` streams into a reasoning row, `before/after_tool_call` show
 * the branch's tools going in and out.
 */
export async function traceBoard<T>(
    stream: RunStream<T>,
    opts: BoardOptions = {},
): Promise<RunResult<T>> {
    const t0 = Date.now();
    const trunk = makePane('trunk', '');
    trunk.status = 'running';
    trunk.start = 0;
    const branches = new Map<string, Pane>();
    const order: Pane[] = [];
    const frame = new Frame();
    let tick = 0;

    const draw = (): void => {
        const spin = SPINNER[tick++ % SPINNER.length] as string;
        const now = Date.now() - t0;
        frame.render([
            // The trunk gets a wide, short pane: it forks once and waits, so its
            // interesting rows are few. The branches get the vertical space.
            ...paneBox(trunk, WIDTH, spin, now, 3),
            ...(order.length ? grid(order, WIDTH, spin, now) : []),
        ]);
    };

    /** The pane an event belongs to. `event.branch` is absent on the trunk. */
    const paneFor = (e: AgentEvent): Pane => {
        if (!e.branch) {
            trunk.agent ||= e.agent;
            return trunk;
        }
        let p = branches.get(e.branch.name);
        if (!p) {
            p = makePane(e.branch.name, e.agent);
            branches.set(e.branch.name, p);
            order.push(p);
        }
        return p;
    };

    if (TTY) {
        process.stdout.write('\x1b[?25l'); // hide the cursor while we redraw
    }
    const timer = setInterval(draw, FRAME_MS);
    // A live board is meaningless in a pipe or a CI log; there, fall back to
    // one prefixed line per committed row so the demo still reads.
    const echo = (p: Pane, e: Entry): void => {
        if (!TTY) {
            console.log(`  ${lane(p.name)(p.name.padEnd(14))} ${e.icon} ${e.text}`);
        }
    };

    try {
        for await (const event of stream) {
            const p = paneFor(event);
            if (event.type !== 'text_delta' && event.type !== 'thinking_delta') {
                seal(p);
            }
            switch (event.type) {
                case 'thinking_delta':
                    streamInto(p, 'thinking', event.delta);
                    break;
                case 'text_delta':
                    streamInto(p, 'text', event.delta);
                    break;
                case 'before_llm_call':
                    p.turns++;
                    break;
                case 'after_llm_call':
                    p.inTok += event.node.usage.inputTokens;
                    p.outTok += event.node.usage.outputTokens;
                    break;
                case 'before_tool_call': {
                    const e: Entry = {
                        icon: '→',
                        text: `${event.call.name}(${event.call.args.preview ?? ''})`,
                        tint: pc.cyan,
                    };
                    push(p, e);
                    echo(p, e);
                    break;
                }
                case 'after_tool_call': {
                    p.tools++;
                    const ms = event.node.durationMs ? ` ${event.node.durationMs}ms` : '';
                    const e: Entry = {
                        icon: event.node.isError ? '✕' : '←',
                        text: `${event.node.name}${ms}: ${event.node.result.preview ?? ''}`,
                        tint: event.node.isError ? pc.red : undefined,
                    };
                    push(p, e);
                    echo(p, e);
                    break;
                }
                case 'handoff': {
                    const e: Entry = { icon: '⇄', text: `${event.from} → ${event.to}` };
                    push(p, e);
                    echo(p, e);
                    break;
                }
                case 'before_fork': {
                    // Panes appear in declared order, before any branch starts,
                    // so the board never reshuffles as branches wake up.
                    for (const b of event.node.branches) {
                        if (!branches.has(b.name)) {
                            const pane = makePane(b.name, b.agent);
                            branches.set(b.name, pane);
                            order.push(pane);
                        }
                    }
                    const e: Entry = {
                        icon: '⑂',
                        text: `fork ${event.node.branches.length} branches (context: ${event.node.contextMode})`,
                        tint: pc.magenta,
                    };
                    push(trunk, e);
                    echo(trunk, e);
                    break;
                }
                case 'branch_started': {
                    const b = paneFor({ ...event, branch: event.child });
                    b.status = 'running';
                    b.start = Date.now() - t0;
                    opts.laps?.push({ name: event.child.name, start: b.start });
                    break;
                }
                case 'branch_finished': {
                    const b = paneFor({ ...event, branch: event.child });
                    b.status = event.status;
                    b.end = Date.now() - t0;
                    const lap = opts.laps?.find(
                        (l) => l.name === event.child.name && l.end === undefined,
                    );
                    if (lap) {
                        lap.end = b.end;
                        lap.status = event.status;
                    }
                    break;
                }
                case 'after_join': {
                    opts.onJoin?.(event.node);
                    const e: Entry = {
                        icon: '⑃',
                        text: `join ${event.node.branches.length} branches · ${tokens(
                            event.node.usage.inputTokens + event.node.usage.outputTokens,
                        )} tok`,
                        tint: pc.magenta,
                    };
                    push(trunk, e);
                    echo(trunk, e);
                    break;
                }
                case 'run_finished':
                    if (!event.branch) {
                        trunk.status = 'ok';
                        trunk.end = Date.now() - t0;
                    }
                    break;
            }
        }
        return await stream.final();
    } finally {
        clearInterval(timer);
        seal(trunk);
        for (const p of branches.values()) {
            seal(p);
        }
        draw();
        if (TTY) {
            process.stdout.write('\x1b[?25h');
        }
    }
}
