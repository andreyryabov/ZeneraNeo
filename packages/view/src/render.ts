import type { Element, ElementContent, Root, RootContent } from 'hast';
import { common, createLowlight } from 'lowlight';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { isHidden } from './paths.ts';
import type { Heading, View } from './types.ts';

// ---------------------------------------------------------------------------
// From a file to a tree the page can draw
//
// Everything becomes hast: markdown through remark and a sanitizer, code
// through lowlight, a directory as a table. The browser never parses anything
// and never sees raw HTML - it turns elements into React elements, so a file
// that changed by one number repaints one text node.
// ---------------------------------------------------------------------------

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const SNIFF_BYTES = 8192;

const lowlight = createLowlight(common);

const LANGUAGE: Record<string, string> = {
    '.json': 'json',
    '.jsonl': 'json',
    '.ndjson': 'json',
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.patch': 'diff',
    '.diff': 'diff',
    '.toml': 'ini',
    '.ini': 'ini',
    '.css': 'css',
    '.scss': 'scss',
    '.xml': 'xml',
    '.sql': 'sql',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.lua': 'lua',
    '.swift': 'swift',
    '.graphql': 'graphql',
};

const NAMED: Record<string, string> = { makefile: 'makefile', dockerfile: 'bash' };

const MARKDOWN = new Set(['.md', '.markdown']);
const MERMAID = new Set(['.mmd', '.mermaid']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);
/** Documents the browser shows better itself; the server hands them over raw. */
export const NATIVE = new Set([...IMAGE, '.html', '.htm', '.svg', '.pdf']);

export interface RenderOptions {
    maxBytes?: number;
    hidden?: boolean;
}

export function languageOf(file: string): string | undefined {
    return LANGUAGE[extname(file).toLowerCase()] ?? NAMED[basename(file).toLowerCase()];
}

/** Whether `path` is something the page draws, rather than a file handed over as it is. */
export function drawn(file: string): boolean {
    return !NATIVE.has(extname(file).toLowerCase());
}

export function renderPath(abs: string, path: string, options: RenderOptions = {}): View {
    const name = path === '/' ? '/' : basename(path);
    let stat;
    try {
        stat = statSync(abs);
    } catch {
        return {
            path,
            kind: 'missing',
            title: name,
            toc: [],
            hast: root([
                el('p', { className: ['note'] }, [
                    txt('Not there yet. This page fills in when it is written.'),
                ]),
            ]),
        };
    }
    if (stat.isDirectory()) {
        return {
            path,
            kind: 'directory',
            title: name,
            toc: [],
            hast: listing(abs, path, options),
            mtimeMs: stat.mtimeMs,
        };
    }
    const max = options.maxBytes ?? MAX_BYTES;
    const { bytes, text } = readHead(abs, max);
    const base = {
        path,
        title: name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(stat.size > max ? { truncated: { shown: max, bytes: stat.size } } : {}),
    };
    const ext = extname(abs).toLowerCase();
    if (NATIVE.has(ext) || (!MARKDOWN.has(ext) && binary(bytes))) {
        const href = `${encodeURIComponent(basename(abs))}?raw`;
        const shown: ElementContent = IMAGE.has(ext)
            ? el('img', { src: href, alt: name })
            : el('a', { href, target: '_blank' }, [txt(`open ${name}`)]);
        return { ...base, kind: 'binary', toc: [], hast: root([el('p', {}, [shown])]) };
    }
    if (MARKDOWN.has(ext)) {
        const hast = markdown(text);
        const toc = headings(hast);
        return {
            ...base,
            kind: 'markdown',
            title: toc.find((h) => h.depth === 1)?.text ?? name,
            toc,
            hast,
        };
    }
    if (MERMAID.has(ext)) {
        return {
            ...base,
            kind: 'mermaid',
            toc: [],
            hast: root([codeBlock(text, 'mermaid', false)]),
        };
    }
    const language = languageOf(abs);
    return {
        ...base,
        kind: language ? 'code' : 'text',
        ...(language ? { language } : {}),
        toc: [],
        hast: root([codeBlock(text, language ?? 'plaintext', true)]),
    };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Raw HTML is dropped, except `<br>`: the one way a markdown table cell holds several lines. */
const lineBreak = (_state: unknown, node: { value: string }): Element | undefined =>
    /^<br\s*\/?>$/i.test(node.value.trim())
        ? { type: 'element', tagName: 'br', properties: {}, children: [] }
        : undefined;

/** Sanitize before the slugs, so heading ids keep GitHub's form and links to them land. */
const pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { handlers: { html: lineBreak } })
    .use(rehypeSanitize)
    .use(rehypeSlug)
    .use(() => highlightBlocks);

export function markdown(text: string): Root {
    const tree = pipeline.runSync(pipeline.parse(text)) as Root;
    tidy(tree);
    walk(tree, lineCell);
    return tree;
}

/**
 * A table cell of `<br>`-separated lines - a trailing `<br>` alone counts - is a list:
 * one row per line, cut at the column's width by the stylesheet, whole in its tooltip.
 */
function lineCell(cell: Element): void {
    if (
        (cell.tagName !== 'td' && cell.tagName !== 'th') ||
        !cell.children.some((c) => c.type === 'element' && c.tagName === 'br')
    ) {
        return;
    }
    const lines: ElementContent[][] = [[]];
    for (const c of cell.children) {
        if (c.type === 'element' && c.tagName === 'br') {
            lines.push([]);
        } else {
            lines.at(-1)!.push(c);
        }
    }
    cell.properties.className = [...classes(cell), 'lines'];
    cell.children = lines
        .filter((l) => l.some((c) => c.type !== 'text' || c.value.trim() !== ''))
        .map((children) => {
            const line: Element = {
                type: 'element',
                tagName: 'div',
                properties: { className: ['line'] },
                children,
            };
            line.properties.title = textOf(line).trim();
            return line;
        });
}

