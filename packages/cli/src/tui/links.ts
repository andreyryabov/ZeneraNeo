import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Block, Span } from './wrap.ts';

// ---------------------------------------------------------------------------
// Workspace paths, as links to this machine
//
// The agent names its files the way the sandbox mounts them — `/workspace/x`
// or `file:///workspace/x` — and neither opens anything on the host. Text is
// never changed where the terminal can carry a hyperlink: the path stays as
// the agent wrote it and the click goes to the real file.
// ---------------------------------------------------------------------------

export interface WorkspaceLink {
    /** the name the agent sees, e.g. `/workspace` */
    at: string;
    /** the directory on this machine */
    host: string;
}

const FILE = 'file://';

/** Prose punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;:!?'"]+$/;

/**
 * The host `file:` url a workspace path names, or nothing.
 *
 * Model output is untrusted, so a path that climbs out of the workspace is
 * not a link to anywhere.
 */
export function workspaceUrl(token: string, ws: WorkspaceLink): string | undefined {
    let path = token;
    let fragment = '';
    if (path.startsWith(FILE)) {
        path = path.slice(FILE.length);
        const cut = path.search(/[?#]/);
        if (cut >= 0) {
            fragment = path.slice(cut);
            path = path.slice(0, cut);
        }
        try {
            path = decodeURIComponent(path);
        } catch {
            return undefined;
        }
    }
    if (path !== ws.at && !path.startsWith(`${ws.at}/`)) {
        return undefined;
    }
    const rest = posix.normalize(path.slice(ws.at.length).replace(/^\/+/, '') || '.');
    if (rest === '..' || rest.startsWith('../') || rest.includes('\0')) {
        return undefined;
    }
    return pathToFileURL(join(ws.host, rest)).href + fragment;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/** Every spelling of a workspace path in running text. */
function pattern(ws: WorkspaceLink): RegExp {
    return new RegExp(
        `(?<![\\w/.:-])(?:${FILE})?${escaped(ws.at)}(?![\\w-]|\\.\\w)(?:/[^\\s<>"'\`()[\\]{}|\\\\^]*)?`,
        'g',
    );
}

/** Each workspace path in `text`, without the punctuation that follows it. */
function* matches(text: string, ws: WorkspaceLink): Generator<{ at: number; token: string }> {
    for (const m of text.matchAll(pattern(ws))) {
        const token = m[0].replace(TRAILING, '');
        if (token) {
            yield { at: m.index, token };
        }
    }
}

/**
 * The same spans with the same text, workspace paths carrying a host `href`.
 *
 * Only `href` changes, so every width measured from `span.text` still holds.
 */
export function linkSpans(spans: readonly Span[], ws: WorkspaceLink): Span[] {
    const out: Span[] = [];
    for (const span of spans) {
        if (span.href) {
            const url = workspaceUrl(span.href, ws);
            out.push(url ? { ...span, href: url } : span);
            continue;
        }
        let from = 0;
        for (const { at, token } of matches(span.text, ws)) {
            const url = workspaceUrl(token, ws);
            if (!url) {
                continue;
            }
            if (at > from) {
                out.push({ ...span, text: span.text.slice(from, at) });
            }
            out.push({ ...span, text: token, href: url });
            from = at + token.length;
        }
        if (from === 0) {
            out.push(span);
        } else if (from < span.text.length) {
            out.push({ ...span, text: span.text.slice(from) });
        }
    }
    return out;
}

/** A block whose prose and cells link their workspace paths; a fence is left alone. */
export function linkBlock(block: Block, ws: WorkspaceLink): Block {
    return {
        ...block,
        ...(block.spans ? { spans: linkSpans(block.spans, ws) } : {}),
        ...(block.cells
            ? { cells: block.cells.map((row) => row.map((cell) => linkSpans(cell, ws))) }
            : {}),
    };
}

/** For a terminal with no hyperlinks: every `file:///workspace/…` url, rewritten to the host. */
export function hostUrls(text: string, ws: WorkspaceLink): string {
    let out = '';
    let from = 0;
    for (const { at, token } of matches(text, ws)) {
        const url = token.startsWith(FILE) ? workspaceUrl(token, ws) : undefined;
        if (!url) {
            continue;
        }
        out += text.slice(from, at) + url;
        from = at + token.length;
    }
    return out + text.slice(from);
}

/** `text` as an OSC 8 hyperlink to `href`. */
export function hyperlink(href: string, text: string): string {
    return `\u001b]8;;${href}\u001b\\${text}\u001b]8;;\u001b\\`;
}

/** Whether this terminal turns OSC 8 into a link; an unknown one is assumed not to. */
export function hyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
    const forced = env.FORCE_HYPERLINK;
    if (forced !== undefined && forced !== '') {
        return forced !== '0' && forced !== 'false';
    }
    if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION) {
        return true;
    }
    if (['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM ?? '')) {
        return true;
    }
    if (env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty') {
        return true;
    }
    return Number(env.VTE_VERSION ?? 0) >= 5000;
}
