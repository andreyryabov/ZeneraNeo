#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, invokedAs, split } from './args.ts';
import { NEO_BANNER, printBanner } from './banner.ts';
import { ALIASES, COMMANDS, EXTERNAL } from './commands/index.ts';
import { cliManifest, versionOf } from './commands/version.ts';
import { hasExternal, loadExternal } from './external.ts';
import { CliError, EXIT, bold, cyan, dim, fail, note, pad, write } from './term.ts';

/** What the user typed: `zen`, `zn` or `zenera` all arrive here. */
const NAME = invokedAs('zen');

/** Usage lines are written against `zen`. Say them back in the reader's word. */
const spell = (usage: string): string => (NAME === 'zen' ? usage : usage.replace(/^zen\b/, NAME));

// ---------------------------------------------------------------------------
// zen — the command line over `@zenera/core`
//
// A shell, deliberately. Argument parsing, help, version and exit codes are
// settled here so that adding a command is a matter of writing one function and
// naming it in `COMMANDS` — nothing about the frame has to be revisited.
//
// Only the drawing surface has a dependency, and it is behind a dynamic import
// inside `run`. Everything on this path is Node's own, which is why `zen --help`
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
        fail((e as Error).message, `run ${bold(`${NAME} --help`)} for the options`);
        return EXIT.usage;
    }

    const json = Boolean(values.json);

    if (values.version && !parts.name) {
        write(await versionOf(cliManifest));
        return EXIT.ok;
    }

    const name = parts.name ? (ALIASES[parts.name] ?? parts.name) : undefined;
    const command = name ? COMMANDS[name] : undefined;
    const external = name && !command ? EXTERNAL[name] : undefined;

    // Narration, so `--json` and every pipe are untouched by it. A command
    // living in another package brings its own brand, but only once it is
    // actually there — a banner over "not installed" is a claim about nothing.
    if (!json) {
        const brand = external && hasExternal(external) ? external.banner : undefined;
        printBanner(brand ?? NEO_BANNER);
    }

    if (parts.name === 'help') {
        await usage(rest[0]);
        return EXIT.ok;
    }
    if (!name) {
        await usage();
        return values.help ? EXIT.ok : EXIT.usage;
    }

    if (!command && !external) {
        fail(`unknown command "${parts.name}"`, `run ${bold(`${NAME} --help`)} for the list`);
        return EXIT.usage;
    }
    if (values.help) {
        await usage(name);
        return EXIT.ok;
    }

    // `-C` is consumed here so no command ever reads `process.cwd()` itself,
    // and every relative path in every command means the same thing.
    const cwd = resolve(values.directory ?? process.cwd());

    try {
        const one = command ?? (await loadExternal(name, external!));
        await one.run({ args: rest, json, cwd });
        return EXIT.ok;
    } catch (e) {
        if (e instanceof CliError) {
            fail(e.message, e.hint ? spell(e.hint) : undefined);
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

async function usage(name?: string): Promise<void> {
    const resolved = name ? (ALIASES[name] ?? name) : undefined;
    const ext = resolved ? EXTERNAL[resolved] : undefined;
    // Asking for one command's help is already asking for that package, so
    // loading it here costs nothing the reader did not request.
    const one = resolved
        ? (COMMANDS[resolved] ??
          (ext && hasExternal(ext)
              ? await loadExternal(resolved, ext).catch(() => undefined)
              : undefined))
        : undefined;
    if (one) {
        write(bold(spell(one.usage)));
        write(`\n  ${one.summary}`);
        if (ext) {
            write(`\n  ${dim(`Provided by ${cyan(ext.package)}.`)}`);
        }
        if (one.details?.length) {
            write('');
            for (const line of one.details) {
                write(line ? `  ${line}` : '');
            }
        }
        return;
    }

    // Not installed: the table is all there is to say, and it is enough.
    if (ext) {
        write(bold(spell(ext.usage)));
        write(`\n  ${ext.summary}`);
        write(`\n  ${dim(`Provided by ${cyan(ext.package)} — run ${cyan(ext.install)}.`)}`);
        return;
    }

    write(`${bold(NAME)} ${dim('— run agent projects from the command line')}`);
    write(`\n${bold('Usage')}\n  ${NAME} <command> [options]`);
    write(`\n${bold('Commands')}`);
    const names = [...Object.keys(COMMANDS), ...Object.keys(EXTERNAL)];
    const width = Math.max(...names.map((k) => k.length));
    for (const [key, cmd] of Object.entries(COMMANDS)) {
        write(`  ${pad(key, width)}  ${dim(cmd.summary)}`);
    }
    for (const [key, ext] of Object.entries(EXTERNAL)) {
        const tail = hasExternal(ext) ? '' : dim(` (${ext.install})`);
        write(`  ${pad(key, width)}  ${dim(ext.summary)}${tail}`);
    }
    write(`\n${bold('Options')}`);
    write(`  -h, --help          ${dim('This, or a command’s own.')}`);
    write(`  -v, --version       ${dim('Print the version.')}`);
    write(`      --json          ${dim('Machine-readable output.')}`);
    write(`  -C, --directory <d> ${dim('Act as if run in <d>.')}`);
    write(`\n${dim(`Start with ${cyan(`${NAME} init`)}, then ${cyan(`${NAME} run`)}.`)}`);
}

process.exitCode = await main(process.argv.slice(2));
