import { SpecError, type Method, type Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// Matching a request to an operation
//
// Small enough to be obvious, which is the point: a route table is the one
// place where a subtle bug looks exactly like a missing feature. The only rule
// worth stating is precedence — a literal segment beats a templated one at the
// same depth, so `/users/me` is not swallowed by `/users/{id}`.
// ---------------------------------------------------------------------------

interface Segment {
    /** the parameter name when templated, undefined when literal */
    name?: string;
    literal?: string;
}

interface Route {
    operation: Operation;
    segments: Segment[];
    /** how many segments are literal — higher wins */
    specificity: number;
}

export interface Match {
    operation: Operation;
    pathParams: Record<string, string>;
}

export class Router {
    readonly #routes = new Map<Method, Route[]>();
    readonly operations: readonly Operation[];

    constructor(operations: readonly Operation[]) {
        this.operations = operations;
        const seen = new Map<string, Operation>();

        for (const operation of operations) {
            const id = `${operation.method} ${operation.path}`;
            const clash = seen.get(id);
            if (clash) {
                throw new SpecError(
                    `${id} is declared twice`,
                    `${clash.source} and ${operation.source} both define it`,
                );
            }
            seen.set(id, operation);

            const segments = compile(operation.path);
            const list = this.#routes.get(operation.method) ?? [];
            list.push({
                operation,
                segments,
                specificity: segments.filter((s) => s.name === undefined).length,
            });
            this.#routes.set(operation.method, list);
        }

        for (const list of this.#routes.values()) {
            list.sort((a, b) => b.specificity - a.specificity);
        }
    }

    match(method: string, pathname: string): Match | undefined {
        const parts = split(pathname);
        for (const route of this.#routes.get(method.toLowerCase() as Method) ?? []) {
            const pathParams = apply(route.segments, parts);
            if (pathParams) {
                return { operation: route.operation, pathParams };
            }
        }
        return undefined;
    }

    /** Whether the path exists under some other method — a 405, not a 404. */
    allowed(pathname: string): Method[] {
        const parts = split(pathname);
        const out: Method[] = [];
        for (const [method, list] of this.#routes) {
            if (list.some((r) => apply(r.segments, parts) !== undefined)) {
                out.push(method);
            }
        }
        return out;
    }
}

function compile(template: string): Segment[] {
    return split(template).map((raw) => {
        const m = /^\{(.+)\}$/.exec(raw);
        return m ? { name: m[1] } : { literal: decode(raw) };
    });
}

const split = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

function apply(segments: Segment[], parts: string[]): Record<string, string> | undefined {
    if (segments.length !== parts.length) {
        return undefined;
    }
    const out: Record<string, string> = {};
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment.name === undefined) {
            if (segment.literal !== decode(parts[i])) {
                return undefined;
            }
            continue;
        }
        out[segment.name] = decode(parts[i]);
    }
    return out;
}

/** A malformed escape is the client's problem; take the segment verbatim. */
function decode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}
