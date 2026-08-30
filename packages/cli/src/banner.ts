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
// The font is here rather than pulled in as a dependency because it is a
// kilobyte of constant and the whole CLI is otherwise Node's own. Two things
// about its shape are deliberate: the stroke is **two cells wide**, because a
// one-cell stem in a dotted fill reads as noise rather than as a letter, and
// the ink is the dotted block (U+2592) rather than a solid one, which makes a
// thick stroke a screen-print instead of a slab.
//
// A terminal too narrow for the art gets the wordmark on one line. A banner
// that wraps is worse than no banner.
// ---------------------------------------------------------------------------

const HEIGHT = 5;
const WIDTH = 6;

const FONT: Record<string, readonly string[]> = {
    A: [' ▒▒▒▒ ', '▒▒  ▒▒', '▒▒▒▒▒▒', '▒▒  ▒▒', '▒▒  ▒▒'],
    B: ['▒▒▒▒▒ ', '▒▒  ▒▒', '▒▒▒▒▒ ', '▒▒  ▒▒', '▒▒▒▒▒ '],
    C: [' ▒▒▒▒▒', '▒▒    ', '▒▒    ', '▒▒    ', ' ▒▒▒▒▒'],
    D: ['▒▒▒▒▒ ', '▒▒  ▒▒', '▒▒  ▒▒', '▒▒  ▒▒', '▒▒▒▒▒ '],
    E: ['▒▒▒▒▒▒', '▒▒    ', '▒▒▒▒▒ ', '▒▒    ', '▒▒▒▒▒▒'],
    F: ['▒▒▒▒▒▒', '▒▒    ', '▒▒▒▒▒ ', '▒▒    ', '▒▒    '],
    G: [' ▒▒▒▒▒', '▒▒    ', '▒▒ ▒▒▒', '▒▒  ▒▒', ' ▒▒▒▒▒'],
    H: ['▒▒  ▒▒', '▒▒  ▒▒', '▒▒▒▒▒▒', '▒▒  ▒▒', '▒▒  ▒▒'],
    I: ['▒▒▒▒▒▒', '  ▒▒  ', '  ▒▒  ', '  ▒▒  ', '▒▒▒▒▒▒'],
    J: ['▒▒▒▒▒▒', '   ▒▒ ', '   ▒▒ ', '▒▒ ▒▒ ', ' ▒▒▒  '],
    K: ['▒▒  ▒▒', '▒▒ ▒▒ ', '▒▒▒▒  ', '▒▒ ▒▒ ', '▒▒  ▒▒'],
    L: ['▒▒    ', '▒▒    ', '▒▒    ', '▒▒    ', '▒▒▒▒▒▒'],
    M: ['▒▒  ▒▒', '▒▒▒▒▒▒', '▒▒▒▒▒▒', '▒▒  ▒▒', '▒▒  ▒▒'],
    N: ['▒▒  ▒▒', '▒▒▒ ▒▒', '▒▒▒▒▒▒', '▒▒ ▒▒▒', '▒▒  ▒▒'],
    O: [' ▒▒▒▒ ', '▒▒  ▒▒', '▒▒  ▒▒', '▒▒  ▒▒', ' ▒▒▒▒ '],
    P: ['▒▒▒▒▒ ', '▒▒  ▒▒', '▒▒▒▒▒ ', '▒▒    ', '▒▒    '],
    Q: [' ▒▒▒▒ ', '▒▒  ▒▒', '▒▒  ▒▒', '▒▒ ▒▒ ', ' ▒▒ ▒▒'],
    R: ['▒▒▒▒▒ ', '▒▒  ▒▒', '▒▒▒▒▒ ', '▒▒ ▒▒ ', '▒▒  ▒▒'],
    S: [' ▒▒▒▒▒', '▒▒    ', ' ▒▒▒▒ ', '    ▒▒', '▒▒▒▒▒ '],
    T: ['▒▒▒▒▒▒', '  ▒▒  ', '  ▒▒  ', '  ▒▒  ', '  ▒▒  '],
    U: ['▒▒  ▒▒', '▒▒  ▒▒', '▒▒  ▒▒', '▒▒  ▒▒', ' ▒▒▒▒ '],
    V: ['▒▒  ▒▒', '▒▒  ▒▒', '▒▒  ▒▒', ' ▒▒▒▒ ', '  ▒▒  '],
    W: ['▒▒  ▒▒', '▒▒  ▒▒', '▒▒▒▒▒▒', '▒▒▒▒▒▒', '▒▒  ▒▒'],
    X: ['▒▒  ▒▒', ' ▒▒▒▒ ', '  ▒▒  ', ' ▒▒▒▒ ', '▒▒  ▒▒'],
    Y: ['▒▒  ▒▒', ' ▒▒▒▒ ', '  ▒▒  ', '  ▒▒  ', '  ▒▒  '],
    Z: ['▒▒▒▒▒▒', '   ▒▒ ', '  ▒▒  ', ' ▒▒   ', '▒▒▒▒▒▒'],
};

const BLANK = ' '.repeat(WIDTH);

/** One word as five rows of equal length — so two words line up when joined. */
function big(word: string): string[] {
    const rows = new Array<string>(HEIGHT).fill('');
    for (const ch of word.toUpperCase()) {
        const glyph = FONT[ch];
        for (let r = 0; r < HEIGHT; r++) {
            rows[r] += `${glyph?.[r] ?? BLANK} `;
        }
    }
    return rows;
}

/** A wordmark rather than a sentence, so the letters are set apart. */
const spaced = (s: string): string => [...s.toUpperCase()].join(' ');

/** The name, in the brightest thing the terminal has. */
const bright = (s: string): string => styleText(['bold', 'whiteBright'], s);

/** The half that carries the colour. */
const neon = (s: string): string => styleText(['bold', 'magentaBright'], s);

export interface BannerText {
    /** drawn white */
    head: string;
    /** drawn in the neon accent */
    accent: string;
    /** the line underneath, dim */
    subtitle: string;
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
    const width = 2 + head[0].length + Math.max(...accent.map((row) => row.length));
    const foot = `  ${dim(spaced(text.subtitle))}`;

    if (width > columns) {
        return [` ${bright(text.head.toUpperCase())} ${neon(text.accent.toUpperCase())}`, foot];
    }

    const lines: string[] = [];
    for (let r = 0; r < HEIGHT; r++) {
        lines.push(` ${bright(head[r])} ${neon(accent[r])}`);
    }
    lines.push('');
    lines.push(foot);
    return lines;
}

/** Narration, and only for someone watching. */
export function printBanner(text: BannerText): void {
    if (!process.stderr.isTTY) {
        return;
    }
    note('');
    for (const line of bannerLines(text)) {
        note(line);
    }
    note('');
}
