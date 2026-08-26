// ---------------------------------------------------------------------------
// Light and dark
//
// A terminal already has a colour scheme, and it is not ours to replace. The
// rule here is to name as few colours as possible and to name them by role:
// the answer is drawn in the terminal's *own* foreground (no colour at all),
// asides are drawn dim, and only the few things that must stand out —
// the person's own turn, the agent name, a warning, an error — take a colour.
//
// That alone fixes most of it. `white` was the bug: it is legible on exactly
// one kind of background, and half the world runs the other kind. What is left
// is the handful of accents that ANSI *does* let a light theme get wrong —
// `cyan` on paper, `gray` on paper — so those swap.
//
// Note what is *not* here: no hex, no 256-colour ramps, no attempt at a brand.
// A palette that ignores the user's scheme is worse on both schemes than one
// that mostly defers to it.
// ---------------------------------------------------------------------------

export type Appearance = 'dark' | 'light';

/** The roles a line can play in the transcript. */
export type Kind = 'you' | 'agent' | 'tool' | 'note' | 'error';

export interface LineStyle {
    /** `undefined` means the terminal's own foreground. */
    readonly color?: string;
    readonly dim?: boolean;
}

export interface Theme {
    readonly appearance: Appearance;
    readonly line: Record<Kind, LineStyle>;
    /** Agent name, prompt caret — the one colour the eye is trained to find. */
    readonly accent: string;
    /** Read-only badge, busy label. */
    readonly warn: string;
    /** Gutters and marks: structure, not content. Always drawn dim. */
    readonly rule?: string;
}

const DARK: Theme = {
    appearance: 'dark',
    line: {
        you: { color: 'cyan' },
        agent: {},
        tool: { color: 'gray', dim: true },
        note: { color: 'cyan', dim: true },
        error: { color: 'red' },
    },
    accent: 'cyan',
    warn: 'yellow',
    rule: 'gray',
};

// On a light background `gray` is bright black — pale grey on white — and
// `cyan` and `yellow` are barely darker than the paper. Dimmed default
// foreground and `blue`/`magenta` are the same information, still legible.
const LIGHT: Theme = {
    appearance: 'light',
    line: {
        you: { color: 'blue' },
        agent: {},
        tool: { dim: true },
        note: { color: 'blue', dim: true },
        error: { color: 'red' },
    },
    accent: 'blue',
    warn: 'magenta',
};

export const THEMES: Record<Appearance, Theme> = { dark: DARK, light: LIGHT };

// ---------------------------------------------------------------------------
// Finding out
//
// Three sources, in order of how much they actually know:
//
//   1. What the user said — `--theme`, then `ZENERA_THEME`. Always wins, and
//      exists because detection can be wrong and nobody should have to argue
//      with a terminal about what colour it is.
//   2. The terminal itself, asked directly (OSC 11). Correct when supported.
//   3. `COLORFGBG`, which a few terminals export and which is stale as often
//      as not, but costs nothing to read.
//
// Failing all three: dark, because that is what most terminals are.
// ---------------------------------------------------------------------------

export type ThemeChoice = Appearance | 'auto';

export function parseChoice(value: string | undefined): ThemeChoice | undefined {
    const v = value?.trim().toLowerCase();
    return v === 'dark' || v === 'light' || v === 'auto' ? v : undefined;
}

export async function resolveTheme(choice?: string): Promise<Theme> {
    const asked = parseChoice(choice) ?? parseChoice(process.env['ZENERA_THEME']) ?? 'auto';
    if (asked !== 'auto') {
        return THEMES[asked];
    }
    return THEMES[(await queryBackground()) ?? fromColorFgBg() ?? 'dark'];
}

/**
 * `COLORFGBG` is `fg;bg` or `fg;<something>;bg`; the background is the last
 * field. Anything non-numeric (notably `default`) tells us nothing.
 */
function fromColorFgBg(): Appearance | undefined {
    const parts = process.env['COLORFGBG']?.split(';');
    const bg = parts?.[parts.length - 1];
    if (bg === undefined || !/^\d+$/.test(bg)) {
        return undefined;
    }
    const n = Number(bg);
    return n === 7 || n >= 9 ? 'light' : 'dark';
}

const QUERY = '\u001b]11;?\u0007';
const REPLY = /\u001b\]11;rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})/i;

/**
 * Ask the terminal for its background colour and read the answer off stdin.
 *
 * This is a conversation with a program that may not be listening, so it is
 * bounded on every axis: raw mode is taken and given back, the listener is
 * removed either way, and a terminal that does not answer costs one timeout
 * and nothing else. Anything the user typed in that window is put back, so
 * the first keystroke of a fast start is not eaten by the handshake.
 */
async function queryBackground(timeoutMs = 120): Promise<Appearance | undefined> {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
        return undefined;
    }

    const wasRaw = stdin.isRaw;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let seen = '';

    return await new Promise<Appearance | undefined>((resolve) => {
        const finish = (result: Appearance | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            stdin.off('data', onData);
            stdin.setRawMode(wasRaw);
            if (!wasRaw) {
                stdin.pause();
            }
            const typed = seen.replace(REPLY, '').replace(/\u001b\\|\u0007/g, '');
            if (typed) {
                stdin.unshift(Buffer.from(typed, 'latin1'));
            }
            resolve(result);
        };

        const onData = (chunk: Buffer): void => {
            seen += chunk.toString('latin1');
            const m = REPLY.exec(seen);
            if (m) {
                finish(appearanceOf(m[1]!, m[2]!, m[3]!));
            } else if (seen.length > 256) {
                finish(undefined);
            }
        };

        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
        timer = setTimeout(() => finish(undefined), timeoutMs);
        timer.unref?.();
        stdout.write(QUERY);
    });
}

/** Components come back as 1–4 hex digits, so each is scaled by its own width. */
function appearanceOf(r: string, g: string, b: string): Appearance {
    const channel = (hex: string): number => parseInt(hex, 16) / (16 ** hex.length - 1);
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.5 ? 'light' : 'dark';
}
