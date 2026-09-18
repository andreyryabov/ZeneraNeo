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

/**
 * How much of the reasoning stream is worth showing.
 *
 * One row. A reasoning summary is not a document to be read while it arrives —
 * it is the model saying what it is about to do, and the sentence that says so
 * is the heading it writes for itself. Six rows of it pushed the answer and the
 * work down the screen to make room for a paragraph nobody finishes reading,
 * and the whole chain is in the trajectory either way.
 */
export const THINKING_ROWS = 1;

/** How much of the frame the work in flight may take. A branch is a box now,
 *  not a row, so a fan-out of two costs fourteen of these. */
export const ACTIVITY_ROWS = 16;

/** The width of the elapsed-time column every call row is drawn behind. */
export const TIME_COL = 5;

export interface Budget {
    /** rows for the list of what is in flight */
    activity: number;
    /** rows for the gist of what the model is reasoning about */
    thinking: number;
    /** rows for the answer as it arrives */
    live: number;
    /**
     * What the three of them occupy together — a constant for a given terminal,
     * whatever is happening inside it. The region grows to this and stops, and
     * never shrinks back while the turn runs, which is what keeps the footer on
     * one row instead of riding up and down on the work.
     */
    total: number;
}

/**
 * How many rows each repainting block may draw in a terminal `rows` tall.
 *
 * Activity is capped first and never takes the last two rows: the answer as it
 * arrives matters more than the machinery producing it. Reasoning yields to it
 * in turn, because it is a progress indicator and the answer is the point.
 *
 * `thinking` is how many rows of reasoning are wanted — one while the model is
 * reasoning, none otherwise — and it never takes the answer's last row.
 */
export function budgetOf(rows: number, activity: number, thinking: number): Budget {
    const total = Math.max(2, rows - CHROME_ROWS);
    const shown = Math.min(Math.max(0, activity), ACTIVITY_ROWS, Math.max(0, total - 2));
    const rest = total - shown;
    const tail = Math.min(Math.max(0, thinking), THINKING_ROWS, Math.max(0, rest - 1));
    return { activity: shown, thinking: tail, live: rest - tail, total };
}

/** The rows a branch box may spend on its own calls and its reasoning. */
export const BRANCH_ROWS = 5;

/** Rows a branch box spends on chrome: the title rule and the closing one. */
export const BOX_CHROME = 2;

/**
 * How many call rows each of `count` branch boxes may draw, given the rows the
 * activity region has to divide between them.
 *
 * Every branch gets the same number, because they are the same kind of thing
 * and a fan-out is read across, not down. A wide fork spends its rows on being
 * complete rather than on being detailed: eight branches showing one call each
 * is a picture of the fork, eight rows of one branch is not.
 */
export function branchRows(count: number, allowance: number): number {
    if (count <= 0) {
        return 0;
    }
    const each = Math.floor(Math.max(0, allowance) / count) - BOX_CHROME;
    return Math.max(1, Math.min(BRANCH_ROWS, each));
}

/**
 * How wide the answer is drawn. A line of prose spanning a 200-column terminal
 * is measurably harder to read than one that stops, which is why every demo in
 * `examples/sdk/` puts its answer in a box of bounded width — the terminal is the
 * page, not the paragraph.
 */
export function answerWidth(columns: number): number {
    return Math.max(24, Math.min(columns - 4, 96));
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

/** Every field of a preview, first mention winning. */
export function fieldsOf(preview: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of preview.matchAll(FIELD)) {
        const key = m[1] as string;
        if (!out.has(key)) {
            out.set(key, unquote(m[2] as string));
        }
    }
    return out;
}

/** The text between `"key":[` and the first `]`, or nothing if there is no such array. */
function arrayBody(preview: string, key: string): string | undefined {
    const at = preview.indexOf(`"${key}"`);
    if (at < 0) {
        return undefined;
    }
    const open = preview.indexOf('[', at);
    if (open < 0) {
        return undefined;
    }
    const close = preview.indexOf(']', open);
    return preview.slice(open + 1, close < 0 ? undefined : close);
}

/**
 * An array argument, as the two things worth knowing about it: what is in it,
 * when its items say their own names, and how many there are either way.
 */
function itemsOf(preview: string, key: string): { names: string[]; total: number } {
    const body = arrayBody(preview, key);
    if (body === undefined || !body.trim()) {
        return { names: [], total: 0 };
    }
    if (/^\s*\{/.test(body)) {
        const names = [...body.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1] as string);
        return { names, total: Math.max(names.length, (body.match(/\{/g) ?? []).length) };
    }
    const names = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string).filter(Boolean);
    return { names, total: names.length };
}

/** A few things are worth naming; more than a few are worth counting. */
function named(items: { names: string[]; total: number }, unit: string): string {
    if (!items.total) {
        return '';
    }
    if (items.names.length && items.names.length <= 2) {
        return items.names.join(', ');
    }
    return `${items.total} ${items.total === 1 ? unit : `${unit}s`}`;
}

// ---------------------------------------------------------------------------
// Reading a call
//
// A transcript row has one line in which to say what the agent just did, and
// the tool's own name next to its serialised arguments is the least readable
// way to spend it. `run_command` is every shell command there is; a
// `memory_commit` carrying three nodes and two links is a paragraph of JSON for
// something that fits in three words; `apply_patch` is an entire diff.
//
// The built-in tools are known quantities, so each one gets a verb and the one
// argument that identifies this call. Anything else \u2014 a skill's own tool, a
// sibling package's \u2014 falls back to the name and `readable`, which is what the
// rows looked like before.
// ---------------------------------------------------------------------------

