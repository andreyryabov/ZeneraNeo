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
import { PatternError } from '../common/match.ts';
import { grid } from '../common/prose.ts';
import { assemble, DEFAULT_MAX_LINES } from './assemble.ts';
import { buildIndex } from './build.ts';
import { CHUNK_KINDS } from './chunk.ts';
import { DOCS_INDEX, readManifest, type DocRecord } from './files.ts';
import { DOC_EXTENSIONS } from './load.ts';
import {
    grepLines,
    listFiles,
    listSections,
    listTables,
    readRange,
    readSection,
    type Listing,
} from './lookup.ts';
import { MATCH_HEADERS, matchRows, renderAssembly } from './render.ts';
import { repl } from './repl.ts';
import {
    DEFAULT_LIMIT,
    DocsIndex,
    SEARCH_MODES,
    type DocsQuery,
    type SearchMode,
} from './search.ts';

const { defaultDir: DEFAULT_DIR, envName: DIR_ENV } = DOCS_INDEX;

// ---------------------------------------------------------------------------
// zen rag docs — a pile of documents, as something to search
//
// The subject word is gone by the time this runs: the frame in `../command.ts`
// strips it and hands over the rest, so everything below is about markdown and
// nothing below knows there is a second subject.
//
// `search` is written for two callers who want the same thing differently. A
// person gets a prompt and refines by typing; a model gets flags, a stable
// `--json` shape, no terminal, and exit 0 when nothing matched — because an
// empty answer is an answer, and a caller made to tell "no results" from "no
// index" by reading stderr will get it wrong.
//
// The narrowings are the point. Nobody finds the paragraph they want on the
// first ask: they search, see it is the wrong release, and search again inside
// one — which is why --file takes a glob, --section takes a heading, and --kind
// takes `table` when the answer is a table and not the prose around it.
//
// `list`, `grep` and `show` are the other half, and they are deliberately not
// searches. A ranking can only ever hand back the top of a list, so it cannot
// answer "does the word `deprecated` appear anywhere" — the honest answer is
// every match or none, and these give it with no model and no credential.
// ---------------------------------------------------------------------------

const USAGE = 'zen rag docs <index|search|list|grep|show|stats> [args...]';

const INDEX_USAGE = 'zen rag docs index --embedding <ref> [--out <dir>] <path...>';
const SEARCH_USAGE = 'zen rag docs search [--dir <dir>] [query...]';
const LIST_USAGE = 'zen rag docs list <files|sections|tables> [--dir <dir>]';
const GREP_USAGE = 'zen rag docs grep <pattern> [--dir <dir>]';
const SHOW_USAGE = 'zen rag docs show <file> [--section <name>] [--lines <from-to>]';