const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);

/** Source positions are most of the bytes sent and the page needs none of them. */
function tidy(node: Root | Element): void {
    delete node.position;
    if (node.type === 'element' && TABLE_PARTS.has(node.tagName)) {
        node.children = node.children.filter((c) => c.type !== 'text' || c.value.trim() !== '');
    }
    for (const child of node.children) {
        if (child.type === 'element') {
            tidy(child);
        } else {
            delete child.position;
        }
    }
}

function highlightBlocks(tree: Root): void {
    walk(tree, (node) => {
        if (node.tagName !== 'pre') {
            return;
        }
        const code = node.children.find(
            (c): c is Element => c.type === 'element' && c.tagName === 'code',
        );
        const lang = classes(code)
            .find((c) => c.startsWith('language-'))
            ?.slice('language-'.length);
        if (!code || !lang || lang === 'mermaid' || !lowlight.registered(lang)) {
            return;
        }
        code.children = lowlight.highlight(lang, textOf(code)).children as ElementContent[];
        code.properties.className = [...classes(code), 'hljs'];
    });
}

function headings(tree: Root): Heading[] {
    const out: Heading[] = [];
    walk(tree, (node) => {
        const depth = /^h([1-3])$/.exec(node.tagName)?.[1];
        const id = node.properties.id;
        if (depth && typeof id === 'string') {
            out.push({ depth: Number(depth), id, text: textOf(node).trim() });
        }
    });
    return out;
}

// ---------------------------------------------------------------------------
// Code, text, directories
// ---------------------------------------------------------------------------

function codeBlock(text: string, language: string, highlight: boolean): Element {
    const children: ElementContent[] =
        highlight && language !== 'plaintext' && lowlight.registered(language)
            ? (lowlight.highlight(language, text).children as ElementContent[])
            : [txt(text)];
    return el('pre', {}, [el('code', { className: ['hljs', `language-${language}`] }, children)]);
}

function listing(abs: string, path: string, options: RenderOptions): Root {
    const here = path === '/' ? '' : path;
    const rows: Element[] = [];
    if (path !== '/') {
        rows.push(
            row(
                el('a', { href: `${here.slice(0, here.lastIndexOf('/')) || '/'}` }, [txt('..')]),
                '',
                '',
            ),
        );
    }
    let names: { name: string; dir: boolean; size: number; mtimeMs: number }[] = [];
    try {
        names = readdirSync(abs, { withFileTypes: true })
            .filter((d) => !isHidden(d.name, options.hidden ?? false))
            .slice(0, MAX_ENTRIES)
            .map((d) => {
                try {
                    const s = statSync(join(abs, d.name));
                    return { name: d.name, dir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
                } catch {
                    return { name: d.name, dir: d.isDirectory(), size: 0, mtimeMs: 0 };
                }
            });
    } catch {
        // Unreadable: an empty listing says as much.
    }
    names.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    for (const n of names) {
        const href = `${here}/${encodeURIComponent(n.name)}${n.dir ? '/' : ''}`;
        rows.push(
            row(
                el('a', { href }, [txt(n.dir ? `${n.name}/` : n.name)]),
                n.dir ? '' : size(n.size),
                stamp(n.mtimeMs),
            ),
        );
    }
    return root([
        el('table', { className: ['listing'] }, [
            el('thead', {}, [
                el(
                    'tr',
                    {},
                    ['name', 'size', 'modified'].map((h) => el('th', {}, [txt(h)])),
                ),
            ]),
            el('tbody', {}, rows),
        ]),
    ]);
}

const row = (name: Element, bytes: string, at: string): Element =>
    el('tr', {}, [
        el('td', {}, [name]),
        el('td', { className: ['num'] }, [txt(bytes)]),
        el('td', {}, [txt(at)]),
    ]);

function size(n: number): string {
    if (n < 1000) {
        return `${n} B`;
    }
    const units = ['kB', 'MB', 'GB'];
    let v = n / 1000;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function stamp(ms: number): string {
    if (!ms) {
        return '';
    }
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readHead(abs: string, max: number): { bytes: Buffer; text: string } {
    const fd = openSync(abs, 'r');
    try {
        const buf = Buffer.alloc(max);
        let n = 0;
        for (let got = -1; got !== 0 && n < max; n += got) {
            got = readSync(fd, buf, n, max - n, null);
        }
        const bytes = buf.subarray(0, n);
        return { bytes, text: new TextDecoder().decode(bytes) };
    } finally {
        closeSync(fd);
    }
}

function binary(bytes: Buffer): boolean {
    return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

// ---------------------------------------------------------------------------
// hast helpers
// ---------------------------------------------------------------------------

const root = (children: RootContent[]): Root => ({ type: 'root', children });

const el = (
    tagName: string,
    properties: Element['properties'] = {},
    children: ElementContent[] = [],
): Element => ({
    type: 'element',
    tagName,
    properties,
    children,
});

const txt = (value: string): ElementContent => ({ type: 'text', value });

function classes(node: Element | undefined): string[] {
    const c = node?.properties.className;
    return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? (c as string).split(' ') : [];
}

function walk(node: Root | Element, visit: (el: Element) => void): void {
    for (const child of node.children) {
        if (child.type === 'element') {
            visit(child);
            walk(child, visit);
        }
    }
}

function textOf(node: Element | Root): string {
    let out = '';
    for (const child of node.children) {
        if (child.type === 'text') {
            out += child.value;
        } else if (child.type === 'element') {
            out += textOf(child);
        }
    }
    return out;
}
