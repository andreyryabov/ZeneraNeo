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
    // Trailing blank rows are never information, and a stream that ends on a
    // paragraph break would spend one of the few rows it has on nothing.
    const tail = text
        .slice(-w * n * 2)
        .replace(/\n{2,}/g, '\n')
        .trimEnd();
    return wrap(tail, w).slice(-n);
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

/** The three footer rows, its margin, the prompt, and a row in hand. */
export const CHROME_ROWS = 7;

/** How much of the reasoning stream is worth showing. It is a progress bar. */
export const THINKING_ROWS = 6;

/** How much of the frame the work in flight may take. A branch is a box now,
 *  not a row, so a fan-out of three costs nine of these. */
export const ACTIVITY_ROWS = 12;

/** The rule that opens a reasoning block and the one that closes it. */
export const THINKING_CHROME = 2;

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
 *
 * `thinking` is how many rows of reasoning are wanted, counting text only: none
 * when there is no reasoning, fewer than `THINKING_ROWS` once the stream has
 * settled and its tail is history rather than progress. The two rules are
 * charged on top, so a block too cramped to be worth boxing is not drawn at all
 * rather than drawn as a border with a line in it.
 */
export function budgetOf(rows: number, activity: number, thinking: number): Budget {
    const total = Math.max(2, rows - CHROME_ROWS);
    const shown = Math.min(Math.max(0, activity), ACTIVITY_ROWS, Math.max(0, total - 2));
    const rest = total - shown;
    const room = rest - 1 - THINKING_CHROME;
    const tail = room >= 1 ? Math.min(Math.max(0, thinking), THINKING_ROWS, room) : 0;
    return { activity: shown, thinking: tail, live: rest - tail - (tail ? THINKING_CHROME : 0) };
}

// ---------------------------------------------------------------------------
// Reading a payload
// ---------------------------------------------------------------------------

/** One field of a preview: a JSON string, or a bare token when it was cut. */
const FIELD = /"([A-Za-z_][\w-]*)"\s*:\s*("(?:[^"\\]|\\.)*"?|[^,}\s]+)/g;

/**
 * A tool payload as a person would read it, rather than as it was serialised.
 *
 * A lone field is printed as its bare value, because the name of a generic tool
 * says almost nothing on its own — `run_command` is every shell command there
 * is, and the argument is the part that identifies THIS call.
 *
 * It scans rather than parses: previews are cut to a length, so the JSON very
 * often does not close, and precisely the calls worth reading are the long ones
 * that got cut.
 */
export function readable(preview: string): string {
    const found = [...preview.matchAll(FIELD)];
    if (!found.length) {
        return preview.trim();
    }
    const fields = found.map((m) => [m[1] as string, unquote(m[2] as string)] as const);
    const one = fields.length === 1 ? fields[0] : undefined;
    return one ? one[1] : fields.map(([k, v]) => `${k}=${v}`).join(' ');
}

function unquote(raw: string): string {
    if (!raw.startsWith('"')) {
        return raw;
    }
    const body = raw.length > 1 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
    return body.replace(/\\[nrt]/g, ' ').replace(/\\(["\\/])/g, '$1');
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
