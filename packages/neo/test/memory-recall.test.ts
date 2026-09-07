import { describe, expect, it } from 'vitest';
import { MemoryGraph } from '../src/memory/graph.ts';
import { rank, recall, stitch } from '../src/memory/recall.ts';
import { RECOLLECTION_TAG, renderRecollection } from '../src/memory/render.ts';
import type { MemoryQuery } from '../src/memory/types.ts';
import { VectorBlock } from '../src/memory/vectors.ts';

const T0 = '2026-01-01T00:00:00.000Z';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

// Small, but wide enough that unrelated text does not collide into a false hit.
const DIMS = 64;

/**
 * One dimension per distinct term, L2-normalized — the shape a real embedder
 * returns, minus the semantics. Deliberately NOT a hashed bag of words: at this
 * width a hash collision between two unrelated terms invents similarity out of
 * nothing, and the test would be measuring the stub instead of the ranker.
 */
const VOCAB = new Map<string, number>();
const STOP = new Set(['the', 'and', 'for', 'until', 'was', 'are', 'its', 'it', 'is', 'to', 'a']);

function embed(text: string): Float32Array {
    const v = new Float32Array(DIMS);
    const terms = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t && !STOP.has(t));
    for (const term of terms) {
        let dim = VOCAB.get(term);
        if (dim === undefined) {
            dim = VOCAB.size;
            if (dim >= DIMS) {
                throw new Error(`stub embedder vocabulary exceeded ${DIMS} terms`);
            }
            VOCAB.set(term, dim);
        }
        v[dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < DIMS; i++) {
        v[i] /= norm;
    }
    return v;
}

interface World {
    graph: MemoryGraph;
    vectors: VectorBlock;
}

function world(): World {
    const graph = new MemoryGraph();
    const vectors = new VectorBlock(DIMS);
    const add = (id: string, kind: string, text: string, audience = ['*']) => {
        graph.add({ id, kind, text, audience }, T0);
        vectors.set(id, embed(text));
    };

    add('ask', 'task', 'audit the firewall rules and report risky ports');
    add('plan', 'plan', 'list domains, pull policies, filter, join to hosts');
    add('note', 'fact', 'paging follows a cursor until it is null');
    add('script', 'file', 'risk report generator');
    add('call', 'operation', 'GET /api/v1/domains/{d}/policies');
    add('other', 'task', 'summarize the quarterly travel expenses');

    graph.update(
        'script',
        { file: { path: '/memory/script.py', bytes: 4312, sha256: 'a'.repeat(64), format: 'py' } },
        T0,
    );
    graph.link('ask', 'script', 'PRODUCED', T0);
    graph.link('plan', 'script', 'INFORMED', T0);
    graph.link('note', 'script', 'INFORMED', T0);
    graph.link('script', 'call', 'CALLS', T0);
    return { graph, vectors };
}

function query(text: string, extra: Partial<MemoryQuery> = {}): MemoryQuery {
    return { text, ...extra };
}

