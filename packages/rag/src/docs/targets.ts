import type { Read } from './lookup.ts';

// ---------------------------------------------------------------------------
// A read, written as its citation
//
// `<document>:<a>-<b>`, `<document>:<a>`, `<document>#<heading>`, or a bare
// document name — the form an answer cites a passage in, so a citation pastes
// back unchanged.
//
// Splitting at the last `:` or `#` would be wrong both ways: a heading may hold
// a colon (`#Step 1: Install`) and a document name is any relative path. So the
// split is wherever the text before it is a document the index holds, longest
// first, and only a name nobody holds is split by guesswork.
// ---------------------------------------------------------------------------

export class TargetError extends Error {}

export function parseTarget(raw: string, names: ReadonlySet<string>): Read {
    if (names.has(raw)) {
        return { target: raw, file: raw };
    }
    for (let at = raw.length - 1; at > 0; at--) {
        if ((raw[at] === ':' || raw[at] === '#') && names.has(raw.slice(0, at))) {
            return selector(raw, raw.slice(0, at), raw[at]!, raw.slice(at + 1));
        }
    }
    // A name the index does not hold: a heading is likelier to carry a colon
    // than a document name a hash, so the first `#` wins over the last `:`.
    const hash = raw.indexOf('#');
    const at = hash > 0 ? hash : raw.lastIndexOf(':');
    return at > 0
        ? selector(raw, raw.slice(0, at), raw[at]!, raw.slice(at + 1))
        : { target: raw, file: raw };
}

/** Does this argument name a part of a document the index holds? */
export function selects(raw: string, names: ReadonlySet<string>): boolean {
    const read = parseTarget(raw, names);
    return names.has(read.file) && read.file !== raw;
}

function selector(raw: string, file: string, mark: string, rest: string): Read {
    if (mark === '#') {
        if (!rest.trim()) {
            throw new TargetError(`"${raw}" names no heading after the #`);
        }
        return { target: raw, file, section: rest };
    }
    const found = /^(\d+)(?:-(\d+))?$/.exec(rest);
    const from = Number(found?.[1]);
    const to = found?.[2] === undefined ? from : Number(found[2]);
    if (!found || from < 1 || to < from) {
        throw new TargetError(`"${raw}" is not a line range - expected <document>:<a>-<b>`);
    }
    return { target: raw, file, from, to };
}
