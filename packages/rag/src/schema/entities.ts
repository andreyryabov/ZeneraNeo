import type { ApiGraph } from './graph.ts';

// ---------------------------------------------------------------------------
// The graph, flattened for retrieval
//
// One row per node, and one `text` column that is both embedded and full-text
// indexed. Materializing the two from the same string is deliberate: if the
// vector half and the keyword half rank different sentences, their fusion is
// comparing two things that were never about the same subject.
//
// A type's text carries its field names. Nobody searches for `Invoice` — they
// search for "the thing with a total and a paid date", and without the names
// in the string the only way to that type is one of its properties.
// ---------------------------------------------------------------------------

export interface EntityRecord {
    id: string;
    kind: string;
    name: string;
    parent: string;
    doc: string;
    direction: string;
    methodType: string;
    httpMethod: string;
    path: string;
    source: string;
    signature: string;
    required: boolean;
    text: string;
}

/** How many field names of a type are worth putting in its search text. */
const FIELDS_IN_TEXT = 40;

export function toEntities(graph: ApiGraph): EntityRecord[] {
    const out: EntityRecord[] = [];
    for (const id of graph.nodes()) {
        const a = graph.getNodeAttributes(id);
        out.push({
            id,
            kind: a.kind,
            name: a.name,
            parent: a.parent,
            doc: a.doc,
            direction: a.direction,
            methodType: a.methodType,
            httpMethod: a.httpMethod,
            path: a.path,
            source: a.source,
            signature: a.signature,
            required: a.required,
            text: textOf(graph, id),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Exported so a literal search reads the same string the index was built from. */
export function textOf(graph: ApiGraph, id: string): string {
    const a = graph.getNodeAttributes(id);
    const parts: string[] = [];

    if (a.kind === 'method') {
        parts.push(`[method] ${a.httpMethod} ${a.path}`, a.name, a.methodType.replace('_', ' '));
    } else if (a.kind === 'type') {
        parts.push(`[type] ${a.name}`, side(a.direction));
        const fields = graph
            .outEdges(id)
            .filter((e) => graph.getEdgeAttribute(e, 'relation') === 'HAS_PROPERTY')
            .slice(0, FIELDS_IN_TEXT)
            .map((e) => graph.getNodeAttribute(graph.target(e), 'name'));
        if (fields.length > 0) {
            parts.push(`fields: ${fields.join(', ')}`);
        }
    } else {
        const where = a.parent ? ` in ${a.parent}` : '';
        parts.push(`[property] ${a.name}${a.signature ? `: ${a.signature}` : ''}${where}`);
        parts.push(side(a.direction));
    }

    const spaced = words(a.name);
    if (spaced) {
        parts.push(spaced);
    }
    if (a.doc) {
        parts.push(`— ${a.doc}`);
    }
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * `meowVolume` as "meow volume". No tokenizer splits an identifier, so without
 * this the only way to a field is to already know how it was capitalized.
 */
function words(name: string): string {
    const spaced = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .toLowerCase()
        .trim();
    return spaced === name.toLowerCase() ? '' : spaced;
}

function side(direction: string): string {
    return direction === 'none' ? '' : `(${direction})`;
}
