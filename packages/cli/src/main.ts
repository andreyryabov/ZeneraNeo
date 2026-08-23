#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs, styleText } from 'node:util';

// ---------------------------------------------------------------------------
// zenera — the command line over `zenera-neo`
//
// A shell, deliberately. Argument parsing, help, version and exit codes are
// settled here so that adding a command later is a matter of writing one
// function and naming it in `COMMANDS` — nothing about the frame has to be
// revisited.
//
// It has no dependencies of its own and is not going to grow any: `parseArgs`
// and `styleText` are Node's, which is the whole reason the CLI can ship beside
// the library without adding weight to it.
// ---------------------------------------------------------------------------

/** What a command receives: its own arguments, already stripped of the name. */
interface Context {
    readonly args: readonly string[];
    readonly json: boolean;
}

interface Command {
    readonly summary: string;
    readonly usage: string;
    run(ctx: Context): Promise<void>;
}

const COMMANDS: Record<string, Command> = {
    version: {
        summary: 'Print the CLI and library versions.',
        usage: 'zenera version',
        run: async ({ json }) => {
            const versions = {
                cli: await version(new URL('../package.json', import.meta.url)),
                'zenera-neo': await version(libraryManifest()),
                node: process.versions.node,
            };
            if (json) {
                write(JSON.stringify(versions));
                return;
            }
            const width = Math.max(...Object.keys(versions).map((k) => k.length));
            for (const [name, value] of Object.entries(versions)) {
                write(`${dim(name.padEnd(width))}  ${value}`);
            }
        },
    },
};

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * Exit codes, so a script can tell the three failures apart: the run went
 * wrong, or the invocation did, or the project it was pointed at is not valid.
 */
const EXIT = { ok: 0, failed: 1, usage: 2, invalid: 3 } as const;

/** Every command shares these; a command's own flags are parsed by the command. */
const GLOBAL = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
} as const;

async function main(argv: readonly string[]): Promise<number> {
    let parsed;
    try {
        // `strict: false` because everything after the command name belongs to
        // the command, and the frame has no business rejecting it.
        parsed = parseArgs({
            args: [...argv],
            options: GLOBAL,
            strict: false,
            allowPositionals: true,
        });
    } catch (e) {
        fail((e as Error).message);
        return EXIT.usage;
    }

    const { values, positionals } = parsed;
    const [name, ...rest] = positionals;

    if (values.version && !name) {
        write(await version(new URL('../package.json', import.meta.url)));
        return EXIT.ok;
    }
    if (!name || values.help) {
        usage(typeof name === 'string' ? name : undefined);
        return name && !values.help ? EXIT.usage : EXIT.ok;
    }

    const command = COMMANDS[name];
    if (!command) {
        fail(`unknown command "${name}"`);
        write(`\nRun ${bold('zenera --help')} for the list.`);
        return EXIT.usage;
    }

    try {
        await command.run({ args: rest.map(String), json: Boolean(values.json) });
        return EXIT.ok;
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return EXIT.failed;
    }
}

/** The whole help text, or one command's, when a name is given. */
function usage(name?: string): void {
    const one = name ? COMMANDS[name] : undefined;
    if (one) {
        write(`${bold(one.usage)}\n\n  ${one.summary}`);
        return;
    }

    write(bold('zenera') + dim(' — run agent projects from the command line'));
    write(`\n${bold('Usage')}\n  zenera <command> [options]`);
    write(`\n${bold('Commands')}`);
    const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
    for (const [key, cmd] of Object.entries(COMMANDS)) {
        write(`  ${key.padEnd(width)}  ${dim(cmd.summary)}`);
    }
    write(`\n${bold('Options')}`);
    write(`  -h, --help     ${dim('Show this help, or a command’s.')}`);
    write(`  -v, --version  ${dim('Print the version.')}`);
    write(`      --json     ${dim('Machine-readable output.')}`);
}

/** A package's version, read from its manifest rather than inlined at build time. */
async function version(manifest: URL): Promise<string> {
    const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    return version;
}

/**
 * Where the library actually resolved from — the workspace symlink in
 * development, `node_modules` once installed. Going through its `exports` map
 * rather than a guessed path means this also fails loudly if that map is ever
 * broken, which is the one packaging mistake nothing else catches.
 */
function libraryManifest(): URL {
    const resolve = createRequire(import.meta.url).resolve;
    return new URL(`file://${resolve('zenera-neo/package.json')}`);
}

// ---------------------------------------------------------------------------
// Output
//
// `styleText` no-ops when stdout is not a tty and honours NO_COLOR itself, so
// there is no flag to thread through and no piped output to garble.
// ---------------------------------------------------------------------------

const bold = (s: string): string => styleText('bold', s);
const dim = (s: string): string => styleText('dim', s);

function write(line: string): void {
    process.stdout.write(`${line}\n`);
}

function fail(message: string): void {
    process.stderr.write(`${styleText('red', 'error')} ${message}\n`);
}

process.exitCode = await main(process.argv.slice(2));
