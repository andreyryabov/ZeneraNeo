import {
    bold,
    CliError,
    CURATED,
    cyan,
    dim,
    ensureHome,
    envNames,
    EXIT,
    form,
    isInteractive,
    json,
    KeyStore,
    note,
    parse,
    PROVIDERS,
    table,
    usageError,
    write,
    type Command,
    type Context,
    type Provider,
} from '@zenera/cli/lib';
import { createEmbedder, type Embedder, type EmbeddingRef } from '@zenera/neo';
import { relative, resolve } from 'node:path';
import { isFormat, present, type Format } from './present.ts';
import { isEmpty, parseQuery, QueryError } from './query.ts';
import { repl } from './repl.ts';
import { buildIndex } from './schema/build.ts';
import { assertSameEmbedding, openIndex, readManifest, type SourceRecord } from './schema/files.ts';
import { SchemaIndex, type SchemaQuery } from './schema/search.ts';
import { stitch } from './schema/subgraph.ts';

// ---------------------------------------------------------------------------
// zen rag — an api description, as something to search
//
// `search` has two modes and neither is the afterthought. Interactively it is
// a loop with prompts; non-interactively it is a tool, and that is the mode
// that has to be exactly specified: every field settable from a flag, the whole
// query settable as one JSON object, a stable `--json` shape, no terminal
// required, and exit 0 when nothing matched — an empty answer is an answer, and
// a caller that has to tell "no results" from "the index is missing" by parsing
// stderr will get it wrong.
// ---------------------------------------------------------------------------

const USAGE = 'zen rag schema <index|search|show|stats> [spec...]';

const INDEX_USAGE = 'zen rag schema index --embedding <ref> [--out <dir>] <spec...>';
const SEARCH_USAGE = 'zen rag schema search [--dir <dir>] [query...]';

const DEFAULT_DIR = './schema-db';

