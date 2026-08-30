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
// The font is here rather than pulled in as a dependency because it is nine
// hundred bytes of constant and the whole CLI is otherwise Node's own. The
// stroke is a dotted block (U+2592) rather than a solid one: it reads as a
// screen-print at any font weight, where a solid fill turns to a slab.
// ---------------------------------------------------------------------------

const HEIGHT = 5;
const WIDTH = 5;

const FONT: Record<string, readonly string[]> = {
    A: [' ▒▒▒ ', '▒   ▒', '▒▒▒▒▒', '▒   ▒', '▒   ▒'],
    B: ['▒▒▒▒ ', '▒   ▒', '▒▒▒▒ ', '▒   ▒', '▒▒▒▒ '],
    C: [' ▒▒▒▒', '▒    ', '▒    ', '▒    ', ' ▒▒▒▒'],
    D: ['▒▒▒▒ ', '▒   ▒', '▒   ▒', '▒   ▒', '▒▒▒▒ '],
    E: ['▒▒▒▒▒', '▒    ', '▒▒▒▒ ', '▒    ', '▒▒▒▒▒'],
    F: ['▒▒▒▒▒', '▒    ', '▒▒▒▒ ', '▒    ', '▒    '],
    G: [' ▒▒▒▒', '▒    ', '▒  ▒▒', '▒   ▒', ' ▒▒▒▒'],
    H: ['▒   ▒', '▒   ▒', '▒▒▒▒▒', '▒   ▒', '▒   ▒'],
    I: ['▒▒▒▒▒', '  ▒  ', '  ▒  ', '  ▒  ', '▒▒▒▒▒'],
    J: ['▒▒▒▒▒', '   ▒ ', '   ▒ ', '▒  ▒ ', ' ▒▒  '],
    K: ['▒   ▒', '▒  ▒ ', '▒▒▒  ', '▒  ▒ ', '▒   ▒'],
    L: ['▒    ', '▒    ', '▒    ', '▒    ', '▒▒▒▒▒'],
    M: ['▒   ▒', '▒▒ ▒▒', '▒ ▒ ▒', '▒   ▒', '▒   ▒'],
    N: ['▒   ▒', '▒▒  ▒', '▒ ▒ ▒', '▒  ▒▒', '▒   ▒'],
    O: [' ▒▒▒ ', '▒   ▒', '▒   ▒', '▒   ▒', ' ▒▒▒ '],
    P: ['▒▒▒▒ ', '▒   ▒', '▒▒▒▒ ', '▒    ', '▒    '],
    Q: [' ▒▒▒ ', '▒   ▒', '▒   ▒', '▒  ▒ ', ' ▒▒ ▒'],
    R: ['▒▒▒▒ ', '▒   ▒', '▒▒▒▒ ', '▒  ▒ ', '▒   ▒'],
    S: [' ▒▒▒▒', '▒    ', ' ▒▒▒ ', '    ▒', '▒▒▒▒ '],
    T: ['▒▒▒▒▒', '  ▒  ', '  ▒  ', '  ▒  ', '  ▒  '],
    U: ['▒   ▒', '▒   ▒', '▒   ▒', '▒   ▒', ' ▒▒▒ '],
    V: ['▒   ▒', '▒   ▒', '▒   ▒', ' ▒ ▒ ', '  ▒  '],
    W: ['▒   ▒', '▒   ▒', '▒ ▒ ▒', '▒▒ ▒▒', '▒   ▒'],
    X: ['▒   ▒', ' ▒ ▒ ', '  ▒  ', ' ▒ ▒ ', '▒   ▒'],
    Y: ['▒   ▒', ' ▒ ▒ ', '  ▒  ', '  ▒  ', '  ▒  '],
    Z: ['▒▒▒▒▒', '   ▒ ', '  ▒  ', ' ▒   ', '▒▒▒▒▒'],
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

export function bannerLines(text: BannerText): string[] {
    const head = big(text.head);
    const accent = big(text.accent);
    const lines: string[] = [];
    for (let r = 0; r < HEIGHT; r++) {
        lines.push(` ${bright(head[r])} ${neon(accent[r])}`);
    }
    lines.push('');
    lines.push(`  ${dim(text.subtitle)}`);
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