describe('memory recall', () => {
    it('returns the subgraph that ends at the remembered file', () => {
        const { graph, vectors } = world();
        const q = query('audit the firewall rules for risky ports');
        const rec = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: NOW,
        });

        expect(rec.seeds).toContain('ask');
        const ids = rec.nodes.map((n) => n.node.id);
        expect(ids).toContain('script');
        expect(ids).toContain('call');
        expect(rec.edges).toContainEqual({ source: 'ask', target: 'script', relation: 'PRODUCED' });
        expect(rec.edges).toContainEqual({ source: 'script', target: 'call', relation: 'CALLS' });
    });

    it('leaves an unrelated memory out', () => {
        const { graph, vectors } = world();
        const q = query('audit the firewall rules for risky ports');
        const rec = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: NOW,
        });
        expect(rec.nodes.map((n) => n.node.id)).not.toContain('other');
    });

    it('ranks lexically when no vector is supplied', () => {
        const { graph } = world();
        const rec = recall({
            graph,
            query: query('quarterly travel expenses'),
            sees: ['*'],
            now: NOW,
        });
        expect(rec.seeds).toEqual(['other']);
    });

    it('drops what has been superseded, and keeps it for an audit', () => {
        const { graph, vectors } = world();
        graph.add(
            { id: 'fixed', kind: 'file', text: 'risk report generator', audience: ['*'] },
            T0,
        );
        vectors.set('fixed', embed('risk report generator'));
        graph.link('fixed', 'script', 'SUPERSEDES', T0);

        const q = query('risk report generator');
        const live = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: NOW,
        });
        expect(live.nodes.map((n) => n.node.id)).toContain('fixed');
        expect(live.nodes.map((n) => n.node.id)).not.toContain('script');

        const audit = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: NOW,
            stale: true,
        });
        expect(audit.nodes.map((n) => n.node.id)).toContain('script');
    });

    it('respects the audience mask end to end', () => {
        const { graph, vectors } = world();
        graph.update('note', { audience: ['triage'] }, T0);
        const q = query('paging follows a cursor');

        const open = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: NOW,
        });
        expect(open.nodes.map((n) => n.node.id)).not.toContain('note');

        const cleared = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['triage'],
            now: NOW,
        });
        expect(cleared.seeds).toContain('note');
    });

    it('filters by kind and by age', () => {
        const { graph } = world();
        const byKind = rank({
            graph,
            query: query('audit the firewall rules', { kinds: ['plan'] }),
            sees: ['*'],
            now: NOW,
        });
        expect(byKind.every((s) => s.node.kind === 'plan')).toBe(true);

        const byAge = rank({
            graph,
            query: query('audit the firewall rules', { newerThan: '2026-06-01T00:00:00.000Z' }),
            sees: ['*'],
            now: NOW,
        });
        expect(byAge).toEqual([]);
    });

    it('spends a tight budget on the spine before the context', () => {
        const { graph } = world();
        const seeds = [{ node: graph.get('ask')!, score: 1, seed: true }];
        const rec = stitch(graph, seeds, { maxNodes: 2, maxHops: 2 }, ['*']);
        expect(rec.nodes.map((n) => n.node.id)).toEqual(['ask', 'script']);
        expect(rec.truncated).toBe(true);
    });

    /** Decay must order, never admit — memory is supposed to outlive a run. */
    it('still finds an exact match that is a year old', () => {
        const { graph, vectors } = world();
        const q = query('audit the firewall rules for risky ports');
        const later = Date.parse('2027-01-01T00:00:00.000Z');
        const rec = recall({
            graph,
            vectors,
            vector: embed(q.text!),
            query: q,
            sees: ['*'],
            now: later,
        });
        expect(rec.seeds).toContain('ask');
        expect(rec.nodes.find((n) => n.node.id === 'ask')?.score).toBeGreaterThan(0.9);
    });

    it('prefers the fresher of two equally good matches', () => {
        const graph = new MemoryGraph();
        graph.add(
            { id: 'old', kind: 'fact', text: 'the cursor is null at the end', audience: ['*'] },
            T0,
        );
        graph.add(
            { id: 'new', kind: 'fact', text: 'the cursor is null at the end', audience: ['*'] },
            T0,
        );
        graph.touch('new', '2026-06-01T00:00:00.000Z');
        const rec = recall({
            graph,
            query: query('the cursor is null at the end'),
            sees: ['*'],
            now: Date.parse('2026-06-02T00:00:00.000Z'),
        });
        expect(rec.seeds[0]).toBe('new');
    });
});

describe('rendering a recollection', () => {
    function render(sees = ['*']) {
        const { graph, vectors } = world();
        const q = query('audit the firewall rules for risky ports');
        const rec = recall({ graph, vectors, vector: embed(q.text!), query: q, sees, now: NOW });
        return renderRecollection(rec, { now: NOW });
    }

    it('emits a mermaid graph and a legend inside the tag', () => {
        const out = render();
        expect(out.startsWith(`<${RECOLLECTION_TAG}>`)).toBe(true);
        expect(out).toContain('graph LR');
        expect(out).toContain('-->|PRODUCED|');
        expect(out).toContain('ask(task)');
        expect(out).toContain('script[/file/]');
    });

    it('puts a file path and its size in the legend, not the diagram', () => {
        const out = render();
        const [dia, leg] = out.split('\n\n');
        expect(leg).toContain('/memory/script.py');
        expect(leg).toContain('4.2 KB');
        expect(dia).not.toContain('/memory/script.py');
    });

    it('keeps mermaid-hostile text out of the diagram entirely', () => {
        const graph = new MemoryGraph();
        const nasty = 'fn(a["b"], c|d) # {e}\nsecond line';
        graph.add({ id: 'N1', kind: 'snippet', text: nasty, audience: ['*'] }, T0);
        const rec = recall({ graph, query: query('fn'), sees: ['*'], now: NOW });
        const out = renderRecollection(rec, { now: NOW });

        const diagram = out.split('\n\n')[0];
        for (const ch of ['"', '(a[', '|d', '#', '{e}']) {
            expect(diagram).not.toContain(ch);
        }
        expect(diagram).toContain('N1(snippet)');
        // Collapsed onto one line so a node is always exactly one legend row.
        expect(out).toContain('fn(a["b"], c|d) # {e} second line');
    });

    it('renders an isolated hit rather than dropping it', () => {
        const graph = new MemoryGraph();
        graph.add(
            { id: 'LONE', kind: 'fact', text: 'the api rejects empty filters', audience: ['*'] },
            T0,
        );
        const rec = recall({
            graph,
            query: query('api rejects empty filters'),
            sees: ['*'],
            now: NOW,
        });
        expect(renderRecollection(rec, { now: NOW })).toContain('LONE(fact)');
    });

    it('is empty when nothing matched', () => {
        const graph = new MemoryGraph();
        const rec = recall({ graph, query: query('anything'), sees: ['*'], now: NOW });
        expect(renderRecollection(rec)).toBe('');
    });
});
