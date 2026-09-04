import type { Embedder } from '@zenera/neo';
import { assertSameEmbedding } from '../common/manifest.ts';
import { loose, PatternError } from '../common/match.ts';
import { CHUNK_KINDS, parseLines } from './chunk.ts';
import {
    openIndex,
    readLines,
    type FileOutline,
    type HeadingRecord,
    type Manifest,
    type OpenDocs,
    type Outline,
} from './files.ts';
import { ChunkStore, type Hit, type StoreFilter } from './store.ts';

// ---------------------------------------------------------------------------
// The one way in
//
// The command, the prompt loop and the tools an agent is handed all call
// `DocsIndex.search`. Ranking lives here once, because three copies of a fusion
// rule is three answers to the same question.
//
// A query is a question plus the narrowings an agent arrives at by asking twice:
// a file pattern, a section, a kind of block. That is the whole shape of how
// these get used — search, read the answer, decide it was the wrong half of the
// tree, search again inside `nsx_4.*` — so narrowing is a first-class argument
// and not a second tool.
//
// The narrowings are resolved against the manifest and the outline BEFORE the
// store is touched, which is what makes them honest. A pattern matching no
// document says so, instead of silently searching everything; a section name
// that appears in four documents becomes four prefixes, not a guess at one.
// ---------------------------------------------------------------------------

export type SearchMode = 'hybrid' | 'vector' | 'text';

export const SEARCH_MODES: readonly SearchMode[] = ['hybrid', 'vector', 'text'];

export interface DocsQuery {
    query?: string;
    mode?: SearchMode;
    /** patterns over the document name: a glob, a substring, or a regex */
    files?: readonly string[];
    exclude_files?: readonly string[];
    /** a heading title, a structure id, or a structure path */
    section?: readonly string[];
    /** one of `CHUNK_KINDS` */
    kinds?: readonly string[];
    /** chunk ids already seen, so asking again moves on */
    exclude_ids?: readonly string[];
    limit?: number;
}

export interface Match {
    id: string;
    path: string;
    kind: string;
    headings: string;
    structureId: string;
    structurePath: string;
    /** every line this chunk wants shown, headings and table header included */
    lineNumbers: number[];
    bodyStart: number;
    bodyEnd: number;
    text: string;
    score: number;
    /** where it placed in each leg, when it placed at all */
    ranks: { vector?: number; text?: number };
}

export interface DocsResult {
    matches: Match[];
    mode: SearchMode;
    /** the documents the narrowings left in play */
    files: string[];
    /** the sections they left in play, as structure paths */
    sections: string[];
    /** distinct chunks either leg returned, before fusion trimmed them */
    considered: number;
}

export const DEFAULT_LIMIT = 8;

/** Reciprocal rank fusion; the constant is the usual one and damps the top. */
const RRF_K = 60;

/** How much to ask each leg for, so fusion and the caps have room to work. */
const OVERFETCH = 6;

/** One section cannot own the whole answer, however well it scored. */
const MAX_PER_SECTION = 3;

/** Nor can one document, when the question ranges over a corpus. */
const MAX_PER_FILE = 5;

export class DocsIndex {
    readonly manifest: Manifest;
    readonly outline: Outline;
    readonly #index: OpenDocs;
    readonly #store: ChunkStore;
    readonly #embedder: Embedder | undefined;

    constructor(index: OpenDocs, store: ChunkStore, embedder?: Embedder) {
        this.manifest = index.manifest;
        this.outline = index.outline;
        this.#index = index;
        this.#store = store;
        this.#embedder = embedder;
    }

    /**
     * An embedder is optional because half of what this index is for needs no
     * model at all: listing, grepping and reading are exact, and asking for a
     * credential to do them would be asking for nothing.
     */
    static async open(dir: string, embedder?: Embedder): Promise<DocsIndex> {
        const index = await openIndex(dir);
        if (embedder) {
            assertSameEmbedding(index.manifest, embedder.id);
        }
        return new DocsIndex(index, await ChunkStore.open(dir), embedder);
    }

