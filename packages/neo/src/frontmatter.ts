// ---------------------------------------------------------------------------
// Markdown frontmatter
//
// Deliberately not a YAML parser: `key: value` and flow lists cover what a
// skill header or a house-rules condition needs, and a real dependency would
// buy nothing. Shared so a document written for one reader parses the same way
// for the other — and so the CLI's validator can mirror the loader exactly.
// ---------------------------------------------------------------------------

export interface Frontmatter {
    data: Record<string, string>;
    /** the document with the header removed, trimmed */
    body: string;
}

export function frontmatter(raw: string): Frontmatter {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
    if (!m) {
        return { data: {}, body: raw.trim() };
    }
    const data: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const i = line.indexOf(':');
        const key = i < 0 ? '' : line.slice(0, i).trim();
        if (!key || key.startsWith('#')) {
            continue;
        }
        data[key] = unquote(line.slice(i + 1).trim());
    }
    return { data, body: raw.slice(m[0].length).trim() };
}

export function toList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    return inner
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
}

export function unquote(value: string): string {
    const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
    return quoted && value.length > 1 ? value.slice(1, -1) : value;
}
