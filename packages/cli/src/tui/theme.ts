// ---------------------------------------------------------------------------
// Light and dark
//
// A terminal already has a colour scheme, and it is not ours to replace. The
// rule here is to name as few colours as possible and to name them by role:
// the answer is drawn in the terminal's *own* foreground (no colour at all),
// and only the few things that must stand out — the person's own turn, the
// agent name, what it is reasoning about, a warning, an error — take a colour.
//
// That alone fixes most of it. `white` was the bug: it is legible on exactly
// one kind of background, and half the world runs the other kind. `gray` was
// the same bug wearing a hat — bright black, dimmed again, is a step from
// unreadable on dark and invisible on paper. What is left is the handful of
// accents that ANSI *does* let a light theme get wrong, so those swap.
//
// A second weight is spent on *chrome* and on the machinery: box rules,
// clocks, the footer's numbers, and the call rows that say how an answer was
// arrived at. What the agent actually said is drawn at full weight in the
// terminal's own foreground, so a transcript read top to bottom reads as prose
// with the work annotated beside it — not as one undifferentiated wall.
//
// That weight used to be SGR 2 (`dim`), and it was the third version of the
// same bug. `dim` is not a colour, it is an instruction, and how far it is
// obeyed is the terminal's business: iTerm2 takes a step, Apple Terminal
// blends most of the way to the background. On Terminal.app the entire margin
// — every rule, every call row, every number — went out with it.
//
// So there is exactly one ramp here, `chrome`, and it is a stated grey rather
// than an attribute. It is the only number in the file, and it buys the one
// thing deference cannot: a floor under the quiet half of the screen.
// Everything else is still named by role and still defers to the user's own
// scheme — no brand, no second hue, no 256-colour palette.
// ---------------------------------------------------------------------------

import { appearance, CHROME, type Appearance } from '../term.ts';

export type { Appearance };

/**
 * The roles a line can play in the transcript.
 *
 * `text` is what the agent said on its way somewhere — prose between one batch
 * of calls and the next — and `agent` is the answer it finished on, which is
 * the only one that gets a box. Reasoning is not among them: it is progress,
 * and progress that has finished is worth no rows at all.
 */
export type Kind = 'you' | 'text' | 'agent' | 'tool' | 'note' | 'error';

export interface LineStyle {
    /** `undefined` means the terminal's own foreground. */
    readonly color?: string;
}

export interface Theme {
    readonly appearance: Appearance;
    readonly line: Record<Kind, LineStyle>;
    /** Agent name, prompt caret — the one colour the eye is trained to find. */
    readonly accent: string;
    /** Read-only badge, busy label. */
    readonly warn: string;
    /**
     * Box rules, clocks, the footer's numbers, the call rows. One step quieter
     * than the prose and never two — stated as a grey because `dim` is a
     * request the terminal is free to over-honour, and some do.
     */
    readonly chrome: LineStyle;
    /**
     * Reasoning. It is not a tool call and it is not the answer, and drawn in
     * the same grey as the rows around it there was nothing to say which — a
     * wall of one weight reads as one thing. Its own hue is what separates the
     * model's thinking from the work it went on to do.
     */
    readonly thinking: LineStyle;
    /**
     * Inline code inside prose — `zen check`, `--theme`, a path.
     *
     * The one role added for markdown, and it is added because the alternative
     * is worse: bold is already what `**strong**` means, and grey would say a
     * command name matters less than the sentence around it when it is usually
     * the only part worth copying. A hue says *this is literal* without
     * ranking it.
     */
    readonly code: LineStyle;
    /**
     * The three things a turn spends time on. One word in the footer says which,
     * and it is read at a glance from across a desk — so the word changing is
     * backed by the colour changing, not left to be spelled out.
     */
    readonly phase: Record<'reasoning' | 'waiting' | 'working', string>;
    /**
     * Branch colours, cycled in order of first sight. A fan-out is the one
     * place where colour carries information rather than decoration: eight
     * branches reporting at once are only separable if they are told apart.
     */
    readonly lanes: readonly string[];
}

// The two greys, shared with every one-shot command so a `zen check` table and
// a TUI call row are the same weight. Chalk steps them down for a 16-colour
// terminal, which is the only place the old `gray` problem is still reachable.
const DARK_CHROME: LineStyle = { color: `ansi256(${CHROME.dark})` };
const LIGHT_CHROME: LineStyle = { color: `ansi256(${CHROME.light})` };