    /** A document, split the way every line number in this index counts it. */
    lines(name: string): Promise<string[]> {
        return readLines(this.#index, name);
    }

    file(name: string): FileOutline | undefined {
        return this.outline.files.find((f) => f.name === name);
    }

    /** Document names matching the patterns, or all of them when there are none. */
    resolveFiles(patterns: readonly string[] = [], exclude: readonly string[] = []): string[] {
        const names = this.manifest.sources.map((s) => s.name);
        const keep = patterns.length === 0 ? names : names.filter(anyMatch(patterns));
        return exclude.length === 0 ? keep : keep.filter((name) => !anyMatch(exclude)(name));
    }

    /**
     * Headings the terms name, over the documents still in play. A term is tried
     * as a structure id, then a structure path, then as a pattern over the
     * title — so `--section overview` and `--section sec:3` are the same
     * argument, and neither has to be explained.
     */
    resolveSections(terms: readonly string[], files: readonly string[]): HeadingRecord[] {
        if (terms.length === 0) {
            return [];
        }
        const within = new Set(files);
        const out: HeadingRecord[] = [];

        for (const file of this.outline.files) {
            if (!within.has(file.name)) {
                continue;
            }
            for (const heading of file.headings) {
                const hit = terms.some(
                    (term) =>
                        term === heading.id ||
                        term === heading.path ||
                        anyMatch([term])(heading.title),
                );
                if (hit) {
                    out.push(heading);
                }
            }
        }
        return out;
    }

    close(): void {
        this.#store.close();
    }

    async search(query: DocsQuery, signal?: AbortSignal): Promise<DocsResult> {
        const mode = query.mode ?? 'hybrid';
        const text = (query.query ?? '').trim();
        const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
        const files = this.resolveFiles(query.files, query.exclude_files);
        const headings = this.resolveSections(query.section ?? [], files);
        const sections = headings.map((h) => h.path);

        // Two ways to ask for nothing: a pattern no document answers to, and a
        // section no document has. Both are told, not silently widened.
        const impossible =
            files.length === 0 || ((query.section?.length ?? 0) > 0 && sections.length === 0);
        if (impossible || !text) {
            return { matches: [], mode, files, sections, considered: 0 };
        }

        const filter = this.#filter(query, files, sections);
        const excluded = new Set(query.exclude_ids ?? []);
        const fetch = limit * OVERFETCH + excluded.size;

        const vector = mode === 'text' ? [] : await this.#nearest(text, filter, fetch, signal);
        const lexical = mode === 'vector' ? [] : await this.#store.matching(text, filter, fetch);

        const fused = fuse(vector, lexical).filter(
            (match) =>
                !excluded.has(match.id) &&
                files.includes(match.path) &&
                under(match.structurePath, sections),
        );
        return {
            matches: diversify(fused, limit),
            mode,
            files,
            sections,
            considered: fused.length,
        };
    }

    async #nearest(
        text: string,
        filter: StoreFilter,
        limit: number,
        signal?: AbortSignal,
    ): Promise<Hit[]> {
        if (!this.#embedder) {
            throw new Error('this index was opened without an embedder, so it cannot be searched');
        }
        const response = await this.#embedder.embed({
            input: [text],
            taskType: 'query',
            signal,
        });
        return await this.#store.nearest(Float32Array.from(response.vectors[0]!), filter, limit);
    }

    /**
     * The SQL side of the narrowing. A short, safe file list becomes a
     * predicate; a long or awkward one is left to the JavaScript filter that
     * runs afterwards regardless, since that is what makes the answer correct.
     */
    #filter(query: DocsQuery, files: string[], sections: string[]): StoreFilter {
        const all = this.manifest.sources.length;
        return {
            kinds: kindsOf(query.kinds),
            paths: files.length < all && files.length <= 64 ? files : undefined,
            prefixes: sections.length > 0 && sections.length <= 64 ? sections : undefined,
        };
    }
}

// ---------------------------------------------------------------------------

const anyMatch = (patterns: readonly string[]) => {
    const matchers = patterns.map((pattern) => loose(pattern));
    return (value: string): boolean => matchers.some((match) => match(value));
};

/**
 * Inside one of these sections, or anywhere when none were asked for. The
 * boundary is a path separator and not a prefix, because `doc/sec:1` is a
 * prefix of `doc/sec:10` and they are different sections.
 */
export const under = (path: string, sections: readonly string[]): boolean =>
    sections.length === 0 ||
    sections.some((section) => path === section || path.startsWith(`${section}/`));

function kindsOf(kinds: readonly string[] | undefined): string[] | undefined {
    if (!kinds || kinds.length === 0) {
        return undefined;
    }
    for (const kind of kinds) {
        if (!(CHUNK_KINDS as readonly string[]).includes(kind)) {
            throw new PatternError(
                `${kind} is not a kind of block: it is one of ${CHUNK_KINDS.join(', ')}`,
            );
        }
    }
    return [...kinds];
}

/**
 * Reciprocal rank fusion over the chunk id. Fusing on the id rather than on a
 * physical row means the ordering survives a compaction of the store, and it is
 * also the only key the two legs are guaranteed to agree on.
 */
function fuse(vector: readonly Hit[], lexical: readonly Hit[]): Match[] {
    const merged = new Map<string, Match>();

    const add = (hits: readonly Hit[], leg: 'vector' | 'text'): void => {
        for (const hit of hits) {
            const existing = merged.get(hit.record.id) ?? match(hit);
            existing.score += 1 / (RRF_K + hit.rank);
            existing.ranks[leg] = hit.rank;
            merged.set(hit.record.id, existing);
        }
    };
    add(vector, 'vector');
    add(lexical, 'text');

    return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function match(hit: Hit): Match {
    const { record } = hit;
    return {
        id: record.id,
        path: record.path,
        kind: record.kind,
        headings: record.headings,
        structureId: record.structureId,
        structurePath: record.structurePath,
        lineNumbers: parseLines(record.lineSpec),
        bodyStart: record.bodyStart,
        bodyEnd: record.bodyEnd,
        text: record.text,
        score: 0,
        ranks: {},
    };
}

/**
 * Caps per section and per document, applied in score order. A question whose
 * answer really is one section still gets it — the cap only stops a run of
 * near-identical neighbours from crowding out the second place a thing is said.
 */
function diversify(matches: readonly Match[], limit: number): Match[] {
    const perSection = new Map<string, number>();
    const perFile = new Map<string, number>();
    const kept: Match[] = [];
    const held: Match[] = [];

    for (const item of matches) {
        const section = `${item.path}\u0000${parentOf(item.structurePath)}`;
        const sections = perSection.get(section) ?? 0;
        const files = perFile.get(item.path) ?? 0;

        if (sections >= MAX_PER_SECTION || files >= MAX_PER_FILE) {
            held.push(item);
            continue;
        }
        perSection.set(section, sections + 1);
        perFile.set(item.path, files + 1);
        kept.push(item);
        if (kept.length === limit) {
            return kept;
        }
    }
    // Better a crowded answer than a short one: what the caps held back fills
    // the rest, still in score order.
    return [...kept, ...held].slice(0, limit);
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || path;
