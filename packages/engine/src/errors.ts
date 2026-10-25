// ---------------------------------------------------------------------------
// Errors and warnings
//
// The engine runs under a terminal and under a server, so it never prints and
// never exits. An error carries a code a CLI turns into an exit status and a
// server turns into an HTTP status; a warning goes to whatever `Logger` the
// host handed in.
// ---------------------------------------------------------------------------

export const EXIT = {
    ok: 0,
    failed: 1,
    usage: 2,
    invalid: 3,
    credentials: 4,
    sandbox: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that already knows what it means. Anything else reaching the top is
 * a bug, which is the distinction a caller needs: a wrong request and a wrong
 * answer are not the same failure.
 */
export class EngineError extends Error {
    readonly code: ExitCode;
    readonly hint?: string;

    constructor(message: string, code: ExitCode = EXIT.failed, hint?: string) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
        this.hint = hint;
    }
}

export const usageError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.usage, hint);
export const invalidError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.invalid, hint);
export const credentialError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.credentials, hint);

export interface Logger {
    warn(message: string): void;
}

/** Plain lines on stderr, for a host that did not say where warnings go. */
export const stderrLogger: Logger = {
    warn: (message) => {
        process.stderr.write(`warning ${message}\n`);
    },
};
