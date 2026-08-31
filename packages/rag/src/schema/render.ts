import type { NodeAttrs } from './graph.ts';
import type { Subgraph, SubgraphEdge, SubgraphNode } from './subgraph.ts';

// ---------------------------------------------------------------------------
// A subgraph, written down
//
// Two shapes, for two readers. The text tree is what a model is given: every
// line is one fact, indentation is containment, and a hit is marked so the
// answer to the actual question does not have to be guessed at from the middle
// of a listing. The Mermaid is for a person, and stays a diagram — no notes
// except on the hits, or the picture is a wall of prose.
// ---------------------------------------------------------------------------

export type RenderFormat = 'text' | 'mermaid' | 'mermaid-flowchart';

export interface RenderOptions {
    docs?: boolean;
    maxDoc?: number;
}

const HIT = '»';

export function render(sub: Subgraph, format: RenderFormat, options: RenderOptions = {}): string {
    switch (format) {
        case 'mermaid':
            return toMermaid(sub, options);
        case 'mermaid-flowchart':
            return toFlowchart(sub, options);
        default:
            return toText(sub, options);
    }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function toText(sub: Subgraph, options: RenderOptions = {}): string {
    const view = new View(sub);
    const lines: string[] = [];

    const methods = view.of('method');
    if (methods.length > 0) {
        lines.push('methods');
        for (const method of methods) {
            lines.push(...methodLines(view, method, options));
        }
    }

    const types = view.of('type');
    if (types.length > 0) {
        lines.push(methods.length > 0 ? '' : '', 'types');
        for (const type of types) {
            lines.push(...typeLines(view, type, options));
        }
    }

    const loose = view.of('property').filter((p) => !view.owned.has(p.id));
    if (loose.length > 0) {
        lines.push('', 'properties');
        for (const property of loose) {
            lines.push(`  ${mark(property)}${field(property)}${doc(property, options, ' ')}`);
        }
    }

    if (sub.truncated) {
        lines.push('', '… truncated to stay inside the node budget');
    }
    return lines.filter((line, at) => line !== '' || at > 0).join('\n');
}

function methodLines(view: View, method: SubgraphNode, options: RenderOptions): string[] {
    const a = method.attributes;
    const out = [
        `  ${mark(method)}${a.httpMethod} ${a.path}  ${a.name}${doc(method, options, ' —')}`,
    ];

    for (const edge of view.out(method.id, 'HAS_PARAM')) {
        const node = view.node(edge.target);
        if (node) {
            out.push(`      ${mark(node)}${field(node)}  (${edge.in})${doc(node, options, ' —')}`);
        }
    }
    for (const edge of view.out(method.id, 'TAKES_INPUT')) {
        out.push(`      accepts ${view.name(edge.target)}`);
    }
    for (const edge of view.out(method.id, 'RETURNS_OUTPUT')) {
        out.push(`      returns ${view.name(edge.target)}  (${edge.status})`);
    }
    return out;
}

function typeLines(view: View, type: SubgraphNode, options: RenderOptions): string[] {
    const out = [
        `  ${mark(type)}${type.attributes.name}${side(type.attributes)}${doc(type, options, ' —')}`,
    ];

    const composes = view.out(type.id, 'COMPOSES').map((e) => view.name(e.target));
    if (composes.length > 0) {
        out.push(`      composes ${composes.join(', ')}`);
    }
    const items = view.out(type.id, 'ITEM_OF').map((e) => view.name(e.target));
    if (items.length > 0) {
        out.push(`      array of ${items.join(', ')}`);
    }
    for (const edge of view.out(type.id, 'HAS_PROPERTY')) {
        const node = view.node(edge.target);
        if (node) {
            out.push(`      ${mark(node)}${field(node)}${doc(node, options, ' —')}`);
        }
    }
    return out;
}

function field(node: SubgraphNode): string {
    const a = node.attributes;
    return `${a.name}${a.required ? '' : '?'}: ${a.signature || 'unknown'}`;
}

function side(a: NodeAttrs): string {
    return a.direction === 'none' ? '' : `  (${a.direction})`;
}

function mark(node: SubgraphNode): string {
    return node.hit ? `${HIT} ` : '  ';
}

function doc(node: SubgraphNode, options: RenderOptions, lead: string): string {
    if (!options.docs || !node.attributes.doc) {
        return '';
    }
    return `${lead} ${clip(node.attributes.doc, options.maxDoc ?? 120)}`;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export function toMermaid(sub: Subgraph, options: RenderOptions = {}): string {
    const view = new View(sub);
    const lines = ['classDiagram'];

    for (const type of view.of('type')) {
        const fields = view
            .out(type.id, 'HAS_PROPERTY')
            .map((e) => view.node(e.target))
            .filter(Boolean) as SubgraphNode[];
        lines.push(`    class ${view.id(type.id)} {`);
        for (const property of fields) {
            const a = property.attributes;
            lines.push(`        ${a.required ? '+' : '-'}${safe(a.signature)} ${safe(a.name)}`);
        }
        lines.push('    }');
        if (type.hit) {
            lines.push(`    style ${view.id(type.id)} fill:#1d2432,stroke:#5b7fff`);
        }
    }

    for (const method of view.of('method')) {
        const id = view.id(method.id);
        const a = method.attributes;
        lines.push(`    class ${id} {`, `        <<${a.httpMethod} ${safe(a.path)}>>`, '    }');
    }

    for (const edge of sub.edges) {
        const arrow = ARROWS[edge.relation];
        if (!arrow || !view.node(edge.source) || !view.node(edge.target)) {
            continue;
        }
        const label = edge.relation === 'RETURNS_OUTPUT' ? `returns ${edge.status}` : arrow.label;
        lines.push(`    ${view.id(edge.source)} ${arrow.line} ${view.id(edge.target)} : ${label}`);
    }

    for (const node of sub.nodes) {
        if (node.hit && options.docs && node.attributes.doc && node.kind !== 'property') {
            const text = clip(node.attributes.doc, options.maxDoc ?? 100).replace(/"/g, "'");
            lines.push(`    note for ${view.id(node.id)} "${text}"`);
        }
    }
    return lines.join('\n');
}

const ARROWS: Partial<Record<SubgraphEdge['relation'], { line: string; label: string }>> = {
    TAKES_INPUT: { line: '..>', label: 'accepts' },
    RETURNS_OUTPUT: { line: '-->', label: 'returns' },
    COMPOSES: { line: '--|>', label: 'composes' },
    ITEM_OF: { line: 'o--', label: 'array of' },
};

export function toFlowchart(sub: Subgraph, options: RenderOptions = {}): string {
    const view = new View(sub);
    const lines = ['flowchart LR'];

    for (const node of sub.nodes) {
        const a = node.attributes;
        const id = view.id(node.id);
        const label =
            node.kind === 'method'
                ? `${a.httpMethod} ${a.path}`
                : node.kind === 'property'
                  ? `${a.name}: ${a.signature || 'unknown'}`
                  : a.name;
        const [open, close] = node.kind === 'method' ? ['([', '])'] : ['[', ']'];
        lines.push(`    ${id}${open}"${safe(label)}"${close}`);
        if (node.hit) {
            lines.push(`    style ${id} fill:#1d2432,stroke:#5b7fff,color:#e6ecff`);
        }
    }

    for (const edge of sub.edges) {
        const label =
            edge.relation === 'RETURNS_OUTPUT' ? `returns ${edge.status}` : LABELS[edge.relation];
        lines.push(`    ${view.id(edge.source)} -->|${label}| ${view.id(edge.target)}`);
    }
    void options;
    return lines.join('\n');
}

const LABELS: Record<SubgraphEdge['relation'], string> = {
    TAKES_INPUT: 'accepts',
    HAS_PARAM: 'param',
    RETURNS_OUTPUT: 'returns',
    HAS_PROPERTY: 'has',
    OF_TYPE: 'of type',
    COMPOSES: 'composes',
    ITEM_OF: 'array of',
};

// ---------------------------------------------------------------------------

/** Indexed access to one subgraph, so a renderer is a loop and nothing else. */
class View {
    readonly owned = new Set<string>();
    readonly #nodes = new Map<string, SubgraphNode>();
    readonly #out = new Map<string, SubgraphEdge[]>();
    readonly #ids = new Map<string, string>();

    constructor(sub: Subgraph) {
        for (const node of sub.nodes) {
            this.#nodes.set(node.id, node);
        }
        for (const edge of sub.edges) {
            const list = this.#out.get(edge.source);
            if (list) {
                list.push(edge);
            } else {
                this.#out.set(edge.source, [edge]);
            }
            if (edge.relation === 'HAS_PROPERTY' || edge.relation === 'HAS_PARAM') {
                this.owned.add(edge.target);
            }
        }
        const taken = new Set<string>();
        for (const node of sub.nodes) {
            let id = safeId(node.attributes.name || node.id);
            for (let n = 2; taken.has(id); n++) {
                id = `${safeId(node.attributes.name || node.id)}_${n}`;
            }
            taken.add(id);
            this.#ids.set(node.id, id);
        }
    }

    node(id: string): SubgraphNode | undefined {
        return this.#nodes.get(id);
    }

    name(id: string): string {
        return this.#nodes.get(id)?.attributes.name ?? id;
    }

    id(id: string): string {
        return this.#ids.get(id) ?? safeId(id);
    }

    of(kind: string): SubgraphNode[] {
        return [...this.#nodes.values()].filter((n) => n.kind === kind);
    }

    out(id: string, relation: SubgraphEdge['relation']): SubgraphEdge[] {
        return (this.#out.get(id) ?? []).filter((e) => e.relation === relation);
    }
}

function clip(text: string, max: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Mermaid takes the label apart on quotes, brackets and newlines. */
function safe(text: string): string {
    return text.replace(/["\n]/g, ' ').replace(/[[\]{}<>|]/g, '');
}

function safeId(text: string): string {
    const cleaned = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}