export const command: Command = {
    summary: 'Search a pile of markdown and text documents.',
    usage: USAGE,
    details: [
        'Commands',
        ...table([
            ['  index <path...>', dim('Read the documents and write a searchable index.')],
            ['  search [text]', dim('Ask it something. --interactive for a prompt.')],
            ['  list <what>', dim('Every document, section or table. No ranking.')],
            ['  grep <pattern>', dim('Every matching line, with the section it sits in.')],
            ['  show <file>', dim('A document, a section of one, or a line range.')],
            ['  stats', dim('What is in an index, and what built it.')],
        ]),
        '',
        'Index',
        ...table([
            ['  <path...>', dim(`Files, directories or globs. ${DOC_EXTENSIONS.join(', ')}.`)],
            [
                '  --embedding <ref>',
                dim('Which embedder makes the vectors. Omit it to be shown the choices.'),
            ],
            [
                '  -o, --out <dir>',
                dim(`Where the index goes. Default ${DEFAULT_DIR}, or ${DIR_ENV}.`),
            ],
            ['  --batch <n>', dim("Texts per embedding request. Default: the model's own cap.")],
            ['  --chunk-tokens <n>', dim('Target chunk size. Default 384.')],
        ]),
        '',
        dim('  Every document is copied into the index, so it stays portable and'),
        dim('  every quoted line comes from the document rather than a rebuild of it.'),
        '',
        'Search',
        ...table([
            ['  <text>', dim('What to look for. One question, not a list of terms.')],
            ['  -d, --dir <dir>', dim(`Which index. Found from here if unset; see ${DIR_ENV}.`)],
            ['  --embedding <ref>', dim('Must be the one the index was built with.')],
            ['  -f, --file <pattern>', dim('Only these documents. Repeatable.')],
            ['  --exclude-file <pattern>', dim('Drop these documents. Repeatable.')],
            ['  -s, --section <name>', dim('Only under this heading, and what nests in it.')],
            [`  --kind <k>`, dim(`${CHUNK_KINDS.join(' | ')}. Repeatable.`)],
            ['  --mode <m>', dim(`${SEARCH_MODES.join(' | ')}. Default hybrid.`)],
            ['  --exclude-id <id>', dim('Drop a passage already seen. Repeatable.')],
            ['  --limit <n>', dim(`Passages kept. Default ${DEFAULT_LIMIT}.`)],
            ['  -B, --before <n>', dim('Extra lines quoted before each passage.')],
            ['  -A, --after <n>', dim('Extra lines quoted after each passage.')],
            [
                '  --max-lines <n>',
                dim(`A ceiling on the whole answer. Default ${DEFAULT_MAX_LINES}.`),
            ],
            ['  --no-numbers', dim('Quote the lines without their numbers.')],
            ['  --hits', dim('One line per passage instead of the text.')],
            ['  --interactive', dim('Prompt, search, narrow, search again. Needs a terminal.')],
            ['  --quiet', dim('No narration.')],
        ]),
        '',
        dim('  A --file pattern with * or ? is a glob over the whole document name,'),
        dim('  otherwise a substring. Names are relative to what was indexed, so'),
        dim('  --file "nsx_4.2*/api/**" is one release and --file routing is a word.'),
        '',
        'Exact listing — no embedder, no credential',
        ...table([
            ['  list files', dim('Every document, with its size and what it holds.')],
            ['  list sections', dim('Every heading. --depth to stop at a level.')],
            ['  list tables', dim('Every table, with its columns and row count.')],
            ['  grep <pattern>', dim('Every matching line. --regex for a regex.')],
            ['  --file <pattern>', dim('Narrow to documents. Repeatable, as everywhere.')],
            ['  --section <name>', dim('Narrow to a heading and what nests in it.')],
            ['  --regex', dim('Read every pattern as a regex.')],
            ['  --case-sensitive', dim('Match the capitals too.')],
            ['  --limit <n>', dim('Keep at most n; the count still reports them all.')],
        ]),
        '',
        'Show',
        ...table([
            ['  <file>', dim('A document name, as `list files` prints it.')],
            ['  --section <name>', dim('Just that heading and what nests under it.')],
            ['  --lines <from-to>', dim('Just those lines, e.g. --lines 40-80.')],
            ['  --no-numbers', dim('Without the line-number gutter.')],
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
    'chunk-tokens'?: string;
    quiet?: boolean;
}

async function index(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<IndexFlags>(
        args,
        {
            out: { type: 'string', short: 'o' },
            embedding: { type: 'string' },
            batch: { type: 'string' },
            'chunk-tokens': { type: 'string' },
            quiet: { type: 'boolean' },
        },
        INDEX_USAGE,
    );

    if (positionals.length === 0) {
        throw usageError('no document, directory or pattern given', INDEX_USAGE);
    }
    const out = outputDir(ctx.cwd, values.out, DOCS_INDEX);
    const loud = !values.quiet && !ctx.json;
    const chosen = await resolveEmbedder(values.embedding, {
        maxBatch: values.batch ? count(values.batch, '--batch') : undefined,
    });
    const started = Date.now();

    const { manifest } = await buildIndex({
        files: positionals,
        cwd: ctx.cwd,
        out,
        embedder: chosen,
        embeddingRef: values.embedding,
        indexer: 'zenera-rag',
        chunk: values['chunk-tokens']
            ? { chunkTokens: count(values['chunk-tokens'], '--chunk-tokens') }
            : undefined,
        onRead: loud
            ? (summary) => {
                  printSources(summary.sources);
                  for (const skip of summary.skipped) {
                      note(dim(`  skipped ${skip.name}: ${skip.reason}`));
                  }
                  // Embedding is one call now, and a long one; this is the line
                  // that makes the wait before the first progress report a wait
                  // rather than a hang.
                  note(dim(`  embedding ${summary.counts.chunks} chunks with ${chosen.id} …`));
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
    // stdout is the path and nothing else, so `DIR=$(zen rag docs index …)`
    // works; what it means goes to stderr, where the narration lives.
    note();
    write(out);
    note(
        `  wrote ${bold(String(manifest.counts.chunks))} chunks from ` +
            `${bold(String(manifest.counts.documents))} document(s) to ${bold(out)}, ` +
            `embedded with ${manifest.embedding.ref} (${manifest.embedding.dimensions}d)`,
    );
    const where =
        out === resolve(ctx.cwd, DEFAULT_DIR) ? '' : ` --dir ${relative(ctx.cwd, out) || out}`;
    note(dim(`  search it: ${cyan(`zen rag docs search${where} "what you are after"`)}`));
}

const SOURCE_HEADERS = ['LINES', 'SECTIONS', 'TABLES', 'CHUNKS'] as const;

function printSources(sources: readonly DocRecord[]): void {
    // A corpus can be thousands of documents and a wall of them is not a report.
    const shownRows = sources.slice(0, 20);
    const cells = shownRows.map((s) => [s.lines, s.sections, s.tables, s.chunks]);
    const total = SOURCE_HEADERS.map((_, i) => sources.reduce((n, s) => n + column(s, i), 0));

    // Numbers are padded before they are styled: a colour code has no width,
    // and `table` cannot know that.
    const widths = SOURCE_HEADERS.map((h, i) =>
        Math.max(h.length, ...[...cells, total].map((row) => String(row[i]).length)),
    );
    note();
    notes(
        table([
            [bold('DOCUMENT'), ...SOURCE_HEADERS.map((h, i) => bold(h.padStart(widths[i])))],
            ...shownRows.map((s, at) => [
                s.name,
                ...cells[at]!.map((c, i) => String(c).padStart(widths[i])),
            ]),
            ...(sources.length > shownRows.length
                ? [[dim(`… and ${sources.length - shownRows.length} more`)]]
                : []),
            [dim('total'), ...total.map((c, i) => dim(String(c).padStart(widths[i])))],
        ]).map((line) => `  ${line}`),
    );
    note();
}

const column = (source: DocRecord, at: number): number =>
    [source.lines, source.sections, source.tables, source.chunks][at] ?? 0;

function elapsed(since: number): string {
    const seconds = Math.round((Date.now() - since) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

interface SearchFlags {
    dir?: string;
    embedding?: string;
    file?: string[];
    'exclude-file'?: string[];
    section?: string[];
    kind?: string[];
    mode?: string;
    'exclude-id'?: string[];
    limit?: string;
    before?: string;
    after?: string;
    'max-lines'?: string;
    'no-numbers'?: boolean;
    hits?: boolean;
    interactive?: boolean;
    quiet?: boolean;
}

const MANY = { type: 'string', multiple: true } as const;

async function search(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<SearchFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            embedding: { type: 'string' },
            file: { ...MANY, short: 'f' },
            'exclude-file': MANY,
            section: { ...MANY, short: 's' },
            kind: MANY,
            mode: { type: 'string' },
            'exclude-id': MANY,
            limit: { type: 'string' },
            before: { type: 'string', short: 'B' },
            after: { type: 'string', short: 'A' },
            'max-lines': { type: 'string' },
            'no-numbers': { type: 'boolean' },
            hits: { type: 'boolean' },
            interactive: { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        SEARCH_USAGE,
    );

    const text = positionals.join(' ').trim();
    const query: DocsQuery = {
        query: text || undefined,
        mode: modeOf(values.mode),
        files: values.file,
        exclude_files: values['exclude-file'],
        section: values.section,
        kinds: kindsOf(values.kind),
        exclude_ids: values['exclude-id'],
        limit: values.limit ? count(values.limit, '--limit') : undefined,
    };
    const shape = {
        before: values.before ? count(values.before, '--before', 0) : undefined,
        after: values.after ? count(values.after, '--after', 0) : undefined,
        maxLines: values['max-lines'] ? count(values['max-lines'], '--max-lines') : undefined,
    };

    // Everything that can be wrong about the invocation is settled before a
    // credential is asked for, so a typo is a usage error and not a login.
    if (values.interactive && !isInteractive()) {
        throw usageError('--interactive needs a terminal', SEARCH_USAGE);
    }
    if (!values.interactive && !text) {
        throw usageError('nothing to search for', SEARCH_USAGE);
    }

    const dir = indexDir(ctx, values.dir);
    const manifest = await readManifest(dir);
    const ref = values.embedding ?? manifest.embedding.ref;
    assertSameEmbedding(manifest, ref);

    const found = await DocsIndex.open(dir, await resolveEmbedder(ref));
    try {
        if (values.interactive) {
            await repl(found, query, shape);
            return;
        }
        const result = await patterned(() => found.search(query));
        const excerpt = await assemble(found, result.matches, shape);

        if (ctx.json) {
            json({
                matches: result.matches,
                files: excerpt.files,
                scope: { files: result.files, sections: result.sections },
                mode: result.mode,
                considered: result.considered,
                truncated: excerpt.truncated,
            });
            return;
        }
        if (values.hits) {
            notes(grid(MATCH_HEADERS, matchRows(result.matches)));
        } else if (excerpt.files.length > 0) {
            write(renderAssembly(excerpt, { numbers: !values['no-numbers'] }));
        }
        if (!values.quiet) {
            note(
                dim(
                    `  ${result.matches.length} passage(s) in ${excerpt.files.length} document(s)` +
                        ` · ${excerpt.shown} line(s) · ${result.files.length} document(s) in scope`,
                ),
            );
        }
    } finally {
        found.close();
    }
}

// ---------------------------------------------------------------------------
// list, grep
//
// The deterministic half. Neither takes an embedder, because neither ranks
// anything: they read the manifest, the outline and the copies in `sources/`.
// What comes back is every match, and where a limit cut the list the count
// still reports the total — being shown 50 of 812 is only useful if you are
// told which of the two happened.
// ---------------------------------------------------------------------------

interface ListFlags {
    dir?: string;
    file?: string[];
    'exclude-file'?: string[];
    section?: string[];
    depth?: string;
    regex?: boolean;
    'case-sensitive'?: boolean;
    limit?: string;
    quiet?: boolean;
}

const LIST_OPTIONS = {
    dir: { type: 'string', short: 'd' },
    file: { ...MANY, short: 'f' },
    'exclude-file': MANY,
    section: { ...MANY, short: 's' },
    depth: { type: 'string' },
    regex: { type: 'boolean' },
    'case-sensitive': { type: 'boolean' },
    limit: { type: 'string' },
    quiet: { type: 'boolean' },
} as const;

async function list(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<ListFlags>(args, LIST_OPTIONS, LIST_USAGE);
    const [what] = positionals;
    if (!what || !['files', 'sections', 'tables'].includes(what)) {
        throw usageError(
            what ? `cannot list "${what}"` : 'nothing named to list',
            'expected files, sections or tables',
        );
    }
    const options = {
        files: values.file,
        exclude_files: values['exclude-file'],
        section: values.section,
        depth: values.depth ? count(values.depth, '--depth') : undefined,
        limit: values.limit ? count(values.limit, '--limit') : undefined,
    };

    const found = await open(ctx, values.dir);
    try {
        const result: Listing<object> = await patterned(async () =>
            what === 'files'
                ? listFiles(found, options)
                : what === 'sections'
                  ? listSections(found, options)
                  : listTables(found, options),
        );
        report(ctx, result, values.quiet, what);
    } finally {
        found.close();
    }
}

async function grep(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<ListFlags>(args, LIST_OPTIONS, GREP_USAGE);
    const [text] = positionals;
    if (!text) {
        throw usageError('no pattern given', GREP_USAGE);
    }

    const found = await open(ctx, values.dir);
    try {
        const result = await patterned(() =>
            grepLines(found, text, {
                files: values.file,
                exclude_files: values['exclude-file'],
                section: values.section,
                regex: values.regex,
                caseSensitive: values['case-sensitive'],
                limit: values.limit ? count(values.limit, '--limit') : undefined,
            }),
        );
        report(ctx, result, values.quiet, 'line');
    } finally {
        found.close();
    }
}

function report<T extends object>(
    ctx: Context,
    result: Listing<T>,
    quiet: boolean | undefined,
    what: string,
): void {
    if (ctx.json) {
        json(result);
        return;
    }
    const headers = Object.keys(result.rows[0] ?? {});
    if (result.rows.length > 0) {
        write(
            grid(
                headers,
                result.rows.map((row) =>
                    headers.map((h) => String((row as Record<string, unknown>)[h] ?? '')),
                ),
            ).join('\n'),
        );
    }
    if (!quiet) {
        note(dim(`  ${result.found} ${what}(s)${shown(result.found, result.rows.length)}`));
    }
}

const shown = (found: number, kept: number): string => (kept < found ? `, showing ${kept}` : '');

// ---------------------------------------------------------------------------
// show, stats
// ---------------------------------------------------------------------------

interface ShowFlags {
    dir?: string;
    section?: string;
    lines?: string;
    'no-numbers'?: boolean;
    quiet?: boolean;
}

/**
 * A document, verbatim. No embedder and no store: the copy in `sources/` is the
 * document, and asking for a credential to print something already on disk
 * would be theatre.
 */
async function show(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<ShowFlags>(
        args,
        {
            dir: { type: 'string', short: 'd' },
            section: { type: 'string', short: 's' },
            lines: { type: 'string' },
            'no-numbers': { type: 'boolean' },
            quiet: { type: 'boolean' },
        },
        SHOW_USAGE,
    );
    const [name] = positionals;
    if (!name) {
        throw usageError('no document named', SHOW_USAGE);
    }

    const found = await open(ctx, values.dir);
    try {
        const file = found.resolveFiles([name])[0];
        if (!file) {
            throw new CliError(
                `no document called ${name}`,
                EXIT.failed,
                'list them with `zen rag docs list files`',
            );
        }
        const span = values.lines ? range(values.lines) : undefined;
        const excerpt = values.section
            ? await readSection(found, file, values.section)
            : await readRange(found, file, span?.[0] ?? 1, span?.[1] ?? Infinity);

        if (ctx.json) {
            json(excerpt);
            return;
        }
        const width = String(excerpt.end).length;
        write(
            excerpt.lines
                .map((line, at) =>
                    values['no-numbers']
                        ? line
                        : `${dim(String(excerpt.start + at).padStart(width))} ${dim('|')} ${line}`,
                )
                .join('\n'),
        );
        if (!values.quiet) {
            note(dim(`  ${file} · lines ${excerpt.start}-${excerpt.end} of ${excerpt.total}`));
        }
    } finally {
        found.close();
    }
}

async function stats(args: readonly string[], ctx: Context): Promise<void> {
    const { values } = parse<{ dir?: string }>(
        args,
        { dir: { type: 'string', short: 'd' } },
        'zen rag docs stats [--dir <dir>]',
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
    notes(
        table([
            ['  documents', String(manifest.counts.documents)],
            ['  chunks', String(manifest.counts.chunks)],
            ['  lines', String(manifest.counts.lines)],
            ['  sections', String(manifest.counts.sections)],
            ['  tables', String(manifest.counts.tables)],
        ]).map(dim),
    );
}

// ---------------------------------------------------------------------------

/**
 * Where the index is, said out loud when nobody named it. Finding one and not
 * saying which would make every answer here unattributable.
 */
function indexDir(ctx: Context, flag: string | undefined): string {
    const { dir, from } = locateIndex(ctx.cwd, flag, DOCS_INDEX);
    if (from === 'found' && !ctx.json) {
        note(dim(`  using ${relative(ctx.cwd, dir) || dir}`));
    }
    return dir;
}

/** The exact half opens the index without an embedder, and so without a key. */
const open = async (ctx: Context, flag: string | undefined): Promise<DocsIndex> =>
    await DocsIndex.open(indexDir(ctx, flag));

/** A bad pattern is a bad invocation, not a failure of the index. */
async function patterned<T>(run: () => Promise<T> | T): Promise<T> {
    try {
        return await run();
    } catch (err) {
        if (err instanceof PatternError) {
            throw usageError(err.message, USAGE);
        }
        throw err;
    }
}

function modeOf(value: string | undefined): SearchMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!(SEARCH_MODES as readonly string[]).includes(value)) {
        throw usageError(`--mode cannot be "${value}"`, `expected ${SEARCH_MODES.join(', ')}`);
    }
    return value as SearchMode;
}

function kindsOf(values: string[] | undefined): string[] | undefined {
    for (const value of values ?? []) {
        if (!(CHUNK_KINDS as readonly string[]).includes(value)) {
            throw usageError(`--kind cannot be "${value}"`, `expected ${CHUNK_KINDS.join(', ')}`);
        }
    }
    return values;
}

/** `40-80`, or `40` for a single line. */
function range(value: string): [number, number] {
    const [from, to] = value.split('-');
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw usageError(`--lines cannot be "${value}"`, 'expected something like 40-80');
    }
    return [start, end];
}

function count(value: string, flag: string, min = 1): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min) {
        throw usageError(`${flag} must be a whole number of at least ${min}`, USAGE);
    }
    return number;
}

function notes(lines: readonly string[]): void {
    for (const line of lines) {
        note(line);
    }
}

const yes = (value: boolean): string => (value ? 'yes' : 'no');
