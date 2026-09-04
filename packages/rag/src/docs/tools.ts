import { tool, type AnyTool } from '@zenera/neo';
import { PatternError } from '../common/match.ts';
import { assemble } from './assemble.ts';
import { CHUNK_KINDS } from './chunk.ts';
import {
    grepLines,
    listFiles,
    listSections,
    listTables,
    readRange,
    readSection,
} from './lookup.ts';
import { renderAssembly } from './render.ts';
import { SEARCH_MODES, type DocsIndex, type DocsQuery } from './search.ts';

// ---------------------------------------------------------------------------
// The same index, given to an agent
//
// Four tools over one engine, and only one of them ranks anything. `search_docs`
// is the way in when the question is vague; the other three are exact, because
// a model told "no results" by a vector search has learned nothing — a ranking
// returns the top of a list, so an empty answer and an absent thing look
// identical.
//
// `search_docs` is shaped for the second call rather than the first. The first
// is always a sentence and always returns too much of the wrong tree; the
// second is the same sentence with `files: ["nsx_4.2*/api/**"]`, or
// `section: "Rate limits"`, or `kind: ["table"]` because the answer is a table
// and not the prose around it. Those are parameters and not separate tools, so
// narrowing costs one call and not three.
//
// Every answer carries line numbers, and `read_docs` takes them. That is the
// loop the whole thing exists for: find the passage, read around it, then edit
// the file the passage came from — and a passage that cannot be pointed at is a
// passage nothing can be done with.
// ---------------------------------------------------------------------------

const GROUP = 'docs';

/** Kept small on purpose: a tool result is prompt, and the model asked for one thing. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

/** A listing is lines rather than passages, so it can afford more of them. */
const DEFAULT_ROWS = 50;
const MAX_ROWS = 200;

/** A ceiling on what one answer may quote, so one long section cannot eat it. */
const DEFAULT_MAX_LINES = 200;
const MAX_LINES = 800;

export interface DocsToolOptions {
    /** passages per search when the model does not say */
    limit?: number;
    /** lines quoted per answer when the model does not say */
    maxLines?: number;
}

interface SearchArgs {
    query: string;
    files?: string[];
    exclude_files?: string[];
    section?: string[];
    kind?: string[];
    mode?: string;
    exclude_ids?: string[];
    limit?: number;
    before?: number;
    after?: number;
    max_lines?: number;
}

interface ListArgs {
    what?: string;
    files?: string[];
    section?: string[];
    depth?: number;
    limit?: number;
}

interface GrepArgs {
    pattern: string;
    files?: string[];
    section?: string[];
    regex?: boolean;
    case_sensitive?: boolean;
    limit?: number;
}

interface ReadArgs {
    file: string;
    section?: string;
    from?: number;
    to?: number;
}

