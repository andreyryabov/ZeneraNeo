import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';

// ---------------------------------------------------------------------------
// Terminal I/O
//
// One rule decides where everything goes: **stdout is the answer, stderr is the
// narration.** Prompts, progress, warnings and errors are narration, so a
// pipeline that only wants the answer gets exactly that and nothing else.
//
// `styleText` no-ops when the stream is not a tty and honours NO_COLOR itself,
// so there is no flag to thread through and no piped output to garble.
// ---------------------------------------------------------------------------

export const EXIT = { ok: 0, failed: 1, usage: 2, invalid: 3, credentials: 4 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that already knows what it means. Anything else reaching the top is
 * a bug and exits `failed`, which is the distinction a script needs: a wrong
 * invocation and a wrong answer are not the same failure.
 */
export class CliError extends Error {
    readonly code: ExitCode;
    readonly hint?: string;

    constructor(message: string, code: ExitCode = EXIT.failed, hint?: string) {
        super(message);
        this.name = 'CliError';
        this.code = code;
        this.hint = hint;
    }
}

export const usageError = (m: string, hint?: string): CliError => new CliError(m, EXIT.usage, hint);
export const invalidError = (m: string, hint?: string): CliError =>
    new CliError(m, EXIT.invalid, hint);
export const credentialError = (m: string, hint?: string): CliError =>
    new CliError(m, EXIT.credentials, hint);

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

export const bold = (s: string): string => styleText('bold', s);
export const dim = (s: string): string => styleText('dim', s);
export const red = (s: string): string => styleText('red', s);
export const green = (s: string): string => styleText('green', s);
export const yellow = (s: string): string => styleText('yellow', s);
export const cyan = (s: string): string => styleText('cyan', s);

/** Visible width — style codes must not count towards column alignment. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const width = (s: string): string => s.replace(ANSI, '');

export function pad(s: string, to: number): string {
    return s + ' '.repeat(Math.max(0, to - width(s).length));
}

/** Column-aligned rows. Trailing whitespace is trimmed so `diff` stays quiet. */
export function table(rows: readonly (readonly string[])[], gap = 2): string[] {
    if (rows.length === 0) {
        return [];
    }
    const columns = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (let c = 0; c < columns; c++) {
        widths[c] = Math.max(...rows.map((r) => width(r[c] ?? '').length));
    }
    return rows.map((r) =>
        r
            .map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c])))
            .join(' '.repeat(gap))
            .trimEnd(),
    );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function write(line = ''): void {
    process.stdout.write(`${line}\n`);
}

export function writeAll(lines: readonly string[]): void {
    for (const l of lines) {
        write(l);
    }
}

/** Machine-readable output. Pretty-printed: it is read by people too. */
export function json(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function note(line = ''): void {
    process.stderr.write(`${line}\n`);
}

export function warn(message: string): void {
    note(`${yellow('warning')} ${message}`);
}

export function fail(message: string, hint?: string): void {
    note(`${red('error')} ${message}`);
    if (hint) {
        note(`        ${dim(hint)}`);
    }
}

// ---------------------------------------------------------------------------
// Asking
//
// Every prompt below refuses to run without a terminal rather than blocking on
// a stdin that will never answer. A CLI that hangs in CI is worse than one that
// fails in CI, because only one of the two tells you which flag you forgot.
// ---------------------------------------------------------------------------

export function isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function requireTty(what: string, flag: string): void {
    if (!isInteractive()) {
        throw usageError(`cannot ask for ${what} without a terminal`, `pass ${flag} instead`);
    }
}

export async function ask(question: string, fallback?: string): Promise<string> {
    requireTty(question, '--yes or the matching flag');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const suffix = fallback ? dim(` [${fallback}]`) : '';
        const answer = (await rl.question(`${question}${suffix} `)).trim();
        return answer || fallback || '';
    } finally {
        rl.close();
    }
}

/**
 * Reads without echoing. `readline` writes what you type through its `output`
 * stream, so the interface is built without one — there is then nothing for it
 * to echo to, and no window in which the secret is on screen.
 */
export async function askSecret(question: string): Promise<string> {
    requireTty('a secret', 'a piped value on stdin');
    process.stderr.write(`${question} `);
    const rl = createInterface({ input: process.stdin, terminal: true });
    try {
        const answer = await rl.question('');
        return answer.trim();
    } finally {
        rl.close();
        process.stderr.write('\n');
    }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
    requireTty(question, '--yes');
    const answer = await ask(`${question} ${dim(fallback ? '(Y/n)' : '(y/N)')}`, '');
    if (!answer) {
        return fallback;
    }
    return /^y(es)?$/i.test(answer);
}

export interface Choice<T> {
    label: string;
    detail?: string;
    value: T;
}

/** A numbered list. The pretty picker is the TUI's; this is the fallback. */
export async function choose<T>(title: string, choices: readonly Choice<T>[]): Promise<T> {
    if (choices.length === 0) {
        throw usageError(`nothing to choose from: ${title}`);
    }
    if (choices.length === 1) {
        return choices[0].value;
    }
    requireTty(title, 'the matching flag');
    note(bold(title));
    const rows = choices.map((c, i) => [`  ${dim(`${i + 1}.`)}`, c.label, dim(c.detail ?? '')]);
    for (const line of table(rows)) {
        note(line);
    }
    for (;;) {
        const answer = await ask('Choose', '1');
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
            return choices[n - 1].value;
        }
        note(dim(`Enter a number between 1 and ${choices.length}.`));
    }
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/** Piped input, or undefined when stdin is a terminal (i.e. nobody piped). */
export async function readStdin(): Promise<string | undefined> {
    if (process.stdin.isTTY) {
        return undefined;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text || undefined;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by several commands
// ---------------------------------------------------------------------------

export function ago(iso: string | undefined): string {
    if (!iso) {
        return 'never';
    }
    const then = Date.parse(iso);
    if (Number.isNaN(then)) {
        return 'unknown';
    }
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    const scale: [number, string][] = [
        [31536000, 'y'],
        [86400, 'd'],
        [3600, 'h'],
        [60, 'm'],
    ];
    for (const [size, unit] of scale) {
        if (seconds >= size) {
            return `${Math.floor(seconds / size)}${unit} ago`;
        }
    }
    return seconds < 5 ? 'just now' : `${seconds}s ago`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
    return `${n} ${n === 1 ? singular : plural}`;
}
