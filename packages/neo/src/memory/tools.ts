/**
 * The four tools an agent gets. Deliberately four and not seven: `search` and
 * `load` are split because finding is not reading — search returns stitched
 * context the model never asked for, and counting that as use would poison
 * recency. `commit` is one transaction because a remembered thing is a
 * subgraph, and building it with three calls leaves the graph half-formed if
 * the model stops early. `forget` is separate because deleting rarely happens
 * in the same breath as creating, and a `forget` buried inside a truncated
 * commit preview would be both irreversible and invisible.
 *
 * `audience` reaches the schema only when the binding grants more than one
 * label, and `sees` never does: an agent that could name its own audience
 * could read another agent's slice just by asking for it.
 */
import { hash } from '../payload.ts';
import {
    type AnyTool,
    MEMORY_COMMIT_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_LOAD_TOOL,
    MEMORY_SEARCH_TOOL,
    tool,
    type ToolContext,
    withEffects,
} from '../types.ts';
import type { CommitEdge, CommitNode, MemoryIndex } from './index.ts';
import { renderRecollection } from './render.ts';
import {
    canForget,
    canWrite,
    KIND_HELP,
    MemoryError,
    type MemoryOpSpec,
    RELATION_HELP,
    type ResolvedMemoryBinding,
} from './types.ts';

/** Deterministic, so a replayed call is the same op and not a second one. */
export function memoryOpId(runId: string, callId: string): string {
    return hash(`${runId}\u0000${callId}`);
}

export interface MemoryToolsOptions {
    index: MemoryIndex;
    binding: ResolvedMemoryBinding;
}

interface SearchArgs {
    query: string;
    kinds?: string[];
    limit?: number;
    max_hops?: number;
    max_nodes?: number;
    newer_than?: string;
}

interface LoadArgs {
    ids: string[];
}

interface CommitArgs {
    nodes: {
        ref?: string;
        id?: string;
        kind?: string;
        text?: string;
        file?: string;
        audience?: string[];
        expected_revision?: number;
    }[];
    edges?: { from: string; to: string; relation: string }[];
}

interface ForgetArgs {
    ids: string[];
    reason?: string;
}