export const command: Command = {
    summary: 'Search an openapi/swagger document as a graph.',
    usage: USAGE,
    details: [
        'Commands',
        ...table([
            ['  index <spec...>', dim('Read the documents and write a searchable index.')],
            ['  search', dim('Ask it something. --interactive for a prompt.')],
            ['  show <id...>', dim('Print named nodes, with no search in between.')],
            ['  stats', dim('What is in an index, and what built it.')],
        ]),
        '',
        'Index',
        ...table([
            [
                '  --embedding <ref>',
                dim('Which embedder makes the vectors. Omit it to be shown the choices.'),
            ],
            ['  -o, --out <dir>', dim(`Where the index goes. Default ${DEFAULT_DIR}.`)],
            [
                '  --batch <n>',
                dim('Texts per embedding request, and how often progress prints. Default 96.'),
            ],
        ]),
        '',
        'Search terms (repeatable)',
        ...table([
            ['  <text>', dim('A bare phrase, the same as --all.')],
            ['  --all <q>', dim('Against everything, unfiltered.')],
            ['  --method <q>', dim('Operations.')],
            ['  --type <q>', dim('Schemas, on the side --direction names.')],
            ['  --input-type <q>', dim('Schemas a call accepts.')],
            ['  --output-type <q>', dim('Schemas a call returns.')],
            ['  --property <q>', dim('Fields and parameters, per --direction.')],
            ['  --input-property <q>', dim('Fields and parameters a call accepts.')],
            ['  --output-property <q>', dim('Fields a call returns.')],
            ['  --query <json|->', dim('A whole query object; - reads stdin.')],
        ]),
        '',
        'Search filters and shape',
        ...table([
            ['  -d, --dir <dir>', dim(`Which index. Default ${DEFAULT_DIR}.`)],
            ['  --embedding <ref>', dim('Must be the one the index was built with.')],
            ['  --direction <d>', dim('input | output | any. Default any.')],
            ['  --method-type <t>', dim('read_only | read_write | any. Default any.')],
            ['  --exclude-id <id>', dim('Drop a node. Repeatable, as are the three below.')],
            ['  --exclude-method <name>', dim('Drop an operation by name.')],
            ['  --exclude-type <name>', dim('Drop a schema by name.')],
            ['  --exclude-property <name>', dim('Drop a field by name.')],
            ['  --limit <n>', dim('Seeds kept per term. Default 5.')],
            ['  --max-hops <n>', dim('How far apart two hits may be. Default 3.')],
            ['  --max-nodes <n>', dim('Nodes per result. Default 200.')],
            ['  --format <f>', dim('text | mermaid | mermaid-flowchart | ts | openapi.')],
            ['  --no-docs', dim('Leave the descriptions out.')],
            ['  --interactive', dim('Prompt, search, refine. Needs a terminal.')],
            ['  --quiet', dim('No narration.')],
        ]),
        '',
        dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`),
    ],

    async run(ctx: Context): Promise<void> {
        const [group, ...rest] = ctx.args;
        // `schema` is the only subject so far; leaving it out is a courtesy,
        // not a second spelling to support forever.
        const [name, ...tail] = group === 'schema' ? rest : ctx.args;

        switch (name) {
            case 'index':
                return await index(tail, ctx);
            case 'search':
                return await search(tail, ctx);
            case 'show':
                return await show(tail, ctx);
            case 'stats':
                return await stats(tail, ctx);
            default:
                throw usageError(name ? `unknown command "${name}"` : 'no command given', USAGE);
        }
    },
};

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

interface IndexFlags {
    out?: string;
    embedding?: string;
    batch?: string;
    quiet?: boolean;
}

async function index(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<IndexFlags>(
        args,
        {
            out: { type: 'string', short: 'o' },
            embedding: { type: 'string' },
            batch: { type: 'string' },
            quiet: { type: 'boolean' },
        },
        INDEX_USAGE,
    );

    if (positionals.length === 0) {
        throw usageError('no document given', INDEX_USAGE);
    }
    const out = resolve(ctx.cwd, values.out ?? DEFAULT_DIR);
    const loud = !values.quiet && !ctx.json;
    const chosen = await embedder(values.embedding);
    const started = Date.now();

    const { manifest } = await buildIndex({
        files: positionals.map((file) => resolve(ctx.cwd, file)),
        out,
        embedder: chosen,
        embeddingRef: values.embedding,
        indexer: 'zenera-rag',
        batch: values.batch ? count(values.batch, '--batch') : undefined,
        onRead: loud
            ? (summary) => {
                  printSources(summary.sources, ctx.cwd);
                  // The first batch can take a while and says nothing while it
                  // does; this is the line that makes that a wait, not a hang.
                  note(dim(`  embedding ${summary.counts.entities} entities with ${chosen.id} …`));
              }
            : undefined,
        onProgress: loud
            ? (done, total) =>
                  note(
                      dim(
                          `  embedded ${done}/${total} · ${Math.round((done / total) * 100)}% · ${elapsed(started)}`,
                      ),
                  )
            : undefined,
    });

    if (ctx.json) {
        json({ out, manifest });
        return;
    }
    // stdout is the path and nothing else, so `DIR=$(zen rag schema index …)`
    // works; what it means goes to stderr, where the narration lives.
    note();
    write(out);
    note(
        `  wrote ${bold(String(manifest.counts.entities))} entities to ${bold(out)}, ` +
            `embedded with ${manifest.embedding.ref} (${manifest.embedding.dimensions}d)`,
    );
    const where =
        out === resolve(ctx.cwd, DEFAULT_DIR) ? '' : ` --dir ${relative(ctx.cwd, out) || out}`;
    note(dim(`  search it: ${cyan(`zen rag schema search${where} --all "what you are after"`)}`));
}

const HEADERS = ['PATHS', 'OPERATIONS', 'SCHEMAS', 'FIELDS'] as const;

function elapsed(since: number): string {
    const seconds = Math.round((Date.now() - since) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function printSources(sources: readonly SourceRecord[], cwd: string): void {
    const rows = sources.map((s) => ({
        name: relative(cwd, s.path) || s.path,
        dialect: s.dialect,
        cells: [s.paths, s.methods, s.types, s.properties],
    }));
    if (rows.length > 1) {
        rows.push({
            name: 'total',
            dialect: '',
            cells: HEADERS.map((_, i) => rows.reduce((n, r) => n + (r.cells[i] ?? 0), 0)),
        });
    }

    // Numbers are padded before they are styled: a colour code has no width,
    // and `table` cannot know that.
    const widths = HEADERS.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => String(r.cells[i]).length)),
    );
    note();
    notes(
        table([
            [bold('SPEC'), bold('DIALECT'), ...HEADERS.map((h, i) => bold(h.padStart(widths[i])))],
            ...rows.map((r) => [
                r.name === 'total' ? dim(r.name) : r.name,
                dim(r.dialect),
                ...r.cells.map((c, i) => String(c).padStart(widths[i])),
            ]),
        ]).map((line) => `  ${line}`),
    );
    note();
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

interface SearchFlags {
    dir?: string;
    embedding?: string;
    all?: string[];
    method?: string[];
    type?: string[];
    'input-type'?: string[];
    'output-type'?: string[];
    property?: string[];
    'input-property'?: string[];
    'output-property'?: string[];
    query?: string;
    direction?: string;
    'method-type'?: string;
    'exclude-id'?: string[];
    'exclude-method'?: string[];
    'exclude-type'?: string[];
    'exclude-property'?: string[];
    limit?: string;
    'max-hops'?: string;
    'max-nodes'?: string;
    format?: string;
    'no-docs'?: boolean;
    'only-hits'?: boolean;
    interactive?: boolean;
    quiet?: boolean;
}

const MANY = { type: 'string', multiple: true } as const;

const SEARCH_OPTIONS = {
    dir: { type: 'string', short: 'd' },
    embedding: { type: 'string' },
    all: MANY,
    method: MANY,
    type: MANY,
    'input-type': MANY,
    'output-type': MANY,
    property: MANY,
    'input-property': MANY,
    'output-property': MANY,
    query: { type: 'string' },
    direction: { type: 'string' },
    'method-type': { type: 'string' },
    'exclude-id': MANY,
    'exclude-method': MANY,
    'exclude-type': MANY,
    'exclude-property': MANY,
    limit: { type: 'string' },
    'max-hops': { type: 'string' },
    'max-nodes': { type: 'string' },
    format: { type: 'string' },
    'no-docs': { type: 'boolean' },
    'only-hits': { type: 'boolean' },
    interactive: { type: 'boolean' },
    quiet: { type: 'boolean' },
} as const;

async function search(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<SearchFlags>(args, SEARCH_OPTIONS, SEARCH_USAGE);
    const dir = resolve(ctx.cwd, values.dir ?? DEFAULT_DIR);
    const format = formatOf(values.format);
    const options = { docs: !values['no-docs'], onlyHits: values['only-hits'] };
    const query = { ...(await fromStdin(values.query)), ...fromFlags(values, positionals) };

    // Everything that can be wrong about the invocation is settled before a
    // credential is asked for, so a typo is a usage error and not a login.
    if (values.interactive && !isInteractive()) {
        throw usageError('--interactive needs a terminal', SEARCH_USAGE);
    }
    if (!values.interactive && isEmpty(query)) {
        throw usageError('no query given', SEARCH_USAGE);
    }

    const manifest = await readManifest(dir);
    const ref = values.embedding ?? manifest.embedding.ref;
    assertSameEmbedding(manifest, ref);

    const index = await SchemaIndex.open(dir, await embedder(ref));
    try {
        if (values.interactive) {
            await repl(index, query, { format, ...options });
            return;
        }

        const result = await index.search(query);
        if (ctx.json) {
            json({
                seeds: result.seeds,
                empty: result.empty,
                subgraphs: result.subgraphs,
                rendered: await present(index, result.subgraphs, format, options),
            });
            return;
        }
        const text = await present(index, result.subgraphs, format, options);
        if (text) {
            write(text);
        }
        if (!values.quiet) {
            note(
                dim(
                    `  ${result.seeds.length} seed(s) · ${result.subgraphs.length} result(s)${
                        result.empty.length > 0 ? ` · nothing for: ${result.empty.join(', ')}` : ''
                    }`,
                ),
            );
        }
    } finally {
        index.close();
    }
}

/** Flags win over `--query`: the more specific spelling is the later thought. */
function fromFlags(values: SearchFlags, positionals: readonly string[] = []): SchemaQuery {
    const query: Record<string, unknown> = {};
    const put = (key: string, value: unknown) => {
        if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
            query[key] = value;
        }
    };

    // A bare phrase is the unfiltered search; there is nothing else it could mean.
    put('all', [...(values.all ?? []), ...positionals]);
    put('methods', values.method);
    put('types', values.type);
    put('input_types', values['input-type']);
    put('output_types', values['output-type']);
    put('properties', values.property);
    put('input_properties', values['input-property']);
    put('output_properties', values['output-property']);
    put('exclude_ids', values['exclude-id']);
    put('exclude_methods', values['exclude-method']);
    put('exclude_types', values['exclude-type']);
    put('exclude_properties', values['exclude-property']);
    put('direction', values.direction);
    put('method_type', values['method-type']);
    put('limit', values.limit && count(values.limit, '--limit'));
    put('max_hops', values['max-hops'] && count(values['max-hops'], '--max-hops'));
    put('max_nodes', values['max-nodes'] && count(values['max-nodes'], '--max-nodes'));

    return check(query);
}

async function fromStdin(source: string | undefined): Promise<SchemaQuery> {
    if (source === undefined) {
        return {};
    }
    const text = source === '-' ? await readStdin() : source;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw usageError(`--query is not JSON: ${(err as Error).message}`, SEARCH_USAGE);
    }
    return check(parsed);
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function check(value: unknown): SchemaQuery {
    try {
        return parseQuery(value);
    } catch (err) {
        if (err instanceof QueryError) {
            throw usageError(err.message, SEARCH_USAGE);
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// show, stats
// ---------------------------------------------------------------------------

/**
 * No embedder and no store: naming a node is a graph lookup, and asking for a
 * credential to print something already on disk would be theatre.
 */
async function show(args: readonly string[], ctx: Context): Promise<void> {
    const usage = 'zen rag schema show <id...>';
    const { values, positionals } = parse<SearchFlags>(args, SEARCH_OPTIONS, usage);
    if (positionals.length === 0) {
        throw usageError('no node named', usage);
    }
    const format = formatOf(values.format);
    const index = await openIndex(resolve(ctx.cwd, values.dir ?? DEFAULT_DIR));

    const missing = positionals.filter((id) => !index.graph.hasNode(id));
    if (missing.length > 0) {
        throw new CliError(
            `no such node: ${missing.join(', ')}`,
            EXIT.failed,
            'ids look like `Type:User` or `Property:User.email`',
        );
    }
    const subgraphs = stitch(
        index.graph,
        positionals.map((id) => ({ id, term: id, field: 'show', score: 1 })),
        { maxNodes: values['max-nodes'] ? count(values['max-nodes'], '--max-nodes') : undefined },
    );
    const text = await present(index, subgraphs, format, { docs: !values['no-docs'] });

    if (ctx.json) {
        json({ subgraphs, rendered: text });
    } else if (text) {
        write(text);
    }
}

async function stats(args: readonly string[], ctx: Context): Promise<void> {
    const { values } = parse<{ dir?: string }>(
        args,
        { dir: { type: 'string', short: 'd' } },
        'zen rag schema stats [--dir <dir>]',
    );
    const dir = resolve(ctx.cwd, values.dir ?? DEFAULT_DIR);
    const manifest = await readManifest(dir);

    if (ctx.json) {
        json(manifest);
        return;
    }
    note(bold(dir));
    notes(
        table([
            ['  built', manifest.createdAt],
            ['  by', manifest.indexer],
            ['  embedder', `${manifest.embedding.ref} (${manifest.embedding.dimensions}d)`],
            [
                '  indexes',
                `fts ${yes(manifest.indexes.fts)} · vector ${yes(manifest.indexes.vector)}`,
            ],
        ]),
    );
    printSources(manifest.sources, ctx.cwd);
    notes(table([['  entities', String(manifest.counts.entities)]]).map(dim));
}

function notes(lines: readonly string[]): void {
    for (const line of lines) {
        note(line);
    }
}

const yes = (value: boolean): string => (value ? 'yes' : 'no');

// ---------------------------------------------------------------------------

/** The keyring is materialised here, and only here: `show` and `stats` read no vectors. */
async function embedder(ref: string | undefined): Promise<Embedder> {
    ensureHome();
    const keys = await KeyStore.open();
    // Asked before materialising, because materialising is what erases the
    // difference between "the environment had it" and "the keyring supplied it".
    const fromEnv = new Set(PROVIDERS.filter((p) => envNames(p).some((n) => process.env[n])));
    keys.materialize();

    if (!ref) {
        throw choices(keys, fromEnv);
    }
    return createEmbedder(ref as EmbeddingRef);
}

/**
 * Well-known embedding models per provider, read off the CLI's catalog table so
 * there is one list rather than two that drift. Any ref the registry can parse
 * works; these are the ones worth typing. Anthropic has none because it
 * publishes no embeddings API at all.
 */
const embeddingsOf = (provider: Provider): string[] =>
    CURATED[provider].filter((m) => m.roles.includes('embedding')).map((m) => m.id);

/** What could be passed, with the ones this machine can actually use first. */
function choices(keys: KeyStore, fromEnv: ReadonlySet<Provider>): CliError {
    const rows: string[][] = [];
    const rest: string[][] = [];

    for (const provider of PROVIDERS) {
        for (const model of embeddingsOf(provider)) {
            const source = fromEnv.has(provider)
                ? 'environment'
                : keys.active(provider)
                  ? 'keyring'
                  : '';
            const row = [`  ${cyan(`${provider}:${model}`)}`, dim(source || form(provider).env)];
            (source ? rows : rest).push(row);
        }
    }

    note(bold('Embeddings'));
    notes(table([...rows, ...rest]));
    note('');
    if (rows.length === 0) {
        note(dim('  no provider on this machine has a credential — try: zen key add openai'));
        note('');
    }
    // `pick` is the one that ends the question rather than restating it: it
    // tries them and prints the first that answers.
    return usageError(
        'no embedder named',
        'pass --embedding <ref>, or run: zen models pick --embedding',
    );
}

function formatOf(value: string | undefined): Format {
    if (value === undefined) {
        return 'text';
    }
    if (!isFormat(value)) {
        throw usageError(
            `unknown format "${value}"`,
            'expected text, mermaid, mermaid-flowchart, ts or openapi',
        );
    }
    return value;
}

function count(value: string, flag: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        throw usageError(`${flag} must be a whole number of at least 1`, USAGE);
    }
    return number;
}
