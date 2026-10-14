import type { Element, Root, RootContent } from 'hast';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { markdown, renderPath } from '../src/render.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zenera-view-render-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function all(tree: Root | Element): Element[] {
    return tree.children.flatMap((c: RootContent) => (c.type === 'element' ? [c, ...all(c)] : []));
}

const tags = (tree: Root): string[] => all(tree).map((e) => e.tagName);
const classes = (e: Element): string[] => (e.properties.className as string[] | undefined) ?? [];

describe('markdown', () => {
    it('draws GitHub tables, keeps no source positions and no whitespace inside them', () => {
        const tree = markdown('| a | b |\n| - | -: |\n| 1 | **2** |\n');
        expect(tags(tree)).toEqual(
            expect.arrayContaining(['table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong']),
        );
        expect(JSON.stringify(tree)).not.toContain('"position"');
        const table = all(tree).find((e) => e.tagName === 'table')!;
        expect(table.children.every((c) => c.type === 'element')).toBe(true);
    });

    it('leaves a mermaid fence as its source and highlights other code', () => {
        const tree = markdown(
            '```mermaid\nflowchart LR\n  A --> B\n```\n\n```python\ndef f():\n    return 1\n```\n',
        );
        const codes = all(tree).filter((e) => e.tagName === 'code');
        expect(classes(codes[0]!)).toEqual(['language-mermaid']);
        expect(codes[0]!.children).toEqual([{ type: 'text', value: 'flowchart LR\n  A --> B\n' }]);
        expect(classes(codes[1]!)).toContain('hljs');
        expect(all(codes[1]!).some((e) => classes(e).includes('hljs-keyword'))).toBe(true);
    });

    it('drops raw HTML and script links', () => {
        const tree = markdown(
            '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n',
        );
        expect(tags(tree)).not.toContain('script');
        expect(tags(tree)).not.toContain('img');
        const a = all(tree).find((e) => e.tagName === 'a');
        expect(a?.properties.href).toBeUndefined();
    });

    it('gives headings the ids GitHub does, so #links into a page land', () => {
        const tree = markdown('# Fine-tuning test50\n\n## Memory · merges\n\n## Memory · merges\n');
        const ids = all(tree)
            .filter((e) => /^h\d$/.test(e.tagName))
            .map((e) => e.properties.id);
        expect(ids).toEqual(['fine-tuning-test50', 'memory--merges', 'memory--merges-1']);
    });
});

describe('renderPath', () => {
    it('reads a markdown title and contents from the first heading', () => {
        writeFileSync(join(dir, 'STATUS.md'), '# Status\n\n## Workers\n\n### one\n\n#### deep\n');
        const view = renderPath(join(dir, 'STATUS.md'), '/STATUS.md');
        expect(view.kind).toBe('markdown');
        expect(view.title).toBe('Status');
        expect(view.toc.map((h) => [h.depth, h.id])).toEqual([
            [1, 'status'],
            [2, 'workers'],
            [3, 'one'],
        ]);
    });

    it('highlights json, jsonl and python by their extension', () => {
        writeFileSync(join(dir, 'a.json'), '{"a": [1, true]}\n');
        writeFileSync(join(dir, 'b.jsonl'), '{"a":1}\n{"b":"x"}\n');
        writeFileSync(join(dir, 'c.py'), 'import os\n');
        for (const [file, language] of [
            ['a.json', 'json'],
            ['b.jsonl', 'json'],
            ['c.py', 'python'],
        ] as const) {
            const view = renderPath(join(dir, file), `/${file}`);
            expect(view.kind).toBe('code');
            expect(view.language).toBe(language);
            expect(all(view.hast).some((e) => classes(e).some((c) => c.startsWith('hljs-')))).toBe(
                true,
            );
        }
    });

    it('shows text it has no grammar for as it is', () => {
        writeFileSync(join(dir, 'run.log'), 'line <b>one</b>\n');
        const view = renderPath(join(dir, 'run.log'), '/run.log');
        expect(view.kind).toBe('text');
        expect(JSON.stringify(view.hast)).toContain('line <b>one</b>');
    });

    it('draws a .mmd file as a diagram', () => {
        writeFileSync(join(dir, 'graph.mmd'), 'flowchart TD\n  A --> B\n');
        const view = renderPath(join(dir, 'graph.mmd'), '/graph.mmd');
        expect(view.kind).toBe('mermaid');
        expect(classes(all(view.hast).find((e) => e.tagName === 'code')!)).toEqual([
            'hljs',
            'language-mermaid',
        ]);
    });

    it('lists a directory with absolute links, hiding dotfiles', () => {
        mkdirSync(join(dir, 'list', 'cases'), { recursive: true });
        writeFileSync(join(dir, 'list', 'a b.md'), '#');
        writeFileSync(join(dir, 'list', '.env'), 'SECRET=1');
        const view = renderPath(join(dir, 'list'), '/list');
        const hrefs = all(view.hast)
            .filter((e) => e.tagName === 'a')
            .map((e) => e.properties.href);
        expect(view.kind).toBe('directory');
        expect(hrefs).toEqual(['/', '/list/cases/', '/list/a%20b.md']);
    });

    it('says a file is not there yet', () => {
        expect(renderPath(join(dir, 'nope.md'), '/nope.md').kind).toBe('missing');
    });

    it('hands binaries and images over raw', () => {
        writeFileSync(join(dir, 'blob.dat'), Buffer.from([1, 0, 2]));
        writeFileSync(join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71]));
        expect(renderPath(join(dir, 'blob.dat'), '/blob.dat').kind).toBe('binary');
        const pic = renderPath(join(dir, 'pic.png'), '/pic.png');
        expect(all(pic.hast).find((e) => e.tagName === 'img')?.properties.src).toBe('pic.png?raw');
    });

    it('renders only the head of a large file, and says so', () => {
        writeFileSync(join(dir, 'big.txt'), 'x'.repeat(5000));
        const view = renderPath(join(dir, 'big.txt'), '/big.txt', { maxBytes: 1000 });
        expect(view.truncated).toEqual({ shown: 1000, bytes: 5000 });
        expect(JSON.stringify(view.hast)).toContain(`"${'x'.repeat(1000)}"`);
    });
});
