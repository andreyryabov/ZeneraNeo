import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryIndex } from '../src/memory/index.ts';
import { recall } from '../src/memory/recall.ts';
import { PREFERENCES_TAG, renderPreferences } from '../src/memory/render.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { MemoryNode, Recollection } from '../src/memory/types.ts';

const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-06-01T00:00:00.000Z';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

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
