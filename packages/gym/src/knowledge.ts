import { embeddingResponse, type AnyTool, type Embedder, type EmbeddingRequest } from '@zenera/neo';
import { docs } from '@zenera/rag';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './store.ts';

// ---------------------------------------------------------------------------
// What the agents know about the world
//
// Two inputs, read two ways. The STORY is the state of this world — who is
// who, what is happening, what has not happened yet — and it is authoritative,
// so it is quoted whole in every world-agent prompt. The DOCS are reference
// material — a knowledge base, runbooks, an admin guide — read when needed,
// through search.
//
// The docs are indexed here, before the server listens, into a directory gym
// owns and nobody is told about: keyed by what the documents say and by which
// model embeds them, so a restart is a cache hit and an edit pays only for the
// chunks that changed (`@zenera/rag` keeps the vectors). With no embedding
// model the index is still built, for full-text search; the vectors it carries
// then are hashed words, there only because the store wants a column.
// ---------------------------------------------------------------------------

/** Past this the story is still quoted whole, but it is probably reference material. */
const STORY_WARN_BYTES = 50_000;

export interface KnowledgeOptions {
    /** files, directories or patterns */
    story: readonly string[];
    docs: readonly string[];
    cwd: string;
    /** gym's workspace; indexes go under `<root>/indexes` */
    root: string;
    /** the model that embeds the docs, or none for full-text search only */
    embedding?: { ref: string; embedder: Embedder };
    onWarn?: (message: string) => void;
    onProgress?: (phase: 'reading' | 'embedding', done: number, total: number) => void;
}

export type SearchMode = 'hybrid' | 'text';

export interface DocsSummary {
    files: number;
    chunks: number;
    search: SearchMode;
    /** the embedding model, when search is hybrid */
    embedding?: string;
    /** whether the index was there already */
    reused: boolean;
}

export interface Knowledge {
    /** what the world agent is told about the world, whole */
    readonly story: string;
    /** a function of the story's content; '' when there is none */
    readonly storyDigest: string;
    readonly storyFiles: number;
    readonly docs?: DocsSummary;
    /** search, list, grep and read over the docs; none without docs */
    readonly tools: AnyTool[];
    /** the passages that best answer a question, quoted; '' when nothing does */
    recall(query: string, limit?: number): Promise<string>;
    close(): void;
}

/** No story: agents invent a plausible world, and are told so. */
export const NO_STORY =
    'There is no story for this world. Invent plausible, internally consistent data: a ' +
    'small cast of people with stable names and email addresses, and content that reads ' +
    'like real use of the API. Reuse what is already in the world before inventing anything new.';

