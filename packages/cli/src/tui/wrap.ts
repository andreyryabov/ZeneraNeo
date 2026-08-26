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
