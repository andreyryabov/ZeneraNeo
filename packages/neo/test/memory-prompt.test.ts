import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryIndex } from '../src/memory/index.ts';
import {
    memoryInstructions,
    PREFERENCES_TAG,
    renderPreferences,
} from '../src/memory/instructions.ts';
import { recall } from '../src/memory/recall.ts';
import { renderRecollection } from '../src/memory/render.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { MemoryNode, Recollection, ResolvedMemoryBinding } from '../src/memory/types.ts';

const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-06-01T00:00:00.000Z';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const binding = (access: ResolvedMemoryBinding['access'], sees = ['*']): ResolvedMemoryBinding => ({
    access,
    sees,
    writes: ['*'],
});

let dir: string;
let index: MemoryIndex;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'neo-mem-prompt-'));
    index = new MemoryIndex({ store: await MemoryStore.open(dir) });
});

afterEach(() => {
    index.store.release();
    rmSync(dir, { recursive: true, force: true });
});

describe('memory instructions', () => {
    it('tells a read-only agent how to read and nothing about writing', () => {
        const text = memoryInstructions(binding('read'));
        expect(text).toContain('memory-recollection');
        expect(text).not.toContain('memory_commit');
        expect(text).not.toContain('memory_forget');
    });

    it('adds the commit policy once the agent can write', () => {
        const text = memoryInstructions(binding('read-write'));
        expect(text).toContain('memory_commit');
        expect(text).toContain('SUPERSEDES');
        expect(text).not.toContain('memory_forget');
    });

    it('adds the forget policy only at full access', () => {
        expect(memoryInstructions(binding('full'))).toContain('memory_forget');
    });

    it('never names the audience labels the agent happens to hold', () => {
        const text = memoryInstructions(binding('full', ['*', 'triage']));
        expect(text).not.toContain('triage');
    });
});

describe('the preference block', () => {
    const pref = (id: string, text: string, at = T0, audience = ['*']): MemoryNode =>
        index.graph.add({ id, kind: 'preference', text, audience }, at);

    it('is empty when there is nothing standing', () => {
        expect(renderPreferences(index.preferences(['*']))).toBe('');
    });

    it('carries the id, so the model can name what it would supersede', () => {
        pref('P1', 'report findings as a table, never prose');
        const out = renderPreferences(index.preferences(['*']));
        expect(out).toContain(`<${PREFERENCES_TAG}>`);
        expect(out).toContain('- report findings as a table, never prose [P1]');
    });

    it('collapses a multi-line instruction without clipping it', () => {
        pref('P1', 'use ISO dates\n   everywhere, including\tfilenames');
        expect(renderPreferences(index.preferences(['*']))).toContain(
            '- use ISO dates everywhere, including filenames [P1]',
        );
    });

    // The regression guard for the decay trap: ranking multiplies by
    // recencyDecay(lastUsedAt) and only memory_load bumps that, so routing this
    // through recall() would make a preference age out of its own list.
    it('keeps a preference nothing has ever read', () => {
        const old = pref('P1', 'always report in UTC');
        expect(old.useCount).toBe(0);
        expect(old.lastUsedAt).toBe(T0);
        expect(index.preferences(['*']).map((n) => n.id)).toEqual(['P1']);
    });

    it('drops one that has been superseded', () => {
        pref('P1', 'report findings as prose');
        pref('P2', 'report findings as a table', T1);
        index.graph.link('P2', 'P1', 'SUPERSEDES', T1);
        expect(index.preferences(['*']).map((n) => n.id)).toEqual(['P2']);
    });

    it('masks a preference the agent may not see', () => {
        pref('P1', 'everyone sees this');
        pref('P2', 'only triage sees this', T1, ['triage']);
        expect(index.preferences(['*']).map((n) => n.id)).toEqual(['P1']);
        expect(index.preferences(['*', 'triage']).map((n) => n.id)).toEqual(['P1', 'P2']);
    });

    // An unstable order would rewrite the system prompt, and so re-issue the
    // provider's cache prefix, for no change in meaning.
    it('orders stably, oldest first', () => {
        pref('P2', 'second', T1);
        pref('P1', 'first', T0);
        expect(renderPreferences(index.preferences(['*']))).toBe(
            renderPreferences(index.preferences(['*'])),
        );
        expect(index.preferences(['*']).map((n) => n.id)).toEqual(['P1', 'P2']);
    });
});

