import {
    bold,
    CliError,
    cyan,
    dim,
    EXIT,
    isInteractive,
    json,
    note,
    parse,
    table,
    usageError,
    write,
    type Command,
    type Context,
} from '@zenera/cli/lib';
import { relative, resolve } from 'node:path';
import { resolveEmbedder } from '../common/embedder.ts';
import { locateIndex, outputDir } from '../common/locate.ts';
import { assertSameEmbedding } from '../common/manifest.ts';
import { isGlob, loose, matcher, PatternError, wildcard, type Matcher } from '../common/match.ts';
import { buildIndex } from './build.ts';
import { openIndex, readManifest, readSource, SCHEMA_INDEX, type SourceRecord } from './files.ts';
import type { ApiGraph, NodeKind } from './graph.ts';
import { fields, grepNodes, listNodes, propertyCount, type Row } from './lookup.ts';
import { isFormat, present, type Format } from './present.ts';
import { isEmpty, parseQuery, QueryError } from './query.ts';
import { sourceTag } from './render.ts';
import { repl } from './repl.ts';
import { SchemaIndex, type SchemaQuery } from './search.ts';
import { select, stitch } from './subgraph.ts';
import { chainOf, DEFAULT_TRACE_HOPS, traceNodes } from './trace.ts';

const { defaultDir: DEFAULT_DIR, envName: DIR_ENV } = SCHEMA_INDEX;

// ---------------------------------------------------------------------------
// zen rag schema — an api description, as something to search
//
// The subject word is gone by the time this runs: the frame in `../command.ts`
// strips it and hands over the rest, so everything below is about openapi and
// nothing below knows there is a second subject.
//
// `search` has two modes and neither is the afterthought. Interactively it is
// a loop with prompts; non-interactively it is a tool, and that is the mode
// that has to be exactly specified: every field settable from a flag, the whole
// query settable as one JSON object, a stable `--json` shape, no terminal
// required, and exit 0 when nothing matched — an empty answer is an answer, and
// a caller that has to tell "no results" from "the index is missing" by parsing
// stderr will get it wrong.
//
// `list`, `grep` and `show` are the other half, and they are deliberately not
// searches. A ranking can only ever hand back the top of a list, so it cannot
// answer "is there a field called `password` anywhere" — the honest answer to
// that question is every match or none, and these three give it without asking
// a model or a credential for permission.
// ---------------------------------------------------------------------------

const USAGE = 'zen rag schema <index|search|list|grep|trace|show|stats> [spec...]';

const INDEX_USAGE = 'zen rag schema index --embedding <ref> [--out <dir>] <spec...>';
const SEARCH_USAGE = 'zen rag schema search [--dir <dir>] [query...]';
const LIST_USAGE = 'zen rag schema list <methods|types|properties> [--dir <dir>]';
const GREP_USAGE = 'zen rag schema grep <pattern> [--dir <dir>]';
const TRACE_USAGE = 'zen rag schema trace <pattern|id...> [--dir <dir>]';
const SHOW_USAGE = 'zen rag schema show [id...] [--method <name>] [--type <name>]';

