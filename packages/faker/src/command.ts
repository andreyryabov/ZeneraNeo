import {
    bold,
    cacheItems,
    clearCache,
    CliError,
    cyan,
    dim,
    EXIT,
    green,
    json,
    KeyStore,
    note,
    ownedContainers,
    parse,
    paths,
    red,
    removeContainers,
    table,
    usageError,
    write,
    writeAll,
    yellow,
    type Command,
    type Context,
} from '@zenera/cli/lib';
import { createModel } from '@zenera/neo';
import { rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { GENERATORS } from './box.ts';
import { FAKER_KIND, type GeneratorMeta } from './cache.ts';
import { reason } from './generate.ts';
import { formatDumpPath } from './logger.ts';
import { listen } from './server.ts';
import {
    chooseModel,
    MODEL_ENV,
    open,
    readSettings,
    SOURCE_LABELS,
    writeSettings,
    type Setup,
} from './setup.ts';
import { called, type Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// zen faker — a mock API from a specification
//
// A command in another package rather than a binary of its own: one thing to
// install, one keyring, one name to remember. `zen` loads this module only when
// somebody types `zen faker`, so nothing here is on the path of `zen list`.
//
// That it stays up is not a problem for the frame — `run` simply does not
// resolve until a signal arrives, and the process lives as long as the answer
// takes, which is what every other command already means.
// ---------------------------------------------------------------------------

const USAGE = 'zen faker <serve|build|cache|model> [spec...]';

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
    'regen-limit'?: string;
    'requests-dir'?: string;
    rebuild?: boolean;
    'no-cache'?: boolean;
    clear?: boolean;
    quiet?: boolean;
}

// `--json` is the frame's, lifted out of the arguments before they arrive; it
// reaches us as `ctx.json` and must not be declared again or `strict` rejects it.
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
    'regen-limit': { type: 'string' },
    'requests-dir': { type: 'string' },
    rebuild: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    clear: { type: 'boolean' },
    quiet: { type: 'boolean' },
} as const;

