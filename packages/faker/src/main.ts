#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
    bold,
    CliError,
    cyan,
    dim,
    EXIT,
    fail,
    green,
    invokedAs,
    json,
    note,
    ownedContainers,
    parse,
    paths,
    printBanner,
    red,
    removeContainers,
    split,
    table,
    usageError,
    write,
    writeAll,
    yellow,
    type BannerText,
} from 'zenera-cli/lib';
import { GENERATORS } from './box.ts';
import { reason } from './generate.ts';
import { listen } from './server.ts';
import { open, type Setup } from './setup.ts';
import { SpecError, type Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// zfake — a mock API from a specification
//
// A separate binary rather than a `zen` subcommand. `zen` runs agent projects
// and everything in it is shaped by that; this is a server, it stays up, and
// the only thing the two genuinely share is where credentials live. Putting it
// under `zen` would have meant one command that means two different things.
// ---------------------------------------------------------------------------

/** What the user typed: `zfake`, `zen-fake`, `zen-faker` or `zenera-fake`. */
const NAME = invokedAs('zfake');

const USAGE = `${NAME} <serve|build|cache> [spec...] [options]`;

const BANNER: BannerText = {
    head: 'Zenera',
    accent: 'Faker',
    subtitle: 'Mock API Server',
};

interface Flags {
    port?: string;
    host?: string;
    model?: string;
    image?: string;
    cache?: string;
    attempts?: string;
    concurrency?: string;
    seed?: string;
    timeout?: string;
    'max-body'?: string;
    rebuild?: boolean;
    'no-cache'?: boolean;
    quiet?: boolean;
    json?: boolean;
}

const OPTIONS = {
    port: { type: 'string' },
    host: { type: 'string' },
    model: { type: 'string' },
    image: { type: 'string' },
    cache: { type: 'string' },
    attempts: { type: 'string' },
    concurrency: { type: 'string' },
    seed: { type: 'string' },
    timeout: { type: 'string' },
    'max-body': { type: 'string' },
    rebuild: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    quiet: { type: 'boolean' },
    json: { type: 'boolean' },
} as const;

async function main(argv: readonly string[]): Promise<number> {
    const { name, after } = split(argv);
    if (!name || name === 'help' || name === '--help' || name === '-h') {
        usage();
        return name ? EXIT.ok : EXIT.usage;
    }

    try {
        switch (name) {
            case 'serve':
                return await serve(after);
            case 'build':
                return await warm(after);
            case 'cache':
                return await cache(after);
            default:
                throw usageError(`unknown command "${name}"`, USAGE);
        }
    } catch (err) {
        if (err instanceof CliError) {
            fail(err.message, err.hint);
            return err.code;
        }
        if (err instanceof SpecError) {
            fail(err.message, err.hint);
            return EXIT.invalid;
        }
        fail(err instanceof Error ? err.message : String(err));
        return EXIT.failed;
    }
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(args: readonly string[]): Promise<number> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, `${NAME} serve <spec...>`);
    const loud = !values.quiet && !values.json;
    if (loud) {
        printBanner(BANNER);
    }
    const setup = await start(values, positionals, 'serve');
    if (loud) {
        printSpecs(setup.router.operations);
    }

    const host = values.host ?? '127.0.0.1';
    const listener = await listen(
        {
            router: setup.router,
            cache: setup.cache,
            checks: setup.checks,
            box: setup.box,
            seed: number(values.seed, 'seed'),
            maxBody: number(values['max-body'], 'max-body'),
            onRequest: values.quiet ? undefined : (line) => note(dim(line)),
        },
        host,
        number(values.port, 'port') ?? 8787,
    );

    if (!values.quiet) {
        note(
            `${green('listening')} ${cyan(`http://${host}:${listener.port}`)} ` +
                dim(`${setup.router.operations.length} operations`),
        );
        if (host !== '127.0.0.1' && host !== 'localhost') {
            note(yellow(`bound to ${host} — this mock is reachable from the network`));
        }
        note(dim(`generators: ${setup.root}/${GENERATORS}`));
    }
    // The address is the answer; the rest was narration.
    write(`http://${host}:${listener.port}`);

    await until(['SIGINT', 'SIGTERM']);
    if (!values.quiet) {
        note(dim('stopping'));
    }
    await listener.close();
    await setup.close();
    return EXIT.ok;
}

/** Resolves when one of the signals arrives, and stops listening for them. */
function until(signals: readonly NodeJS.Signals[]): Promise<void> {
    return new Promise<void>((settle) => {
        const done = (): void => {
            for (const s of signals) {
                process.off(s, done);
            }
            settle();
        };
        for (const s of signals) {
            process.once(s, done);
        }
    });
}

