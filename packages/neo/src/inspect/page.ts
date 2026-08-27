import { CLIENT } from './client.ts';
import { CSS } from './css.ts';
import type { RunReport } from './report.ts';

// ---------------------------------------------------------------------------
// The document
//
// One function, one string. The page is data-driven: all of the report travels
// as JSON and the rendering happens in the browser, so the only thing this
// module has to get right is the shell and the escaping.
// ---------------------------------------------------------------------------

export function page(report: RunReport, mermaidUrl: string): string {
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
      <button data-view="agents">Agents</button>
    </div>
    <div id="graph" class="pane">
      <div class="gtools">
        <button data-zoom="out" title="zoom out">−</button>
        <button data-zoom="in" title="zoom in">+</button>
        <button data-zoom="fit" title="fit to window (double-click the canvas)">fit</button>
        <button data-zoom="reset" title="actual size">1:1</button>
        <span class="hint">scroll to zoom · drag to pan</span>
        <span class="hint lvl">100%</span>
      </div>
      <div class="viewport"><div class="canvas"><div class="hint pad">rendering…</div></div></div>
    </div>
    <div id="detail" hidden></div>
    <div id="stats" hidden></div>
    <div id="agents" class="pane" hidden>
      <div class="gtools">
        <button data-zoom="out" title="zoom out">−</button>
        <button data-zoom="in" title="zoom in">+</button>
        <button data-zoom="fit" title="fit to window (double-click the canvas)">fit</button>
        <button data-zoom="reset" title="actual size">1:1</button>
        <span class="hint" id="alegend"></span>
        <span class="hint lvl">100%</span>
      </div>
      <div class="viewport"><div class="canvas"><div class="hint pad">rendering…</div></div></div>
    </div>
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
