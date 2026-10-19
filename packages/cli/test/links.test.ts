import { Workspace } from '@zenera/neo';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
    hostUrls,
    hyperlinks,
    linkBlock,
    linkSpans,
    mountsOf,
    mountUrl,
} from '../src/tui/links.ts';
import { blocksOf, inlineOf, type Span } from '../src/tui/wrap.ts';

// realpath'd, because on macOS the temp dir is a symlink and `within` resolves it.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'zn-links-')));
const dir = (...parts: string[]): string => {
    const path = join(root, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
};
const workspace = dir('my ws');
const assets = dir('assets');
const skill = dir('skills', 'report');
const outside = dir('outside');
symlinkSync(outside, join(workspace, 'escape'));

const mounts = mountsOf(
    new Workspace({
        root: workspace,
        mount: '/workspace',
        mounts: [
            { host: assets, at: '/assets' },
            { host: skill, at: '/skills/report' },
        ],
    }),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const url = (path: string): string => pathToFileURL(path).href;
const WS = url(workspace);

const joined = (spans: readonly Span[]): string => spans.map((s) => s.text).join('');
const linked = (spans: readonly Span[]): [string, string][] =>
    spans.filter((s) => s.href).map((s) => [s.text, s.href ?? '']);

describe('a mounted path, as a host url', () => {
    it('maps the bare path, the file url and the root', () => {
        expect(mountUrl('/workspace/out/r.html', mounts)).toBe(`${WS}/out/r.html`);
        expect(mountUrl('file:///workspace/a%20b.html', mounts)).toBe(`${WS}/a%20b.html`);
        expect(mountUrl('file:///workspace/r.html#top', mounts)).toBe(`${WS}/r.html#top`);
        expect(mountUrl('/workspace', mounts)).toBe(WS);
        expect(mountUrl('/workspace/a/../b', mounts)).toBe(`${WS}/b`);
    });

    it('maps every tree the file tools reach', () => {
        expect(mountUrl('/assets/specs/api.yaml', mounts)).toBe(
            url(join(assets, 'specs/api.yaml')),
        );
        expect(mountUrl('/skills/report/SKILL.md', mounts)).toBe(url(join(skill, 'SKILL.md')));
    });

    it('refuses what is in no tree', () => {
        expect(mountUrl('/workspace/../outside/x', mounts)).toBeUndefined();
        expect(mountUrl('file:///workspace/%2E%2E/x', mounts)).toBeUndefined();
        expect(mountUrl('/workspace/escape/secret', mounts)).toBeUndefined();
        expect(mountUrl('/workspaces/x', mounts)).toBeUndefined();
        expect(mountUrl('/skills/other/x', mounts)).toBeUndefined();
        expect(mountUrl('/home/agent/.bashrc', mounts)).toBeUndefined();
        expect(mountUrl('out/r.html', mounts)).toBeUndefined();
        expect(mountUrl('/', mounts)).toBeUndefined();
        expect(mountUrl('https://example.com/workspace/x', mounts)).toBeUndefined();
    });

    it('follows a workspace mounted under another name', () => {
        const src = mountsOf(new Workspace({ root: workspace, mount: '/src' }));
        expect(mountUrl('/src/x.ts', src)).toBe(`${WS}/x.ts`);
        expect(mountUrl('/workspace/x.ts', src)).toBeUndefined();
    });
});

describe('linking the spans of an answer', () => {
    it('links paths in prose and code without changing a character', () => {
        const text = 'Saved to /workspace/out.html. See `file:///assets/r.html` too.';
        const spans = linkSpans(inlineOf(text), mounts);
        expect(joined(spans)).toBe(joined(inlineOf(text)));
        expect(linked(spans)).toEqual([
            ['/workspace/out.html', `${WS}/out.html`],
            ['file:///assets/r.html', url(join(assets, 'r.html'))],
        ]);
        expect(spans.find((s) => s.href?.endsWith('r.html'))?.code).toBe(true);
    });

    it('points a markdown link at the host', () => {
        const spans = linkSpans(inlineOf('[the report](/workspace/r.html)'), mounts);
        expect(linked(spans)).toEqual([['the report', `${WS}/r.html`]]);
    });

    it('leaves alone what is not a mounted path', () => {
        const text =
            'see /home/workspace/x, x/workspace/y, /workspace.bak, /skills/reporter and [a](https://a.b)';
        const spans = linkSpans(inlineOf(text), mounts);
        expect(joined(spans)).toBe(joined(inlineOf(text)));
        expect(linked(spans)).toEqual([['a', 'https://a.b']]);
    });

    it('links inside table cells and leaves a fence verbatim', () => {
        const [table, fence] = blocksOf(
            '| file |\n| --- |\n| /workspace/a.csv |\n\n```\n/workspace/b\n```',
        ).map((b) => linkBlock(b, mounts));
        expect(linked(table?.cells?.flat(2) ?? [])).toEqual([['/workspace/a.csv', `${WS}/a.csv`]]);
        expect(fence?.lines).toEqual(['/workspace/b']);
    });
});

describe('a workspace-relative path in code', () => {
    writeFileSync(join(dir('my ws', 'scripts'), 'chart.py'), '');
    writeFileSync(join(outside, 'secret.py'), '');

    it('links an existing file and leaves everything else alone', () => {
        const text =
            'Run `scripts/chart.py`, not `scripts/missing.py`, `scripts`, `escape/secret.py`, ' +
            '`../outside/secret.py` or `res.output`; prose scripts/chart.py stays plain.';
        const spans = linkSpans(inlineOf(text), mounts);
        expect(joined(spans)).toBe(joined(inlineOf(text)));
        expect(linked(spans)).toEqual([['scripts/chart.py', `${WS}/scripts/chart.py`]]);
    });
});

describe('a terminal with no hyperlinks', () => {
    it('rewrites only the file urls', () => {
        expect(hostUrls('open file:///workspace/r.html, not /workspace/x', mounts)).toBe(
            `open ${WS}/r.html, not /workspace/x`,
        );
        expect(hostUrls('[r](file:///assets/r.html)', mounts)).toBe(
            `[r](${url(join(assets, 'r.html'))})`,
        );
        expect(hostUrls('file:///workspace/../x', mounts)).toBe('file:///workspace/../x');
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
