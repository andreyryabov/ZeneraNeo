import { collectPayloads, type Payload, type PayloadResolver } from './payload.ts';
import type { AgentState } from './state.ts';

// ---------------------------------------------------------------------------
// Run inspector — a single HTML file that explains a run
//
// A state is a graph of references, which makes it cheap to store and useless
// to read. This module does the inverse of the storage design: it resolves
// every payload a run points at and inlines the whole thing into one page, so
// debugging needs no server, no store credentials and no live process — just a
// file you can open, attach to a bug report or diff against yesterday's run.
//
// The page is data-driven: all of the report travels as JSON and the rendering
// happens in the browser, so the only thing this module has to get right is the
// data and the escaping.
// ---------------------------------------------------------------------------

/** Default per-payload inline cap. Keeps one runaway tool result from turning
 *  a report into a file no editor will open. */
const MAX_BLOB_BYTES = 512 * 1024;

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

export interface ReportOptions {
    title?: string;
    /** per-payload inline cap; larger values are cut, with a visible marker */
    maxBlobBytes?: number;
    /**
     * Where the page loads Mermaid from. The diagram is the one thing the page
     * cannot carry itself without bloating past a megabyte; everything else is
     * inlined, and the timeline works with no network at all.
     */
    mermaidUrl?: string;
}

/** Everything the page needs, and nothing that needs a store to interpret. */
export interface RunReport {
    title: string;
    generatedAt: string;
    state: AgentState;
    /** sha256 → content, deduped by address exactly as in a `RunBundle` */
    blobs: Record<string, string>;
    /** addresses whose content was cut to `maxBlobBytes` */
    truncated: string[];
}

/**
 * Resolves a state into a self-describing report. Separate from rendering so a
 * caller can ship the JSON somewhere else (a service, a test fixture) instead
 * of the page.
 */
export async function buildRunReport(
    state: AgentState,
    payloads: PayloadResolver,
    opts: ReportOptions = {},
): Promise<RunReport> {
    const limit = opts.maxBlobBytes ?? MAX_BLOB_BYTES;
    const refs: Payload[] = collectPayloads(state);
    const values = await payloads.getMany(refs);
    const blobs: Record<string, string> = {};
    const truncated: string[] = [];
    for (const ref of refs) {
        const value = values.get(ref.sha256) ?? '';
        if (value.length > limit) {
            blobs[ref.sha256] = value.slice(0, limit);
            truncated.push(ref.sha256);
        } else {
            blobs[ref.sha256] = value;
        }
    }
    return {
        title: opts.title ?? `Run ${state.runId}`,
        generatedAt: new Date().toISOString(),
        state,
        blobs,
        truncated,
    };
}

/** Report → one standalone HTML document. */
export function renderReportHtml(report: RunReport, opts: ReportOptions = {}): string {
    return page(report, opts.mermaidUrl ?? MERMAID_URL);
}

/** The usual entry point: state in, HTML out. */
export async function renderRunReport(
    state: AgentState,
    payloads: PayloadResolver,
    opts: ReportOptions = {},
): Promise<string> {
    return renderReportHtml(await buildRunReport(state, payloads, opts), opts);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Blob content is model output and tool output — untrusted by definition. Two
 * rules keep it inert: it reaches the document only as JSON inside a non-executable
 * `application/json` block, and the page only ever writes it through
 * `textContent`. Escaping every `<`, `>` and `&` makes the first rule
 * unbreakable: no byte sequence in a payload can close the script element.
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
// The document
// ---------------------------------------------------------------------------

function page(report: RunReport, mermaidUrl: string): string {
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
    <div class="pad"><input id="filter" type="search" placeholder="filter nodes…" autocomplete="off"></div>
    <ol id="timeline"></ol>
  </aside>
  <section id="middle">
    <div class="tabs" id="viewtabs">
      <button data-view="graph" class="on">Graph</button>
      <button data-view="detail">Detail</button>
      <button data-view="stats">Stats</button>
    </div>
    <div id="graph">
      <div class="gtools" id="gtools">
        <button data-zoom="out" title="zoom out">−</button>
        <button data-zoom="in" title="zoom in">+</button>
        <button data-zoom="fit" title="fit to window (double-click the canvas)">fit</button>
        <button data-zoom="reset" title="actual size">1:1</button>
        <span class="hint">scroll to zoom · drag to pan</span>
        <span class="hint" id="zoomlvl">100%</span>
      </div>
      <div id="gviewport"><div id="gcanvas"><div class="hint pad">rendering…</div></div></div>
    </div>
    <div id="detail" hidden></div>
    <div id="stats" hidden></div>
  </section>
</main>
<script id="run-data" type="application/json">${embedJson(report)}</script>
<script type="module">
const MERMAID_URL = ${embedJson(mermaidUrl)};
${CLIENT}
</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #0f1115; --panel: #161922; --line: #262b36; --fg: #d7dbe3; --dim: #8a92a6;
  --accent: #6ea8fe; --ok: #4ec9a0; --err: #f0776c; --warn: #e2b341; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 600; }
header .kv { color: var(--dim); font-size: 12px; }
header .kv b { color: var(--fg); font-weight: 600; }
main { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 49px); }
aside { border-right: 1px solid var(--line); overflow: auto; background: var(--panel); }
.pad { padding: 10px; position: sticky; top: 0; background: var(--panel); border-bottom: 1px solid var(--line); }
#filter { width: 100%; padding: 6px 8px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; }
#timeline { list-style: none; margin: 0; padding: 4px 0; }
#timeline li { padding: 6px 10px; border-left: 3px solid transparent; cursor: pointer; }
#timeline li:hover { background: #1c2130; }
#timeline li.sel { background: #1f2637; border-left-color: var(--accent); }
#timeline li.covered { opacity: .45; }
#timeline .row { display: flex; gap: 6px; align-items: baseline; }
#timeline .t { color: var(--fg); font: 11px var(--mono); min-width: 38px; text-align: right; }
#timeline .t.same { color: #3d4453; }
#timeline .dur { margin-left: auto; color: var(--dim); font: 11px var(--mono); }
#timeline .idx { color: var(--dim); font: 11px var(--mono); min-width: 22px; }
#timeline .prev { color: var(--dim); font-size: 11px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; padding-left: 44px; }
/* Branch histories are contiguous in this list, so a coloured edge plus a
   header is enough to stop ten parallel branches reading as one long run. */
#timeline li.sep { cursor: default; padding: 10px 10px 4px; display: flex; gap: 7px;
  align-items: center; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--dim); border-left-color: transparent; }
