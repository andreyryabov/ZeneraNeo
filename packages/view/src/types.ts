import type { Root } from 'hast';

// Shared by the server and the browser bundle: types only, no imports that run.

export type ViewKind =
    'markdown' | 'code' | 'mermaid' | 'text' | 'directory' | 'binary' | 'missing';

export interface Heading {
    depth: number;
    id: string;
    text: string;
}

/** One file or directory, rendered: what the page draws, and nothing it must work out. */
export interface View {
    /** the URL path, `/` separated, always starting with `/` */
    path: string;
    kind: ViewKind;
    title: string;
    /** sanitized: every element and attribute in it is safe to hand to React */
    hast: Root;
    toc: Heading[];
    language?: string;
    bytes?: number;
    mtimeMs?: number;
    /** only the first `shown` bytes of `bytes` were rendered */
    truncated?: { shown: number; bytes: number };
}
