// ---------------------------------------------------------------------------
// The command contract
//
// A command receives its own arguments, already stripped of the name, and the
// two things the frame settled before dispatching: whether output should be
// machine-readable, and which directory the whole invocation is relative to.
//
// It returns nothing. Success is the absence of a throw; every failure worth
// distinguishing is a `CliError` carrying its exit code.
// ---------------------------------------------------------------------------

export interface Context {
    readonly args: readonly string[];
    readonly json: boolean;
    /** honours `-C <dir>`, so nothing below reads `process.cwd()` directly */
    readonly cwd: string;
}

export interface Command {
    readonly summary: string;
    readonly usage: string;
    /** lines printed under the usage line by `zn help <command>` */
    readonly details?: readonly string[];
    run(ctx: Context): Promise<void>;
}
