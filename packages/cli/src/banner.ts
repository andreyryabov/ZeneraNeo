import { styleText } from 'node:util';
import { dim, note } from './term.ts';

// ---------------------------------------------------------------------------
// The banner
//
// The one piece of output that exists to be looked at rather than read. It goes
// to **stderr**, like every other piece of narration, and only when stderr is a
// terminal — a pipeline asking for the answer gets the answer, and a CI log is
// not decorated with block letters.
//
// The font is here rather than pulled in as a dependency because it is a couple
// of kilobytes of constant and the whole CLI is otherwise Node's own. It is the
// shadowed block face: a solid stroke lit from the top left with a box-drawing
// bevel down its right side and along its foot, so the letters read as raised
// rather than as a texture. Glyphs are variable width and carry their own
// spacing, so they abut directly — the gap belongs to the letter, not the join.
//
// A terminal too narrow for the art gets the wordmark on one line. A banner
// that wraps is worse than no banner.
// ---------------------------------------------------------------------------

const HEIGHT = 6;

/** Between the two words. Wide enough that they read as two, not as one. */
const GAP = 3;

/** A left margin, so the art does not start against the edge of the screen. */
const INDENT = 2;

const FONT: Record<string, readonly string[]> = {
    A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
    B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
    C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
    D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
    E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
    F: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '██║     ', '╚═╝     '],
    G: [' ██████╗ ', '██╔════╝ ', '██║  ███╗', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
    I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
    J: ['     ██╗', '     ██║', '     ██║', '██   ██║', '╚█████╔╝', ' ╚════╝ '],
    K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
    L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
    M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
    N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
    O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
    Q: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║▄▄ ██║', '╚██████╔╝', ' ╚══▀▀═╝ '],
    R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
    S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
    T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
    U: ['██╗   ██╗', '██║   ██║', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
    W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
    X: ['██╗  ██╗', '╚██╗██╔╝', ' ╚███╔╝ ', ' ██╔██╗ ', '██╔╝ ██╗', '╚═╝  ╚═╝'],
    Y: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
    Z: ['███████╗', '╚══███╔╝', '  ███╔╝ ', ' ███╔╝  ', '███████╗', '╚══════╝'],
};

const BLANK = ['    ', '    ', '    ', '    ', '    ', '    '];

/** One word as six rows of equal length — so two words line up when joined. */
function big(word: string): string[] {
    const rows = new Array<string>(HEIGHT).fill('');
    for (const ch of word.toUpperCase()) {
        const glyph = FONT[ch] ?? BLANK;
        for (let r = 0; r < HEIGHT; r++) {
            rows[r] += glyph[r];
        }
    }
    return rows;
}

/** A wordmark rather than a sentence, so the letters are set apart. */
const spaced = (s: string): string => [...s.toUpperCase()].join(' ');

/** Whether anything should be coloured at all — `styleText`'s own answer. */
const styling = (): boolean => styleText('dim', '.') !== '.';

const RESET = '\u001b[0m';

/** A stroke and the bevel that shades it, one step darker in the same hue. */
interface Tone {
    face: string;
    shade: string;
}

const HEAD: Tone = { face: '\u001b[1;38;5;231m', shade: '\u001b[0;38;5;244m' };
const ACCENT: Tone = { face: '\u001b[1;38;5;208m', shade: '\u001b[0;38;5;130m' };

/** Runs of stroke and runs of bevel, alternating; spaces stay unstyled. */
const RUNS = /[█▀▄]+|[^█▀▄ ]+/g;
const isStroke = (run: string): boolean => /[█▀▄]/.test(run);

/**
 * Two tones per word — without the darker bevel the letter is a flat outline
 * and the shadow reads as part of the stroke.
 */
const paint = (text: string, tone: Tone): string =>
    styling()
        ? text.replace(RUNS, (run) => `${isStroke(run) ? tone.face : tone.shade}${run}${RESET}`)
        : text;

/** The wordmark has no bevel to shade, so it is all face. */
const flat = (text: string, tone: Tone): string =>
    styling() ? `${tone.face}${text}${RESET}` : text;

export interface BannerText {
    /** drawn white */
    head: string;
    /** drawn in the neon accent */
    accent: string;
    /** the line underneath, dim */
    subtitle: string;
}

export interface PrintBannerOptions {
    /** Render the block face even when the terminal is narrower than it. */
    readonly full?: boolean;
}

export const NEO_BANNER: BannerText = {
    head: 'Zenera',
    accent: 'Neo',
    subtitle: 'Agentic Runtime',
};

export function bannerLines(text: BannerText, columns = process.stderr.columns || 80): string[] {
    const head = big(text.head);
    // Trimmed: the widest accent row is the banner's right edge, and a pad left
    // inside a styled string cannot be trimmed away later.
    const accent = big(text.accent).map((row) => row.trimEnd());
    const margin = ' '.repeat(INDENT);
    const width = INDENT + head[0].length + GAP + Math.max(...accent.map((row) => row.length));

    if (width > columns) {
        return [
            `${margin}${flat(text.head.toUpperCase(), HEAD)} ${flat(text.accent.toUpperCase(), ACCENT)}`,
            `${margin}${dim(spaced(text.subtitle))}`,
        ];
    }

    const lines: string[] = [];
    for (let r = 0; r < HEIGHT; r++) {
        lines.push(`${margin}${paint(head[r], HEAD)}${' '.repeat(GAP)}${paint(accent[r], ACCENT)}`);
    }
    // Rules on both sides, centred under the art: the subtitle is a caption,
    // and without them a short line of spaced capitals floats.
    const caption = `───  ${spaced(text.subtitle)}  ───`;
    lines.push('');
    lines.push(
        `${' '.repeat(Math.max(INDENT, Math.round((width - caption.length) / 2)))}${dim(caption)}`,
    );
    return lines;
}

/** Narration, and only for someone watching. */
export function printBanner(text: BannerText, options: PrintBannerOptions = {}): void {
    if (!process.stderr.isTTY) {
        return;
    }
    note('');
    for (const line of bannerLines(text, options.full ? Infinity : undefined)) {
        note(line);
    }
    note('');
}