/** What a call is doing, and what it is doing it to. */
export interface CallView {
    /** The verb, drawn first: what kind of thing this is. */
    verb: string;
    /** What identifies this call: a path, a command, a query. May be empty. */
    subject: string;
}

interface Shape {
    verb: string;
    /** argument names to try in order; the first one present is the subject */
    of?: readonly string[];
    /** two argument names, drawn as `from → to` */
    pair?: readonly [string, string];
    /** an array argument, named while it is short and counted once it is not */
    count?: readonly [key: string, unit: string];
}

const CALLS: Record<string, Shape> = {
    read_file: { verb: 'read', of: ['path'] },
    list_dir: { verb: 'list', of: ['path'] },
    find_files: { verb: 'find', of: ['pattern'] },
    write_file: { verb: 'write', of: ['path'] },
    apply_patch: { verb: 'patch' },
    move_file: { verb: 'move', pair: ['from', 'to'] },
    delete_file: { verb: 'delete', of: ['path'] },
    run_command: { verb: 'run', of: ['command'] },
    run_command_background: { verb: 'start', of: ['command'] },
    read_command_output: { verb: 'output', of: ['job_id'] },
    stop_command: { verb: 'stop', of: ['job_id'] },
    memory_search: { verb: 'recall', of: ['query'] },
    memory_load: { verb: 'read memory', count: ['ids', 'node'] },
    memory_commit: { verb: 'remember', count: ['nodes', 'node'] },
    memory_forget: { verb: 'forget', count: ['ids', 'node'] },
    skill_search: { verb: 'find skill', of: ['query'] },
    skill_load: { verb: 'load skill', count: ['names', 'skill'] },
    fork: { verb: 'fork', count: ['branches', 'branch'] },
    final_output: { verb: 'answer' },
    search_api: { verb: 'search api', of: ['query'] },
    list_api: { verb: 'list api', of: ['name', 'kind'] },
    grep_api: { verb: 'grep api', of: ['pattern'] },
    trace_api: { verb: 'trace api', of: ['pattern'] },
};

/** The handoff tools are minted per agent, so they are matched by prefix. */
const TRANSFER = 'transfer_to_';

/** A patch names its own files, and that is the only part of it worth a row. */
const PATCHED = /\*\*\* (?:Add|Update|Delete) File:\s*(.*?)(?:\\[nr]|"|$)/g;

export function describeCall(name: string, preview: string): CallView {
    if (name.startsWith(TRANSFER)) {
        return { verb: 'hand off to', subject: name.slice(TRANSFER.length) };
    }
    const shape = CALLS[name];
    if (!shape) {
        return { verb: name, subject: readable(preview) };
    }
    if (name === 'apply_patch') {
        const files = [...preview.matchAll(PATCHED)].map((m) => (m[1] as string).trim());
        return { verb: shape.verb, subject: named({ names: files, total: files.length }, 'file') };
    }
    if (shape.pair) {
        const fields = fieldsOf(preview);
        const [from, to] = shape.pair;
        return { verb: shape.verb, subject: `${fields.get(from) ?? ''} → ${fields.get(to) ?? ''}` };
    }
    if (shape.count) {
        const [key, unit] = shape.count;
        return { verb: shape.verb, subject: named(itemsOf(preview, key), unit) };
    }
    const fields = fieldsOf(preview);
    for (const key of shape.of ?? []) {
        const value = fields.get(key);
        if (value) {
            return { verb: shape.verb, subject: value };
        }
    }
    return { verb: shape.verb, subject: '' };
}

/**
 * What a finished call has to say for itself, in the few words a row has left.
 *
 * A `[]` suffix means "count it": the interesting thing about a listing is how
 * much came back, and printing the first two of forty entries says less than
 * the number does.
 */
const RESULTS: Record<string, readonly string[]> = {
    read_file: ['lines'],
    list_dir: ['entries[]'],
    find_files: ['matches[]'],
    write_file: ['bytes'],
    apply_patch: ['files[]'],
    move_file: ['to'],
    delete_file: ['path'],
    run_command: ['exit_code'],
    run_command_background: ['job_id'],
};

export function summarise(name: string, preview: string): string {
    const fields = fieldsOf(preview);
    // An error is the whole of what happened, and it is what the next turn
    // will be about. Nothing else on the row competes with it.
    const failed = fields.get('error');
    if (failed) {
        return failed;
    }
    const parts: string[] = [];
    for (const key of RESULTS[name] ?? []) {
        if (key.endsWith('[]')) {
            const of = key.slice(0, -2);
            const { total } = itemsOf(preview, of);
            if (total) {
                parts.push(`${total} ${of}`);
            }
            continue;
        }
        const value = fields.get(key);
        if (value !== undefined && value !== '') {
            parts.push(`${key.replace(/_/g, ' ')} ${value}`);
        }
    }
    return parts.length ? parts.join(' · ') : readable(preview);
}

// ---------------------------------------------------------------------------
// The gist of a reasoning stream
// ---------------------------------------------------------------------------

/** How much of a stream is looked at for a heading. Its end is where it got to. */
const GIST_TAIL = 4000;

/** A reasoning summary writes its own headings, in bold. */
const BOLD = /\*\*([^*\n]{2,}?)\*\*/g;

/**
 * One line saying where the model has got to.
 *
 * Reasoning summaries arrive as markdown and are structured by their own bold
 * headings — Gemini emits one every few sentences, and they are the shortest
 * true account of the step. The last one is where the model is now. Failing
 * that the raw text is clipped, which is a fragment, but a moving fragment is
 * still proof that something is happening.
 */
export function gistOf(text: string, width: number): string {
    const tail = text.slice(-GIST_TAIL);
    const heads = [...tail.matchAll(BOLD)];
    const last = heads.at(-1)?.[1];
    return clip(last ?? tail, width);
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
