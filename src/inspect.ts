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
    </div>
    <div id="graph"><div class="hint">rendering…</div></div>
    <div id="detail" hidden></div>
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
main { display: grid; grid-template-columns: 320px 1fr; height: calc(100vh - 49px); }
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
#timeline .idx { color: var(--dim); font: 11px var(--mono); min-width: 22px; }
#timeline .prev { color: var(--dim); font-size: 11px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; padding-left: 28px; }
#timeline li.branch { padding-left: 22px; }
#middle { display: flex; flex-direction: column; overflow: hidden; }
.tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.tabs button { background: none; border: 1px solid transparent; color: var(--dim);
  padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.tabs button.on { color: var(--fg); background: var(--panel); border-color: var(--line); }
#graph, #detail { overflow: auto; padding: 16px; flex: 1; }
#graph svg { max-width: none; }
#graph .node { cursor: pointer; }
.hint { color: var(--dim); font-size: 12px; }
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
pre { margin: 0; padding: 10px 12px; font: 12px/1.55 var(--mono); white-space: pre-wrap;
  word-break: break-word; overflow-wrap: anywhere; }
pre.text { white-space: pre-wrap; }
.msg { border-top: 1px solid var(--line); }
.msg:first-of-type { border-top: none; }
.msg > .role { padding: 5px 12px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .05em; color: var(--dim); background: #1b202c;
  display: flex; justify-content: space-between; }
.msg.user > .role { color: #9dc1ff; }
.msg.assistant > .role { color: #c3a6ff; }
.msg.tool > .role { color: #8ee0c2; }
.msg.system > .role { color: var(--warn); }
.msg.err > .role { color: var(--err); }
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
      key: 'n' + ENTRIES.length, node: node, depth: depth, branch: branch,
      covered: hidden.has(node.id), children: []
    };
    ENTRIES.push(e); BY_KEY.set(e.key, e); level.push(e);
    if (node.type === 'join') {
      for (const b of node.branches) e.children.push({ name: b.name, entries: flatten(b.nodes, depth + 1, b.name) });
    }
  }
  return level;
}
const ROOT = flatten(STATE.trajectory, 0, null);

// --- labels ---------------------------------------------------------------

function names(list) { return list.join(', '); }

function label(n) {
  switch (n.type) {
    case 'user_input': return n.synthetic ? 'user input (synthetic)' : 'user input';
    case 'system_prompt': return 'system prompt';
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

// --- timeline -------------------------------------------------------------

const listEl = document.getElementById('timeline');
ENTRIES.forEach(function (e, i) {
  const li = el('li', e.branch ? 'branch' : '');
  if (e.covered) li.classList.add('covered');
  li.dataset.key = e.key;
  const row = el('div', 'row');
  row.appendChild(el('span', 'idx', '#' + (i + 1)));
  const badge = el('span', 'type ' + e.node.type
    + (e.node.type === 'tool_result' && e.node.isError ? ' err' : ''), e.node.type.replace(/_/g, ' '));
  row.appendChild(badge);
  li.appendChild(row);
  li.appendChild(el('div', 'prev', (e.branch ? '[' + e.branch + '] ' : '')
    + label(e.node) + (preview(e.node) ? ' — ' + preview(e.node).slice(0, 90) : '')));
  li.addEventListener('click', function () { select(e.key, true); });
  listEl.appendChild(li);
});

document.getElementById('filter').addEventListener('input', function (ev) {
  const q = ev.target.value.toLowerCase();
  Array.prototype.forEach.call(listEl.children, function (li) {
    const e = BY_KEY.get(li.dataset.key);
    const hay = (label(e.node) + ' ' + e.node.type + ' ' + preview(e.node)).toLowerCase();
    li.hidden = q.length > 0 && hay.indexOf(q) === -1;
  });
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
  if (req.system) into.appendChild(textBlock('Request · system prompt', req.system));

  const conv = block('Request · messages', (req.messages || []).length + ' messages');
  (req.messages || []).forEach(function (m) { conv.appendChild(message(m)); });
  if (!(req.messages || []).length) conv.appendChild(el('div', 'empty', '(none)'));
  into.appendChild(conv);

  const tools = block('Request · tools offered', (req.tools || []).length + ' tools');
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
  if (e.branch) meta.appendChild(el('span', null, 'branch ' + e.branch));
  if (e.covered) meta.appendChild(el('span', null, 'hidden by a later compaction'));
  out.appendChild(meta);

  switch (n.type) {
    case 'system_prompt':
      out.appendChild(textBlock('Prompt', blob(n.prompt)));
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
        return s.name + (s.version ? '@' + s.version : '') + '  ' + s.contentHash.slice(0, 12);
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
      if (n.request) requestBlocks(blob(n.request), out);
      else {
        const miss = block('Request');
        miss.appendChild(el('div', 'empty',
          'not recorded — construct the runner with { recordRequests: true } to capture it'));
        out.appendChild(miss);
      }
      if (n.thinking) out.appendChild(textBlock('Reasoning', blob(n.thinking)));
      out.appendChild(textBlock('Response', blob(n.text), n.stopReason));
      n.toolCalls.forEach(function (c) {
        out.appendChild(textBlock('Tool call · ' + c.name, pretty(blob(c.args)), c.callId));
      });
      out.appendChild(textBlock('Usage', usageTag(n.usage), n.model));
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
      n.branches.forEach(function (b) {
        out.appendChild(textBlock('Branch · ' + b.name,
          b.status === 'ok' ? blob(b.output) : (b.error || blob(b.output)),
          b.status + ' · ' + b.agent + ' · ' + b.nodes.length + ' nodes · ' + usageTag(b.usage)));
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

// --- views ----------------------------------------------------------------

function show(view) {
  document.getElementById('graph').hidden = view !== 'graph';
  detailEl.hidden = view !== 'detail';
  Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
    b.classList.toggle('on', b.dataset.view === view);
  });
}
Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
  b.addEventListener('click', function () { show(b.dataset.view); });
});

// --- diagram --------------------------------------------------------------

const CLASSES = {
  llm_call: 'llm', tool_call: 'tool', tool_result: 'tool', compaction: 'comp',
  fork: 'fork', join: 'fork', final_output: 'final', handoff: 'hand'
};

// Diagram labels are built from node types and identifiers only, and are
// stripped to a conservative character set: nothing a model wrote can reach
// the Mermaid parser, let alone the SVG.
function safe(text) {
  return String(text).replace(/[^\\w .:\\-\\/>+=()]/g, ' ').slice(0, 60).trim();
}

function shape(e, i) {
  const n = e.node;
  const text = '"' + (i + 1) + '. ' + safe(label(n)) + '"';
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
    const cls = CLASSES[e.node.type];
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
        lines.push('  subgraph sg_' + e.key + '_' + bi + '["' + safe(br.name) + '"]');
        lines.push('  direction TB');
        chain(br.entries, lines);
        lines.push('  end');
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
  lines.push('  classDef covered opacity:0.45,stroke-dasharray:4 3;');
  chain(ROOT, lines);
  return lines.join('\\n');
}

async function drawGraph() {
  const host = document.getElementById('graph');
  let mermaid;
  try {
    mermaid = (await import(MERMAID_URL)).default;
  } catch (err) {
    host.replaceChildren(el('div', 'hint',
      'Mermaid could not be loaded (offline?). The timeline on the left has the same nodes.'));
    show('detail');
    return;
  }
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', flowchart: { htmlLabels: false } });
  try {
    const rendered = await mermaid.render('run-graph', diagram());
    // Mermaid produced this markup from labels we sanitized above; no payload
    // text reaches it.
    host.innerHTML = rendered.svg;
  } catch (err) {
    host.replaceChildren(el('pre', null, 'diagram failed: ' + err.message + '\\n\\n' + diagram()));
    return;
  }
  host.querySelectorAll('.node').forEach(function (g) {
    // Mermaid ids are '<renderId>-flowchart-<ourKey>-<seq>'; only the key matters.
    const m = /-(n\\d+)-\\d+$/.exec(g.id || '');
    const key = m ? m[1] : null;
    if (!key || !BY_KEY.has(key)) return;
    g.addEventListener('click', function () { select(key, true); });
  });
}

drawGraph();
if (ENTRIES.length) select('n0', false);
`;
