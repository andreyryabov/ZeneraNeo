import type { MemoryEdge, MemoryNode, Recollection, ScoredNode } from './types.ts';

// ---------------------------------------------------------------------------
// What the model actually reads
//
// Not JSON. This is a prompt part, not a machine interface, and the two halves
// of a subgraph want opposite formats: topology reads better as arrows than as
// an array of {source,target,relation} objects, while arbitrary node text is an
// escaping minefield inside a mermaid label — quotes, brackets, pipes, hashes
// and newlines all break it.
//
// So the diagram carries no free text at all. Node labels are the `kind` and
// edge labels the `relation`, both closed vocabularies that need no escaping,
// and every piece of authored text lives in the legend below, where it is just
// a line. Ids appear in both halves because the id is what the model has to
// copy into `memory_load`.
//
// No SUPERSEDES arrow can appear on the ordinary path: recall drops the node
// one points at, so the edge loses an endpoint before it reaches here. It shows
// up only under `stale`, which is the audit view, and `memory/instructions.ts`
// therefore does not teach the model to look for one.
// ---------------------------------------------------------------------------

export const RECOLLECTION_TAG = 'memory-recollection';

/** Enough to judge relevance; the model calls `memory_load` for the rest. */
const TEXT_CLIP = 160;

export interface RenderOptions {
    /** wrap in the <memory-recollection> element; off for CLI output */
    tagged?: boolean;
    clip?: number;
    now?: number;
}

export function renderRecollection(rec: Recollection, opts: RenderOptions = {}): string {
    if (!rec.nodes.length) {
        return '';
    }
    const body = [diagram(rec), '', ...legend(rec, opts)];
    if (rec.truncated) {
        body.push('', '(more memory matched than fits; narrow the query or raise max_nodes)');
    }
    const text = body.join('\n');
    return opts.tagged === false ? text : `<${RECOLLECTION_TAG}>\n${text}\n</${RECOLLECTION_TAG}>`;
}

function diagram(rec: Recollection): string {
    // Recollection edges are drawn only between nodes it carries, so every
    // endpoint resolves here.
    const byId = new Map(rec.nodes.map(({ node }) => [node.id, node]));
    const lines = ['graph LR'];
    const linked = new Set<string>();
    for (const edge of rec.edges) {
        linked.add(edge.source);
        linked.add(edge.target);
        lines.push(`  ${arrow(byId, edge)}`);
    }
    // A node nothing joins is still a hit, and must not vanish from the picture.
    for (const { node } of rec.nodes) {
        if (!linked.has(node.id)) {
            lines.push(`  ${shape(node)}`);
        }
    }
    return lines.join('\n');
}

function arrow(byId: Map<string, MemoryNode>, edge: MemoryEdge): string {
    return `${shape(byId.get(edge.source)!)} -->|${edge.relation}| ${shape(byId.get(edge.target)!)}`;
}

/**
 * A file gets its own outline so the one node the model can actually run is
 * distinguishable at a glance from the notes describing it.
 */
function shape(node: MemoryNode): string {
    const kind = label(node.kind);
    return node.file ? `${node.id}[/${kind}/]` : `${node.id}(${kind})`;
}

/** Kinds are a closed vocabulary, but a project may add its own — so still guard. */
function label(kind: string): string {
    return kind.replace(/[^A-Za-z0-9_ -]/g, '') || 'node';
}

function legend(rec: Recollection, opts: RenderOptions): string[] {
    const clip = opts.clip ?? TEXT_CLIP;
    const now = opts.now ?? Date.now();
    const width = Math.max(...rec.nodes.map((n) => n.node.id.length));
    const kinds = Math.max(...rec.nodes.map((n) => label(n.node.kind).length));
    return rec.nodes.map((scored) => {
        const { node } = scored;
        const id = node.id.padEnd(width);
        const kind = label(node.kind).padEnd(kinds);
        return `${id}  ${score(scored)}  ${kind}  ${detail(node, clip, now)}`;
    });
}

function score(scored: ScoredNode): string {
    return scored.seed ? scored.score.toFixed(2) : ' -- ';
}

function detail(node: MemoryNode, clip: number, now: number): string {
    const summary = clipped(node.text, clip);
    if (!node.file) {
        return summary;
    }
    const facts = [node.file.path, bytes(node.file.bytes), used(node, now)].filter(Boolean);
    return `${facts.join(' · ')}${summary ? ` — ${summary}` : ''}`;
}

function clipped(text: string, clip: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > clip ? `${flat.slice(0, clip - 1)}…` : flat;
}

function bytes(n: number): string {
    return n < 1024
        ? `${n} B`
        : n < 1024 * 1024
          ? `${(n / 1024).toFixed(1)} KB`
          : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function used(node: MemoryNode, now: number): string {
    if (!node.useCount) {
        return 'unused';
    }
    const days = Math.floor((now - Date.parse(node.lastUsedAt)) / 86_400_000);
    const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
    return `used ${node.useCount}\u00d7, ${ago}`;
}