export const command: Command = {
    summary: 'A mock API from an openapi/swagger document.',
    usage: USAGE,
    details: [
        'Commands',
        ...table([
            ['  serve <spec...>', dim('Serve the documents. Generators are written on demand.')],
            ['  build <spec...>', dim('Write every generator now and exit.')],
            ['  cache ls|clear', dim('What has been generated, or throw it away.')],
            ['  model [ref]', dim('Show or set the model it uses. Remembered between runs.')],
        ]),
        '',
        'Options',
        ...table([
            ['  --port <n>', dim('Default 8787.')],
            ['  --host <h>', dim('Default 127.0.0.1. Anything else is reachable off-machine.')],
            ['  --model <ref>', dim('Which model writes the generators, for this run only.')],
            ['  --image <ref>', dim('Skip the baked image and use this one.')],
            ['  --cache <dir>', dim("The container's workspace. Default ~/.zenera/neo/faker.")],
            ['  --seed <n>', dim('Answer the same request the same way every time.')],
            ['  --attempts <n>', dim('Tries per generator before giving up. Default 5.')],
            ['  --concurrency <n>', dim('Generators written at once. Default 4.')],
            ['  --timeout <s>', dim('Seconds one generator may take. Default 30.')],
            ['  --max-body <n>', dim('Largest request body accepted, in bytes.')],
            ['  --regen-limit <n>', dim('Maximum regenerations per URL on error. Default 3.')],
            ['  --requests-dir <dir>', dim('Where to save request/response .md files.')],
            ['  --rebuild', dim('Ignore what is cached and write it again.')],
            ['  --no-cache', dim('Do not record what is written.')],
            ['  --clear', dim('With `model`: forget the stored one.')],
            ['  --quiet', dim('No narration.')],
        ]),
        '',
        dim(
            `The model is looked for in this order: ${cyan('--model')}, ${cyan(MODEL_ENV)}, ` +
                `${cyan('zen faker model')}, then the best one your keys can buy.`,
        ),
        dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`),
    ],

    async run(ctx: Context): Promise<void> {
        const [name, ...rest] = ctx.args;
        switch (name) {
            case 'serve':
                return await serve(rest, ctx);
            case 'build':
                return await warm(rest, ctx);
            case 'cache':
                return await cache(rest, ctx);
            case 'model':
                return await model(rest, ctx);
            default:
                throw usageError(name ? `unknown command "${name}"` : 'no command given', USAGE);
        }
    },
};

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, 'zen faker serve <spec...>');
    const loud = !values.quiet && !ctx.json;
    const setup = await start(values, positionals, ctx, 'serve');
    if (loud) {
        printSpecs(setup.router.operations, ctx.cwd);
    }

    const host = values.host ?? '127.0.0.1';
    const requestsDir = values['requests-dir']
        ? resolve(ctx.cwd, values['requests-dir'])
        : undefined;
    const listener = await listen(
        {
            router: setup.router,
            cache: setup.cache,
            checks: setup.checks,
            box: setup.box,
            seed: number(values.seed, 'seed'),
            maxBody: number(values['max-body'], 'max-body'),
            requestsDir,
            regenLimit: number(values['regen-limit'], 'regen-limit'),
            onRequest: values.quiet ? undefined : (line) => note(line),
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
        note(dim(`request logs: ${requestsDir ?? `${setup.root}/requests`}`));
        note(dim(`failed builds: ${setup.root}/builds`));
    }
    // The address is the answer; the rest was narration.
    write(`http://${host}:${listener.port}`);

    await until(['SIGINT', 'SIGTERM']);
    if (!values.quiet) {
        note(dim('stopping'));
    }
    await listener.close();
    await setup.close();
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

async function warm(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, 'zen faker build <spec...>');
    const loud = !values.quiet && !ctx.json;
    const setup = await start(values, positionals, ctx, 'build');
    if (loud) {
        printSpecs(setup.router.operations, ctx.cwd);
    }

    const results: { operation: string; status: string; detail?: string }[] = [];
    try {
        for (const operation of setup.router.operations) {
            const id = `${operation.method.toUpperCase()} ${called(operation)}`;
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

    if (ctx.json) {
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

    // Reported first, then failed: the table is the answer either way.
    const failed = results.filter((r) => r.status === 'failed').length;
    if (failed > 0) {
        throw new CliError(
            `${failed} of ${results.length} generators failed`,
            EXIT.failed,
            'run again to retry, or raise --attempts',
        );
    }
}

const mark = (status: string): string =>
    status === 'failed' ? red('failed') : status === 'skipped' ? dim('skipped') : green(status);

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

async function cache(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, 'zen faker cache <ls|clear>');
    const root = values.cache ? resolve(ctx.cwd, values.cache) : paths.faker();
    const sub = positionals[0] ?? 'ls';

    if (sub === 'ls') {
        const entries = listGenerators();
        if (ctx.json) {
            json(entries);
            return;
        }
        if (entries.length === 0) {
            note('nothing cached yet');
            return;
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
        return;
    }

    if (sub === 'clear') {
        clearCache({ kind: FAKER_KIND });
        // The workspace is scratch — whatever a hit was copied into it is
        // written again from the cache, or by the model.
        rmSync(join(root, GENERATORS), { recursive: true, force: true });
        // The container is named after its configuration, so a stale one would
        // otherwise sit there stopped forever with nothing pointing at it.
        // `zn-<key>-<digest>` is the shape, and this one's key is `faker`.
        const mine = (await ownedContainers()).filter((c) => c.name.startsWith('zn-faker-'));
        if (mine.length > 0) {
            await removeContainers(mine.map((c) => c.name));
        }
        note(`${green('cleared')} ${dim(paths.cache())}`);
        return;
    }

    throw usageError(`unknown cache command "${sub}"`, 'zen faker cache <ls|clear>');
}

type Listed = GeneratorMeta & { key: string };

/**
 * The keys are the operation keys, written verbatim — which is why they can be
 * listed at all. Anything the store cannot parse is left out rather than shown
 * as a row with nothing in it.
 */
function listGenerators(): Listed[] {
    const { rows } = cacheItems(FAKER_KIND);
    return rows
        .map((row) => ({ key: row.key, ...(row.value as { meta?: GeneratorMeta })?.meta }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// model
//
// A stored model is remembered the way `zen meta model` remembers one: in the
// home directory, beside the keyring, because it is a choice about this tool on
// this machine. Shown rather than merely set, since the question when a run
// surprises you is not "which model" but "why that one".
// ---------------------------------------------------------------------------

const MODEL_USAGE = 'zen faker model [ref|--clear]';

async function model(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, MODEL_USAGE);
    const ref = positionals[0];
    if (ref && values.clear) {
        throw usageError('--clear takes no model', MODEL_USAGE);
    }

    // Before anything builds a model: vertex reads its project out of the
    // environment, and the keyring is what puts it there.
    const keys = await KeyStore.open();
    keys.materialize();

    if (ref || values.clear) {
        const file = await readSettings();
        if (ref) {
            // Only that the ref parses: asking the provider costs a call, and
            // the next run makes one anyway.
            createModel(ref);
            writeSettings({ ...file, model: ref });
        } else {
            delete file.model;
            writeSettings(file);
        }
        if (ctx.json) {
            json({ model: ref });
            return;
        }
        note(ref ? `${green('set')} ${ref}` : `${green('cleared')} ${dim('the stored model')}`);
    }

    const chosen = await chooseModel(values.model, keys);
    if (ctx.json) {
        json({ model: chosen?.ref, from: chosen?.from, stored: (await readSettings()).model });
        return;
    }
    if (!chosen) {
        note('no model, and no key to recommend one from');
        note(dim('add a key: zen key add openai'));
        return;
    }
    note(`${cyan(chosen.ref)} ${dim(`from ${SOURCE_LABELS[chosen.from]}`)}`);
    if (chosen.from === 'default') {
        note(dim(`set one: zen faker model <provider>:<id>`));
    }
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

function printSpecs(operations: readonly Operation[], cwd: string): void {
    const stats = summarize(operations);
    const rows = stats.map((s) => ({
        name: relative(cwd, s.source) || s.source,
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
    ctx: Context,
    what: 'serve' | 'build',
): Promise<Setup> {
    const loud = !values.quiet && !ctx.json;
    const setup = await open({
        specs,
        cwd: ctx.cwd,
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
                          `${dim('writing a generator for')} ${operation.method.toUpperCase()} ${called(operation)}`,
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
                ? ({ operation, error, dump }) => {
                      note(`  ${red('gave up')} ${dim(operation.operationId)} ${reason(error)}`);
                      if (dump) {
                          note(formatDumpPath('report', dump));
                      }
                  }
                : undefined,
        },
    });
    if (loud) {
        note(dim(`model ${setup.choice.ref} from ${SOURCE_LABELS[setup.choice.from]}`));
    }
    return setup;
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