// ---------------------------------------------------------------------------
// build — every generator, up front
// ---------------------------------------------------------------------------

async function warm(args: readonly string[]): Promise<number> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, `${NAME} build <spec...>`);
    const loud = !values.quiet && !values.json;
    if (loud) {
        printBanner(BANNER);
    }
    const setup = await start(values, positionals, 'build');
    if (loud) {
        printSpecs(setup.router.operations);
    }

    const results: { operation: string; status: string; detail?: string }[] = [];
    try {
        for (const operation of setup.router.operations) {
            const id = `${operation.method.toUpperCase()} ${operation.path}`;
            if (!operation.success.schema) {
                results.push({ operation: id, status: 'skipped', detail: 'no response body' });
                continue;
            }
            try {
                const generator = await setup.cache.ensure(operation);
                results.push({ operation: id, status: generator.cached ? 'cached' : 'built' });
            } catch (err) {
                results.push({
                    operation: id,
                    status: 'failed',
                    detail: reason(err),
                });
            }
        }
    } finally {
        await setup.close();
    }

    if (values.json) {
        json(results);
    } else {
        writeAll(
            table(
                results.map((r) => [
                    `  ${mark(r.status)}`,
                    r.operation,
                    dim(r.detail?.slice(0, 100) ?? ''),
                ]),
            ),
        );
    }
    return results.some((r) => r.status === 'failed') ? EXIT.failed : EXIT.ok;
}

const mark = (status: string): string =>
    status === 'failed' ? red('failed') : status === 'skipped' ? dim('skipped') : green(status);

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

async function cache(args: readonly string[]): Promise<number> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, `${NAME} cache <ls|clear>`);
    const root = values.cache ?? paths.faker();
    const sub = positionals[0] ?? 'ls';

    if (sub === 'ls') {
        const entries = await listGenerators(root);
        if (values.json) {
            json(entries);
            return EXIT.ok;
        }
        if (entries.length === 0) {
            note('nothing cached yet');
            return EXIT.ok;
        }
        writeAll(
            table([
                [bold('KEY'), bold('OPERATION'), bold('MODEL'), bold('TRIES')],
                ...entries.map((e) => [
                    e.key,
                    `${e.method?.toUpperCase() ?? '?'} ${e.path ?? ''}`,
                    dim(e.model ?? '—'),
                    dim(String(e.attempts ?? '—')),
                ]),
            ]),
        );
        return EXIT.ok;
    }

    if (sub === 'clear') {
        rmSync(join(root, GENERATORS), { recursive: true, force: true });
        // The container is named after its configuration, so a stale one would
        // otherwise sit there stopped forever with nothing pointing at it.
        // `zn-<key>-<digest>` is the shape, and this one's key is `faker`.
        const mine = (await ownedContainers()).filter((c) => c.name.startsWith('zn-faker-'));
        if (mine.length > 0) {
            await removeContainers(mine.map((c) => c.name));
        }
        note(`${green('cleared')} ${dim(root)}`);
        return EXIT.ok;
    }

    throw usageError(`unknown cache command "${sub}"`, `${NAME} cache <ls|clear>`);
}

interface Meta {
    key: string;
    method?: string;
    path?: string;
    model?: string;
    attempts?: number;
}

