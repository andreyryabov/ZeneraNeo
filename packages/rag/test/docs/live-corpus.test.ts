import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/docs/chunk.ts';
import { parseDocument } from '../../src/docs/parse.ts';

// ---------------------------------------------------------------------------
// The cutter against a thousand READMEs it has never seen
//
// `structure.test.ts` asks the same questions of a document written to be
// hostile, which only ever contains the traps its author thought of. This one
// asks them of markdown-dataset: 983 READMEs from the most-starred MIT
// repositories on GitHub, badge soup, raw HTML, nested fences and all.
//
// It has already earned its place. It found a sponsors table in raw HTML that
// came out as one 1090-line chunk, and a README with a 92kB line that a
// neighbouring chunk carried whole into its embedding.
//
// `markdown-dataset` is a pinned devDependency — a frozen corpus, so a floating
// range would move the ground under the counts below. ZEN_MARKDOWN_DATASET
// overrides the path. Skips without either, and `--exclude '**/live-*'` keeps
// its thirteen seconds out of the ordinary run.
// ---------------------------------------------------------------------------

interface Entry {
    repoName: string;
    markdownEncoded: string;
    markdownEncoding: string;
}

const DATASET =
    process.env.ZEN_MARKDOWN_DATASET ?? 'node_modules/markdown-dataset/data/markdown.json';

/** No embedding request may be handed a chunk this big. */
const MAX_TOKENS = 2048;

/** Nor may one match spend this much of a reader's budget. */
const MAX_LINES = 256;
const corpus = await readFile(DATASET, 'utf8')
    .then((raw) => JSON.parse(raw) as Entry[])
    .catch(() => undefined);

interface Finding {
    repo: string;
    what: string;
}

/** One pass over the corpus; every question below reads the same findings. */
function audit(entries: readonly Entry[]) {
    const bodies: Finding[] = [];
    const fences: Finding[] = [];
    const tables: Finding[] = [];
    const heavy: Finding[] = [];
    const wide: Finding[] = [];
    let documents = 0;
    let chunks = 0;

    for (const entry of entries) {
        if (entry.markdownEncoding !== 'base64') {
            continue;
        }
        const text = Buffer.from(entry.markdownEncoded, 'base64').toString('utf8');
        const lines = text.split('\n');
        const doc = parseDocument(text, `${entry.repoName}/README.md`, 'markdown');
        const repo = entry.repoName;
        documents++;

        // The parser's own blocks, not a scan of the source: a scan has to
        // reimplement CommonMark to know that a line opening with ```var```
        // is a sentence, and gets it wrong on six repositories here.
        const code = doc.blocks.filter((block) => block.kind === 'code');
        const gridded = doc.blocks.filter((block) => block.table).map((block) => block.table!);

        for (const chunk of chunkDocument(doc)) {
            chunks++;
            const shown = new Set(chunk.lineNumbers);
            const at = `${repo}#c${chunk.index}`;

            if (chunk.lineNumbers.length === 0) {
                bodies.push({ repo, what: `${at} cites no lines` });
                continue;
            }
            if (!shown.has(chunk.bodyStart) || !shown.has(chunk.bodyEnd)) {
                bodies.push({ repo, what: `${at} does not cover its own body` });
            }
            for (const line of chunk.lineNumbers) {
                if (line < 1 || line > lines.length) {
                    bodies.push({ repo, what: `${at} cites line ${line} of ${lines.length}` });
                }
            }
            for (const block of code) {
                const inside = chunk.lineNumbers.some(
                    (line) => line > block.start && line < block.end,
                );
                if (inside && (!shown.has(block.start) || !shown.has(block.end))) {
                    fences.push({ repo, what: `${at} opens ${block.start} and never closes it` });
                }
            }
            for (const table of gridded) {
                if (!table.rows.some((row) => shown.has(row.line))) {
                    continue;
                }
                if (!shown.has(table.headerLine)) {
                    tables.push({ repo, what: `${at} quotes a row with no header` });
                }
                if (table.separatorLine !== undefined && !shown.has(table.separatorLine)) {
                    tables.push({ repo, what: `${at} quotes a row with no rule` });
                }
            }
            if (chunk.tokens > MAX_TOKENS) {
                heavy.push({ repo, what: `${at} ${chunk.kind} embeds ${chunk.tokens} tokens` });
            }
            if (chunk.lineNumbers.length > MAX_LINES) {
                wide.push({
                    repo,
                    what: `${at} ${chunk.kind} cites ${chunk.lineNumbers.length} lines for ${chunk.tokens} tokens`,
                });
            }
        }
    }
    return { documents, chunks, bodies, fences, tables, heavy, wide };
}

const result = corpus ? audit(corpus) : undefined;
const say = (findings: readonly Finding[]) => findings.slice(0, 5).map((f) => f.what);

describe.skipIf(!result)('the cutter, over a thousand real READMEs', () => {
    it('read the whole corpus', () => {
        expect(result!.documents).toBeGreaterThan(900);
        expect(result!.chunks).toBeGreaterThan(20_000);
    });

    it('gives every chunk lines that exist, and covers its own body', () => {
        expect(say(result!.bodies)).toEqual([]);
    });

    it('never quotes a code block it does not also close', () => {
        expect(say(result!.fences)).toEqual([]);
    });

    it('never quotes a table row without its header and rule', () => {
        expect(say(result!.tables)).toEqual([]);
    });

    it('leaves nothing too big to hand an embedding model', () => {
        expect(say(result!.heavy)).toEqual([]);
    });

    it('rarely cites more lines than a reader would want', () => {
        // A sponsors table in raw HTML is a thousand lines of badge markup and
        // a couple of dozen words once the tags come off, so the packer, which
        // measures the words, has nothing to divide. Ratchet, not a blessing.
        expect(result!.wide.length, say(result!.wide).join('; ')).toBeLessThanOrEqual(3);
    });
});
