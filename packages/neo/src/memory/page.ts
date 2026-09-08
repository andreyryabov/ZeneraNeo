import { MERMAID_URL } from '../inspect/report.ts';
import type { MemoryReport } from './report.ts';

// ---------------------------------------------------------------------------
// The memory, as one page
//
// A debugging tool, and it is shaped like the question being asked of it:
// *why did the agent recall that?* So the whole graph is here, unmasked and
// unranked, and the three panes are the three halves of an answer — which
// nodes exist, how they are joined, and what one of them actually says.
//
// Everything is a single file with no server behind it, which is what makes it
// mailable: `zen memory export` produces something you can attach to a bug.
// The only network it does is Mermaid, and the page degrades to a working list
// and detail view when that fails.
//
// Escaping follows the run report exactly, because the content here is no less
// hostile: node text and remembered files are model output. Data reaches the
// document only inside an inert `application/json` block, and only ever leaves
// it through `textContent`.
// ---------------------------------------------------------------------------

/** Pinned once, in the run inspector, and shared so the two pages cannot drift. */
export interface PageOptions {
    mermaidUrl?: string;
}

/** Report → one standalone HTML document. */
export function renderMemoryHtml(report: MemoryReport, opts: PageOptions = {}): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header id="head"></header>
<main>
  <aside id="side">
    <div class="pad">
      <input id="q" type="search" placeholder="search text, id, metadata…" autocomplete="off">
      <div class="filters">
        <select id="kind"><option value="">every kind</option></select>
        <select id="aud"><option value="">every audience</option></select>
      </div>
      <div class="filters">
        <label><input type="checkbox" id="files"> files only</label>
        <label><input type="checkbox" id="stale"> superseded</label>
        <label><input type="checkbox" id="orphans"> unlinked</label>
      </div>
    </div>
    <ol id="list"></ol>
  </aside>
  <section id="middle">
    <div class="gtools">
      <button data-zoom="out" title="zoom out">−</button>
      <button data-zoom="in" title="zoom in">+</button>
      <button data-zoom="fit" title="fit to window">fit</button>
      <button data-zoom="reset" title="actual size">1:1</button>
      <select id="focus" title="how much of the graph to draw">
        <option value="all">whole graph</option>
        <option value="0">selection only</option>
        <option value="1">1 hop from selection</option>
        <option value="2">2 hops from selection</option>
        <option value="3">3 hops from selection</option>
        <option value="4">4 hops from selection</option>
        <option value="5">5 hops from selection</option>
      </select>
      <span class="hint" id="gcount"></span>
      <span class="hint lvl">100%</span>
    </div>
    <div class="viewport"><div class="canvas"><div class="hint pad">rendering…</div></div></div>
  </section>
  <section id="detail"><div class="hint pad">Pick a node.</div></section>
