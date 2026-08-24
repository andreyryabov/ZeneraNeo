#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, split } from './args.ts';
import { ALIASES, COMMANDS } from './commands/index.ts';
import { cliManifest, versionOf } from './commands/version.ts';
import { CliError, EXIT, bold, cyan, dim, fail, note, pad, write } from './term.ts';

// ---------------------------------------------------------------------------
// zn — the command line over `zenera-neo`
//
// A shell, deliberately. Argument parsing, help, version and exit codes are
// settled here so that adding a command is a matter of writing one function and
// naming it in `COMMANDS` — nothing about the frame has to be revisited.
//
// Only the drawing surface has a dependency, and it is behind a dynamic import
// inside `run`. Everything on this path is Node's own, which is why `zn --help`
// starts instantly and why the CLI adds no weight to the library.
// ---------------------------------------------------------------------------

const GLOBAL = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    // Uppercase, like make, tar and git: it changes where the command applies,
    // not what it does.
    directory: { type: 'string', short: 'C' },
} as const;

async function main(argv: readonly string[]): Promise<number> {
    const parts = split(argv);
    const { rest, global } = extract(parts.after);

    let values;
    try {
        values = parseArgs({
            args: [...parts.before, ...global],
            options: GLOBAL,
            strict: true,
            allowPositionals: false,
        }).values;
    } catch (e) {
        fail((e as Error).message, `run ${bold('zn --help')} for the options`);
        return EXIT.usage;
    }

    const json = Boolean(values.json);

    if (values.version && !parts.name) {
        write(await versionOf(cliManifest));
        return EXIT.ok;
    }
    if (parts.name === 'help') {
        usage(rest[0]);
        return EXIT.ok;
    }
    if (!parts.name) {
        usage();
        return values.help ? EXIT.ok : EXIT.usage;
    }

    const name = ALIASES[parts.name] ?? parts.name;
    const command = COMMANDS[name];
    if (!command) {
        fail(`unknown command "${parts.name}"`, `run ${bold('zn --help')} for the list`);
        return EXIT.usage;
    }
    if (values.help) {
        usage(name);
        return EXIT.ok;
    }

    // `-C` is consumed here so no command ever reads `process.cwd()` itself,
    // and every relative path in every command means the same thing.
    const cwd = resolve(values.directory ?? process.cwd());

    try {
        await command.run({ args: rest, json, cwd });
        return EXIT.ok;
    } catch (e) {
        if (e instanceof CliError) {
            fail(e.message, e.hint);
            return e.code;
        }
        fail(e instanceof Error ? e.message : String(e));
        if (process.env.ZENERA_DEBUG && e instanceof Error && e.stack) {
            note(dim(e.stack));
        }
        return EXIT.failed;
    }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function usage(name?: string): void {
    const one = name ? COMMANDS[ALIASES[name] ?? name] : undefined;
    if (one) {
        write(bold(one.usage));
        write(`\n  ${one.summary}`);
        if (one.details?.length) {
            write('');
            for (const line of one.details) {
                write(line ? `  ${line}` : '');
            }
        }
        return;
    }

    write(`${bold('zn')} ${dim('— run agent projects from the command line')}`);
    write(`\n${bold('Usage')}\n  zn <command> [options]`);
    write(`\n${bold('Commands')}`);
    const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
    for (const [key, cmd] of Object.entries(COMMANDS)) {
        write(`  ${pad(key, width)}  ${dim(cmd.summary)}`);
    }
    write(`\n${bold('Options')}`);
    write(`  -h, --help          ${dim('This, or a command’s own.')}`);
    write(`  -v, --version       ${dim('Print the version.')}`);
    write(`      --json          ${dim('Machine-readable output.')}`);
    write(`  -C, --directory <d> ${dim('Act as if run in <d>.')}`);
    write(`\n${dim(`Start with ${cyan('zn init')}, then ${cyan('zn run')}.`)}`);
}

process.exitCode = await main(process.argv.slice(2));