export function memoryTools<TCtx>(opts: MemoryToolsOptions): AnyTool<TCtx>[] {
    const { index, binding } = opts;
    const kinds = [...index.kinds];
    const relations = [...index.relations];
    const kindHelp = kinds
        .map((k) => `${k}: ${KIND_HELP[k as keyof typeof KIND_HELP] ?? ''}`)
        .join('; ');
    const relationHelp = relations
        .map((r) => `${r}: ${RELATION_HELP[r as keyof typeof RELATION_HELP] ?? ''}`)
        .join('; ');

    const tools: AnyTool<TCtx>[] = [
        tool<SearchArgs, TCtx>({
            name: MEMORY_SEARCH_TOOL,
            description:
                'Search memory for what was learned on earlier runs. Returns a diagram of ' +
                'the matching subgraph plus a legend of ids; read a node with ' +
                `${MEMORY_LOAD_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'what you are trying to recall' },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: kinds },
                        description: 'restrict to these kinds',
                    },
                    limit: { type: 'integer', description: 'how many matches to seed from' },
                    max_hops: { type: 'integer', description: 'how far to follow links' },
                    max_nodes: { type: 'integer', description: 'cap on the returned subgraph' },
                    newer_than: {
                        type: 'string',
                        description: 'ISO timestamp; ignore anything older',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const query = {
                    text: args.query,
                    kinds: args.kinds,
                    limit: args.limit,
                    maxHops: args.max_hops,
                    maxNodes: args.max_nodes,
                    newerThan: args.newer_than,
                };
                const rec = await index.search(query, binding.sees);
                const content = renderRecollection(rec);
                if (!content) {
                    return 'no memory of this';
                }
                return withEffects(content, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'recall',
                        query,
                        seeds: [...rec.seeds],
                        nodes: rec.nodes.map((n) => ({
                            id: n.node.id,
                            kind: n.node.kind,
                            score: n.score,
                        })),
                        edges: [...rec.edges],
                        content,
                    },
                });
            },
        }),
        tool<LoadArgs, TCtx>({
            name: MEMORY_LOAD_TOOL,
            description:
                'Read memories in full by id, using the ids from a ' +
                `${MEMORY_SEARCH_TOOL} legend. A remembered file comes back inline when it ` +
                'is small, otherwise as a path under /memory you can open or run.',
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['ids'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                const loaded = await index.load(args.ids, binding.sees, tc.services.clock);
                // Recorded because this is the only path that puts a whole body
                // in the context: a recall block carries a clipped line.
                const spec: MemoryOpSpec = {
                    kind: 'op',
                    op: 'load',
                    opId,
                    nodes: loaded.map((l) => ({
                        id: l.node.id,
                        kind: l.node.kind,
                        revision: l.node.revision,
                    })),
                    edges: [],
                    files: loaded.filter((l) => l.content !== undefined).length,
                };
                return withEffects(
                    loaded.map((l) => ({
                        id: l.node.id,
                        kind: l.node.kind,
                        text: l.node.text,
                        created: l.node.createdAt,
                        revision: l.node.revision,
                        metadata: l.node.metadata,
                        file: l.node.file
                            ? { path: l.node.file.path, bytes: l.node.file.bytes }
                            : undefined,
                        content: l.content,
                    })),
                    { kind: 'memory_op', spec },
                );
            },
        }),
    ];

    if (!canWrite(binding)) {
        return tools;
    }

    const labels = binding.writes;
    const audience =
        labels.length > 1
            ? {
                  audience: {
                      type: 'array',
                      items: { type: 'string', enum: labels },
                      description: 'who may later see this node; defaults to everyone',
                  },
              }
            : {};

    tools.push(
        tool<CommitArgs, TCtx>({
            name: MEMORY_COMMIT_TOOL,
            description:
                'Remember something as a small graph, in one call: the nodes and the links ' +
                'between them. Link a new node to an existing one by using its id. A node ' +
                'that already exists is folded into it, and its id comes back under your ref.',
            parameters: {
                type: 'object',
                properties: {
                    nodes: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            properties: {
                                ref: {
                                    type: 'string',
                                    description:
                                        'a short name for a new node, used by edges in this call',
                                },
                                id: {
                                    type: 'string',
                                    description: 'to change an existing node instead of adding one',
                                },
                                kind: { type: 'string', enum: kinds, description: kindHelp },
                                text: {
                                    type: 'string',
                                    description: 'what to remember, in your own words',
                                },
                                file: {
                                    type: 'string',
                                    description:
                                        'path of a file to keep a copy of, for kind "file"',
                                },
                                ...audience,
                                expected_revision: {
                                    type: 'integer',
                                    description: 'refuse the change if the node moved on',
                                },
                            },
                            additionalProperties: false,
                        },
                    },
                    edges: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                from: {
                                    type: 'string',
                                    description: 'a ref from this call, or an id',
                                },
                                to: {
                                    type: 'string',
                                    description: 'a ref from this call, or an id',
                                },
                                relation: {
                                    type: 'string',
                                    enum: relations,
                                    description: relationHelp,
                                },
                            },
                            required: ['from', 'to', 'relation'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['nodes'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                let nodes: CommitNode[];
                try {
                    nodes = args.nodes.map((n) => ({
                        ref: n.ref,
                        id: n.id,
                        kind: n.kind,
                        text: n.text,
                        audience: n.audience,
                        expectedRevision: n.expected_revision,
                        file: n.file === undefined ? undefined : { source: source(tc, n.file) },
                    }));
                } catch (err) {
                    return refusal(err);
                }
                const edges: CommitEdge[] = (args.edges ?? []).map((e) => ({
                    from: e.from,
                    to: e.to,
                    relation: e.relation,
                }));

                let res;
                try {
                    res = await index.commit(
                        { nodes, edges },
                        { writes: labels, sees: binding.sees, clock: tc.services.clock },
                    );
                } catch (err) {
                    return refusal(err);
                }

                // The TUI shows a truncated preview, so the counts go first.
                const parts = [`${MEMORY_COMMIT_TOOL} ${res.created + res.updated} nodes`];
                if (res.edges) {
                    parts.push(`${res.edges} edges`);
                }
                if (res.files) {
                    parts.push(`${res.files} files`);
                }
                if (res.merged) {
                    parts.push(`${res.merged} already known`);
                }
                const spec: MemoryOpSpec = {
                    kind: 'op',
                    op: 'commit',
                    opId,
                    nodes: changed(index, res.ids),
                    edges: [],
                    files: res.files,
                };
                return withEffects(
                    { summary: parts.join(' '), ids: res.ids },
                    { kind: 'memory_op', spec },
                );
            },
        }),
    );

    if (!canForget(binding)) {
        return tools;
    }

    tools.push(
        tool<ForgetArgs, TCtx>({
            name: MEMORY_FORGET_TOOL,
            description:
                'Delete memories by id, with the files they hold. Use this only for what is ' +
                'wrong or no longer allowed to be kept; to correct something, prefer a new ' +
                `node linked with SUPERSEDES in ${MEMORY_COMMIT_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    reason: { type: 'string', description: 'why this is being removed' },
                },
                required: ['ids'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                const before = args.ids.flatMap((id) => {
                    const node = index.graph.get(id);
                    return node ? [{ id, kind: node.kind, revision: node.revision }] : [];
                });
                // Taken before the delete: afterwards nothing can say what this
                // node hung from, and a report would draw it floating.
                const links = new Map(
                    args.ids
                        .flatMap((id) => index.graph.neighbors(id, binding.sees))
                        .map((e) => [`${e.source}|${e.relation}|${e.target}`, e]),
                );
                try {
                    await index.forget(args.ids, binding.sees);
                } catch (err) {
                    return refusal(err);
                }
                return withEffects(`${MEMORY_FORGET_TOOL} ${before.length} nodes`, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'op',
                        op: 'forget',
                        opId,
                        nodes: before,
                        edges: [...links.values()],
                        files: 0,
                    },
                });
            },
        }),
    );

    return tools;
}

/**
 * A refusal is a result, not a throw: the model can read it and fix the call,
 * whereas an exception ends the turn.
 */
function refusal(err: unknown): { error: string; hint?: string } {
    if (err instanceof MemoryError) {
        return { error: err.message, hint: err.hint };
    }
    throw err;
}

function source<TCtx>(tc: ToolContext<TCtx>, path: string): string {
    if (!tc.services.resolveFile) {
        throw new MemoryError(
            'this agent cannot remember files',
            'commit the node without `file`, or give the agent a workspace',
        );
    }
    return tc.services.resolveFile(path);
}

function changed(
    index: MemoryIndex,
    ids: Record<string, string>,
): { id: string; kind: string; revision: number }[] {
    return Object.values(ids).flatMap((id) => {
        const node = index.graph.get(id);
        return node ? [{ id, kind: node.kind, revision: node.revision }] : [];
    });
}
