import { CliError, EXIT } from '@zenera/cli/lib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '../../src/command.ts';
import { buildIndex } from '../../src/docs/build.ts';
import { parseTarget, TargetError } from '../../src/docs/targets.ts';
import { StubEmbedder } from '../stub.ts';

// ---------------------------------------------------------------------------
// `show` with several targets
//
// What is defended is one call reading every passage an answer will cite, each
// under a header that pastes back as a target, so an agent never spends a turn
// per document.
// ---------------------------------------------------------------------------

const ROUTING = 'acme_4.2.0/api/routing.md';
const LONG = 'acme_4.2.0/guides/long.md';

const CORPUS: Record<string, string> = {
    [ROUTING]: [
        '# Routing',
        '',
        'Traffic is matched against the table below.',
        '',
        '## Rate limits',
        '',
        'Requests are counted per tenant.',
        '',
        '| route | limit |',
        '| --- | --- |',
        '| /api/users | 250 |',
        '',
        '## Step 1: Retry',
        '',
        'A 429 response carries a Retry-After header.',
    ].join('\n'),

    [LONG]: ['# Long', ...Array.from({ length: 159 }, (_, i) => `line ${i + 2}`)].join('\n'),

    // Names are relative to the common root; this keeps the release in them.
    'notes.txt': 'The staging cluster is rebuilt every Sunday.',
};

const source = await mkdtemp(join(tmpdir(), 'zenera-show-src-'));
const dir = await mkdtemp(join(tmpdir(), 'zenera-show-'));

