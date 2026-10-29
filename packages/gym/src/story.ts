import { loose, PatternError, tool, type AnyTool } from '@zenera/neo';
import { docs } from '@zenera/rag';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from './store.ts';

// ---------------------------------------------------------------------------
// The story
//
// What the world is supposed to look like, in prose: who the people are, what
// they are writing to each other about, what is on whose calendar. It is read
// by agents, never by handlers — a handler only ever sees the entities an agent
// already turned the story into.
//
// `--story` names either a pre-built `zen rag docs` index or plain documents. A
// short story is put straight into the prompt, because a tool call to read
// three paragraphs is a turn spent on nothing; a long one is handed over as
// tools, and the agent reads the parts it needs.
// ---------------------------------------------------------------------------

/** Below this, the story is quoted whole rather than left to the tools. */
const INLINE_BYTES = 16_000;

export interface Story {
    /** a function of the story's content, which names the world it shares */
    readonly digest: string;
    /** what an agent is told up front: the whole story, or a table of contents */
    readonly brief: string;
    readonly tools: AnyTool[];
    close(): void;
}

/** No story: agents invent a plausible world, and are told so. */
export const NO_STORY: Story = {
    digest: '',
    brief:
        'There is no story for this world. Invent plausible, internally consistent data: a ' +
        'small cast of people with stable names and email addresses, and content that ' +
        'reads like real use of the API. Reuse what is already in the world before ' +
        'inventing anything new.',
    tools: [],
    close: () => {},
};

export async function openStory(path: string, cwd: string): Promise<Story> {
    const at = resolve(cwd, path);
    return existsSync(join(at, 'manifest.json')) ? await fromIndex(at) : await fromFiles(path, cwd);
}

async function fromIndex(dir: string): Promise<Story> {
    // Opened without an embedder: listing, grepping and reading are exact and
    // need no model, so only the ranked search is left out.
    const index = await docs.DocsIndex.open(dir);
    const sources = index.manifest.sources;
    const full = await Promise.all(
        sources.map(async (s) => (await index.lines(s.name)).join('\n')),
    );
    const bytes = full.reduce((n, text) => n + text.length, 0);
    return {
        digest: digest(JSON.stringify(sources.map((s) => [s.name, s.sha256]))),
        brief:
            bytes <= INLINE_BYTES
                ? inline(sources.map((s, i) => ({ name: s.name, text: full[i]! })))
                : contents(sources.map((s) => `${s.name} — ${s.title} (${s.lines} lines)`)),
        tools: docs.docsTools(index).filter((t) => t.name !== 'search_docs'),
        close: () => index.close(),
    };
}

async function fromFiles(path: string, cwd: string): Promise<Story> {
    const corpus = await docs.loadDocuments([path], cwd, { cache: false });
    const files = corpus.docs.map((d) => ({ name: d.name, text: d.text }));
    const bytes = files.reduce((n, f) => n + f.text.length, 0);
    return {
        digest: digest(JSON.stringify(corpus.docs.map((d) => [d.name, d.sha256]))),
        brief:
            bytes <= INLINE_BYTES
                ? inline(files)
                : contents(
                      corpus.docs.map(
                          (d) =>
                              `${d.name} (${d.text.split('\n').length} lines): ` +
                              (d.outline.headings.map((h) => h.title).join(' · ') || 'no headings'),
                      ),
                  ),
        tools: fileTools(files),
        close: () => {},
    };
}

function inline(files: readonly { name: string; text: string }[]): string {
    return [
        'THE STORY OF THIS WORLD. Everything the API returns must agree with it.',
        '',
        ...files.map((f) => `=== ${f.name} ===\n${f.text.trim()}`),
    ].join('\n');
}

function contents(lines: readonly string[]): string {
    return [
        'THE STORY OF THIS WORLD is too long to quote. Everything the API returns must agree',
        'with it. Read the parts you need with list_docs, grep_docs and read_docs:',
        '',
        ...lines.map((l) => `- ${l}`),
    ].join('\n');
}

/** The exact half of `docsTools`, over documents that were never indexed. */
function fileTools(files: readonly { name: string; text: string }[]): AnyTool[] {
    const lines = new Map(files.map((f) => [f.name, f.text.split('\n')]));

    const list = tool<Record<string, never>>({
        name: 'list_docs',
        group: 'docs',
        description: 'Lists the story documents and how long each one is.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({
            files: files.map((f) => ({ name: f.name, lines: lines.get(f.name)!.length })),
        }),
    });

    const grep = tool<{ pattern: string; regex?: boolean; limit?: number }>({
        name: 'grep_docs',
        group: 'docs',
        description:
            'Every line of the story matching a pattern, with its document and line number. ' +
            'Exact, so it can also say that something is not in the story at all.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'A substring, a glob, or a regex.' },
                regex: { type: 'boolean' },
                limit: { type: 'integer', description: 'Lines kept. Default 50.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        execute: ({ pattern, regex, limit }) => {
            let match: (s: string) => boolean;
            try {
                match = loose(pattern, { regex });
            } catch (err) {
                return { error: err instanceof PatternError ? err.message : String(err) };
            }
            const rows: { file: string; line: number; text: string }[] = [];
            let found = 0;
            for (const [file, text] of lines) {
                text.forEach((line, at) => {
                    if (match(line)) {
                        found++;
                        if (rows.length < Math.min(limit ?? 50, 200)) {
                            rows.push({ file, line: at + 1, text: line });
                        }
                    }
                });
            }
            return { found, truncated: found > rows.length, lines: rows };
        },
    });

    const read = tool<{ file: string; from?: number; to?: number }>({
        name: 'read_docs',
        group: 'docs',
        description: 'Reads a story document verbatim, or a line range of it.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'A name as list_docs prints it.' },
                from: { type: 'integer', description: 'First line, 1-based.' },
                to: { type: 'integer', description: 'Last line.' },
            },
            required: ['file'],
            additionalProperties: false,
        },
        execute: ({ file, from, to }) => {
            const text = lines.get(file);
            if (!text) {
                return { error: `no document called ${file}`, hint: 'call list_docs' };
            }
            const start = Math.max(1, from ?? 1);
            const end = Math.min(text.length, to ?? start + 399);
            return {
                file,
                total: text.length,
                text: text
                    .slice(start - 1, end)
                    .map((l, i) => `${start + i} | ${l}`)
                    .join('\n'),
            };
        },
    });

    return [list, grep, read];
}