</main>
<script id="memory-data" type="application/json">${embedJson(report)}</script>
<script type="module">
const MERMAID_URL = ${embedJson(opts.mermaidUrl ?? MERMAID_URL)};
${CLIENT}
</script>
</body>
</html>
`;
}

/**
 * Node text and file contents are model output — untrusted by definition. Two
 * rules keep them inert: they reach the document only as JSON inside a
 * non-executable block, and the page only ever writes them through
 * `textContent`. Escaping every `<`, `>` and `&` makes the first rule
 * unbreakable: no byte sequence in a remembered file can close the script tag.
 */
function embedJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #0f1115; --panel: #161922; --line: #262b36; --fg: #d7dbe3; --dim: #8a92a6;
  --accent: #6ea8fe; --ok: #4ec9a0; --err: #f0776c; --warn: #e2b341;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 600; }
header .kv { color: var(--dim); font-size: 12px; }
header .kv b { color: var(--fg); font-weight: 600; }
/* The middle column is the point of the page, so it is the one that keeps its
   space: minmax(0,...) stops a wide diagram forcing the grid open, and the
   side panes give way first as the window narrows. */
main { display: grid; grid-template-columns: 300px minmax(0, 1fr) minmax(300px, 400px);
  height: calc(100vh - 49px); }
@media (max-width: 1200px) { main { grid-template-columns: 240px minmax(0, 1fr) 300px; } }
@media (max-width: 900px) {
  main { grid-template-columns: 200px minmax(0, 1fr); }
  #detail { position: fixed; top: 49px; right: 0; bottom: 0; width: min(400px, 55vw);
    box-shadow: -10px 0 30px rgba(0,0,0,.55); z-index: 5; }
}
aside { border-right: 1px solid var(--line); overflow: auto; background: var(--panel); }
.pad { padding: 10px; position: sticky; top: 0; background: var(--panel);
  border-bottom: 1px solid var(--line); }
#q { width: 100%; padding: 6px 8px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; }
.filters { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
.filters label { color: var(--dim); font-size: 12px; display: flex; gap: 4px; align-items: center; }
select { background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 6px; font-size: 12px; flex: 1; min-width: 0; }
#list { list-style: none; margin: 0; padding: 4px 0; }
#list li { padding: 7px 10px; border-left: 3px solid transparent; cursor: pointer; }
#list li:hover { background: #1c2130; }
#list li.sel { background: #1f2637; border-left-color: var(--accent); }
#list li.stale { opacity: .5; }
#list .row { display: flex; gap: 6px; align-items: baseline; }
#list .id { color: var(--dim); font: 11px var(--mono); margin-left: auto; }
#list .prev { font-size: 12px; color: var(--fg); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
#middle { display: flex; flex-direction: column; overflow: hidden; }
#detail { border-left: 1px solid var(--line); overflow: auto; background: var(--panel); }
.gtools { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--line); background: var(--panel); }
.gtools button { background: var(--bg); border: 1px solid var(--line); color: var(--fg);
  border-radius: 6px; padding: 2px 10px; cursor: pointer; font: 12px var(--mono); }
.gtools button:hover { border-color: var(--accent); }
.gtools select { flex: 0 0 auto; margin-left: 8px; }
.gtools .lvl { margin-left: auto; font-family: var(--mono); }
/* The canvas is transformed, not scrolled: panning has to work past the edges
   of the diagram, which overflow:auto would forbid. */
.viewport { flex: 1; overflow: hidden; position: relative; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.viewport.drag { cursor: grabbing; }
.canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.canvas svg { max-width: none; display: block; }
.canvas .node { cursor: pointer; }
/* Selection is a class rather than attributes written onto the shapes, so that
   deselecting is possible: the previous pick has to lose the outline without a
   redraw, and there is nothing to restore it to. */
.canvas .node.picked rect, .canvas .node.picked polygon,
.canvas .node.picked path, .canvas .node.picked circle {
  stroke: var(--accent) !important; stroke-width: 3px !important; }
.hint { color: var(--dim); font-size: 12px; }
.hint.pad { padding: 16px; position: static; border: none; background: none; }
.kind { font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; background: #232a38; color: var(--dim); }
.kind.task { background: #1e3357; color: #9dc1ff; }
.kind.plan { background: #3a2450; color: #d1a6ff; }
.kind.fact { background: #14392c; color: #8ee0c2; }
.kind.snippet { background: #1e3d33; color: #8ee0c2; }
.kind.file { background: #40331a; color: #f0dfb4; }
.kind.operation { background: #3d2a1b; color: #f2d9c2; }
.kind.preference { background: #3d1f2c; color: #f5b8cd; }
#detail .body { padding: 16px; }
.dt { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; }
.idrow { display: flex; gap: 8px; align-items: center; margin: 0 0 14px; }
.idrow code { flex: 1; min-width: 0; font: 12px var(--mono); color: var(--fg);
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 4px 8px; word-break: break-all; }
.idrow button { flex: 0 0 auto; background: var(--bg); border: 1px solid var(--line);
  color: var(--dim); border-radius: 6px; padding: 4px 9px; font: 11px var(--mono);
  cursor: pointer; }
.idrow button:hover { border-color: var(--accent); color: var(--fg); }
/* Two columns, so the values line up and the eye can run down them; a wrapping
   row of key-value pairs made every field look like part of the one before. */
dl.props { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 14px;
  margin: 0 0 14px; font: 12px var(--mono); }
dl.props dt { color: var(--dim); }
dl.props dd { margin: 0; word-break: break-word; }
section.blk { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px;
  background: var(--bg); overflow: hidden; }
section.blk > h3 { margin: 0; padding: 7px 12px; font-size: 12px; font-weight: 600;
  color: var(--dim); border-bottom: 1px solid var(--line); letter-spacing: .03em; }
section.blk > h3 .tag { float: right; font-weight: 400; text-transform: none; }
pre { margin: 0; padding: 10px 12px; font: 12px/1.55 var(--mono); white-space: pre-wrap;
  word-break: break-word; overflow-wrap: anywhere; }
img.media { display: block; max-width: 100%; margin: 10px 12px; border: 1px solid var(--line);
  border-radius: 6px; background: #0d1017; }
.empty { padding: 10px 12px; color: var(--dim); font-size: 12px; font-style: italic; }
ul.links { list-style: none; margin: 0; padding: 0; }
ul.links li { display: grid; grid-template-columns: 96px auto minmax(0, 1fr); gap: 8px;
  align-items: baseline; padding: 6px 12px; }
ul.links li + li { border-top: 1px solid var(--line); }
ul.links .rel { font: 11px var(--mono); color: var(--warn); white-space: nowrap; }
button.link { background: none; border: none; color: var(--accent); cursor: pointer;
  font: 12px/1.4 system-ui, sans-serif; padding: 0; text-align: left;
  overflow-wrap: anywhere; }
button.link:hover { text-decoration: underline; }
.badge { font: 11px var(--mono); color: var(--dim); }
.badge.warn { color: var(--warn); }
`;

