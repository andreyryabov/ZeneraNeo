import RandExp from 'randexp';

// ---------------------------------------------------------------------------
// Content for judging
//
// When a handler is being judged, its requests for content are answered from
// here instead of by an agent: a value the schema accepts, made up in
// microseconds. The judgement is about the handler's mechanics — does it read
// the right collection, echo the id, end its pages — and paying a model to
// write convincing prose for a probe would buy nothing but a slower build.
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

export function sample(
    schema: unknown,
    types: Readonly<Record<string, Schema>>,
    seed = 1,
): unknown {
    let state = seed >>> 0 || 1;
    const random = (): number => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
    return value(schema, 0);

    function value(node: unknown, depth: number): unknown {
        if (!isObject(node) || depth > 8) {
            return null;
        }
        const ref = typeof node.$ref === 'string' ? refName(node.$ref) : undefined;
        if (ref !== undefined) {
            const target = types[ref] ?? defs(node)?.[ref];
            return target ? value(target, depth + 1) : null;
        }
        if ('const' in node) {
            return node.const;
        }
        if (Array.isArray(node.enum) && node.enum.length > 0) {
            return node.enum[int(0, node.enum.length - 1)];
        }
        if (Array.isArray(node.allOf)) {
            const merged: Record<string, unknown> = {};
            for (const part of node.allOf) {
                const v = value(part, depth + 1);
                if (isObject(v)) {
                    Object.assign(merged, v);
                }
            }
            const own = node.properties ? value({ ...node, allOf: undefined }, depth + 1) : {};
            return { ...merged, ...(isObject(own) ? own : {}) };
        }
        for (const key of ['oneOf', 'anyOf'] as const) {
            const branches = node[key];
            if (Array.isArray(branches) && branches.length > 0) {
                return value(branches[0], depth + 1);
            }
        }
        switch (typeOf(node)) {
            case 'null':
                return null;
            case 'boolean':
                return random() < 0.5;
            case 'integer':
                return Math.round(bounded(node, int(1, 1000)));
            case 'number':
                return bounded(node, int(1, 100000) / 100);
            case 'array': {
                // Recursive types end where the schema lets them: empty lists, deep down.
                const min = num(node.minItems) ?? (depth >= 3 ? 0 : 1);
                const max = Math.max(min, Math.min(num(node.maxItems) ?? 3, min + 2));
                return Array.from({ length: int(min, max) }, () => value(node.items, depth + 1));
            }
            case 'object': {
                const out: Record<string, unknown> = {};
                const props = isObject(node.properties) ? node.properties : {};
                const required = new Set(Array.isArray(node.required) ? node.required : []);
                for (const [name, sub] of Object.entries(props)) {
                    if (required.has(name) || (depth < 3 && random() < 0.6)) {
                        out[name] = value(sub, depth + 1);
                    }
                }
                if (isObject(node.additionalProperties) && Object.keys(props).length === 0) {
                    out[WORDS[int(0, WORDS.length - 1)]!] = value(
                        node.additionalProperties,
                        depth + 1,
                    );
                }
                return out;
            }
            default:
                return text(node);
        }
    }

    function text(node: Schema): string {
        if (typeof node.pattern === 'string') {
            try {
                const gen = new RandExp(node.pattern);
                gen.max = 6;
                gen.randInt = int;
                return gen.gen();
            } catch {
                // an unreadable pattern falls through to plain text
            }
        }
        const at = new Date(
            Date.UTC(2026, 0, 1) + int(0, 300) * 86_400_000 + int(0, 86_399) * 1000,
        );
        switch (node.format) {
            case 'date-time':
                return at.toISOString().replace(/\.\d+Z$/, 'Z');
            case 'date':
                return at.toISOString().slice(0, 10);
            case 'email':
                return `${WORDS[int(0, WORDS.length - 1)]}@example.com`;
            case 'uuid':
                return '00000000-0000-4000-8000-'.concat(
                    Array.from({ length: 12 }, () => int(0, 15).toString(16)).join(''),
                );
            case 'uri':
            case 'url':
                return `https://example.com/${WORDS[int(0, WORDS.length - 1)]}`;
            case 'ipv4':
                return `10.0.${int(0, 255)}.${int(1, 254)}`;
            default:
                break;
        }
        const min = num(node.minLength) ?? 0;
        const max = num(node.maxLength) ?? 64;
        const word = `${WORDS[int(0, WORDS.length - 1)]} ${WORDS[int(0, WORDS.length - 1)]}`;
        return word.padEnd(min, 'x').slice(0, Math.max(min, Math.min(max, word.length)));
    }
}

const isObject = (v: unknown): v is Schema =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function refName(ref: string): string | undefined {
    const m = /^#\/(?:\$defs|definitions|components\/schemas)\/(.+)$/.exec(ref);
    return m ? decodeURIComponent(m[1]!).replace(/~1/g, '/').replace(/~0/g, '~') : undefined;
}

/** A dereferenced schema keeps its shared parts under its own `$defs`. */
const defs = (node: Schema): Record<string, Schema> | undefined =>
    isObject(node.$defs) ? (node.$defs as Record<string, Schema>) : undefined;

function typeOf(node: Schema): string | undefined {
    const t = node.type;
    if (typeof t === 'string') {
        return t;
    }
    if (Array.isArray(t)) {
        return t.find((x) => x !== 'null') as string | undefined;
    }
    return node.properties ? 'object' : node.items ? 'array' : undefined;
}

function bounded(node: Schema, wanted: number): number {
    const min = num(node.minimum) ?? num(node.exclusiveMinimum);
    const max = num(node.maximum) ?? num(node.exclusiveMaximum);
    let v = wanted;
    if (min !== undefined && v <= min) {
        v = min + 1;
    }
    if (max !== undefined && v >= max) {
        v = max - 1;
    }
    return v;
}