export async function openKnowledge(opts: KnowledgeOptions): Promise<Knowledge> {
    const story = opts.story.length > 0 ? await readStory(opts) : undefined;
    const index = opts.docs.length > 0 ? await openDocs(opts) : undefined;
    const search = index?.tools.find((t) => t.name === 'search_docs');

    return {
        story: story?.text ?? NO_STORY,
        storyDigest: story?.digest ?? '',
        storyFiles: story?.files ?? 0,
        docs: index?.summary,
        tools: index?.tools ?? [],
        async recall(query, limit = 4) {
            if (!search || !query.trim()) {
                return '';
            }
            try {
                const found = (await search.execute(
                    { query, limit, max_lines: 120 },
                    {} as never,
                )) as { passages?: string };
                return found.passages ?? '';
            } catch {
                // Recall is a head start, not a dependency: the agent can still search.
                return '';
            }
        },
        close: () => index?.close(),
    };
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

async function readStory(
    opts: KnowledgeOptions,
): Promise<{ text: string; digest: string; files: number }> {
    const corpus = await docs.loadDocuments(opts.story, opts.cwd);
    const bytes = corpus.docs.reduce((n, d) => n + d.bytes, 0);
    if (bytes > STORY_WARN_BYTES) {
        opts.onWarn?.(
            `the story is ${Math.round(bytes / 1000)} KB and is quoted whole in every prompt — ` +
                'reference material belongs in --docs, where it is searched instead',
        );
    }
    return {
        text: [
            'THE STORY OF THIS WORLD. Everything the API returns must agree with it.',
            '',
            ...corpus.docs.map((d) => `=== ${d.name} ===\n${d.text.trim()}`),
        ].join('\n'),
        digest: digest(JSON.stringify(corpus.docs.map((d) => [d.name, d.sha256]))),
        files: corpus.docs.length,
    };
}

// ---------------------------------------------------------------------------
// The docs
// ---------------------------------------------------------------------------

interface OpenDocs {
    summary: DocsSummary;
    tools: AnyTool[];
    close(): void;
}

async function openDocs(opts: KnowledgeOptions): Promise<OpenDocs> {
    // Read first to learn what the index would be called. The parse cache makes
    // the second read, inside the build, free.
    const corpus = await docs.loadDocuments(opts.docs, opts.cwd, {
        onProgress: (done, total) => opts.onProgress?.('reading', done, total),
    });
    const content = digest(JSON.stringify(corpus.docs.map((d) => [d.name, d.sha256])));

    let mode: SearchMode = opts.embedding ? 'hybrid' : 'text';
    let dir = indexDir(opts.root, content, opts.embedding?.ref);
    let reused = existsSync(dir);
    if (!reused) {
        try {
            await build(opts, dir, opts.embedding);
        } catch (err) {
            if (!opts.embedding) {
                throw err;
            }
            // The docs are still worth searching by their wording.
            opts.onWarn?.(
                `could not embed the docs with ${opts.embedding.ref} ` +
                    `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — ` +
                    'searching them by wording only',
            );
            mode = 'text';
            dir = indexDir(opts.root, content, undefined);
            reused = existsSync(dir);
            if (!reused) {
                await build(opts, dir, undefined);
            }
        }
    }

    const index = await docs.DocsIndex.open(
        dir,
        mode === 'hybrid' ? opts.embedding!.embedder : undefined,
    );
    const tools = docs.docsTools(index);
    return {
        summary: {
            files: index.manifest.sources.length,
            chunks: index.manifest.counts.chunks,
            search: mode,
            embedding: mode === 'hybrid' ? opts.embedding!.ref : undefined,
            reused,
        },
        tools: mode === 'hybrid' ? tools : tools.map(wordingOnly),
        close: () => index.close(),
    };
}

/**
 * Built beside where it belongs and renamed into place, so a half-built index
 * is never opened, and a second process building the same one at the same
 * moment loses the rename instead of the index.
 */
async function build(
    opts: KnowledgeOptions,
    dir: string,
    embedding: KnowledgeOptions['embedding'],
): Promise<void> {
    mkdirSync(join(dir, '..'), { recursive: true });
    const scratch = `${dir}.tmp-${randomUUID().slice(0, 8)}`;
    try {
        await docs.buildIndex({
            files: opts.docs,
            cwd: opts.cwd,
            out: scratch,
            embedder: embedding?.embedder ?? TEXT_ONLY,
            embeddingRef: embedding?.ref ?? TEXT_ONLY.id,
            indexer: '@zenera/gym',
            onReading: (done, total) => opts.onProgress?.('reading', done, total),
            onProgress: (done, total) => opts.onProgress?.('embedding', done, total),
        });
        try {
            renameSync(scratch, dir);
        } catch {
            if (!existsSync(dir)) {
                throw new Error(`could not move the docs index into ${dir}`);
            }
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

export function indexDir(root: string, content: string, ref: string | undefined): string {
    const model = ref ? ref.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'text';
    return join(root, 'indexes', `docs-${content}-${model}`);
}

/**
 * `search_docs` with the vector half taken away. A question is asked of the
 * full-text index as it stands; a vector wording becomes a text one.
 */
function wordingOnly(tool: AnyTool): AnyTool {
    if (tool.name !== 'search_docs') {
        return tool;
    }
    return {
        ...tool,
        description: `${tool.description} Matches wording only: there is no embedding model, so use the words the documents would use.`,
        execute: (raw, tc) => {
            const { vector_query: vector, mode: _mode, ...args } = raw as Record<string, unknown>;
            const text = args.text_query ?? (args.query ? undefined : vector);
            return tool.execute(
                text !== undefined
                    ? { ...args, query: undefined, text_query: text }
                    : { ...args, mode: 'text' },
                tc,
            );
        },
    };
}

/**
 * The store wants a vector per chunk, so a model-free index gets one: hashed
 * words, which nothing searches. Cheap, deterministic, and shaped well enough
 * for the store to build its vector index on a large corpus.
 */
export const TEXT_ONLY: Embedder = {
    id: 'gym-text-only',
    embed: (req: EmbeddingRequest) =>
        Promise.resolve(embeddingResponse(req.input.map(hashed), req)),
};

const DIMENSIONS = 32;

function hashed(text: string): number[] {
    const v = new Array<number>(DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) {
            h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
        }
        v[h % DIMENSIONS] += h & 0x100 ? 1 : -1;
    }
    if (!v.some((x) => x !== 0)) {
        v[0] = 1;
    }
    return v;
}