const DARK: Theme = {
    appearance: 'dark',
    line: {
        you: { color: 'cyan' },
        text: {},
        agent: {},
        // A call is the machinery, not the work: the transcript is read for
        // what the agent said, and the rows saying how it found out are a
        // margin note beside that.
        tool: DARK_CHROME,
        note: { color: 'cyan' },
        error: { color: 'red' },
    },
    accent: 'cyan',
    warn: 'yellow',
    chrome: DARK_CHROME,
    // Bright: the gist is one line among many and plain `magenta` on black is
    // the darkest of the six.
    thinking: { color: 'magentaBright' },
    // Green is the one hue with no other job here: it is not the accent, not
    // the warning, and not the thinking.
    code: { color: 'green' },
    phase: { reasoning: 'magenta', waiting: 'yellow', working: 'cyan' },
    lanes: ['cyan', 'green', 'yellow', 'blue', 'red', 'magenta'],
};

// On a light background `cyan` and `yellow` are barely darker than the paper.
// Grey and `blue`/`magenta` are the same information, still legible.
const LIGHT: Theme = {
    appearance: 'light',
    line: {
        you: { color: 'blue' },
        text: {},
        agent: {},
        tool: LIGHT_CHROME,
        note: { color: 'blue' },
        error: { color: 'red' },
    },
    accent: 'blue',
    warn: 'magenta',
    chrome: LIGHT_CHROME,
    thinking: { color: 'magenta' },
    code: { color: 'green' },
    // No yellow: `waiting` takes blue and `working` green, which are the two
    // that survive paper.
    phase: { reasoning: 'magenta', waiting: 'blue', working: 'green' },
    // No cyan or yellow: on paper they are barely darker than the paper.
    lanes: ['blue', 'green', 'red', 'magenta'],
};

export const THEMES: Record<Appearance, Theme> = { dark: DARK, light: LIGHT };

// ---------------------------------------------------------------------------
// Finding out
//
// Two sources, in this order:
//
//   1. What the user said — `--theme`, then `ZENERA_THEME`. Always wins, and
//      exists because detection can be wrong and nobody should have to argue
//      with a terminal about what colour it is.
//   2. The terminal itself, asked directly (OSC 11). Correct when supported,
//      and worth the round trip here in a way it is not for a command that
//      prints four lines and exits.
//
// Failing both: whatever `term.ts` can work out without asking.
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
    return THEMES[(await queryBackground()) ?? appearance()];
}

// The DA1 behind the colour query is what makes the answer conclusive. Every
// terminal replies to DA1, and none replies to it ahead of an OSC 11 it
// supports — so a DA1 arriving alone means "I do not do that", known in one
// round trip instead of guessed at the end of a timeout. What is left for the
// timeout is the terminal that answers neither, which is the only case worth
// waiting on and now the only one that does.
const QUERY = '\u001b]11;?\u0007\u001b[c';
const REPLY = /\u001b\]11;rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})/i;
const DA1 = /\u001b\[\?[\d;]*c/;

/**
 * Ask the terminal for its background colour and read the answer off stdin.
 *
 * This is a conversation with a program that may not be listening, so it is
 * bounded on every axis: raw mode is taken and given back, the listener is
 * removed either way, and a terminal that does not answer costs one timeout
 * and nothing else. Anything the user typed in that window is put back, so
 * the first keystroke of a fast start is not eaten by the handshake.
 */
async function queryBackground(timeoutMs = 300): Promise<Appearance | undefined> {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
        return undefined;
    }

    const wasRaw = stdin.isRaw;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let seen = '';
    let found: Appearance | undefined;

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
            const typed = seen
                .replace(REPLY, '')
                .replace(DA1, '')
                .replace(/\u001b\\|\u0007/g, '');
            if (typed) {
                stdin.unshift(Buffer.from(typed, 'latin1'));
            }
            resolve(result);
        };

        // The DA1 is sent second and answered second, so it is the end of the
        // conversation whether or not the colour came back. Settling on the
        // colour alone leaves the DA1 in the pipe, and it surfaces a moment
        // later as `[?64;1;2;...c` typed into the prompt.
        const onData = (chunk: Buffer): void => {
            seen += chunk.toString('latin1');
            const m = REPLY.exec(seen);
            if (m) {
                found = appearanceOf(m[1]!, m[2]!, m[3]!);
            }
            if (DA1.test(seen) || seen.length > 256) {
                finish(found);
            }
        };

        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
        timer = setTimeout(() => finish(found), timeoutMs);
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
