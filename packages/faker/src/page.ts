import { bannerArt } from '@zenera/cli/lib';
import { basename } from 'node:path';
import type { Schema } from './schema.ts';
import type { Operation, ParamSpec } from './spec.ts';

// ---------------------------------------------------------------------------
// The index page
//
// What a person does first with a mock is point a browser at it, and a 404 on
// `/` tells them nothing about what the thing is serving. So the root is a
// contents page: every operation, grouped by the document it came from, in the
// order the document declared it.
//
// It is one self-contained string — no stylesheet to fetch, no script, no
// font, nothing loaded off a network the mock may well be standing in for.
// The banner is the CLI's own art, so the page and the terminal agree about
// what this program is called.
// ---------------------------------------------------------------------------

const BRAND = { head: 'Zenera', accent: 'Faker', subtitle: 'Mock API Server' };

export function indexPage(operations: readonly Operation[]): string {
    const documents = group(operations);
    const title = `${BRAND.head} ${BRAND.accent}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
${banner()}
<p class="caption">${esc(BRAND.subtitle)}</p>
<p class="meta">${operations.length} operation${operations.length === 1 ? '' : 's'} &middot; ${documents.length} document${documents.length === 1 ? '' : 's'} &middot; <a href="/__faker/routes">routes</a> &middot; <a href="/__faker/health">health</a></p>
</header>
<main>
${documents.map(document).join('\n') || '<p class="empty">No operations are being served.</p>'}
</main>
</body>
</html>
`;
}

/** By source document, each keeping the order its document declared. */
function group(operations: readonly Operation[]): [string, Operation[]][] {
    const out = new Map<string, Operation[]>();
    for (const operation of operations) {
        const list = out.get(operation.source) ?? [];
        list.push(operation);
        out.set(operation.source, list);
    }
    return [...out];
}

function document([source, operations]: [string, Operation[]]): string {
    return `<section>
<h2>${esc(basename(source))} <span class="source">${esc(source)}</span></h2>
${operations.map(entry).join('\n')}
</section>`;
}

function entry(operation: Operation): string {
    const parts = [
        `<div class="op">`,
        `<div class="sig"><span class="verb ${operation.method}">${operation.method.toUpperCase()}</span><code class="path">${esc(operation.path)}</code><span class="id">${esc(operation.operationId)}</span></div>`,
    ];
    if (operation.summary) {
        parts.push(`<p class="summary">${esc(operation.summary)}</p>`);
    }
    if (operation.description && operation.description !== operation.summary) {
        parts.push(`<p class="about">${esc(operation.description)}</p>`);
    }
    parts.push(`<p class="answer">${esc(answer(operation))}</p>`);
    if (operation.params.length > 0 || operation.requestBody) {
        parts.push(
            `<div class="rows"><table class="params">${rows(operation).join('')}</table></div>`,
        );
    }
    parts.push('</div>');
    return parts.join('\n');
}

/** The one line that says what a call gets back. */
function answer(operation: Operation): string {
    const body = operation.success.schema ? typeOf(operation.success.schema) : 'no body';
    const paged = operation.paging
        ? ` · pages by ${operation.paging.param}${operation.paging.next ? ` → ${operation.paging.next}` : ''}`
        : '';
    return `→ ${operation.success.status} ${body}${paged}`;
}

function rows(operation: Operation): string[] {
    const out = operation.params.map(
        (p: ParamSpec) =>
            `<tr><td class="name">${esc(p.name)}</td><td class="in">${esc(p.in)}</td><td class="type">${esc(typeOf(p.schema))}</td><td class="need">${p.required ? 'required' : ''}</td><td class="note">${esc(p.description ?? '')}</td></tr>`,
    );
    if (operation.requestBody) {
        out.push(
            `<tr><td class="name">body</td><td class="in">body</td><td class="type">${esc(typeOf(operation.requestBody.schema))}</td><td class="need">${operation.requestBody.required ? 'required' : ''}</td><td class="note"></td></tr>`,
        );
    }
    return out;
}

/** A schema in as many words as fit in a column: the shape, not the contract. */
function typeOf(schema: Schema, root: Schema = schema, depth = 0): string {
    const node = deref(schema, root);
    const type = Array.isArray(node.type) ? node.type.join(' | ') : node.type;
    if (type === 'array' && depth < 3) {
        const items = node.items;
        return `${isObject(items) ? typeOf(items, root, depth + 1) : 'any'}[]`;
    }
    if (Array.isArray(node.enum)) {
        return brief(
            node.enum.map((v) => String(v)),
            ' | ',
        );
    }
    if (isObject(node.properties)) {
        return `object { ${brief(Object.keys(node.properties), ', ')} }`;
    }
    if (typeof type === 'string') {
        return `${type}${typeof node.format === 'string' ? ` <${node.format}>` : ''}`;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        if (Array.isArray(node[key])) {
            return key;
        }
    }
    return 'any';
}