// ---------------------------------------------------------------------------
// The client
//
// Plain ES2015 in a module, no build step and no dependencies but Mermaid.
// Written with string concatenation rather than template literals only because
// it lives inside one.
// ---------------------------------------------------------------------------

const CLIENT = String.raw`
const DATA = JSON.parse(document.getElementById('memory-data').textContent);
const NODES = DATA.nodes;
const EDGES = DATA.edges;
const BY_ID = new Map(NODES.map(function (n) { return [n.id, n]; }));

// Short synthetic keys, stable across redraws, because a Mermaid id has to
// survive being pasted into a DOM id and read back out of one.
const KEY = new Map();
const ID = new Map();
NODES.forEach(function (n, i) { KEY.set(n.id, 'n' + i); ID.set('n' + i, n.id); });

const ADJ = new Map();
function adj(id) {
  if (!ADJ.has(id)) ADJ.set(id, []);
  return ADJ.get(id);
}
EDGES.forEach(function (e) {
  adj(e.source).push({ other: e.target, rel: e.relation, out: true });
  adj(e.target).push({ other: e.source, rel: e.relation, out: false });
});

let sel = null;

// --- small builders -------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function short(id) { return id.length > 10 ? id.slice(0, 4) + '…' + id.slice(-4) : id; }

function clip(s, n) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(1) + ' MiB';
}

/** Timestamps are read to answer "is this still current?", which an ISO string
 *  makes you do arithmetic for. The exact value stays, as the title. */
function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return iso || '—';
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  if (s < 5184000) return Math.round(s / 86400) + ' days ago';
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Text as at most 'max' lines of roughly 'width' characters. A diagram label is
 * one long line otherwise, and Mermaid will not break it: every node ends up as
 * wide as its sentence and the graph is unreadable at any zoom that fits.
 */
function wrap(text, width, max) {
  const words = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i].length > width ? words[i].slice(0, width - 1) + '…' : words[i];
    if (!w) continue;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else if (out.length + 1 < max) { out.push(cur); cur = w; }
    else break;
  }
  if (cur) out.push(cur);
  const last = out.length - 1;
  if (i < words.length && last >= 0 && out[last].slice(-1) !== '…') out[last] += '…';
  return out;
}

function block(title, tag) {
  const s = el('section', 'blk');
  const h = el('h3', null, title);
  if (tag) h.appendChild(el('span', 'tag', tag));
  s.appendChild(h);
  return s;
}

function textBlock(title, body, tag) {
  const s = block(title, tag);
  if (body) s.appendChild(el('pre', null, body));
  else s.appendChild(el('div', 'empty', 'empty'));
  return s;
}

function prop(list, key, value, title) {
  list.appendChild(el('dt', null, key));
  const d = el('dd', null, value);
  if (title) d.title = title;
  list.appendChild(d);
}

// --- header ---------------------------------------------------------------

(function head() {
  const h = document.getElementById('head');
  h.appendChild(el('h1', null, DATA.title));
  const bits = [
    ['nodes', String(NODES.length)],
    ['edges', String(EDGES.length)],
  ];
  if (DATA.embedding) {
    bits.push(['embedding', DATA.embedding.model + ' · ' + DATA.embedding.dimensions + 'd']);
  } else {
    bits.push(['embedding', 'none — recall falls back to term overlap']);
  }
  if (DATA.vectors) bits.push(['vectors', DATA.vectors.rows + ' rows · ' + bytes(DATA.vectors.bytes)]);
  bits.push(['dir', DATA.dir]);
  bits.forEach(function (b) {
    const s = el('span', 'kv');
    s.appendChild(document.createTextNode(b[0] + ' '));
    s.appendChild(el('b', null, b[1]));
    h.appendChild(s);
  });
  // A vector row per node is the healthy state; anything else means a commit
  // ran without an embedder and that memory cannot be found by meaning.
  if (DATA.vectors && DATA.vectors.rows !== NODES.length) {
    h.appendChild(el('span', 'badge warn',
      '⚠ ' + (NODES.length - DATA.vectors.rows) + ' node(s) have no vector'));
  }
})();

// --- filters --------------------------------------------------------------

const q = document.getElementById('q');
const kindSel = document.getElementById('kind');
const audSel = document.getElementById('aud');
const filesOnly = document.getElementById('files');
const staleOnly = document.getElementById('stale');
const orphansOnly = document.getElementById('orphans');
const focusSel = document.getElementById('focus');

DATA.kinds.forEach(function (k) { kindSel.appendChild(new Option(k, k)); });
DATA.audiences.forEach(function (a) { audSel.appendChild(new Option(a, a)); });

function matches(n) {
  if (kindSel.value && n.kind !== kindSel.value) return false;
  if (audSel.value && n.audience.indexOf(audSel.value) < 0) return false;
  if (filesOnly.checked && !n.file) return false;
  if (staleOnly.checked && !n.stale) return false;
  if (orphansOnly.checked && n.degree !== 0) return false;
  const term = q.value.trim().toLowerCase();
  if (!term) return true;
  return haystack(n).indexOf(term) >= 0;
}

function haystack(n) {
  if (n._hay == null) {
    n._hay = [n.id, n.kind, n.text, n.audience.join(' '),
      n.file ? n.file.path : '', n.metadata ? JSON.stringify(n.metadata) : '']
      .join(' ').toLowerCase();
  }
  return n._hay;
}

function visible() { return NODES.filter(matches); }

[q, kindSel, audSel, filesOnly, staleOnly, orphansOnly].forEach(function (c) {
  c.addEventListener('input', refresh);
});
focusSel.addEventListener('input', drawGraph);

// --- the list -------------------------------------------------------------

function renderList() {
  const list = document.getElementById('list');
  const rows = visible();
  list.replaceChildren();
  if (!rows.length) {
    list.appendChild(el('li', 'hint pad', NODES.length ? 'nothing matches' : 'this memory is empty'));
    return;
  }
  rows.forEach(function (n) {
    const li = el('li', n.stale ? 'stale' : null);
    li.dataset.id = n.id;
    if (n.id === sel) li.classList.add('sel');
    const row = el('div', 'row');
    row.appendChild(el('span', 'kind ' + n.kind, n.kind));
    if (n.file) row.appendChild(el('span', 'badge', '⎘ ' + n.file.format));
    row.appendChild(el('span', 'id', short(n.id)));
    li.appendChild(row);
    li.appendChild(el('div', 'prev', clip(n.text, 90)));
    li.addEventListener('click', function () { select(n.id); });
    list.appendChild(li);
  });
}

// --- the detail pane ------------------------------------------------------

function renderDetail() {
  const pane = document.getElementById('detail');
  pane.replaceChildren();
  const n = sel && BY_ID.get(sel);
  if (!n) {
    pane.appendChild(el('div', 'hint pad', 'Pick a node.'));
    return;
  }
  const body = el('div', 'body');

  const h = el('div', 'dt');
  h.appendChild(el('span', 'kind ' + n.kind, n.kind));
  if (n.file) h.appendChild(el('span', 'badge', '⎘ ' + n.file.format));
  if (n.stale) h.appendChild(el('span', 'badge warn', 'superseded'));
  body.appendChild(h);

  // The id is the thing you carry to 'zen memory show', so it is whole, on its
  // own line, and takeable in one click.
  const idrow = el('div', 'idrow');
  idrow.appendChild(el('code', null, n.id));
  const copy = el('button', null, 'copy');
  copy.addEventListener('click', function () {
    navigator.clipboard.writeText(n.id).then(function () {
      copy.textContent = 'copied';
      setTimeout(function () { copy.textContent = 'copy'; }, 1200);
    }, function () { copy.textContent = 'blocked'; });
  });
  idrow.appendChild(copy);
  body.appendChild(idrow);

  const props = el('dl', 'props');
  prop(props, 'audience', n.audience.join(', ') || '—');
  prop(props, 'recalled', n.useCount + '× · last ' + ago(n.lastUsedAt), n.lastUsedAt);
  prop(props, 'created', ago(n.createdAt), n.createdAt);
  if (n.updatedAt !== n.createdAt) prop(props, 'updated', ago(n.updatedAt), n.updatedAt);
  prop(props, 'revision', String(n.revision));
  body.appendChild(props);

  body.appendChild(textBlock('Text', n.text));

  if (n.metadata) {
    body.appendChild(textBlock('Metadata', JSON.stringify(n.metadata, null, 2)));
  }

  if (n.file) {
    const tag = n.file.path + ' · ' + bytes(n.file.bytes);
    if (n.image) {
      const s = block('File', tag);
      const img = el('img', 'media');
      img.src = n.image;
      img.alt = n.file.path;
      s.appendChild(img);
      body.appendChild(s);
    } else if (n.content != null) {
      body.appendChild(textBlock('File', n.content, tag));
    } else {
      const s = block('File', tag);
      s.appendChild(el('div', 'empty', EXCUSE[n.omitted] || 'not shown'));
      body.appendChild(s);
    }
    body.appendChild(textBlock('Digest', n.file.sha256));
  }

  const links = adj(n.id);
  const s = block('Links', String(links.length));
  if (!links.length) {
    s.appendChild(el('div', 'empty', 'nothing points here and it points nowhere'));
  } else {
    const ul = el('ul', 'links');
    // Outgoing first: PRODUCED read forwards is the story of the node, and
    // mixing the two directions made every row need reading twice.
    links.slice().sort(function (a, b) { return (a.out ? 0 : 1) - (b.out ? 0 : 1); })
      .forEach(function (l) {
        const other = BY_ID.get(l.other);
        const li = el('li');
        li.appendChild(el('span', 'rel', (l.out ? '→ ' : '← ') + l.rel));
        li.appendChild(el('span', 'kind ' + (other ? other.kind : ''), other ? other.kind : '?'));
        const b = el('button', 'link', other ? clip(other.text, 70) || short(l.other) : short(l.other));
        b.title = l.other;
        b.addEventListener('click', function () { select(l.other); });
        li.appendChild(b);
        ul.appendChild(li);
      });
    s.appendChild(ul);
  }
  body.appendChild(s);
  pane.appendChild(body);
}

const EXCUSE = {
  'too-big': 'too big to inline — read it from the memory directory',
  binary: 'binary, so there is nothing to show',
  missing: 'the graph records this file but it is not on disk',
  unreadable: 'on disk but could not be read'
};

// --- selection ------------------------------------------------------------

function select(id, fromGraph) {
  sel = id;
  renderList();
  renderDetail();
  const li = document.querySelector('#list li[data-id="' + cssEscape(id) + '"]');
  if (li) li.scrollIntoView({ block: 'nearest' });
  if (focusSel.value !== 'all') drawGraph();
  else markSelected();
  if (!fromGraph) reveal(id);
}

function cssEscape(v) { return String(v).replace(/["\\]/g, '\\$&'); }

function markSelected() {
  const key = sel && KEY.get(sel);
  document.querySelectorAll('.canvas .node').forEach(function (g) {
    g.classList.toggle('picked', keyOf(g) === key);
  });
}

/** Scrolls a node into view in the diagram, when it is drawn at all. */
function reveal(id) {
  const key = KEY.get(id);
  const g = [].find.call(document.querySelectorAll('.canvas .node'), function (x) {
    return keyOf(x) === key;
  });
  if (g) g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function refresh() {
  renderList();
  drawGraph();
}

// --- the diagram ----------------------------------------------------------

// Past this Mermaid produces something no one can read and takes a long time
// doing it. The filters and the hop focus are the way through, so the pane
// says so rather than hanging.
const MAX_GRAPH_NODES = 300;

const SHAPES = { file: ['[/', '/]'], plan: ['{{', '}}'], operation: ['([', '])'] };
const PAINTED = new Set(['task', 'plan', 'fact', 'snippet', 'file', 'operation', 'preference']);

// Labels are ids, closed-vocabulary kinds, and a clip of text stripped to a
// conservative character set: nothing a model wrote reaches the Mermaid parser
// with its punctuation intact, let alone the SVG. The ellipsis and the middle
// dot are in the set because the label is built out of them — stripping them
// turned '01M2…ERNE' into '01M2 ERNE', which reads as two words, not one id.
function safe(text) {
  return String(text).replace(/[^\w .,:!?'·…\-\/>+=()%]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * One node's label: what it is on the first line, what it says underneath.
 * Run together on a single line there was no telling the id from the kind from
 * the text, which is the whole complaint about reading these diagrams.
 */
function label(id, n) {
  const head = safe(n.kind + ' · ' + short(id)) + (n.file ? ' · ' + safe(n.file.format) : '');
  return [head].concat(wrap(n.text, 28, 3).map(safe)).join('<br/>');
}

/** The nodes to draw: what the filters left, optionally narrowed to a neighbourhood. */
function scope() {
  const shown = new Set(visible().map(function (n) { return n.id; }));
  const hops = focusSel.value;
  if (hops === 'all' || !sel) return shown;
  const keep = new Set([sel]);
  let edge = [sel];
  for (let i = 0; i < Number(hops); i++) {
    const next = [];
    edge.forEach(function (id) {
      adj(id).forEach(function (l) {
        if (!keep.has(l.other)) { keep.add(l.other); next.push(l.other); }
      });
    });
    edge = next;
  }
  return keep;
}

function diagram(ids) {
  const lines = ['graph LR'];
  lines.push('  classDef task fill:#1e3357,stroke:#3d5f9e,color:#cfe0ff;');
  lines.push('  classDef plan fill:#3a2450,stroke:#6b4b90,color:#e6d3ff;');
  lines.push('  classDef fact fill:#14392c,stroke:#2f7a5c,color:#c6f5e0;');
  lines.push('  classDef snippet fill:#1e3d33,stroke:#3d7a66,color:#c8f0e2;');
  lines.push('  classDef file fill:#40331a,stroke:#7a6535,color:#f0dfb4;');
  lines.push('  classDef operation fill:#3d2a1b,stroke:#7a5535,color:#f2d9c2;');
  lines.push('  classDef preference fill:#3d1f2c,stroke:#7a3b56,color:#f5b8cd;');
  lines.push('  classDef stale opacity:0.45,stroke-dasharray:4 3;');
  ids.forEach(function (id) {
    const n = BY_ID.get(id);
    if (!n) return;
    const k = KEY.get(id);
    const shape = SHAPES[n.kind] || ['(', ')'];
    lines.push('  ' + k + shape[0] + '"' + label(id, n) + '"' + shape[1]);
    // Kinds are configurable, so a project can have one this page has no
    // colour for; naming a class that was never defined fails the render.
    if (PAINTED.has(n.kind)) lines.push('  class ' + k + ' ' + n.kind + ';');
    if (n.stale) lines.push('  class ' + k + ' stale;');
  });
  EDGES.forEach(function (e) {
    if (!ids.has(e.source) || !ids.has(e.target)) return;
    lines.push('  ' + KEY.get(e.source) + ' -->|' + e.relation + '| ' + KEY.get(e.target));
  });
  return lines.join('\n');
}

function keyOf(g) {
  // Mermaid ids are '<renderId>-<ourKey>-<seq>'; only the key matters.
  const m = /-(n\d+)-\d+$/.exec(g.id || '');
  return m ? m[1] : null;
}

let mermaidLib = null;
function mermaid() {
  if (!mermaidLib) {
    mermaidLib = import(MERMAID_URL).then(function (m) {
      m.default.initialize({
        startOnLoad: false, theme: 'dark', securityLevel: 'strict',
        maxEdges: 20000, maxTextSize: 5000000,
        flowchart: { htmlLabels: false, nodeSpacing: 45, rankSpacing: 80, useMaxWidth: false }
      });
      return m.default;
    });
  }
  return mermaidLib;
}

const canvas = document.querySelector('.canvas');
const gcount = document.getElementById('gcount');
let drawSeq = 0;

async function drawGraph() {
  const ids = scope();
  gcount.textContent = ids.size + ' of ' + NODES.length + ' shown';
  if (!ids.size) {
    canvas.replaceChildren(el('div', 'hint pad', 'nothing to draw'));
    return;
  }
  if (ids.size > MAX_GRAPH_NODES) {
    canvas.replaceChildren(el('div', 'hint pad',
      ids.size + ' nodes is more than this pane can draw legibly. Narrow it with the'
      + ' filters on the left, or pick a node and switch to a hop view above.'));
    return;
  }
  const seq = ++drawSeq;
  let lib;
  try {
    lib = await mermaid();
  } catch (err) {
    canvas.replaceChildren(el('div', 'hint pad',
      'Mermaid could not be loaded (offline?). The list and the detail pane still work.'));
    return;
  }
  let rendered;
  try {
    rendered = await lib.render('memory-graph-' + seq, diagram(ids));
  } catch (err) {
    canvas.replaceChildren(el('pre', null, 'diagram failed: ' + err.message));
    return;
  }
  if (seq !== drawSeq) return;
  // Mermaid produced this markup from labels sanitized above; no node text and
  // no file content reaches it.
  canvas.innerHTML = rendered.svg;
  const svg = canvas.querySelector('svg');
  if (svg) {
    const box = svg.viewBox && svg.viewBox.baseVal;
    const w = (box && box.width) || svg.getBoundingClientRect().width;
    const h = (box && box.height) || svg.getBoundingClientRect().height;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
    natural = { w: w, h: h };
  }
  canvas.querySelectorAll('.node').forEach(function (g) {
    const key = keyOf(g);
    const id = key && ID.get(key);
    if (id) g.dataset.node = id;
  });
  markSelected();
  // A redraw changes how much there is to see, so a view nobody has touched
  // should follow it.
  if (auto) fit();
}

// --- pan and zoom ---------------------------------------------------------

const viewport = document.querySelector('.viewport');
const level = document.querySelector('.lvl');
let scale = 1, tx = 0, ty = 0, natural = { w: 0, h: 0 }, moved = false;
// While true the view is the page's to choose; the first manual zoom or pan
// hands it to the operator and we stop moving it under them.
let auto = true;

function applyView() {
  canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  level.textContent = Math.round(scale * 100) + '%';
}

function zoomAt(factor, cx, cy) {
  auto = false;
  const next = Math.min(4, Math.max(0.05, scale * factor));
  const k = next / scale;
  tx = cx - k * (cx - tx);
  ty = cy - k * (cy - ty);
  scale = next;
  applyView();
}

function fit() {
  if (!natural.w) return;
  const r = viewport.getBoundingClientRect();
  // A pane can be narrower than the padding it wants; clamped, because a scale
  // at or below zero renders the diagram as nothing at all.
  scale = Math.max(0.05, Math.min((r.width - 24) / natural.w, (r.height - 24) / natural.h, 1));
  tx = Math.max(0, (r.width - natural.w * scale) / 2);
  ty = 12;
  auto = true;
  applyView();
}

// The pane is a grid column, so it resizes with the window and with nothing
// else; a scale measured against its old width would be wrong from then on.
if (window.ResizeObserver) {
  new ResizeObserver(function () { if (auto) fit(); }).observe(viewport);
}

document.querySelector('.gtools').addEventListener('click', function (ev) {
  const what = ev.target.dataset && ev.target.dataset.zoom;
  if (!what) return;
  const r = viewport.getBoundingClientRect();
  if (what === 'in') zoomAt(1.25, r.width / 2, r.height / 2);
  else if (what === 'out') zoomAt(0.8, r.width / 2, r.height / 2);
  else if (what === 'fit') fit();
  else { auto = false; scale = 1; tx = 0; ty = 0; applyView(); }
});

viewport.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  const r = viewport.getBoundingClientRect();
  zoomAt(ev.deltaY < 0 ? 1.1 : 0.9, ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });

viewport.addEventListener('dblclick', fit);

let dragging = false, sx = 0, sy = 0, downOn = null;
viewport.addEventListener('pointerdown', function (ev) {
  // The node under the press is recorded here because capturing the pointer
  // retargets the click that follows onto the viewport: a listener on the node
  // itself never hears it, which is why picking one did nothing.
  downOn = ev.target && ev.target.closest ? ev.target.closest('.node') : null;
  dragging = true; moved = false; sx = ev.clientX - tx; sy = ev.clientY - ty;
  viewport.classList.add('drag');
  viewport.setPointerCapture(ev.pointerId);
});
viewport.addEventListener('pointermove', function (ev) {
  if (!dragging) return;
  const nx = ev.clientX - sx, ny = ev.clientY - sy;
  if (Math.abs(nx - tx) + Math.abs(ny - ty) > 3) { moved = true; auto = false; }
  tx = nx; ty = ny;
  applyView();
});
function endDrag(ev) {
  if (!dragging) return;
  dragging = false;
  viewport.classList.remove('drag');
  if (viewport.hasPointerCapture(ev.pointerId)) viewport.releasePointerCapture(ev.pointerId);
  // A press that did not turn into a drag is a pick.
  const hit = downOn;
  downOn = null;
  if (!moved && hit && hit.dataset.node) select(hit.dataset.node, true);
  // Let the click that ends a drag pass without selecting.
  setTimeout(function () { moved = false; }, 0);
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

// --- go -------------------------------------------------------------------

renderList();
renderDetail();
drawGraph().then(fit);
`;
