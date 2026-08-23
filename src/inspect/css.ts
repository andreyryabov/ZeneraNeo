// ---------------------------------------------------------------------------
// Page styles
//
// Split out of the report code for no reason other than size: this is one
// string, embedded verbatim into the <style> element by `page()`.
// ---------------------------------------------------------------------------

export const CSS = `
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