/**
 * Anything shared or recursive was hoisted into `$defs` under a made-up name,
 * so the pointer says nothing and the shape it points at says everything.
 */
function deref(schema: Schema, root: Schema, hops = 0): Schema {
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !ref.startsWith(DEFS) || hops >= 4) {
        return schema;
    }
    const defs = root.$defs;
    if (!isObject(defs)) {
        return schema;
    }
    const target = defs[ref.slice(DEFS.length)];
    return isObject(target) ? deref(target, root, hops + 1) : schema;
}

const DEFS = '#/$defs/';

/** A list cut short: a contents page is not the document. */
const brief = (values: string[], sep: string): string =>
    values.slice(0, MOST).join(sep) + (values.length > MOST ? `${sep}…` : '');

const MOST = 6;

const isObject = (v: unknown): v is Schema =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** The CLI's block face, split at the word so the accent keeps its colour. */
function banner(): string {
    const { head, accent } = bannerArt(BRAND);
    const rows = head.map(
        (row, i) =>
            `<span class="head">${paint(row)}</span>   <span class="accent">${paint(accent[i] ?? '')}</span>`,
    );
    return `<pre class="banner" role="img" aria-label="${esc(`${BRAND.head} ${BRAND.accent}`)}">${rows.join('\n')}</pre>`;
}

/**
 * Stroke and bevel, the terminal's two tones. Without the darker bevel the
 * letter reads as a doubled outline rather than as a raised face.
 */
const paint = (row: string): string =>
    row.replace(/[█▀▄]+|[^█▀▄ ]+/g, (run) =>
        /[█▀▄]/.test(run) ? `<b>${run}</b>` : `<i>${run}</i>`,
    );

const esc = (s: string): string =>
    s.replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );

// The two schemes are the terminal's two, and the accent is the same mint the
// `zen faker` banner is painted in on both.
const CSS = `
:root {
  color-scheme: dark light;
  --bg: #12131a; --fg: #e6e7ee; --dim: #8b8fa3; --line: #262838;
  --card: #191b25; --accent: #87ffaf; --shade: #5fd787;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #fbfbfd; --fg: #1d1f2a; --dim: #6a6e80; --line: #e2e3ec;
          --card: #ffffff; --accent: #14915a; --shade: #0f7548; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 0 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main { width: 90%; margin: 0 auto; }
.banner { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  margin: 0; overflow-x: auto; }
.banner b, .banner i { font: inherit; }
.banner .head b { color: var(--fg); }
.banner .head i { color: var(--dim); }
.banner .accent b { color: var(--accent); }
.banner .accent i { color: var(--shade); }
.caption { margin: .75rem 0 0; color: var(--dim); letter-spacing: .35em;
  text-transform: uppercase; font-size: 11px; }
.meta { margin: .35rem 0 2.5rem; color: var(--dim); font-size: 13px; }
.meta a { color: var(--shade); text-decoration: none; }
.meta a:hover { text-decoration: underline; }
h2 { font-size: 14px; font-weight: 600; margin: 2.5rem 0 .75rem;
  padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
h2 .source { font-weight: 400; color: var(--dim); font-size: 12px; margin-left: .5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.op { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: .8rem 1rem; margin: .5rem 0; }
.sig { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.verb { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em;
  padding: .3rem .45rem; border-radius: 4px; color: #0c0d12; background: var(--dim); }
.verb.get { background: #87ffaf; } .verb.post { background: #7fbcff; }
.verb.put { background: #ffd479; } .verb.patch { background: #d3a6ff; }
.verb.delete { background: #ff8f8f; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  overflow-wrap: anywhere; }
.id { color: var(--dim); font-size: 12px; margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.summary { margin: .5rem 0 0; }
.about { margin: .3rem 0 0; color: var(--dim); font-size: 13px; white-space: pre-wrap;
  overflow-wrap: anywhere; }
.answer { margin: .5rem 0 0; color: var(--shade); font-size: 12px; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.rows { overflow-x: auto; }
.params { margin: .6rem 0 0; border-collapse: collapse; width: 100%; font-size: 12px; }
.params td { padding: .2rem .5rem .2rem 0; vertical-align: top; overflow-wrap: break-word;
  border-top: 1px solid var(--line); }
.params .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.params .in, .params .need { color: var(--dim); white-space: nowrap; }
.params .type { color: var(--dim); max-width: 18rem; overflow-wrap: anywhere; }
.params .note { color: var(--dim); width: 50%; }
.empty { color: var(--dim); }
`;
