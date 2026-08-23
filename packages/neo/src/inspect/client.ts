// ---------------------------------------------------------------------------
// The page's brain
//
// Written without template literals so that nothing here has to be escaped
// when it is embedded, and so the file stays greppable.
// ---------------------------------------------------------------------------

export const CLIENT = `
const DATA = JSON.parse(document.getElementById('run-data').textContent);
const STATE = DATA.state;
const BLOBS = DATA.blobs;
const MEDIA = DATA.media || [];
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

// An <img> never runs script, but the src is still pinned to shapes we
// understand: a raster data: uri (svg is excluded on principle) or an http url.
const IMG_SUBTYPES = ['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp'];

/** Undoes the report's media hoisting; anything else passes through. */
function mediaUrl(u) {
  if (typeof u !== 'string' || u.indexOf('media:') !== 0) return u;
  const v = MEDIA[Number(u.slice(6))];
  return v === undefined ? u : v;
}

function imageSrc(p) {
  if (p.type !== 'image') return null;
  const u = mediaUrl(p.url);
  if (typeof u !== 'string') return null;
  if (u.indexOf('https://') === 0 || u.indexOf('http://') === 0) return u;
  if (u.indexOf('data:image/') !== 0) return null;
  const sub = u.slice(11).split(/[;,]/)[0].toLowerCase();
  return IMG_SUBTYPES.indexOf(sub) < 0 ? null : u;
}

/** The rendered picture, or null when the part is not one we will inline. */
function imageEl(p, thumb) {
  const src = imageSrc(p);
  if (!src) return null;
  const img = el('img', thumb ? 'media thumb' : 'media');
  img.src = src;
  img.alt = p.type + (p.mimeType ? ' ' + p.mimeType : '');
  img.loading = 'lazy';
  if (thumb) {
    img.title = 'click to enlarge';
    img.addEventListener('click', function () { img.classList.toggle('thumb'); });
  }
  return img;
}

function mediaBlock(title, p) {
  const tag = p.type + (p.mimeType ? ' · ' + p.mimeType : '');
  const src = imageSrc(p);
  const img = imageEl(p, false);
  if (!img) return textBlock(title, mediaUrl(p.url), tag);
  const s = block(title, tag);
  s.appendChild(img);
  // The bytes stay reachable; they just no longer own the screen.
  const d = document.createElement('details');
  d.appendChild(el('summary', null, 'source'));
  d.appendChild(el('pre', null, src));
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
      if (p.type === 'text') { wrap.appendChild(el('pre', 'text', p.text)); return; }
      const img = imageEl(p, true);
      wrap.appendChild(img || el('pre', 'text', '[' + p.type + '] ' + mediaUrl(p.url)));
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
          : mediaBlock('Media part ' + (i + 1), p));
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

// Panes that hold a zoomable diagram, by view name. A pane laid out while it
// was hidden has no width to fit against, so becoming visible is the moment it
// gets a second chance.
const PANES = {};

function show(view) {
  document.getElementById('graph').hidden = view !== 'graph';
  document.getElementById('agents').hidden = view !== 'agents';
  detailEl.hidden = view !== 'detail';
  statsEl.hidden = view !== 'stats';
  Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
    b.classList.toggle('on', b.dataset.view === view);
  });
  if (PANES[view]) PANES[view].refit();
}
Array.prototype.forEach.call(document.getElementById('viewtabs').children, function (b) {
  b.addEventListener('click', function () { show(b.dataset.view); });
});

// --- zoom and pan ---------------------------------------------------------
//
// A diagram grows with what it describes, so a fixed scale is useless past a
// dozen nodes. The canvas is moved with a CSS transform rather than scrolled:
// that keeps zooming anchored on the pointer and costs no layout.
//
// Written as a factory because there are two of these — the run graph and the
// architecture — and they must not share a scale, a pan or a drag.

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function panZoom(paneId) {
  const pane = document.getElementById(paneId);
  const viewportEl = pane.querySelector('.viewport');
  const canvasEl = pane.querySelector('.canvas');
  const zoomEl = pane.querySelector('.lvl');
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

  pane.querySelector('.gtools').addEventListener('click', function (ev) {
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

  return {
    canvas: canvasEl,
    setNatural: function (w, h) { natW = w; natH = h; fit(); },
    refit: function () { if (pendingFit) fit(); },
    // A pan that ends on a node must not be read as a click on it.
    moved: function () { return dragMoved; }
  };
}

PANES.graph = panZoom('graph');
PANES.agents = panZoom('agents');

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

// One Mermaid, two diagrams. Loading it is the only network the page does, so
// it happens once and both panes wait on the same promise.
let mermaidLib = null;
function mermaid() {
  if (!mermaidLib) {
    mermaidLib = import(MERMAID_URL).then(function (m) {
      m.default.initialize({
        startOnLoad: false, theme: 'dark', securityLevel: 'strict',
        flowchart: { htmlLabels: false }
      });
      return m.default;
    });
  }
  return mermaidLib;
}

/** Renders one diagram into a pane and wires its nodes. False when it failed. */
async function draw(pane, id, source, onNode) {
  let lib;
  try {
    lib = await mermaid();
  } catch (err) {
    pane.canvas.replaceChildren(el('div', 'hint pad',
      'Mermaid could not be loaded (offline?). The timeline on the left has the same nodes.'));
    return false;
  }
  try {
    const rendered = await lib.render(id, source);
    // Mermaid produced this markup from labels we sanitized above; no payload
    // text reaches it.
    pane.canvas.innerHTML = rendered.svg;
  } catch (err) {
    pane.canvas.replaceChildren(el('pre', null, 'diagram failed: ' + err.message + '\\n\\n' + source));
    return false;
  }
  const svg = pane.canvas.querySelector('svg');
  if (svg) {
    // Mermaid sizes the SVG to fit its container; we want its natural size so
    // the transform above is the only thing deciding scale.
    const box = svg.viewBox && svg.viewBox.baseVal;
    const w = (box && box.width) || svg.getBoundingClientRect().width;
    const h = (box && box.height) || svg.getBoundingClientRect().height;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
    pane.setNatural(w, h);
  }
  pane.canvas.querySelectorAll('.node').forEach(onNode);
  return true;
}

async function drawGraph() {
  const ok = await draw(PANES.graph, 'run-graph', diagram(), function (g) {
    // Mermaid ids are '<renderId>-flowchart-<ourKey>-<seq>'; only the key matters.
    const m = /-(n\\d+)-\\d+$/.exec(g.id || '');
    const key = m ? m[1] : null;
    if (!key || !BY_KEY.has(key)) return;
    g.addEventListener('click', function () { if (!PANES.graph.moved()) select(key, true); });
  });
  if (!ok) show('detail');
}

// --- architecture ---------------------------------------------------------
//
// The run graph answers "what happened". This one answers "what was wired up",
// which is the question a trajectory structurally cannot: the agent nobody
// handed off to and the tool nobody called leave no node behind. The declared
// wiring arrives with the report when a runner was there to describe itself;
// otherwise the run is read backwards into the same shape, which is smaller
// but never wrong.

const SEP = '::';

function bump(map, key, entryKey) {
  const cur = map.get(key);
  if (cur) { cur.count += 1; return; }
  map.set(key, { count: 1, key: entryKey });
}

// What this run actually exercised, keyed the same way the diagram names
// things — so drawing "used" is a lookup rather than a search.
const USED = {
  agents: new Map(), models: new Map(), tools: new Map(),
  skills: new Map(), handoffs: new Map(), memory: new Map(), forks: new Map()
};

ENTRIES.forEach(function (e) {
  const n = e.node;
  bump(USED.agents, n.agent, e.key);
  if (n.type === 'llm_call') {
    if (!USED.models.has(n.agent)) USED.models.set(n.agent, n.model);
  } else if (n.type === 'tool_call') {
    bump(USED.tools, n.agent + SEP + n.name, e.key);
  } else if (n.type === 'load_skills') {
    n.skills.forEach(function (s) { bump(USED.skills, n.agent + SEP + s.name, e.key); });
  } else if (n.type === 'handoff') {
    bump(USED.handoffs, n.from + SEP + n.to, e.key);
  } else if (n.type === 'memory_recall' || n.type === 'memory_op') {
    bump(USED.memory, n.agent + SEP + n.store + '/' + n.scope, e.key);
  } else if (n.type === 'fork') {
    n.branches.forEach(function (b) { bump(USED.forks, n.agent + SEP + b.agent, e.key); });
  }
});

function has(list, name) {
  return list.some(function (x) { return x.name === name; });
}

/** The run read backwards into the same shape. Used when none was supplied. */
function observedArchitecture() {
  const byName = new Map();
  function agentOf(name) {
    if (!byName.has(name)) {
      byName.set(name, { name: name, tools: [], handoffs: [], memory: [] });
    }
    return byName.get(name);
  }
  ENTRIES.forEach(function (e) {
    const n = e.node;
    const a = agentOf(n.agent);
    if (n.type === 'llm_call') {
      if (!a.model) a.model = n.model;
    } else if (n.type === 'tool_call') {
      // Handoff tools are drawn as edges between agents, never as tool nodes.
      const handoff = n.name.indexOf('transfer_to_') === 0;
      if (!handoff && !has(a.tools, n.name)) a.tools.push({ name: n.name });
    } else if (n.type === 'load_skills') {
      if (!a.skills) a.skills = { provider: n.provider, discovery: 'index', catalog: [] };
      n.skills.forEach(function (s) {
        if (has(a.skills.catalog, s.name)) return;
        // The unlocked tools are recorded per activation, not per skill, so
        // they can only be attributed when one skill loaded on its own.
        a.skills.catalog.push({
          name: s.name, version: s.version,
          toolNames: n.skills.length === 1 ? n.toolNames : undefined
        });
      });
    } else if (n.type === 'handoff') {
      const from = agentOf(n.from);
      agentOf(n.to);
      if (from.handoffs.indexOf(n.to) < 0) from.handoffs.push(n.to);
    } else if (n.type === 'memory_recall' || n.type === 'memory_op') {
      const known = a.memory.some(function (m) {
        return m.store === n.store && m.scope === n.scope;
      });
      if (!known) {
        a.memory.push({
          store: n.store, scope: n.scope,
          access: n.type === 'memory_op' ? 'read-write' : 'read'
        });
      }
    } else if (n.type === 'fork') {
      if (!a.fork) a.fork = { agents: [] };
      n.branches.forEach(function (b) {
        agentOf(b.agent);
        if (a.fork.agents.indexOf(b.agent) < 0) a.fork.agents.push(b.agent);
      });
    }
  });
  return { source: 'observed', agents: Array.from(byName.values()) };
}

const ARCH = DATA.architecture || observedArchitecture();

// Diagram key -> the first trajectory node that exercised the thing it names,
// or null when nothing did. Clicking is only offered for the former.
const ARCH_KEYS = new Map();
let archSeq = 0;
function archKey(used) {
  const k = 'x' + archSeq++;
  ARCH_KEYS.set(k, used ? used.key : null);
  return k;
}

/** An agent with more tools than this gets a "+N more" node instead of a wall. */
const MAX_TOOLS = 12;

function times(used) {
  return used ? ' x' + used.count : '';
}

function archDiagram() {
  const lines = ['flowchart LR'];
  lines.push('  classDef agent fill:#1e3357,stroke:#3d5f9e,color:#cfe0ff;');
  lines.push('  classDef start fill:#14392c,stroke:#2f7a5c,color:#c6f5e0;');
  lines.push('  classDef tool fill:#1e3d33,stroke:#3d7a66,color:#c8f0e2;');
  lines.push('  classDef skill fill:#3a2450,stroke:#6b4b90,color:#e6d3ff;');
  lines.push('  classDef mem fill:#40331a,stroke:#7a6535,color:#f0dfb4;');
  lines.push('  classDef more fill:#1b202c,stroke:#39415a,color:#8a92a6;');
  lines.push('  classDef idle opacity:0.4,stroke-dasharray:4 3;');

  const startAgent = (STATE.spec && STATE.spec.startAgent) || STATE.agentName;
  const selfKey = new Map();
  // Minted up front so a hand-off can name an agent declared further down.
  ARCH.agents.forEach(function (a) {
    selfKey.set(a.name, archKey(USED.agents.get(a.name)));
  });

  ARCH.agents.forEach(function (a) {
    const self = selfKey.get(a.name);
    const live = USED.agents.get(a.name);
    // The model on the node is the declared one, or — when the report carries
    // no wiring — whatever this run was seen using.
    const model = a.model || USED.models.get(a.name);
    lines.push('  subgraph sg_' + self + '["' + safe(a.name)
      + (a.description ? ' - ' + safe(a.description) : '') + '"]');
    lines.push('  direction LR');
    lines.push('  ' + self + '[["' + safe(a.name)
      + (model ? '   ' + safe(model) + (a.inheritedModel ? ' (inherited)' : '') : '')
      + '"]]');
    lines.push('  class ' + self + ' ' + (a.name === startAgent ? 'start' : 'agent') + ';');
    if (!live) lines.push('  class ' + self + ' idle;');

    // Skills first: a skill owns tools, so its node has to exist before the
    // tools it unlocks can point back at it.
    const skillKey = new Map();
    const catalog = (a.skills && a.skills.catalog) || [];
    catalog.forEach(function (s) {
      const used = USED.skills.get(a.name + SEP + s.name);
      const k = archKey(used);
      skillKey.set(s.name, k);
      lines.push('  ' + k + '(["' + safe(s.name) + (s.preload ? ' (preloaded)' : '')
        + times(used) + '"])');
      lines.push('  class ' + k + ' skill;');
      if (!used) lines.push('  class ' + k + ' idle;');
      lines.push('  ' + self + ' --- ' + k);
    });
    if (a.skills && a.skills.unresolved) {
      const k = archKey(null);
      lines.push('  ' + k + '(["catalog unavailable: ' + safe(a.skills.provider) + '"])');
      lines.push('  class ' + k + ' skill;');
      lines.push('  class ' + k + ' idle;');
      lines.push('  ' + self + ' --- ' + k);
    }

    const shown = a.tools.slice(0, MAX_TOOLS);
    shown.forEach(function (t) {
      const used = USED.tools.get(a.name + SEP + t.name);
      const k = archKey(used);
      lines.push('  ' + k + '["' + safe(t.name) + times(used) + '"]');
      lines.push('  class ' + k + ' tool;');
      if (!used) lines.push('  class ' + k + ' idle;');
      // A skill-owned tool hangs off the skill that unlocks it, not off the
      // agent: that edge is the whole point of a locked tool.
      const owner = t.skill ? skillKey.get(t.skill) : null;
      if (owner) lines.push('  ' + owner + ' -.-> ' + k);
      else lines.push('  ' + self + ' --- ' + k);
    });
    if (a.tools.length > shown.length) {
      const k = archKey(null);
      lines.push('  ' + k + '["+' + (a.tools.length - shown.length) + ' more tools"]');
      lines.push('  class ' + k + ' more;');
      lines.push('  ' + self + ' --- ' + k);
    }

    a.memory.forEach(function (m) {
      const used = USED.memory.get(a.name + SEP + m.store + '/' + m.scope);
      const k = archKey(used);
      lines.push('  ' + k + '[("' + safe(m.store) + ' / ' + safe(m.scope)
        + (m.access === 'read-write' ? ' (rw)' : ' (ro)') + '")]');
      lines.push('  class ' + k + ' mem;');
      if (!used) lines.push('  class ' + k + ' idle;');
      lines.push('  ' + self + ' --- ' + k);
    });
    lines.push('  end');
    // Mermaid's default subgraph is a light box, which on a dark page reads as
    // the foreground rather than as the container. An agent nobody entered is
    // outlined rather than filled, so a dead corner of the wiring is visible
    // from across the diagram.
    lines.push('  style sg_' + self + ' fill:#12151d,color:#8a92a6,stroke:'
      + (live ? '#39415a;' : '#2b3346,stroke-dasharray:5 4;'));
  });

  // Edges between agents live outside every subgraph, so Mermaid routes them
  // between the boxes instead of trying to keep them inside one.
  ARCH.agents.forEach(function (a) {
    const self = selfKey.get(a.name);
    a.handoffs.forEach(function (to) {
      if (!selfKey.has(to)) return;
      const used = USED.handoffs.get(a.name + SEP + to);
      lines.push('  ' + self + (used ? ' -- "handoff' + times(used) + '" --> ' : ' -.-> ')
        + selfKey.get(to));
    });
    ((a.fork && a.fork.agents) || []).forEach(function (to) {
      if (!selfKey.has(to) || to === a.name) return;
      const used = USED.forks.get(a.name + SEP + to);
      lines.push('  ' + self + ' == "fork' + times(used) + '" ==> ' + selfKey.get(to));
    });
  });
  return lines.join('\\n');
}

function archLegend() {
  const agents = ARCH.agents.length;
  const tools = ARCH.agents.reduce(function (n, a) { return n + a.tools.length; }, 0);
  const skills = ARCH.agents.reduce(function (n, a) {
    return n + ((a.skills && a.skills.catalog.length) || 0);
  }, 0);
  const idle = ARCH.agents.filter(function (a) { return !USED.agents.has(a.name); }).length;
  return (ARCH.source === 'declared' ? 'declared' : 'observed only')
    + ' \\u00b7 ' + agents + ' agents \\u00b7 ' + tools + ' tools \\u00b7 ' + skills + ' skills'
    + (idle ? ' \\u00b7 ' + idle + ' idle' : '')
    + ' \\u00b7 dimmed = unused \\u00b7 click to jump';
}

async function drawArch() {
  document.getElementById('alegend').textContent = archLegend();
  if (!ARCH.agents.length) {
    PANES.agents.canvas.replaceChildren(el('div', 'hint pad', 'No agents to draw.'));
    return;
  }
  await draw(PANES.agents, 'arch-graph', archDiagram(), function (g) {
    const m = /-(x\\d+)-\\d+$/.exec(g.id || '');
    const key = m && ARCH_KEYS.get(m[1]);
    if (!key) return;
    g.addEventListener('click', function () { if (!PANES.agents.moved()) select(key, true); });
  });
}

drawGraph().then(drawArch);
buildStats();
if (ENTRIES.length) select('n0', false);
`;