async function listGenerators(root: string): Promise<Meta[]> {
    let keys: string[];
    try {
        keys = await readdir(join(root, GENERATORS));
    } catch {
        return [];
    }
    const out: Meta[] = [];
    for (const key of keys.sort()) {
        try {
            const meta = JSON.parse(
                await readFile(join(root, GENERATORS, key, 'meta.json'), 'utf8'),
            );
            out.push({ key, ...meta });
        } catch {
            out.push({ key });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// What was loaded
//
// One row per document named on the argv, because that is the unit the user
// typed. `methods` is the operations in it; `functions` is how many of those
// need a generator written for them — an operation answering with no body is
// served without ever asking a model, and the difference between the two
// numbers is the size of the job ahead.
// ---------------------------------------------------------------------------

interface SpecStat {
    source: string;
    paths: Set<string>;
    methods: number;
    functions: number;
}

function summarize(operations: readonly Operation[]): SpecStat[] {
    const by = new Map<string, SpecStat>();
    for (const op of operations) {
        let stat = by.get(op.source);
        if (!stat) {
            stat = { source: op.source, paths: new Set(), methods: 0, functions: 0 };
            by.set(op.source, stat);
        }
        stat.paths.add(op.path);
        stat.methods += 1;
        if (op.success.schema) {
            stat.functions += 1;
        }
    }
    return [...by.values()];
}

const HEADERS = ['PATHS', 'METHODS', 'FUNCTIONS'] as const;

function printSpecs(operations: readonly Operation[]): void {
    const stats = summarize(operations);
    const rows = stats.map((s) => ({
        name: relative(process.cwd(), s.source) || s.source,
        cells: [s.paths.size, s.methods, s.functions],
    }));
    if (rows.length > 1) {
        rows.push({
            name: 'total',
            cells: HEADERS.map((_, i) => rows.reduce((n, r) => n + r.cells[i], 0)),
        });
    }

    // Numbers are padded before they are styled: a colour code has no width,
    // and `table` cannot know that.
    const widths = HEADERS.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => String(r.cells[i]).length)),
    );
    const lines = table([
        [bold('SPEC'), ...HEADERS.map((h, i) => bold(h.padStart(widths[i])))],
        ...rows.map((r) => [
            r.name === 'total' ? dim(r.name) : r.name,
            ...r.cells.map((c, i) => String(c).padStart(widths[i])),
        ]),
    ]);
    note('');
    for (const line of lines) {
        note(`  ${line}`);
    }
    note('');
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function start(
    values: Flags,
    specs: readonly string[],
    what: 'serve' | 'build',
): Promise<Setup> {
    const loud = !values.quiet && !values.json;
    return open({
        specs,
        cwd: process.cwd(),
        cache: values.cache,
        model: values.model,
        image: values.image,
        attempts: number(values.attempts, 'attempts'),
        concurrency: number(values.concurrency, 'concurrency'),
        timeout: number(values.timeout, 'timeout'),
        rebuild: values.rebuild,
        ephemeral: values['no-cache'],
        onImageBuild: loud
            ? (tag) => note(`${dim('building')} ${tag} ${dim('— once, then cached')}`)
            : undefined,
        events: {
            onStart: loud
                ? ({ operation }) =>
                      note(
                          `${dim('writing a generator for')} ${operation.method.toUpperCase()} ${operation.path}`,
                      )
                : undefined,
            onAttempt: loud
                ? ({ operation, attempt, diagnostics }) =>
                      note(
                          `  ${yellow(`attempt ${attempt} failed`)} ${dim(`${operation.operationId}: ${(diagnostics ?? []).join(' ').slice(0, 160)}`)}`,
                      )
                : undefined,
            onReady:
                loud && what === 'serve'
                    ? ({ operation, cached }) =>
                          cached
                              ? undefined
                              : note(`  ${green('ready')} ${dim(operation.operationId)}`)
                    : undefined,
            onFail: loud
                ? ({ operation, error }) =>
                      note(`  ${red('gave up')} ${dim(operation.operationId)} ${reason(error)}`)
                : undefined,
        },
    });
}

function number(raw: string | undefined, what: string): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw usageError(`--${what} must be a number, got "${raw}"`);
    }
    return value;
}

function usage(): void {
    printBanner(BANNER);
    write(`${bold(NAME)} ${dim('— a mock API from an openapi/swagger document')}`);
    write(`\n${bold('Usage')}\n  ${USAGE}`);
    write(`\n${bold('Commands')}`);
    writeAll(
        table([
            ['  serve <spec...>', dim('Serve the documents. Generators are written on demand.')],
            ['  build <spec...>', dim('Write every generator now and exit.')],
            ['  cache ls|clear', dim('What has been generated, or throw it away.')],
        ]),
    );
    write(`\n${bold('Options')}`);
    writeAll(
        table([
            ['  --port <n>', dim('Default 8787.')],
            ['  --host <h>', dim('Default 127.0.0.1. Anything else is reachable off-machine.')],
            ['  --model <ref>', dim('Which model writes the generators.')],
            ['  --image <ref>', dim('Skip the baked image and use this one.')],
            ['  --cache <dir>', dim('Where generators live. Default ~/.zenera/neo/faker.')],
            ['  --seed <n>', dim('Answer the same request the same way every time.')],
            ['  --attempts <n>', dim('Tries per generator before giving up. Default 3.')],
            ['  --concurrency <n>', dim('Generators written at once. Default 4.')],
            ['  --timeout <s>', dim('Seconds one generator may take. Default 30.')],
            ['  --max-body <n>', dim('Largest request body accepted, in bytes.')],
            ['  --rebuild', dim('Ignore what is cached and write it again.')],
            ['  --no-cache', dim('Do not record what is written.')],
            ['  --quiet', dim('No narration.')],
            ['  --json', dim('Machine-readable output.')],
        ]),
    );
    write(
        `\n${dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`)}`,
    );
}

process.exitCode = await main(process.argv.slice(2));