export const command: Command = {
    summary: 'Search an openapi/swagger document as a graph.',
    usage: USAGE,
    details: [
        'Commands',
        ...table([
            ['  index <spec...>', dim('Read the documents and write a searchable index.')],
            ['  search', dim('Ask it something. --interactive for a prompt.')],
            ['  list <what>', dim('Every method, type or property matching a pattern.')],
            ['  grep <pattern>', dim('Every literal match, ranked by nothing.')],
            ['  trace <pattern>', dim('Up from a field or schema to the calls that carry it.')],
            ['  show [id...]', dim('Print named nodes, with no search in between.')],
            ['  stats', dim('What is in an index, and what built it.')],
        ]),
        '',
        'Index',
        ...table([
            [
                '  --embedding <ref>',
                dim('Which embedder makes the vectors. Omit it to be shown the choices.'),
            ],
            [
                '  -o, --out <dir>',
                dim(`Where the index goes. Default ${DEFAULT_DIR}, or ${DIR_ENV}.`),
            ],
            ['  --batch <n>', dim("Texts per embedding request. Default: the model's own cap.")],
            ['  --no-sources', dim('Do not keep a copy of each document in the index.')],
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
            ['  -d, --dir <dir>', dim(`Which index. Found from here if unset; see ${DIR_ENV}.`)],
            ['  --embedding <ref>', dim('Must be the one the index was built with.')],
            ['  --direction <d>', dim('input | output | any. Default any.')],
            ['  --method-type <t>', dim('read_only | read_write | any. Default any.')],
            ['  --exclude-id <id>', dim('Drop a node. Repeatable, as are the three below.')],
            ['  --exclude-method <name>', dim('Drop an operation by name.')],
            ['  --exclude-type <name>', dim('Drop a schema by name.')],
            ['  --exclude-property <name>', dim('Drop a field by name.')],
            ['  --source <name>', dim('Only this document, as `stats` names it. Repeatable.')],
            ['  --limit <n>', dim('Seeds kept per term. Default 5.')],
            ['  --max-hops <n>', dim('How far apart two hits may be. Default 3.')],
            ['  --max-nodes <n>', dim('Nodes per result. Default 200.')],
            ['  --format <f>', dim('text | mermaid | mermaid-flowchart | ts | openapi.')],
            ['  --show-source', dim('Name the document each operation and schema came from.')],
            ['  --no-docs', dim('Leave the descriptions out.')],
            ['  --interactive', dim('Prompt, search, refine. Needs a terminal.')],
            ['  --quiet', dim('No narration.')],
        ]),
        '',
        'Exact listing — no embedder, no credential',
        ...table([
            ['  list methods', dim('Operations. Filter with --path and --name.')],
            ['  list types', dim('Schemas. Filter with --name.')],
            ['  list properties', dim('Fields and parameters. Filter with --name and --path.')],
            ['  grep <pattern>', dim('Substring over every node; --regex for a regex.')],
            ['  --regex', dim('Read every pattern as a regex, list and grep alike.')],
            ['  --case-sensitive', dim('Match the capitals too.')],
            ['  --kind <k>', dim('grep: method | type | property. Repeatable.')],
            ['  --name <p>', dim('grep too: only nodes whose name matches. Repeatable.')],
            ['  --path <p>', dim('grep too: only what sits on a matching route.')],
            ['  --ids-only', dim('grep: bare ids, to pipe into show.')],
            ['  --source <name>', dim('Only this document, as `stats` names it.')],
            ['  --show-source', dim('Print which document each row came from.')],
            ['  --limit <n>', dim('Keep at most n; the count still reports them all.')],
        ]),
        '',
        dim('  A pattern with * or ? is a glob over the whole name; otherwise it is'),
        dim('  a substring, so --name password finds ResetPasswordPayload. With'),
        dim('  --regex it is a regex either way, so --path "^/(users|teams)/" works.'),
        '',
        'Trace — from a field to the operations that carry it',
        ...table([
            ['  <pattern|id...>', dim('What to trace up from. A name, a glob, or a node id.')],
            [
                '  --kind <k>',
                dim('method | type | property. Repeatable. Schemas and fields by default.'),
            ],
            ['  --direction <d>', dim('Keep only the calls that accept it, or return it.')],
            ['  --max-hops <n>', dim(`How far up to walk. Default ${DEFAULT_TRACE_HOPS}.`)],
            ['  --limit <n>', dim('Trace at most n matching nodes.')],
            ['  --routes <n>', dim('Operations printed per node; the count still has them all.')],
            ['  --ids-only', dim('Bare operation ids, one per line, for piping into show.')],
            ['  --regex', dim('Read the pattern as a regex. --case-sensitive too.')],
            ['  --source <name>', dim('Only nodes from this document.')],
        ]),
        '',
        'Show',
        ...table([
            ['  <id...>', dim('Node ids, e.g. Type:User or Property:User.email.')],
            ['  --method <name>', dim('An operation by name. * to take more. Repeatable.')],
            ['  --type <name>', dim('A schema by name. * to take more. Repeatable.')],
            ['  --source <name>', dim('A whole document, as it was indexed.')],
            ['  --show-source', dim('Name the document each node came from.')],
            ['  --exact', dim('Only what was named, without the neighbours.')],
        ]),
        '',
        dim(`Without --dir, the index is the nearest one at or above the working`),
        dim(`directory; ${cyan(DIR_ENV)} names it outright.`),
        '',
        dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`),
    ],

    async run(ctx: Context): Promise<void> {
        const [name, ...tail] = ctx.args;

        switch (name) {
            case 'index':
                return await index(tail, ctx);
            case 'search':
                return await search(tail, ctx);
            case 'list':
                return await list(tail, ctx);
            case 'grep':
                return await grep(tail, ctx);
            case 'trace':
                return await trace(tail, ctx);
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
    'no-sources'?: boolean;
    quiet?: boolean;
}

async function index(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<IndexFlags>(
        args,
        {
            out: { type: 'string', short: 'o' },
            embedding: { type: 'string' },
            batch: { type: 'string' },
            'no-sources': { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        INDEX_USAGE,
    );

    if (positionals.length === 0) {
        throw usageError('no document given', INDEX_USAGE);
    }
    const out = outputDir(ctx.cwd, values.out, SCHEMA_INDEX);
    const loud = !values.quiet && !ctx.json;
    const chosen = await resolveEmbedder(values.embedding, {
        maxBatch: values.batch ? count(values.batch, '--batch') : undefined,
    });
    const started = Date.now();

    const { manifest } = await buildIndex({
        files: positionals.map((file) => resolve(ctx.cwd, file)),
        out,
        embedder: chosen,
        embeddingRef: values.embedding,
        indexer: 'zenera-rag',
        sources: !values['no-sources'],
        onRead: loud
            ? (summary) => {
                  printSources(summary.sources);
                  // Embedding is one call now, and a long one; this is the line
                  // that makes the wait before the first progress report a wait
                  // rather than a hang.
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

function printSources(sources: readonly SourceRecord[]): void {
    const rows = sources.map((s) => ({
        name: s.file,
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
    source?: string[];
    limit?: string;
    'max-hops'?: string;
    'max-nodes'?: string;
    format?: string;
    'no-docs'?: boolean;
    'only-hits'?: boolean;
    'show-source'?: boolean;
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
    source: MANY,
    limit: { type: 'string' },
    'max-hops': { type: 'string' },
    'max-nodes': { type: 'string' },
    format: { type: 'string' },
    'no-docs': { type: 'boolean' },
    'only-hits': { type: 'boolean' },
    'show-source': { type: 'boolean' },
    interactive: { type: 'boolean' },
    quiet: { type: 'boolean' },
} as const;

async function search(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<SearchFlags>(args, SEARCH_OPTIONS, SEARCH_USAGE);
    const dir = indexDir(ctx, values.dir);
    const format = formatOf(values.format);
    const options = {
        docs: !values['no-docs'],
        onlyHits: values['only-hits'],
        source: values['show-source'],
    };
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

    const index = await SchemaIndex.open(dir, await resolveEmbedder(ref));
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
    put('sources', values.source);
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
// list, grep
//
// The deterministic half. Neither takes an embedder, because neither ranks
// anything: `list` filters on the attributes a node already has and `grep`
// reads the same materialized string the index was built from. What comes back
// is every match, and where a limit cut the list the count still reports the
// total — being shown three of three hundred is only useful if you are told
// which of the two happened.
// ---------------------------------------------------------------------------

const SUBJECTS: Record<string, NodeKind> = {
    methods: 'method',
    types: 'type',
    properties: 'property',
};

interface ListFlags {
    dir?: string;
    name?: string[];
    path?: string[];
    source?: string;
    'method-type'?: string;
    direction?: string;
    regex?: boolean;
    'case-sensitive'?: boolean;
    'show-source'?: boolean;
    limit?: string;
    quiet?: boolean;
}

async function list(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<ListFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            name: MANY,
            path: MANY,
            source: { type: 'string' },
            'method-type': { type: 'string' },
            direction: { type: 'string' },
            regex: { type: 'boolean' },
            'case-sensitive': { type: 'boolean' },
            'show-source': { type: 'boolean' },
            limit: { type: 'string' },
            quiet: { type: 'boolean' },
        },
        LIST_USAGE,
    );

    const subject = positionals[0];
    const kind = subject ? SUBJECTS[subject] : undefined;
    if (!kind) {
        throw usageError(
            subject ? `cannot list "${subject}"` : 'nothing named to list',
            `expected one of ${Object.keys(SUBJECTS).join(', ')}`,
        );
    }
    if (positionals.length > 1) {
        throw usageError('one subject at a time', LIST_USAGE);
    }

    const how = { regex: values.regex, caseSensitive: values['case-sensitive'] };
    const index = await openIndex(indexDir(ctx, values.dir));
    const found = listNodes(index.graph, {
        kind,
        name: patterns(values.name, '--name', how),
        path: patterns(values.path, '--path', how),
        source: values.source,
        methodType: oneOf(values['method-type'], ['read_only', 'read_write'], '--method-type'),
        direction: oneOf(values.direction, ['input', 'output'], '--direction'),
        limit: values.limit ? count(values.limit, '--limit') : undefined,
    });

    if (ctx.json) {
        json({ found: found.found, truncated: found.truncated, rows: found.rows });
        return;
    }
    const lines = rowLines(index.graph, kind, found.rows, values['show-source']);
    if (lines.length > 0) {
        write(lines.join('\n'));
    }
    if (!values.quiet) {
        note(dim(`  ${found.found} ${subject}${shown(found.found, found.rows.length)}`));
    }
}

function rowLines(
    graph: ApiGraph,
    kind: NodeKind,
    rows: readonly Row[],
    showSource = false,
): string[] {
    const from = (r: Row): string[] => (showSource ? [dim(sourceTag(r.source))] : []);
    if (kind === 'method') {
        return table(
            rows.map((r) => [`${r.httpMethod} ${r.path}`, r.name, ...from(r), doc(r.doc)]),
        );
    }
    if (kind === 'type') {
        return table(
            rows.map((r) => [
                r.name,
                dim(fields(propertyCount(graph, r.id))),
                dim(r.direction === 'none' ? '' : `(${r.direction})`),
                ...from(r),
                doc(r.doc),
            ]),
        );
    }
    return table(
        rows.map((r) => [
            `${r.parent ? `${r.parent}.` : ''}${r.name}${r.required ? '' : '?'}`,
            `: ${r.signature || 'unknown'}`,
            ...from(r),
            doc(r.doc),
        ]),
    );
}

interface GrepFlags {
    dir?: string;
    regex?: boolean;
    'case-sensitive'?: boolean;
    kind?: string[];
    name?: string[];
    path?: string[];
    source?: string;
    'show-source'?: boolean;
    limit?: string;
    'ids-only'?: boolean;
    quiet?: boolean;
}

async function grep(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<GrepFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            regex: { type: 'boolean' },
            'case-sensitive': { type: 'boolean' },
            kind: MANY,
            name: MANY,
            path: MANY,
            source: { type: 'string' },
            'show-source': { type: 'boolean' },
            limit: { type: 'string' },
            'ids-only': { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        GREP_USAGE,
    );

    if (positionals.length === 0) {
        throw usageError('no pattern given', GREP_USAGE);
    }
    if (positionals.length > 1) {
        throw usageError('one pattern at a time — quote it if it has spaces', GREP_USAGE);
    }
    const kinds = (values.kind ?? []).map((k) =>
        oneOf(k, ['method', 'type', 'property'], '--kind'),
    ) as string[];

    // The pattern is read as the flags say; the constraints are always names,
    // so they stay globs-or-substrings even under --regex on the pattern.
    const how = { caseSensitive: values['case-sensitive'] };
    const index = await openIndex(indexDir(ctx, values.dir));
    const result = pattern(() =>
        grepNodes(
            index.graph,
            matcher(positionals[0], {
                regex: values.regex,
                caseSensitive: values['case-sensitive'],
            }),
            {
                kinds,
                source: values.source,
                name: patterns(values.name, '--name', how),
                path: patterns(values.path, '--path', how),
                limit: values.limit ? count(values.limit, '--limit') : undefined,
            },
        ),
    );

    if (ctx.json) {
        json({
            found: result.found,
            truncated: result.truncated,
            matches: result.matches.map((m) => ({ id: m.id, ...m.attributes, text: m.text })),
        });
        return;
    }
    if (result.matches.length > 0) {
        const lines = values['ids-only']
            ? result.matches.map((m) => m.id)
            : table(
                  result.matches.map((m) => [
                      m.id,
                      ...(values['show-source'] ? [dim(sourceTag(m.attributes.source))] : []),
                      dim(clip(m.text, 140)),
                  ]),
              );
        write(lines.join('\n'));
    }
    if (!values.quiet && !values['ids-only']) {
        note(dim(`  ${result.found} match(es)${shown(result.found, result.matches.length)}`));
    }
}

// ---------------------------------------------------------------------------
// trace
//
// The one question the other commands answer only in pieces: given a field,
// which calls can reach it? `grep` finds the field, `show` prints the type it
// sits on, and then you are searching again for whatever holds that type, and
// again — three lookups and a guess about the branch you did not follow.
//
// Search reaches part of the way: it stitches its seeds into one connected
// piece and prints what each operation accepts and returns. But it only joins
// what RANKED, only within --max-hops, and it never names the chain. And the
// operation almost never says the word: `POST /transport-nodes` and
// `audit_password` share no vocabulary at all, so the field has to rank on its
// own and the call has to land near it. The $refs between them are certain;
// the ranking is not.
// ---------------------------------------------------------------------------

interface TraceFlags {
    dir?: string;
    kind?: string[];
    direction?: string;
    'max-hops'?: string;
    limit?: string;
    routes?: string;
    'ids-only'?: boolean;
    regex?: boolean;
    'case-sensitive'?: boolean;
    source?: string;
    'show-source'?: boolean;
    quiet?: boolean;
}

async function trace(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<TraceFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            kind: MANY,
            direction: { type: 'string' },
            'max-hops': { type: 'string' },
            limit: { type: 'string' },
            routes: { type: 'string' },
            'ids-only': { type: 'boolean' },
            regex: { type: 'boolean' },
            'case-sensitive': { type: 'boolean' },
            source: { type: 'string' },
            'show-source': { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        TRACE_USAGE,
    );

    if (positionals.length === 0) {
        throw usageError('nothing named to trace', TRACE_USAGE);
    }
    const side = oneOf(values.direction, ['input', 'output'], '--direction');
    const kinds = (values.kind ?? []).map((k) =>
        oneOf(k, ['method', 'type', 'property'], '--kind'),
    ) as NodeKind[];

    // A node id is a thing, not a pattern: someone pasting `Type:User` back
    // from an earlier answer means that node and no other.
    const index = await openIndex(indexDir(ctx, values.dir));
    const ids = positionals.filter((p) => index.graph.hasNode(p));
    const words = positionals.filter((p) => !ids.includes(p));
    const how = { regex: values.regex, caseSensitive: values['case-sensitive'] };

    const result = traceNodes(index.graph, {
        ids,
        kinds: kinds.length > 0 ? kinds : undefined,
        name: patterns(words, '<pattern>', how),
        source: values.source,
        limit: values.limit ? count(values.limit, '--limit') : undefined,
        maxRoutes: values.routes ? count(values.routes, '--routes') : undefined,
        maxHops: values['max-hops'] ? count(values['max-hops'], '--max-hops') : undefined,
    });

    const traces = result.traces.map((t) => ({
        ...t,
        routes: t.routes.filter((r) => !side || r.direction === side || r.direction === 'both'),
    }));

    if (ctx.json) {
        json({
            found: result.found,
            truncated: result.truncated,
            traces: traces.map((t) => ({
                id: t.id,
                name: t.attributes.name,
                found: t.found,
                truncated: t.truncated,
                routes: t.routes.map((r) => ({
                    id: r.id,
                    name: r.attributes.name,
                    method: r.attributes.httpMethod,
                    path: r.attributes.path,
                    direction: r.direction,
                    hops: r.hops,
                    via: r.via,
                    chain: chainOf(index.graph, t.id, r),
                })),
            })),
        });
        return;
    }

    if (values['ids-only']) {
        const operations = [...new Set(traces.flatMap((t) => t.routes.map((r) => r.id)))];
        if (operations.length > 0) {
            write(operations.join('\n'));
        }
        return;
    }

    const lines: string[] = [];
    for (const t of traces) {
        lines.push(t.id);
        if (t.routes.length === 0) {
            // Reachable by nothing is an answer, and a useful one: a schema no
            // call carries is dead weight in the document, or a wrong guess.
            lines.push(dim('    no operation reaches it'));
            continue;
        }
        lines.push(
            ...table(
                t.routes.map((r) => [
                    `    ${r.attributes.httpMethod} ${r.attributes.path}`,
                    r.attributes.name,
                    dim(r.direction),
                    ...(values['show-source'] ? [dim(sourceTag(r.attributes.source))] : []),
                    dim(chainOf(index.graph, t.id, r)),
                ]),
            ),
        );
    }
    if (lines.length > 0) {
        write(lines.join('\n'));
    }
    if (!values.quiet) {
        const routes = traces.reduce((n, t) => n + t.routes.length, 0);
        note(
            dim(
                `  ${result.found} node(s)${shown(result.found, traces.length)} · ${routes} operation(s)`,
            ),
        );
    }
}

// ---------------------------------------------------------------------------

const shown = (found: number, kept: number): string => (kept < found ? `, showing ${kept}` : '');

/**
 * Where the index is, said out loud when nobody named it. Finding one and not
 * saying which would make every answer here unattributable.
 */
function indexDir(ctx: Context, flag: string | undefined): string {
    const { dir, from } = locateIndex(ctx.cwd, flag, SCHEMA_INDEX);
    if (from === 'found' && !ctx.json) {
        note(dim(`  using ${relative(ctx.cwd, dir) || dir}`));
    }
    return dir;
}

function patterns(
    values: string[] | undefined,
    flag: string,
    options: { regex?: boolean; caseSensitive?: boolean } = {},
): Matcher[] | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }
    return values.map((p) => pattern(() => loose(p, options), flag));
}

/** A bad pattern is a bad invocation, not a failure of the index. */
function pattern<T>(run: () => T, flag?: string): T {
    try {
        return run();
    } catch (err) {
        if (err instanceof PatternError) {
            throw usageError(`${flag ? `${flag}: ` : ''}${err.message}`, USAGE);
        }
        throw err;
    }
}

function oneOf<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    flag: string,
): T | undefined {
    if (value === undefined || value === 'any') {
        return undefined;
    }
    if (!(allowed as readonly string[]).includes(value)) {
        throw usageError(`${flag} cannot be "${value}"`, `expected ${allowed.join(' or ')}`);
    }
    return value as T;
}

const doc = (text: string): string => (text ? dim(`— ${clip(text.replace(/\s+/g, ' '), 90)}`) : '');

const clip = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// ---------------------------------------------------------------------------
// show, stats
// ---------------------------------------------------------------------------

interface ShowFlags {
    dir?: string;
    method?: string[];
    type?: string[];
    source?: string;
    exact?: boolean;
    format?: string;
    'max-nodes'?: string;
    'no-docs'?: boolean;
    'show-source'?: boolean;
    quiet?: boolean;
}

/**
 * No embedder and no store: naming a node is a graph lookup, and asking for a
 * credential to print something already on disk would be theatre.
 *
 * Ids are the precise way in, and `--method`/`--type` are the way in for
 * someone who has a name rather than an id — which, with `--format openapi
 * --exact`, is how a resolved slice of the document is got out.
 */
async function show(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<ShowFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            method: MANY,
            type: MANY,
            source: { type: 'string' },
            exact: { type: 'boolean' },
            format: { type: 'string' },
            'max-nodes': { type: 'string' },
            'no-docs': { type: 'boolean' },
            'show-source': { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        SHOW_USAGE,
    );

    const format = formatOf(values.format);
    const dir = indexDir(ctx, values.dir);

    // A whole document, verbatim: the copy kept at index time is the resolved
    // original, and anything rebuilt from the graph would be a paraphrase.
    if (values.source && format === 'openapi' && positionals.length === 0 && !named(values)) {
        const document = await readSource(dir, values.source);
        if (document) {
            write(document);
            return;
        }
        if (!values.quiet) {
            note(dim('  this index kept no copy of the documents — rebuilding it from the graph'));
        }
    }

    const index = await openIndex(dir);
    const ids = resolveIds(index.graph, positionals, values);
    const subgraphs = values.exact
        ? [select(index.graph, ids)]
        : stitch(
              index.graph,
              ids.map((id) => ({ id, term: id, field: 'show', score: 1 })),
              {
                  maxNodes: values['max-nodes']
                      ? count(values['max-nodes'], '--max-nodes')
                      : undefined,
              },
          );
    const text = await present(index, subgraphs, format, {
        docs: !values['no-docs'],
        source: values['show-source'],
    });

    if (ctx.json) {
        json({ ids, subgraphs, rendered: text });
    } else if (text) {
        write(text);
    }
}

const named = (values: ShowFlags): boolean => Boolean(values.method?.length || values.type?.length);

/** Ids as given, plus whatever the name selectors resolve to. */
function resolveIds(graph: ApiGraph, ids: readonly string[], values: ShowFlags): string[] {
    if (ids.length === 0 && !named(values) && !values.source) {
        throw usageError('no node named', SHOW_USAGE);
    }
    const missing = ids.filter((id) => !graph.hasNode(id));
    if (missing.length > 0) {
        throw new CliError(
            `no such node: ${missing.join(', ')}`,
            EXIT.failed,
            'ids look like `Type:User` or `Property:User.email`',
        );
    }

    const out = new Set(ids);
    for (const kind of ['method', 'type'] as const) {
        for (const wanted of values[kind] ?? []) {
            // Selecting, not searching: a bare name means that name. A star is
            // the way to ask for more than one.
            const match = isGlob(wanted)
                ? pattern(() => wildcard(wanted), `--${kind}`)
                : (name: string) => name === wanted;
            const rows = listNodes(graph, { kind, name: [match], source: values.source });
            // A selector that matched nothing is a wrong answer, not an empty
            // one: the caller named something they believe is there.
            if (rows.found === 0) {
                throw new CliError(
                    `no ${kind} called ${wanted}`,
                    EXIT.failed,
                    `try: zen rag schema list ${kind}s --name "${wanted}"`,
                );
            }
            for (const row of rows.rows) {
                out.add(row.id);
            }
        }
    }

    // `--source` on its own means the whole document.
    if (out.size === 0 && values.source) {
        for (const kind of ['method', 'type'] as const) {
            for (const row of listNodes(graph, { kind, source: values.source }).rows) {
                out.add(row.id);
            }
        }
        if (out.size === 0) {
            throw new CliError(`nothing in this index came from ${values.source}`, EXIT.failed);
        }
    }
    return [...out];
}

async function stats(args: readonly string[], ctx: Context): Promise<void> {
    const { values } = parse<{ dir?: string }>(
        args,
        { dir: { type: 'string', short: 'd' } },
        'zen rag schema stats [--dir <dir>]',
    );
    const dir = indexDir(ctx, values.dir);
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
    printSources(manifest.sources);
    notes(table([['  entities', String(manifest.counts.entities)]]).map(dim));
}

function notes(lines: readonly string[]): void {
    for (const line of lines) {
        note(line);
    }
}

const yes = (value: boolean): string => (value ? 'yes' : 'no');

// ---------------------------------------------------------------------------

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