describe('preferences and ordinary recall', () => {
    beforeEach(() => {
        index.graph.add(
            { id: 'P1', kind: 'preference', text: 'report findings as a table', audience: ['*'] },
            T0,
        );
        index.graph.add(
            {
                id: 'T1',
                kind: 'task',
                text: 'report findings on the gateway rules',
                audience: ['*'],
            },
            T0,
        );
    });

    const search = (kinds?: string[]): Recollection =>
        recall({
            graph: index.graph,
            query: { text: 'report findings as a table', ...(kinds ? { kinds } : {}) },
            sees: ['*'],
            now: NOW,
        });

    it('leaves preferences out, so the prompt does not say it twice', () => {
        expect(search().nodes.map((n) => n.node.id)).not.toContain('P1');
    });

    it('returns them when the kind is asked for by name', () => {
        expect(search(['preference']).nodes.map((n) => n.node.id)).toEqual(['P1']);
    });
});

describe('the vocabulary', () => {
    it('keeps `preference` even when a project declares its own kinds', async () => {
        const own = mkdtempSync(join(tmpdir(), 'neo-mem-kinds-'));
        const store = await MemoryStore.open(own);
        try {
            const custom = new MemoryIndex({ store, kinds: ['note'] });
            expect(custom.kinds).toContain('preference');
            expect(custom.kinds).toContain('note');
            expect(custom.kinds).not.toContain('task');
        } finally {
            store.release();
            rmSync(own, { recursive: true, force: true });
        }
    });
});

/**
 * The instructions describe a layout that lives in another file. Nothing but a
 * test stops the renderer moving and the prose staying behind, still confidently
 * telling the model to look for something that is no longer there.
 */
describe('the instructions match what the renderer emits', () => {
    const node = (id: string, kind: string, extra: Partial<MemoryNode> = {}): MemoryNode => ({
        id,
        kind,
        text: 'risk report generator',
        audience: ['*'],
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: T0,
        useCount: 0,
        revision: 1,
        ...extra,
    });

    const rec: Recollection = {
        nodes: [
            { node: node('T1', 'task'), score: 0.9, seed: true },
            {
                node: node('F1', 'file', {
                    file: {
                        path: '/memory/F1.py',
                        bytes: 4312,
                        sha256: 'a'.repeat(64),
                        format: 'py',
                    },
                }),
                score: 0,
                seed: false,
            },
        ],
        edges: [{ source: 'T1', target: 'F1', relation: 'PRODUCED' }],
        seeds: ['T1'],
        truncated: false,
    };

    const prose = memoryInstructions(binding('read'));
    const out = renderRecollection(rec, { now: Date.parse(T0) });

    it('claims a mermaid graph, and gets one', () => {
        expect(prose).toContain('graph LR');
        expect(out).toContain('graph LR');
    });

    it('claims a file is drawn differently, and it is', () => {
        expect(prose).toContain('[/file/]');
        expect(out).toContain('[/file/]');
    });

    it('claims a non-match scores `--`, and it does', () => {
        expect(prose).toContain('`--`');
        expect(out).toMatch(/F1\s+--\s+file/);
    });

    it('claims two halves split by a blank line, and there are', () => {
        const [diagram, legend] = out.split('\n\n');
        expect(diagram).toContain('graph LR');
        expect(legend).toContain('/memory/F1.py');
        expect(diagram).not.toContain('/memory/F1.py');
    });
});
