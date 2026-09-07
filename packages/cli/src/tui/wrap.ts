// ---------------------------------------------------------------------------
// Measuring in rows
//
// The unit that matters in a repainting terminal frame is the **row the
// terminal draws**, not the line the model wrote. A reasoning stream is one
// enormous paragraph with almost no newlines in it, so counting `\n` says
// "six lines" while the terminal draws sixty — and a frame that outgrows the
// viewport is the one thing Ink cannot erase (see tui/app.tsx).
//
// So the text is wrapped here, to a width we know, and measured in what comes
// out. Plain text only: nothing that reaches these two functions has style
// codes in it, so there is no need to carry the machinery for counting around
// them.
// ---------------------------------------------------------------------------

/**
 * The last `rows` rows of `text` once wrapped to `width`, each one short enough
 * that the terminal will not wrap it again.
 *
 * Only the tail is ever wanted, so only the tail is wrapped: `width * rows * 2`
 * characters is more than enough to fill the window whatever the wrapping does,
 * and bounds the work per keystroke on a stream that never stops growing.
 */
export function windowOf(text: string, width: number, rows: number): string[] {
    const w = Math.max(8, width);
    const n = Math.max(1, rows);
    const wrapped = wrap(text.slice(-w * n * 2).replace(/\n{2,}/g, '\n'), w);
    return wrapped.slice(-n);
}

/**
 * `text` flattened onto one row of at most `width` columns, ellipsized when it
 * did not fit. Newlines and runs of space collapse: a row is a row, and a tool
 * argument or a result preview arrives with whatever shape it happened to have.
 */
export function clip(text: string, width: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const w = Math.max(1, width);
    return flat.length <= w ? flat : `${flat.slice(0, w - 1)}…`;
}

/** Word wrap. Every returned row is at most `width` columns wide. */
export function wrap(text: string, width: number): string[] {
    const w = Math.max(1, width);
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            // A word wider than the terminal has to be broken somewhere, and
            // anywhere is as good as anywhere else.
            let rest = word;
            while (rest.length > w) {
                if (line) {
                    out.push(line);
                    line = '';
                }
                out.push(rest.slice(0, w));
                rest = rest.slice(w);
            }
            if (!line) {
                line = rest;
            } else if (line.length + 1 + rest.length <= w) {
                line += ` ${rest}`;
            } else {
                out.push(line);
                line = rest;
            }
        }
        out.push(line);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Dividing the frame
//
// The same invariant, stated as arithmetic: every repainting block gets its
// rows from here, and the sum is never more than the viewport has to give.
// ---------------------------------------------------------------------------

/** The two footer rows, its margin, the prompt, and a row in hand. */
export const CHROME_ROWS = 6;

/** How much of the reasoning stream is worth showing. It is a progress bar. */
export const THINKING_ROWS = 6;

/** How many things in flight are worth naming at once. */
export const ACTIVITY_ROWS = 6;

export interface Budget {
    /** rows for the list of what is in flight */
    activity: number;
    /** rows for the tail of the reasoning stream */
    thinking: number;
    /** rows for the answer as it arrives */
    live: number;
}

/**
 * How many rows each repainting block may draw in a terminal `rows` tall.
 *
 * Activity is capped first and never takes the last two rows: the answer as it
 * arrives matters more than the machinery producing it. Reasoning yields to it
 * in turn, because it is a progress indicator and the answer is the point.
 */
export function budgetOf(rows: number, activity: number, thinking: boolean): Budget {
    const total = Math.max(2, rows - CHROME_ROWS);
    const shown = Math.min(Math.max(0, activity), ACTIVITY_ROWS, Math.max(0, total - 2));
    const rest = total - shown;
    const tail = thinking ? Math.min(THINKING_ROWS, rest - 1) : 0;
    return { activity: shown, thinking: tail, live: rest - tail };
}

// ---------------------------------------------------------------------------
// Fenced blocks
// ---------------------------------------------------------------------------

/** A run of lines from an answer, and whether it was fenced as code. */
export interface Segment {
    code: boolean;
    /** the fence's info string, when it had one */
    title?: string;
    lines: string[];
}

/**
 * Splits an answer on ``` fences. Prose is left exactly as it was — the common
 * answer has no fence in it and comes back in one piece — but a fenced block is
 * the one thing a terminal must not reflow: its indentation is its meaning, and
 * wrapping it as prose destroys it.
 */
export function segmentsOf(text: string): Segment[] {
    const out: Segment[] = [];
    let current: Segment = { code: false, lines: [] };
    const flush = (): void => {
        if (current.lines.length) {
            out.push(current);
        }
    };
    for (const raw of text.split('\n')) {
        const fence = /^\s*```+\s*(\S*)/.exec(raw);
        if (!fence) {
            current.lines.push(raw);
            continue;
        }
        flush();
        current = current.code
            ? { code: false, lines: [] }
            : { code: true, title: fence[1] || undefined, lines: [] };
    }
    flush();
    return out;
}