export function docsTools<TCtx = unknown>(
    index: DocsIndex,
    options: DocsToolOptions = {},
): AnyTool<TCtx>[] {
    const limitOf = (asked: number | undefined): number =>
        clamp(asked ?? options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const linesOf = (asked: number | undefined): number =>
        clamp(asked ?? options.maxLines ?? DEFAULT_MAX_LINES, 20, MAX_LINES);

    const searchDocs = tool<SearchArgs, TCtx>({
        name: 'search_docs',
        group: GROUP,
        description:
            'Searches the documents and answers with the passages that matched, quoted ' +
            'verbatim with their line numbers and with a marker wherever something between ' +
            'two passages was left out. When the first answer is from the wrong part of the ' +
            'corpus, ask again with the same query and a narrowing: `files` for a path ' +
            'pattern, `section` for a heading, `kind` for tables or code only. Pass the ids ' +
            'from an earlier answer in exclude_ids to be shown something new instead.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What is wanted, as a sentence rather than keywords.',
                },
                files: strings(
                    'Only documents whose name matches. A glob if it has * or ?, e.g. ' +
                        '"guides/**" or "nsx_4.2*/api/**"; otherwise a substring.',
                ),
                exclude_files: strings('Documents to leave out, matched the same way.'),
                section: strings(
                    'Only under these headings, and whatever nests inside them. A heading ' +
                        'title, or a structure path from an earlier answer.',
                ),
                kind: {
                    type: 'array',
                    items: { type: 'string', enum: [...CHUNK_KINDS] },
                    description:
                        'Only these kinds of block. Use ["table"] or ["table_row"] when the ' +
                        'answer is tabular, ["code"] for examples.',
                },
                mode: {
                    type: 'string',
                    enum: [...SEARCH_MODES],
                    description:
                        'hybrid blends meaning and wording; text is exact wording only, for ' +
                        'an error string or an identifier.',
                },
                exclude_ids: strings('Passage ids already seen, as printed in an earlier answer.'),
                limit: {
                    type: 'integer',
                    description: `Passages kept. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`,
                },
                before: { type: 'integer', description: 'Extra lines quoted before each passage.' },
                after: { type: 'integer', description: 'Extra lines quoted after each passage.' },
                max_lines: {
                    type: 'integer',
                    description: `A ceiling on the whole answer. Default ${DEFAULT_MAX_LINES}.`,
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        execute: async (args) => {
            const query: DocsQuery = {
                query: args.query,
                files: args.files,
                exclude_files: args.exclude_files,
                section: args.section,
                kinds: args.kind,
                mode: args.mode as DocsQuery['mode'],
                exclude_ids: args.exclude_ids,
                limit: limitOf(args.limit),
            };
            const result = await guard(() => index.search(query));
            if ('error' in result) {
                return result;
            }
            if (result.files.length === 0) {
                return {
                    found: 0,
                    hint: 'no document matched `files` — call list_docs to see their names',
                };
            }
            if (result.matches.length === 0) {
                return {
                    found: 0,
                    scope: { documents: result.files.length, sections: result.sections.length },
                    hint: args.section?.length
                        ? 'nothing under that section — drop `section` and search the whole document'
                        : 'try fewer words, or mode "text" if it is an exact string',
                };
            }
            const excerpt = await assemble(index, result.matches, {
                before: args.before,
                after: args.after,
                maxLines: linesOf(args.max_lines),
            });
            return {
                found: result.matches.length,
                ids: result.matches.map((m) => m.id),
                documents: excerpt.files.map((f) => f.path),
                truncated: excerpt.truncated,
                passages: renderAssembly(excerpt, { colour: false }),
            };
        },
    });

    const listDocs = tool<ListArgs, TCtx>({
        name: 'list_docs',
        group: GROUP,
        description:
            'Lists what is in the index — the documents, their headings, or their tables — ' +
            'without searching or ranking anything. Call it first to learn the document ' +
            "names that `files` patterns are matched against, or to see a document's " +
            'structure before asking about one part of it.',
        parameters: {
            type: 'object',
            properties: {
                what: {
                    type: 'string',
                    enum: ['files', 'sections', 'tables'],
                    description: 'Default files.',
                },
                files: strings('Only these documents, matched by glob or substring.'),
                section: strings('Only under these headings.'),
                depth: {
                    type: 'integer',
                    description: 'sections only: the deepest heading level to report.',
                },
                limit: { type: 'integer', description: `Rows kept. Default ${DEFAULT_ROWS}.` },
            },
            additionalProperties: false,
        },
        execute: async (args) => {
            const options = {
                files: args.files,
                section: args.section,
                depth: args.depth,
                limit: clamp(args.limit ?? DEFAULT_ROWS, 1, MAX_ROWS),
            };
            const what = args.what ?? 'files';
            const result = await guard(() =>
                what === 'sections'
                    ? listSections(index, options)
                    : what === 'tables'
                      ? listTables(index, options)
                      : listFiles(index, options),
            );
            if ('error' in result) {
                return result;
            }
            return {
                found: result.found,
                truncated: result.truncated,
                [what]: result.rows,
                ...(result.found === 0
                    ? { hint: 'nothing matched — widen `files`, or call it with no arguments' }
                    : {}),
            };
        },
    });

    const grepDocs = tool<GrepArgs, TCtx>({
        name: 'grep_docs',
        group: GROUP,
        description:
            'Every line matching a pattern, with the document and line number, and the ' +
            'section it sits in. Exact, not ranked, and it reports the true total even when ' +
            'the rows are cut — so unlike search_docs it can answer "does this string appear ' +
            'anywhere". Reach for it with an identifier, an error message, or a flag name.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'A substring, a glob if it has * or ?, or a regex with regex.',
                },
                files: strings('Only these documents.'),
                section: strings('Only under these headings.'),
                regex: { type: 'boolean', description: 'Read the pattern as a regex.' },
                case_sensitive: { type: 'boolean', description: 'Match the capitals too.' },
                limit: { type: 'integer', description: `Lines kept. Default ${DEFAULT_ROWS}.` },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        execute: async (args) => {
            const result = await guard(() =>
                grepLines(index, args.pattern, {
                    files: args.files,
                    section: args.section,
                    regex: args.regex,
                    caseSensitive: args.case_sensitive,
                    limit: clamp(args.limit ?? DEFAULT_ROWS, 1, MAX_ROWS),
                }),
            );
            if ('error' in result) {
                return result;
            }
            return {
                found: result.found,
                truncated: result.truncated,
                lines: result.rows,
                ...(result.found === 0 ? { hint: 'nothing matched anywhere in scope' } : {}),
            };
        },
    });

    const readDocs = tool<ReadArgs, TCtx>({
        name: 'read_docs',
        group: GROUP,
        description:
            'Reads a document verbatim: a whole named section, or a line range as printed by ' +
            'search_docs or grep_docs. Use it when a passage was found and the lines around ' +
            'it are needed in full, with nothing omitted and nothing summarised.',
        parameters: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    description: 'A document name, exactly as list_docs prints it.',
                },
                section: {
                    type: 'string',
                    description: 'A heading title or structure path. Overrides from/to.',
                },
                from: { type: 'integer', description: 'First line, 1-based. Default 1.' },
                to: { type: 'integer', description: 'Last line. Default the end of the document.' },
            },
            required: ['file'],
            additionalProperties: false,
        },
        execute: async (args) => {
            const file = index.resolveFiles([args.file])[0];
            if (!file) {
                return {
                    error: `no document called ${args.file}`,
                    hint: 'call list_docs for the names',
                };
            }
            const result = await guard(async () =>
                args.section
                    ? await readSection(index, file, args.section)
                    : await readRange(index, file, args.from ?? 1, args.to ?? Infinity),
            );
            if ('error' in result) {
                return result;
            }
            // A whole large document is prompt spent on lines nobody asked for.
            const kept = result.lines.slice(0, MAX_LINES);
            return {
                file: result.file,
                start: result.start,
                end: result.start + kept.length - 1,
                total: result.total,
                truncated: kept.length < result.lines.length,
                text: kept.map((line, at) => `${result.start + at} | ${line}`).join('\n'),
            };
        },
    });

    return [searchDocs, listDocs, grepDocs, readDocs];
}

// ---------------------------------------------------------------------------

const strings = (description: string) => ({
    type: 'array' as const,
    items: { type: 'string' as const },
    description,
});

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(Math.trunc(value), low), high);

/**
 * A bad pattern is a bad argument, not a failure. A model handed a thrown
 * exception retries the same call; one handed a sentence fixes it.
 */
async function guard<T>(run: () => Promise<T> | T): Promise<T | { error: string }> {
    try {
        return await run();
    } catch (err) {
        if (err instanceof PatternError) {
            return { error: err.message };
        }
        throw err;
    }
}