#timeline li.sep:hover { background: none; }
#timeline li.sep .dot { width: 8px; height: 8px; border-radius: 2px;
  background: var(--bc, var(--dim)); }
/* The group header shouts in uppercase; its elapsed time should not. */
#timeline li.sep .dur { text-transform: none; letter-spacing: 0; }
/* The branch the join actually waited for. */
#timeline li.sep.slow { background: #232a38; color: var(--fg); }
#timeline li.sep.slow .dur { color: var(--fg); }
#timeline li.branch { padding-left: 20px; border-left-color: var(--bc, var(--line)); }
#timeline li.branch.sel { border-left-color: var(--bc, var(--accent)); }
#middle { display: flex; flex-direction: column; overflow: hidden; }
.tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.tabs button { background: none; border: 1px solid transparent; color: var(--dim);
  padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.tabs button.on { color: var(--fg); background: var(--panel); border-color: var(--line); }
#detail { overflow: auto; padding: 16px; flex: 1; }
#stats { overflow: auto; padding: 16px; flex: 1; }
table.st { width: 100%; border-collapse: collapse; font: 12px var(--mono); }
table.st th { text-align: right; color: var(--dim); font-weight: 600; padding: 6px 12px;
  border-bottom: 1px solid var(--line); white-space: nowrap; }
table.st td { text-align: right; padding: 5px 12px; border-bottom: 1px solid #1d2230;
  white-space: nowrap; }
table.st th:first-child, table.st td:first-child { text-align: left; }
table.st tbody tr:hover { background: #1c2130; }
table.st tbody tr:last-child td { border-bottom: none; }
/* The total is a different kind of row, not one more of the same: it gets its
   own band so nobody reads it as another model or another agent. */
table.st tfoot td { color: var(--fg); font-weight: 600; background: #191e2a;
  border-top: 1px solid #2b3346; border-bottom: none; padding: 7px 12px; }
table.st tfoot td:first-child { color: var(--dim); text-transform: uppercase;
  letter-spacing: .07em; font-size: 11px; }
#graph { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
/* An explicit display on the pane would otherwise beat the hidden attribute
   and both views would show at once. */
#graph[hidden], #detail[hidden], #stats[hidden] { display: none; }
#graph svg { max-width: none; display: block; }
#graph .node { cursor: pointer; }
.gtools { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--line); background: var(--panel); }
.gtools button { background: var(--bg); border: 1px solid var(--line); color: var(--fg);
  border-radius: 6px; padding: 2px 10px; cursor: pointer; font: 12px var(--mono); }
.gtools button:hover { border-color: var(--accent); }
.gtools .hint:first-of-type { margin-left: 8px; }
.gtools #zoomlvl { margin-left: auto; font-family: var(--mono); }
/* The canvas is transformed, not scrolled: panning has to work past the edges
   of the diagram, which overflow:auto would forbid. */
#gviewport { flex: 1; overflow: hidden; position: relative; cursor: grab; touch-action: none;
  user-select: none; -webkit-user-select: none; }
#gviewport.drag { cursor: grabbing; }
#gcanvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.hint { color: var(--dim); font-size: 12px; }
.hint.pad { padding: 16px; }
.type { font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; background: #232a38; color: var(--dim); }
.type.llm_call { background: #1e3357; color: #9dc1ff; }
.type.tool_call, .type.tool_result { background: #1e3d33; color: #8ee0c2; }
.type.compaction { background: #40331a; color: var(--warn); }
.type.fork, .type.join { background: #3a2450; color: #d1a6ff; }
.type.final_output { background: #14392c; color: var(--ok); }
.type.err { background: #4a1f1c; color: var(--err); }
h2.dt { font-size: 16px; margin: 0 0 4px; display: flex; gap: 10px; align-items: center; }
.meta { color: var(--dim); font-size: 12px; font-family: var(--mono); margin-bottom: 14px;
  display: flex; flex-wrap: wrap; gap: 4px 14px; }
section.blk { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px;
  background: var(--panel); overflow: hidden; }
section.blk > h3 { margin: 0; padding: 7px 12px; font-size: 12px; font-weight: 600;
  color: var(--dim); border-bottom: 1px solid var(--line); letter-spacing: .03em; }
section.blk > h3 .tag { float: right; font-weight: 400; }
section.blk.sys { border-left: 3px solid var(--warn); }
/* An LLM call has three things a reader wants to tell apart at a glance: what
   went in, what came back, and what it cost. Groups carry the first two. */
.group { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px;
  background: #12151d; overflow: hidden; }
.group > .ghdr { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  background: #1b2130; border-bottom: 1px solid var(--line); }
.group > .ghdr .tag { margin-left: auto; font: 11px var(--mono); font-weight: 400;
  letter-spacing: 0; text-transform: none; color: var(--dim); }
.group > .body { padding: 10px; }
.group > .body > .blk:last-child { margin-bottom: 0; }
.group.req { border-left: 3px solid var(--accent); }
.group.req > .ghdr { color: #9dc1ff; }
.group.res { border-left: 3px solid var(--ok); }
.group.res > .ghdr { color: #8ee0c2; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  padding: 3px 12px; font: 12px var(--mono); color: var(--dim); }
.stat b { color: var(--fg); font-weight: 600; }
pre { margin: 0; padding: 10px 12px; font: 12px/1.55 var(--mono); white-space: pre-wrap;
  word-break: break-word; overflow-wrap: anywhere; }
pre.text { white-space: pre-wrap; }
.msg { border-top: 1px solid var(--line); border-left: 3px solid transparent; }
.msg:first-of-type { border-top: none; }
.msg > .role { padding: 5px 12px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .05em; color: var(--dim); background: #1b202c;
  display: flex; justify-content: space-between; }
.msg.user > .role { color: #9dc1ff; }
.msg.user { border-left-color: #35507f; }
.msg.assistant > .role { color: #c3a6ff; }
.msg.assistant { border-left-color: #5a4380; }
.msg.tool > .role { color: #8ee0c2; }
.msg.tool { border-left-color: #2f6b58; }
.msg.system > .role { color: var(--warn); }
.msg.system { border-left-color: #7a6535; }
.msg.err > .role { color: var(--err); }
.msg.err { border-left-color: #8a3a33; }
.call { border-top: 1px dashed var(--line); }
.call .name { padding: 5px 12px; font: 12px var(--mono); color: #8ee0c2; }
details > summary { cursor: pointer; padding: 6px 12px; color: var(--dim); font-size: 12px; }
.badge { font: 11px var(--mono); color: var(--dim); }
.badge.ok { color: var(--ok); } .badge.bad { color: var(--err); }
.empty { padding: 10px 12px; color: var(--dim); font-size: 12px; font-style: italic; }
button.link { background: none; border: none; color: var(--accent); cursor: pointer;
  font: 12px var(--mono); padding: 0 6px 0 0; }
`;

/**
 * The page's brain. Written without template literals so that nothing here has
 * to be escaped when it is embedded, and so the file stays greppable.
 */
const CLIENT = `
const DATA = JSON.parse(document.getElementById('run-data').textContent);
const STATE = DATA.state;
const BLOBS = DATA.blobs;
const CUT = new Set(DATA.truncated || []);

// --- payload access -------------------------------------------------------

function blob(ref) {
  if (!ref || typeof ref.sha256 !== 'string') return '';
  const v = BLOBS[ref.sha256];
  if (v === undefined) return '[payload not resolved: ' + ref.sha256.slice(0, 12) + ']';
  return CUT.has(ref.sha256) ? v + '\\n\\n[… truncated, ' + ref.size + ' bytes total]' : v;
}

function pretty(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return raw; }
}

// --- flatten the trajectory ----------------------------------------------

const ENTRIES = [];
const BY_KEY = new Map();

function covered(nodes) {
  const out = new Set();
  for (const n of nodes) if (n.type === 'compaction') for (const id of n.covers) out.add(id);
  return out;
}

function flatten(nodes, depth, branch) {
  const hidden = covered(nodes);
  const level = [];
  for (const node of nodes) {
    const e = {
      key: '', node: node, depth: depth, branch: branch,
      covered: hidden.has(node.id), children: []
    };
    // A join's branches ran between the fork and the join, so they are
    // numbered and listed there — which means recursing before this entry
    // takes its own number.
    if (node.type === 'join') {
      for (const b of node.branches) e.children.push({ name: b.name, entries: flatten(b.nodes, depth + 1, b.name) });
    }
    e.key = 'n' + ENTRIES.length;
    ENTRIES.push(e); BY_KEY.set(e.key, e); level.push(e);
  }
  return level;
}
const ROOT = flatten(STATE.trajectory, 0, null);

// --- labels ---------------------------------------------------------------

function names(list) { return list.join(', '); }

function base(path) { return path.split('/').pop() || path; }

function label(n) {
  switch (n.type) {
    case 'user_input': return n.synthetic ? 'user input (synthetic)' : 'user input';
    case 'system_prompt': return 'system prompt'
      + (n.sources && n.sources.length ? ': ' + names(n.sources.map(function (s) { return base(s.path); })) : '');
    case 'load_skills': return 'skills: ' + names(n.skills.map(function (s) { return s.name; }));
    case 'memory_recall': return 'memory recall: ' + n.scope;
    case 'memory_op': return 'memory ' + n.op;
    case 'llm_call': return 'llm: ' + n.model + (n.toolCalls.length
      ? ' -> ' + names(n.toolCalls.map(function (c) { return c.name; })) : '');
    case 'tool_call': return 'call: ' + n.name;
    case 'tool_result': return 'result: ' + n.name + (n.isError ? ' (error)' : '');
    case 'handoff': return 'handoff: ' + n.from + ' -> ' + n.to;
    case 'fork': return 'fork: ' + names(n.branches.map(function (b) { return b.name; }));
    case 'join': return 'join: ' + names(n.branches.map(function (b) { return b.name + '=' + b.status; }));
    case 'compaction': return 'compaction: ' + n.reason + ' (' + n.covers.length + ' nodes)';
    case 'final_output': return 'final output';
    default: return n.type;
  }
}

function preview(n) {
  switch (n.type) {
    case 'user_input': {
      const t = n.content.find(function (p) { return p.type === 'text'; });
      return t ? blob(t.text) : '';
    }
    case 'system_prompt': return blob(n.prompt);
    case 'llm_call': return blob(n.text);
    case 'tool_call': return blob(n.args);
    case 'tool_result': return blob(n.result);
    case 'compaction': return blob(n.summary);
    case 'final_output': return blob(n.output);
    case 'memory_recall': return blob(n.content);
    case 'load_skills': return blob(n.content);
    default: return '';
  }
}

// --- DOM helpers ----------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
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
  if (body) s.appendChild(el('pre', 'text', body));
  else s.appendChild(el('div', 'empty', '(empty)'));
  return s;
}

function foldBlock(title, body) {
  const s = block(title);
  const d = document.createElement('details');
  d.appendChild(el('summary', null, 'show'));
  d.appendChild(el('pre', null, body));
  s.appendChild(d);
  return s;
}

// A titled container for several blocks. Returns the element to append and the
// body to fill, so callers never have to know the internal structure.
function group(title, kind, tag) {
  const s = el('section', 'group ' + kind);
  const h = el('div', 'ghdr', title);
  if (tag) h.appendChild(el('span', 'tag', tag));
  s.appendChild(h);
  const body = el('div', 'body');
  s.appendChild(body);
  return { el: s, body: body };
}

function stat(key, value) {
  const d = el('span', 'stat', key + ' ');
  d.appendChild(el('b', null, value));
  return d;
}

// --- header ---------------------------------------------------------------

function kv(key, value) {
  const d = el('div', 'kv');
  d.appendChild(document.createTextNode(key + ' '));
  d.appendChild(el('b', null, value));
  return d;
}

(function head() {
  const h = document.getElementById('head');
  const u = STATE.usage || {};
  const llm = ENTRIES.filter(function (e) { return e.node.type === 'llm_call'; }).length;
  h.appendChild(el('h1', null, DATA.title));
  h.appendChild(kv('run', STATE.runId));
  h.appendChild(kv('agent', STATE.agentName));
  h.appendChild(kv('phase', STATE.phase));
  h.appendChild(kv('nodes', ENTRIES.length));
  h.appendChild(kv('llm calls', llm));
  h.appendChild(kv('tokens', (u.inputTokens || 0) + ' in / ' + (u.outputTokens || 0) + ' out'));
  if (STATE.error) h.appendChild(kv('error', STATE.error));
  h.appendChild(kv('generated', DATA.generatedAt));
})();

// --- timing ---------------------------------------------------------------
//
// A node is stamped when it is appended, which is when the work behind it
// finished. So the interval between a node and the one before it in the same
// lane *is* that work: an llm_call's interval is the model latency, a
// tool_result's is the tool. That gives every node a start and a duration
// without storing either.
//
// Offsets are counted from the start of the turn, not of the run: in a
// follow-up the interesting question is "how long did this answer take", and
// counting from a conversation that began an hour ago answers nothing. A trunk
// user_input opens a new turn; a branch inherits the turn that forked it, so
// ten branches starting at one offset still read as parallel.

function stampOf(node) {
  const t = Date.parse(node.ts);
  return isNaN(t) ? null : t;
}

(function time(level, lanePrev, turnStart) {
  let prev = lanePrev;
  let t0 = turnStart;
  level.forEach(function (e) {
    const ts = stampOf(e.node);
    // A real user turn resets the clock and starts at itself: the gap since
    // the previous run is waiting, not work. Synthetic inputs (a branch seed,
    // a re-injection) are not turns — same rule the kernel uses.
    const opensTurn = !e.branch && e.node.type === 'user_input' && !e.node.synthetic;
    if (opensTurn) t0 = ts;
    e.turnStart = t0 === null ? ts : t0;
    e.startMs = opensTurn || prev === null ? ts : prev;
    e.endMs = ts;
    // Branches run between the fork and the join, so they start where the
    // trunk left off — and the join's own duration is the whole parallel
    // section it waited on.
    if (e.node.type === 'join') {
      let slowest = null;
      e.children.forEach(function (br) {
        time(br.entries, prev, e.turnStart);
        // The branch as a whole gets the same shape as a node — start, end,
        // turn — so a reader sees how long *it* ran instead of having to
        // subtract two offsets to find out that ten branches were parallel.
        const last = br.entries[br.entries.length - 1];
        br.turnStart = e.turnStart;
        br.startMs = prev;
        br.endMs = last ? last.endMs : prev;
        if (br.entries.length) br.entries[0].branchSpan = br;
        // The join costs exactly its slowest branch, so that branch is the
        // only one worth optimizing: it gets marked and rendered lighter.
        if (br.entries.length && (!slowest || br.endMs > slowest.endMs)) slowest = br;
      });
      if (slowest) slowest.slowest = true;
    }
    prev = ts;
  });
})(ROOT, null, null);

function fmtSecs(ms) {
  const s = ms / 1000;
  if (s < 100) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(Math.floor(s - m * 60)).padStart(2, '0');
}

/** Offset of a node's start from the beginning of its turn. */
function startedAt(e) {
  if (e.startMs === null || e.turnStart === null) return '';
  return fmtSecs(e.startMs - e.turnStart);
}

/** How long the work behind a node took. Blank when it is not worth a number. */
function took(e) {
  if (e.startMs === null || e.endMs === null) return '';
  const ms = e.endMs - e.startMs;
  if (ms < 10) return '';
  return fmtDur(ms);
}

function fmtDur(ms) {
  return ms < 1000 ? Math.round(ms) + 'ms' : fmtSecs(ms);
}

function spanMs(e) {
  return e.startMs === null || e.endMs === null ? 0 : e.endMs - e.startMs;
}

// One colour per branch, stable for the life of the page. The trunk keeps the
// neutral accent so branches are the thing that stands out.
const PALETTE = ['#6ea8fe', '#4ec9a0', '#e2b341', '#d1a6ff', '#f0776c',
  '#5fd0d8', '#f09a5c', '#a3d160', '#ef8ec0', '#9aa4ff'];
const BRANCH_COLOR = new Map();
function branchColor(name) {
  if (!name) return null;
  if (!BRANCH_COLOR.has(name)) BRANCH_COLOR.set(name, PALETTE[BRANCH_COLOR.size % PALETTE.length]);
  return BRANCH_COLOR.get(name);
}

// --- timeline -------------------------------------------------------------

const listEl = document.getElementById('timeline');
let lastBranch = false;
let lastStamp = null;

ENTRIES.forEach(function (e, i) {
  // Branch histories are contiguous in the flattened order, so a change of
  // branch is a group boundary: label it and restart the elapsed column.
  if (e.branch !== lastBranch) {
    const sep = el('li', 'sep');
    const color = branchColor(e.branch);
    if (color) sep.style.setProperty('--bc', color);
    sep.appendChild(el('span', 'dot'));
    sep.appendChild(el('span', null, e.branch ? 'branch · ' + e.branch : 'trunk'));
    if (e.branchSpan) {
      const bd = took(e.branchSpan);
      if (e.branchSpan.slowest) sep.classList.add('slow');
      if (bd) {
        sep.appendChild(el('span', 'dur',
          't+' + startedAt(e.branchSpan) + ' · ' + bd + (e.branchSpan.slowest ? ' · slowest' : '')));
      }
    }
    listEl.appendChild(sep);
    lastBranch = e.branch;
    lastStamp = null;
  }

  const li = el('li', e.branch ? 'branch' : '');
  if (e.covered) li.classList.add('covered');
  const color = branchColor(e.branch);
  if (color) li.style.setProperty('--bc', color);
  li.dataset.key = e.key;

  const row = el('div', 'row');
  // Consecutive nodes often start at the same instant (a tool call is recorded
  // the moment the response carrying it is applied). Repeating the offset
  // would only bury the moments where time actually moved.
  const at = startedAt(e);
  row.appendChild(el('span', 't' + (at === lastStamp ? ' same' : ''), at === lastStamp ? '·' : at));
  lastStamp = at;
  row.appendChild(el('span', 'idx', '#' + (i + 1)));
  const badge = el('span', 'type ' + e.node.type
    + (e.node.type === 'tool_result' && e.node.isError ? ' err' : ''), e.node.type.replace(/_/g, ' '));
  row.appendChild(badge);
  const d = took(e);
  if (d) row.appendChild(el('span', 'dur', d));
  li.appendChild(row);
  li.appendChild(el('div', 'prev', label(e.node)
    + (preview(e.node) ? ' — ' + preview(e.node).slice(0, 90) : '')));
  li.addEventListener('click', function () { select(e.key, true); });
  listEl.appendChild(li);
});

// A group header is only worth showing while something in its group is.
function applyFilter(q) {
  const rows = Array.prototype.slice.call(listEl.children);
  rows.forEach(function (li) {
    if (li.classList.contains('sep')) return;
    const e = BY_KEY.get(li.dataset.key);
    const hay = (label(e.node) + ' ' + e.node.type + ' ' + (e.branch || '')
      + ' ' + preview(e.node)).toLowerCase();
    li.hidden = q.length > 0 && hay.indexOf(q) === -1;
  });
  let sep = null, kept = false;
  rows.forEach(function (li) {
    if (li.classList.contains('sep')) {
      if (sep) sep.hidden = !kept;
      sep = li; kept = false;
    } else if (!li.hidden) kept = true;
  });
  if (sep) sep.hidden = !kept;
}

document.getElementById('filter').addEventListener('input', function (ev) {
  applyFilter(ev.target.value.toLowerCase());
});

// --- detail ---------------------------------------------------------------

function message(m) {
  const wrap = el('div', 'msg ' + m.role + (m.isError ? ' err' : ''));
  const role = el('div', 'role');
  role.appendChild(el('span', null, m.role + (m.agent ? ' · ' + m.agent : '')
    + (m.name ? ' · ' + m.name : '')));
  if (m.callId) role.appendChild(el('span', 'badge', m.callId));
  wrap.appendChild(role);

  if (m.role === 'user' && Array.isArray(m.content)) {
    m.content.forEach(function (p) {
      if (p.type === 'text') wrap.appendChild(el('pre', 'text', p.text));
      else wrap.appendChild(el('pre', 'text', '[' + p.type + '] ' + p.url));
    });
  } else if (typeof m.content === 'string' && m.content) {
    wrap.appendChild(el('pre', 'text', m.role === 'tool' ? pretty(m.content) : m.content));
  } else if (!m.toolCalls) {
    wrap.appendChild(el('div', 'empty', '(no content)'));
  }

  (m.toolCalls || []).forEach(function (c) {
    const box = el('div', 'call');
    box.appendChild(el('div', 'name', c.name + '(' + c.id + ')'));
    box.appendChild(el('pre', null, pretty(c.args)));
    wrap.appendChild(box);
  });
  return wrap;
}

function requestBlocks(raw, into) {
  let req;
  try { req = JSON.parse(raw); } catch (e) {
    into.appendChild(textBlock('Request (unparsed)', raw));
    return;
  }
  if (req.system) into.appendChild(textBlock('System prompt', req.system)).classList.add('sys');

  const conv = block('Messages', (req.messages || []).length + ' messages');
  (req.messages || []).forEach(function (m) { conv.appendChild(message(m)); });
  if (!(req.messages || []).length) conv.appendChild(el('div', 'empty', '(none)'));
  into.appendChild(conv);

  const tools = block('Tools offered', (req.tools || []).length + ' tools');
  (req.tools || []).forEach(function (t) {
    const d = document.createElement('details');
    d.appendChild(el('summary', null, t.name + (t.description ? ' — ' + t.description : '')));
    d.appendChild(el('pre', null, JSON.stringify(t.parameters, null, 2)));
    tools.appendChild(d);
  });
  if (!(req.tools || []).length) tools.appendChild(el('div', 'empty', '(none)'));
  into.appendChild(tools);
}

function usageTag(u) {
  if (!u) return '';
  return (u.inputTokens || 0) + ' in (' + (u.cachedInputTokens || 0) + ' cached) / '
    + (u.outputTokens || 0) + ' out (' + (u.reasoningTokens || 0) + ' reasoning)';
}

function detailFor(e) {
  const n = e.node;
  const out = document.createDocumentFragment();

  const h = el('h2', 'dt');
  h.appendChild(el('span', 'type ' + n.type, n.type.replace(/_/g, ' ')));
  h.appendChild(el('span', null, label(n)));
  out.appendChild(h);

  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, 'id ' + n.id));
  meta.appendChild(el('span', null, 'agent ' + n.agent));
  meta.appendChild(el('span', null, n.ts));
  meta.appendChild(el('span', null, 'started t+' + startedAt(e) + (took(e) ? ' · took ' + took(e) : '')));
  if (e.branch) {
    const br = el('span', null, 'branch ' + e.branch);
    br.style.color = branchColor(e.branch);
    meta.appendChild(br);
  }
  if (e.covered) meta.appendChild(el('span', null, 'hidden by a later compaction'));
  out.appendChild(meta);

  switch (n.type) {
    case 'system_prompt':
      out.appendChild(textBlock('Prompt', blob(n.prompt)));
      // The editable half: which file to open when the instruction is wrong.
      (n.sources || []).forEach(function (s) {
        out.appendChild(textBlock(s.path, blob(s.content), 'prompt file'));
      });
      break;

    case 'user_input':
      n.content.forEach(function (p, i) {
        out.appendChild(p.type === 'text'
          ? textBlock('Text part ' + (i + 1), blob(p.text))
          : textBlock('Media part ' + (i + 1), p.url, p.type + (p.mimeType ? ' · ' + p.mimeType : '')));
      });
      break;

    case 'load_skills':
      out.appendChild(textBlock('Skills', n.skills.map(function (s) {
        return s.name + (s.version ? '@' + s.version : '') + '  ' + s.contentHash.slice(0, 12)
          + (s.file ? '  ' + s.file : '');
      }).join('\\n'), n.provider));
      out.appendChild(textBlock('Injected instructions', blob(n.content)));
      out.appendChild(textBlock('Tools unlocked', n.toolNames.join('\\n')));
      break;

    case 'memory_recall':
      out.appendChild(textBlock('Query', JSON.stringify(n.query, null, 2), n.store + ' · ' + n.scope));
      out.appendChild(textBlock('Hits', n.hits.map(function (hit) {
        return hit.id + '  score=' + hit.score + '  rev=' + hit.revision;
      }).join('\\n')));
      out.appendChild(textBlock('Injected block', blob(n.content)));
      break;

    case 'memory_op':
      out.appendChild(textBlock('Operation',
        n.op + ' ' + n.recordId + ' (rev ' + n.revision + ')', n.store + ' · ' + n.scope));
      if (n.before) out.appendChild(textBlock('Before', blob(n.before)));
      if (n.after) out.appendChild(textBlock('After', blob(n.after)));
      break;

    case 'llm_call': {
      const u = n.usage || {};
      const strip = el('div', 'stats');
      strip.appendChild(stat('model', n.model));
      strip.appendChild(stat('in', u.inputTokens || 0));
      strip.appendChild(stat('cached', u.cachedInputTokens || 0));
      strip.appendChild(stat('out', u.outputTokens || 0));
      if (u.reasoningTokens) strip.appendChild(stat('reasoning', u.reasoningTokens));
      strip.appendChild(stat('stop', n.stopReason || '?'));
      out.appendChild(strip);

      const req = group('Request', 'req', 'sent to ' + n.model);
      if (n.request) requestBlocks(blob(n.request), req.body);
      else {
        req.body.appendChild(el('div', 'empty',
          'not recorded — construct the runner with { recordRequests: true } to capture it'));
      }
      out.appendChild(req.el);

      const res = group('Response', 'res', n.stopReason);
      if (n.thinking) res.body.appendChild(textBlock('Reasoning', blob(n.thinking)));
      res.body.appendChild(textBlock('Text', blob(n.text)));
      n.toolCalls.forEach(function (c) {
        res.body.appendChild(textBlock('Tool call · ' + c.name, pretty(blob(c.args)), c.callId));
      });
      out.appendChild(res.el);

      out.appendChild(textBlock('Request digest', n.requestDigest || '(not recorded)'));
      break;
    }

    case 'tool_call':
      out.appendChild(textBlock('Arguments', pretty(blob(n.args)), n.name + ' · ' + n.callId));
      break;

    case 'tool_result':
      out.appendChild(textBlock(n.isError ? 'Error result' : 'Result',
        pretty(blob(n.result)),
        n.name + (n.durationMs !== undefined ? ' · ' + n.durationMs + 'ms' : '')));
      break;

    case 'handoff':
      out.appendChild(textBlock('Handoff', n.from + '  ->  ' + n.to
        + (n.reason ? '\\n\\nreason: ' + n.reason : '')));
      break;

    case 'fork':
      n.branches.forEach(function (b) {
        out.appendChild(textBlock('Branch · ' + b.name, blob(b.instructions),
          b.agent + ' · ' + n.contextMode + ' · ' + b.childRunId));
      });
      break;

    case 'join':
      n.branches.forEach(function (b, i) {
        const br = e.children[i];
        const bd = br ? took(br) : '';
        out.appendChild(textBlock('Branch · ' + b.name,
          b.status === 'ok' ? blob(b.output) : (b.error || blob(b.output)),
          b.status + ' · ' + b.agent + ' · ' + b.nodes.length + ' nodes'
            + (bd ? ' · ' + bd : '') + ' · ' + usageTag(b.usage)));
      });
      break;

    case 'compaction': {
      out.appendChild(textBlock('Summary', blob(n.summary), n.reason));
      const cov = block('Replaces', n.covers.length + ' nodes');
      const line = el('div', 'empty', '');
      line.textContent = '';
      n.covers.forEach(function (id) {
        const hit = ENTRIES.find(function (x) { return x.node.id === id; });
        const b = el('button', 'link', hit ? label(hit.node) : id);
        if (hit) b.addEventListener('click', function () { select(hit.key, true); });
        line.appendChild(b);
      });
      cov.appendChild(line);
      out.appendChild(cov);
      out.appendChild(textBlock('Summarizer usage', usageTag(n.usage)));
      break;
    }

    case 'final_output':
      out.appendChild(textBlock('Output', blob(n.output)));
      if (n.parsed !== undefined) out.appendChild(textBlock('Parsed', JSON.stringify(n.parsed, null, 2)));
      break;
  }

  out.appendChild(foldBlock('Raw node', JSON.stringify(n, null, 2)));
  return out;
}

const detailEl = document.getElementById('detail');
const statsEl = document.getElementById('stats');
let selected = null;

function select(key, focus) {
  const e = BY_KEY.get(key);
  if (!e) return;
  selected = key;
  detailEl.replaceChildren(detailFor(e));
  Array.prototype.forEach.call(listEl.children, function (li) {
    li.classList.toggle('sel', li.dataset.key === key);
  });
  const li = listEl.querySelector('li[data-key="' + key + '"]');
  if (li) li.scrollIntoView({ block: 'nearest' });
  if (focus) show('detail');
  detailEl.scrollTop = 0;
}

// --- stats ----------------------------------------------------------------
//
// Tokens are not fungible across models and seconds are not fungible across
// lanes: a thousand tokens cost a different amount on a different model, and
// branch time runs in parallel with other branch time. So every number here
// is broken down by model and by agent, and the wall clock sits next to the
// sums so the gap between them is visible instead of misleading.

function bucket() {
  return { calls: 0, errors: 0, ms: 0, in: 0, cached: 0, out: 0, reasoning: 0 };
}

function bucketOf(map, key) {
  if (!map.has(key)) map.set(key, bucket());
  return map.get(key);
}

function addUsage(into, u) {
  if (!u) return;
  into.in += u.inputTokens || 0;
  into.cached += u.cachedInputTokens || 0;
  into.out += u.outputTokens || 0;
  into.reasoning += u.reasoningTokens || 0;
}

function num(n) { return n.toLocaleString('en-US'); }

function table(cols, rows, foot) {
  const t = el('table', 'st');
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  cols.forEach(function (c) { hr.appendChild(el('th', null, c)); });
  head.appendChild(hr);
  t.appendChild(head);
  const body = document.createElement('tbody');
  rows.forEach(function (r) {
    const tr = document.createElement('tr');
    r.forEach(function (v) { tr.appendChild(el('td', null, v)); });
    body.appendChild(tr);
  });
  t.appendChild(body);
  if (foot) {
    const tf = document.createElement('tfoot');
    const fr = document.createElement('tr');
    foot.forEach(function (v) { fr.appendChild(el('td', null, v)); });
    tf.appendChild(fr);
    t.appendChild(tf);
  }
  return t;
}

const TOKEN_COLS = ['calls', 'in', 'cached', 'out', 'reasoning', 'time', 'avg'];

function tokenRow(name, b) {
  return [name, num(b.calls), num(b.in), num(b.cached), num(b.out), num(b.reasoning),
    fmtDur(b.ms), b.calls ? fmtDur(b.ms / b.calls) : '—'];
}

function byTokens(a, b) { return (b[1].in + b[1].out) - (a[1].in + a[1].out); }

function buildStats() {
  const byModel = new Map(), byAgent = new Map(), byTool = new Map(), byType = new Map();
  const all = bucket();
  let llmMs = 0, toolMs = 0, toolCalls = 0, from = null, to = null;

  ENTRIES.forEach(function (e) {
    const n = e.node;
    byType.set(n.type, (byType.get(n.type) || 0) + 1);
    if (e.startMs !== null && (from === null || e.startMs < from)) from = e.startMs;
    if (e.endMs !== null && (to === null || e.endMs > to)) to = e.endMs;

    // A join's usage is the sum of its branches, whose nodes are already in
    // this list, so counting it too would double every branch token. A
    // compaction has no model of its own but did burn a summarizer.
    if (n.type === 'llm_call' || n.type === 'compaction') {
      const ms = spanMs(e);
      const model = n.type === 'compaction' ? 'summarizer' : n.model;
      [bucketOf(byModel, model), bucketOf(byAgent, n.agent), all].forEach(function (b) {
        addUsage(b, n.usage);
        b.calls += 1;
        b.ms += ms;
      });
      llmMs += ms;
      return;
    }
    // The tool's own measurement when the runner took one; the gap to the
    // previous node otherwise.
    if (n.type === 'tool_result') {
      const b = bucketOf(byTool, n.name);
      const ms = n.durationMs !== undefined ? n.durationMs : spanMs(e);
      b.calls += 1;
      b.ms += ms;
      if (n.isError) b.errors += 1;
      toolCalls += 1;
      toolMs += ms;
    }
  });

  const pills = el('div', 'stats');
  pills.appendChild(stat('wall clock', from === null ? '—' : fmtDur(to - from)));
  pills.appendChild(stat('in llm', fmtDur(llmMs)));
  pills.appendChild(stat('in tools', fmtDur(toolMs)));
  pills.appendChild(stat('llm calls', num(all.calls)));
  pills.appendChild(stat('tool calls', num(toolCalls)));
  pills.appendChild(stat('tokens', num(all.in) + ' in / ' + num(all.out) + ' out'));
  pills.appendChild(stat('cached', num(all.cached)));
  pills.appendChild(stat('nodes', num(ENTRIES.length)));
  statsEl.replaceChildren(pills);

  const note = el('div', 'hint', 'Branches run in parallel, so llm and tool time are sums '
    + 'over every lane and add up to more than the wall clock.');
  note.style.marginBottom = '14px';
  statsEl.appendChild(note);

  const models = Array.from(byModel.entries()).sort(byTokens);
  const modelBlock = block('Tokens by model', models.length + (models.length === 1 ? ' model' : ' models'));
  modelBlock.appendChild(table(['model'].concat(TOKEN_COLS),
    models.map(function (m) { return tokenRow(m[0], m[1]); }), tokenRow('total', all)));
  statsEl.appendChild(modelBlock);

  const agents = Array.from(byAgent.entries()).sort(byTokens);
  const agentBlock = block('Tokens by agent', agents.length + (agents.length === 1 ? ' agent' : ' agents'));
  agentBlock.appendChild(table(['agent'].concat(TOKEN_COLS),
    agents.map(function (a) { return tokenRow(a[0], a[1]); }), tokenRow('total', all)));
  statsEl.appendChild(agentBlock);

  const tools = Array.from(byTool.entries()).sort(function (a, b) { return b[1].ms - a[1].ms; });
  const toolBlock = block('Tool calls', num(toolCalls) + ' calls · ' + fmtDur(toolMs));
  if (tools.length) {
    toolBlock.appendChild(table(['tool', 'calls', 'errors', 'time', 'avg'],
      tools.map(function (t) {
        const b = t[1];
        return [t[0], num(b.calls), b.errors ? num(b.errors) : '', fmtDur(b.ms),
          b.calls ? fmtDur(b.ms / b.calls) : '—'];
      })));
  } else {
    toolBlock.appendChild(el('div', 'empty', '(none)'));
  }
  statsEl.appendChild(toolBlock);

  const types = Array.from(byType.entries()).sort(function (a, b) { return b[1] - a[1]; });
  const typeBlock = block('Nodes by type', num(ENTRIES.length) + ' nodes');
  typeBlock.appendChild(table(['type', 'count'],
    types.map(function (t) { return [t[0].replace(/_/g, ' '), num(t[1])]; })));
  statsEl.appendChild(typeBlock);
}

// --- views ----------------------------------------------------------------

function show(view) {
  document.getElementById('graph').hidden = view !== 'graph';
  detailEl.hidden = view !== 'detail';
  statsEl.hidden = view !== 'stats';
  Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
    b.classList.toggle('on', b.dataset.view === view);
  });
  if (view === 'graph' && pendingFit) fit();
}
Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
  b.addEventListener('click', function () { show(b.dataset.view); });
});

// --- graph zoom and pan ---------------------------------------------------
//
// The diagram grows with the run, so a fixed scale is useless past a dozen
// nodes. The canvas is moved with a CSS transform rather than scrolled: that
// keeps zooming anchored on the pointer and costs no layout.

const viewportEl = document.getElementById('gviewport');
const canvasEl = document.getElementById('gcanvas');
const zoomEl = document.getElementById('zoomlvl');
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
let zoom = 1, panX = 0, panY = 0;
let natW = 0, natH = 0;
let pendingFit = false;

function applyView() {
  canvasEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  zoomEl.textContent = Math.round(zoom * 100) + '%';
}

function zoomAt(factor, cx, cy) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const ratio = next / zoom;
  // Keep the point under the cursor fixed while the scale changes.
  panX = cx - (cx - panX) * ratio;
  panY = cy - (cy - panY) * ratio;
  zoom = next;
  applyView();
}

function zoomCenter(factor) {
  const r = viewportEl.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

function fit() {
  const r = viewportEl.getBoundingClientRect();
  if (!r.width || !natW || !natH) { pendingFit = true; return; }
  pendingFit = false;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
    Math.min((r.width - 32) / natW, (r.height - 32) / natH)));
  panX = (r.width - natW * zoom) / 2;
  panY = Math.max(16, (r.height - natH * zoom) / 2);
  applyView();
}

document.getElementById('gtools').addEventListener('click', function (ev) {
  const what = ev.target.dataset ? ev.target.dataset.zoom : null;
  if (what === 'in') zoomCenter(1.25);
  else if (what === 'out') zoomCenter(1 / 1.25);
  else if (what === 'fit') fit();
  else if (what === 'reset') { zoom = 1; panX = 16; panY = 16; applyView(); }
});

viewportEl.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  const r = viewportEl.getBoundingClientRect();
  zoomAt(Math.exp(-ev.deltaY * 0.002), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });

let dragging = false, dragMoved = false, startX = 0, startY = 0, baseX = 0, baseY = 0;

viewportEl.addEventListener('pointerdown', function (ev) {
  if (ev.button !== 0) return;
  dragging = true; dragMoved = false;
  startX = ev.clientX; startY = ev.clientY; baseX = panX; baseY = panY;
});
viewportEl.addEventListener('pointermove', function (ev) {
  if (!dragging) return;
  const dx = ev.clientX - startX, dy = ev.clientY - startY;
  if (!dragMoved) {
    if (Math.abs(dx) + Math.abs(dy) <= 4) return;
    dragMoved = true;
    // Captured only once this is a drag: capturing on pointerdown would
    // retarget the following click to the viewport and no node would ever
    // receive it.
    viewportEl.setPointerCapture(ev.pointerId);
    viewportEl.classList.add('drag');
  }
  panX = baseX + dx; panY = baseY + dy;
  applyView();
});
function endDrag(ev) {
  if (!dragging) return;
  dragging = false;
  viewportEl.classList.remove('drag');
  if (viewportEl.hasPointerCapture(ev.pointerId)) viewportEl.releasePointerCapture(ev.pointerId);
}
viewportEl.addEventListener('pointerup', endDrag);
viewportEl.addEventListener('pointercancel', endDrag);
viewportEl.addEventListener('dblclick', function () { fit(); });
window.addEventListener('resize', function () { if (pendingFit) fit(); });

// --- diagram --------------------------------------------------------------

const CLASSES = {
  llm_call: 'llm', tool_call: 'tool', tool_result: 'tool', compaction: 'comp',
  fork: 'fork', join: 'fork', final_output: 'final', handoff: 'hand'
};

// A failed call is the one thing in a trace people look for, so it is coloured
// by outcome rather than by type — the same red the sidebar badge uses.
function nodeClass(n) {
  if (n.type === 'tool_result' && n.isError) return 'err';
  return CLASSES[n.type];
}

// Diagram labels are built from node types and identifiers only, and are
// stripped to a conservative character set: nothing a model wrote can reach
// the Mermaid parser, let alone the SVG.
function safe(text) {
  return String(text).replace(/[^\\w .:\\-\\/>+=()]/g, ' ').slice(0, 60).trim();
}

function shape(e, i) {
  const n = e.node;
  // The timing is ours, not the run's: digits and a unit, appended after
  // sanitizing. It stays on one line because Mermaid's strict mode drops the
  // <br/> that would break it.
  const d = took(e);
  const text = '"' + (i + 1) + '. ' + safe(label(n))
    + '   t+' + startedAt(e) + (d ? ' · ' + d : '') + '"';
  if (n.type === 'fork' || n.type === 'join') return e.key + '{{' + text + '}}';
  if (n.type === 'final_output') return e.key + '([' + text + '])';
  if (n.type === 'user_input' || n.type === 'system_prompt') return e.key + '[/' + text + '/]';
  return e.key + '[' + text + ']';
}

function chain(level, lines) {
  let prev = null;
  level.forEach(function (e) {
    const i = ENTRIES.indexOf(e);
    lines.push('  ' + shape(e, i));
    const cls = nodeClass(e.node);
    if (cls) lines.push('  class ' + e.key + ' ' + cls + ';');
    if (e.covered) lines.push('  class ' + e.key + ' covered;');
    if (prev) lines.push('  ' + prev.key + ' --> ' + e.key);

    if (e.node.type === 'join' && e.children.length) {
      // A branch hangs off the fork that opened it and rejoins at the join.
      const fork = level.find(function (x) {
        return x.node.type === 'fork' && x.node.callId === e.node.callId;
      });
      e.children.forEach(function (br, bi) {
        if (!br.entries.length) return;
        const bd = took(br);
        const sg = 'sg_' + e.key + '_' + bi;
        lines.push('  subgraph ' + sg + '["' + safe(br.name)
          + '   t+' + startedAt(br) + (bd ? ' · ' + bd : '')
          + (br.slowest ? ' · slowest' : '') + '"]');
        lines.push('  direction TB');
        chain(br.entries, lines);
        lines.push('  end');
        // The one branch the join actually waited for, lifted out of the pack.
        if (br.slowest) lines.push('  style ' + sg + ' fill:#5b6070,stroke:#a9b2c6,color:#f2f4f8;');
        if (fork) lines.push('  ' + fork.key + ' -.-> ' + br.entries[0].key);
        lines.push('  ' + br.entries[br.entries.length - 1].key + ' -.-> ' + e.key);
      });
    }
    prev = e;
  });
}

function diagram() {
  const lines = ['flowchart TD'];
  lines.push('  classDef llm fill:#1e3357,stroke:#3d5f9e,color:#cfe0ff;');
  lines.push('  classDef tool fill:#1e3d33,stroke:#3d7a66,color:#c8f0e2;');
  lines.push('  classDef comp fill:#40331a,stroke:#7a6535,color:#f0dfb4;');
  lines.push('  classDef fork fill:#3a2450,stroke:#6b4b90,color:#e6d3ff;');
  lines.push('  classDef final fill:#14392c,stroke:#2f7a5c,color:#c6f5e0;');
  lines.push('  classDef hand fill:#3d2a1b,stroke:#7a5535,color:#f2d9c2;');
  lines.push('  classDef err fill:#4a1f1c,stroke:#8a3a33,color:#f0776c;');
  lines.push('  classDef covered opacity:0.45,stroke-dasharray:4 3;');
  chain(ROOT, lines);
  return lines.join('\\n');
}

async function drawGraph() {
  let mermaid;
  try {
    mermaid = (await import(MERMAID_URL)).default;
  } catch (err) {
    canvasEl.replaceChildren(el('div', 'hint pad',
      'Mermaid could not be loaded (offline?). The timeline on the left has the same nodes.'));
    show('detail');
    return;
  }
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', flowchart: { htmlLabels: false } });
  try {
    const rendered = await mermaid.render('run-graph', diagram());
    // Mermaid produced this markup from labels we sanitized above; no payload
    // text reaches it.
    canvasEl.innerHTML = rendered.svg;
  } catch (err) {
    canvasEl.replaceChildren(el('pre', null, 'diagram failed: ' + err.message + '\\n\\n' + diagram()));
    return;
  }
  const svg = canvasEl.querySelector('svg');
  if (svg) {
    // Mermaid sizes the SVG to fit its container; we want its natural size so
    // the transform above is the only thing deciding scale.
    const box = svg.viewBox && svg.viewBox.baseVal;
    natW = (box && box.width) || svg.getBoundingClientRect().width;
    natH = (box && box.height) || svg.getBoundingClientRect().height;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.width = natW + 'px';
    svg.style.height = natH + 'px';
  }
  fit();
  canvasEl.querySelectorAll('.node').forEach(function (g) {
    // Mermaid ids are '<renderId>-flowchart-<ourKey>-<seq>'; only the key matters.
    const m = /-(n\\d+)-\\d+$/.exec(g.id || '');
    const key = m ? m[1] : null;
    if (!key || !BY_KEY.has(key)) return;
    // A pan that ends on a node must not be read as a click on it.
    g.addEventListener('click', function () { if (!dragMoved) select(key, true); });
  });
}

drawGraph();
buildStats();
if (ENTRIES.length) select('n0', false);
`;