for (const [name, text] of Object.entries(CORPUS)) {
    const path = join(source, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
}

await buildIndex({
    files: [source],
    cwd: process.cwd(),
    out: dir,
    embedder: new StubEmbedder(),
    indexer: 'test',
});

afterAll(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function show(targets: string[], json = false): Promise<{ out: string; error?: CliError }> {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await command.run({
            args: ['docs', 'show', '--dir', dir, '--quiet', ...targets],
            json,
            cwd: process.cwd(),
        });
    } catch (thrown) {
        return { out: out.join(''), error: thrown as CliError };
    }
    return { out: out.join('') };
}

const headers = (out: string): string[] => out.split('\n').filter((line) => line.startsWith('## '));

describe('reading the grammar of a target', () => {
    const names = new Set([ROUTING, LONG, 'odd:name.md']);

    it('reads a bare name, a range, a line and a heading', () => {
        expect(parseTarget(ROUTING, names)).toEqual({ target: ROUTING, file: ROUTING });
        expect(parseTarget(`${ROUTING}:3-9`, names)).toMatchObject({ from: 3, to: 9 });
        expect(parseTarget(`${ROUTING}:7`, names)).toMatchObject({ from: 7, to: 7 });
        expect(parseTarget(`${ROUTING}#Rate limits`, names)).toMatchObject({
            file: ROUTING,
            section: 'Rate limits',
        });
    });

    it('splits where a known document ends, not at the last colon', () => {
        expect(parseTarget(`${ROUTING}#Step 1: Retry`, names)).toMatchObject({
            file: ROUTING,
            section: 'Step 1: Retry',
        });
        expect(parseTarget('odd:name.md:4', names)).toMatchObject({ file: 'odd:name.md', from: 4 });
    });

    it('refuses a range that is not one', () => {
        for (const bad of [`${ROUTING}:5-`, `${ROUTING}:9-3`, `${ROUTING}:0`, `${ROUTING}:x`]) {
            expect(() => parseTarget(bad, names)).toThrow(TargetError);
        }
    });
});

describe('docs show, several at once', () => {
    it('prints each target under its own header, in the order given', async () => {
        const { out, error } = await show([`${LONG}:5-8`, `${ROUTING}:9-11`]);
        expect(error).toBeUndefined();
        expect(headers(out)).toEqual([`## ${LONG}:5-8`, `## ${ROUTING}:9-11`]);
        expect(out).toContain('| /api/users | 250 |');
    });

    it('heads a single range too, so the citation is on the page', async () => {
        const { out } = await show([`${ROUTING}:9-11`]);
        expect(headers(out)).toEqual([`## ${ROUTING}:9-11`]);
    });

    it('prints overlapping and repeated ranges once', async () => {
        expect(headers((await show([`${ROUTING}:1-5`, `${ROUTING}:4-8`])).out)).toEqual([
            `## ${ROUTING}:1-8`,
        ]);
        expect(headers((await show([`${ROUTING}:1-5`, `${ROUTING}:1-5`])).out)).toEqual([
            `## ${ROUTING}:1-5`,
        ]);
    });

    it('reads a heading that holds a colon, and names it', async () => {
        const { out } = await show([`${ROUTING}#Step 1: Retry`, `${LONG}:2`]);
        expect(headers(out)[0]).toMatch(/^## .*routing\.md:13-\d+ \(#Step 1: Retry\)$/);
        expect(out).toContain('Retry-After');
    });

    it('says when a range ran past the end', async () => {
        const { out } = await show([`${ROUTING}:10-999`, `${LONG}:1`]);
        expect(headers(out)[0]).toBe(`## ${ROUTING}:10-15 (asked 10-999; the document ends at 15)`);
    });

    it('reports a missing document in place and prints the rest', async () => {
        const { out, error } = await show([`${ROUTING}:1-3`, 'missing.md:1-20']);
        expect(error).toBeUndefined();
        expect(headers(out)).toEqual([`## ${ROUTING}:1-3`, '## missing.md:1-20']);
        expect(out).toContain('error: no document by that name');
        expect(out).toContain('list files');
    });

    it('fails when no target could be read', async () => {
        const { error } = await show(['missing.md', 'nowhere.md']);
        expect(error).toBeInstanceOf(CliError);
        expect(error!.code).toBe(EXIT.failed);
    });

    it('refuses a malformed target before printing anything', async () => {
        const { out, error } = await show([`${ROUTING}:1-3`, `${ROUTING}:9-3`]);
        expect(error!.code).toBe(EXIT.usage);
        expect(out).toBe('');
    });

    it('refuses --lines beside several documents', async () => {
        const { error } = await show([ROUTING, LONG, '--lines', '1-5']);
        expect(error!.code).toBe(EXIT.usage);
    });

    it('shares the line budget, and every cut names the read that continues it', async () => {
        const { out } = await show([
            `${LONG}:1-30`,
            `${LONG}:41-70`,
            `${LONG}:81-110`,
            `${LONG}:121-150`,
            '--max-lines',
            '40',
        ]);
        expect(headers(out)).toEqual([
            `## ${LONG}:1-10`,
            `## ${LONG}:41-50`,
            `## ${LONG}:81-90`,
            `## ${LONG}:121-130`,
        ]);
        expect(out).toContain(`... truncated at line 10 of 30 - read ${LONG}:11-30 to continue`);
        expect(out).toContain(`read ${LONG}:131-150 to continue`);
    });

    it('answers --json with one result per target', async () => {
        const { out } = await show([`${ROUTING}:9-11`, 'missing.md'], true);
        const parsed = JSON.parse(out);
        expect(parsed.printed).toBe(1);
        expect(parsed.failed).toBe(1);
        expect(parsed.results[0]).toMatchObject({
            target: `${ROUTING}:9-11`,
            file: ROUTING,
            from: 9,
            to: 11,
            section: null,
            truncated: false,
        });
        expect(parsed.results[0].text).toContain('| /api/users | 250 |');
        expect(parsed.results[1].error).toBe('no document by that name');
    });
});

describe('docs show, one document as before', () => {
    it('prints a --lines range with no header', async () => {
        const { out } = await show([ROUTING, '--lines', '9-11', '--no-numbers']);
        expect(out).toBe(
            ['| route | limit |', '| --- | --- |', '| /api/users | 250 |', ''].join('\n'),
        );
    });

    it('prints a whole long document uncapped', async () => {
        const { out } = await show([LONG, '--no-numbers']);
        expect(out.trimEnd().split('\n')).toHaveLength(160);
    });

    it('cuts it when --max-lines is asked for', async () => {
        const { out } = await show([LONG, '--no-numbers', '--max-lines', '5']);
        expect(out.trimEnd().split('\n')).toHaveLength(6);
        expect(out).toContain(`read ${LONG}:6-160 to continue`);
    });
});
