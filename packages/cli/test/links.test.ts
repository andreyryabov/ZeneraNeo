import { describe, expect, it } from 'vitest';
import {
    hostUrls,
    hyperlinks,
    linkBlock,
    linkSpans,
    workspaceUrl,
    type WorkspaceLink,
} from '../src/tui/links.ts';
import { blocksOf, inlineOf, type Span } from '../src/tui/wrap.ts';

const ws: WorkspaceLink = { at: '/workspace', host: '/Users/me/my proj' };
const HOST = 'file:///Users/me/my%20proj';

const joined = (spans: readonly Span[]): string => spans.map((s) => s.text).join('');
const linked = (spans: readonly Span[]): [string, string][] =>
    spans.filter((s) => s.href).map((s) => [s.text, s.href ?? '']);

describe('a workspace path, as a host url', () => {
    it('maps the bare path, the file url and the root', () => {
        expect(workspaceUrl('/workspace/out/r.html', ws)).toBe(`${HOST}/out/r.html`);
        expect(workspaceUrl('file:///workspace/a%20b.html', ws)).toBe(`${HOST}/a%20b.html`);
        expect(workspaceUrl('file:///workspace/r.html#top', ws)).toBe(`${HOST}/r.html#top`);
        expect(workspaceUrl('/workspace', ws)).toBe(HOST);
        expect(workspaceUrl('/workspace/a/../b', ws)).toBe(`${HOST}/b`);
    });

    it('refuses what is not in the workspace', () => {
        expect(workspaceUrl('/workspace/../etc/passwd', ws)).toBeUndefined();
        expect(workspaceUrl('file:///workspace/%2E%2E/x', ws)).toBeUndefined();
        expect(workspaceUrl('/workspaces/x', ws)).toBeUndefined();
        expect(workspaceUrl('/assets/x', ws)).toBeUndefined();
        expect(workspaceUrl('https://example.com/workspace/x', ws)).toBeUndefined();
    });

    it('follows a workspace mounted under another name', () => {
        expect(workspaceUrl('/src/x.ts', { at: '/src', host: '/h' })).toBe('file:///h/x.ts');
        expect(workspaceUrl('/workspace/x.ts', { at: '/src', host: '/h' })).toBeUndefined();
    });
});

describe('linking the spans of an answer', () => {
    it('links paths in prose and code without changing a character', () => {
        const text = 'Saved to /workspace/out.html. See `file:///workspace/r.html` too.';
        const spans = linkSpans(inlineOf(text), ws);
        expect(joined(spans)).toBe(joined(inlineOf(text)));
        expect(linked(spans)).toEqual([
            ['/workspace/out.html', `${HOST}/out.html`],
            ['file:///workspace/r.html', `${HOST}/r.html`],
        ]);
        expect(spans.find((s) => s.href?.endsWith('r.html'))?.code).toBe(true);
    });

    it('points a markdown link at the host', () => {
        const spans = linkSpans(inlineOf('[the report](/workspace/r.html)'), ws);
        expect(linked(spans)).toEqual([['the report', `${HOST}/r.html`]]);
    });

    it('leaves alone what is not a workspace path', () => {
        const text = 'see /home/workspace/x, x/workspace/y, /workspace.bak and [a](https://a.b)';
        const spans = linkSpans(inlineOf(text), ws);
        expect(joined(spans)).toBe(joined(inlineOf(text)));
        expect(linked(spans)).toEqual([['a', 'https://a.b']]);
    });

    it('links inside table cells and leaves a fence verbatim', () => {
        const [table, fence] = blocksOf(
            '| file |\n| --- |\n| /workspace/a.csv |\n\n```\n/workspace/b\n```',
        ).map((b) => linkBlock(b, ws));
        expect(linked(table?.cells?.flat(2) ?? [])).toEqual([
            ['/workspace/a.csv', `${HOST}/a.csv`],
        ]);
        expect(fence?.lines).toEqual(['/workspace/b']);
    });
});

describe('a terminal with no hyperlinks', () => {
    it('rewrites only the file urls', () => {
        expect(hostUrls('open file:///workspace/r.html, not /workspace/x', ws)).toBe(
            `open ${HOST}/r.html, not /workspace/x`,
        );
        expect(hostUrls('[r](file:///workspace/r.html)', ws)).toBe(`[r](${HOST}/r.html)`);
        expect(hostUrls('file:///workspace/../x', ws)).toBe('file:///workspace/../x');
    });
});

describe('which terminals draw hyperlinks', () => {
    it('trusts the ones that do and nothing it does not know', () => {
        expect(hyperlinks({ TERM_PROGRAM: 'vscode' })).toBe(true);
        expect(hyperlinks({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
        expect(hyperlinks({ WT_SESSION: 'x' })).toBe(true);
        expect(hyperlinks({ VTE_VERSION: '7600' })).toBe(true);
        expect(hyperlinks({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
        expect(hyperlinks({})).toBe(false);
    });

    it('lets FORCE_HYPERLINK decide either way', () => {
        expect(hyperlinks({ FORCE_HYPERLINK: '1' })).toBe(true);
        expect(hyperlinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'vscode' })).toBe(false);
    });
});
