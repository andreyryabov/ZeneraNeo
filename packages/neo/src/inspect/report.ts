import type { Architecture } from '../architecture.ts';
import { buildMemorySlice, type ReportNode } from '../memory/report.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { MemoryEdge } from '../memory/types.ts';
import { collectPayloads, type Payload, type PayloadResolver } from '../payload.ts';
import type { AgentState } from '../state.ts';
import type { TrajectoryNode } from '../trajectory.ts';

// ---------------------------------------------------------------------------
// Run inspector — a single HTML file that explains a run
//
// A state is a graph of references, which makes it cheap to store and useless
// to read. This module does the inverse of the storage design: it resolves
// every payload a run points at and inlines the whole thing into one page, so
// debugging needs no server, no store credentials and no live process — just a
// file you can open, attach to a bug report or diff against yesterday's run.
// ---------------------------------------------------------------------------

/** Default per-payload inline cap. Keeps one runaway tool result from turning
 *  a report into a file no editor will open. */
export const MAX_BLOB_BYTES = 512 * 1024;

export const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

/** Deliberately meaner than the memory page's own cap: this file already holds
 *  a whole run, and one remembered artifact should not decide whether it opens. */
export const MAX_MEMORY_FILE_BYTES = 64 * 1024;

export interface ReportOptions {
    title?: string;
    /** per-payload inline cap; larger values are cut, with a visible marker */
    maxBlobBytes?: number;
    /**
     * Where the page loads Mermaid from. The diagram is the one thing the page
     * cannot carry itself without bloating past a megabyte; everything else is
     * inlined, and the timeline works with no network at all.
     */
    mermaidUrl?: string;
    /**
     * The declared wiring, from `AgentRunner.describe()`. Optional because a
     * report is often rendered from a stored state with no live runner around;
     * the page then reconstructs what the run itself touched, which is a
     * strictly smaller picture but never a wrong one.
     */
    architecture?: Architecture;
    /**
     * The memory to resolve recalled and committed nodes against. A trajectory
     * records ids, kinds and edges but no bodies, so without this the memory
     * view can draw the shape of what was read and not a word of it.
     */
    memory?: MemoryStore;
    /** ceiling on an inlined remembered file; 0 to inline none */
    maxMemoryFileBytes?: number;
}

/** Everything the page needs, and nothing that needs a store to interpret. */
export interface RunReport {
    title: string;
    generatedAt: string;
    state: AgentState;
    /** sha256 → content, deduped by address exactly as in a `RunBundle` */
    blobs: Record<string, string>;
    /** addresses whose content was cut to `maxBlobBytes` */
    truncated: string[];
    /**
     * Base64 `data:` uris lifted out of the state and the payloads above,
     * both of which now refer to them as `media:<index>`. A conversation
     * re-sends its images with every turn, so a run with five model calls
     * would otherwise inline the same megabyte six times — and each recorded
     * request would blow past `maxBlobBytes`, arriving cut mid-string and
     * unparseable. Blob content therefore no longer hashes to the address it
     * is filed under: a report is a thing to read, not a bundle to restore.
     */
    media: string[];
    /** the declared wiring, when the caller had a runner to ask */
    architecture?: Architecture;
    /**
     * The memory nodes this run read or wrote, as the graph holds them *now* —
     * which is later than the run. The page says so where it matters: a node
     * can have moved on a revision since, or be gone from the graph entirely.
     */
    memory?: RunMemory;
}

export interface RunMemory {
    dir: string;
    nodes: ReportNode[];
    edges: MemoryEdge[];
}

/** Base64 data uris only: the charset ends at the closing JSON quote. */
const DATA_URL = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** Below this a uri is cheaper to leave in place than to indirect through. */
const MIN_HOIST = 2048;

function hoistMedia(text: string, media: string[]): string {
    return text.replace(DATA_URL, (url) => {
        if (url.length < MIN_HOIST) return url;
        const at = media.indexOf(url);
        return `media:${at < 0 ? media.push(url) - 1 : at}`;
    });
}

/**
 * Resolves a state into a self-describing report. Separate from rendering so a
 * caller can ship the JSON somewhere else (a service, a test fixture) instead
 * of the page.
 */
export async function buildRunReport(
    state: AgentState,
    payloads: PayloadResolver,
    opts: ReportOptions = {},
): Promise<RunReport> {
    const limit = opts.maxBlobBytes ?? MAX_BLOB_BYTES;
    const refs: Payload[] = collectPayloads(state);
    const values = await payloads.getMany(refs);
    const blobs: Record<string, string> = {};
    const truncated: string[] = [];
    const media: string[] = [];
    for (const ref of refs) {
        const value = hoistMedia(values.get(ref.sha256) ?? '', media);
        if (value.length > limit) {
            blobs[ref.sha256] = value.slice(0, limit);
            truncated.push(ref.sha256);
        } else {
            blobs[ref.sha256] = value;
        }
    }
    return {
        title: opts.title ?? `Run ${state.runId}`,
        generatedAt: new Date().toISOString(),
        // The user input carries the same image the requests do. Putting the
        // whole state through the same table is the difference between one
        // copy of a photo in the file and one copy per turn.
        state: JSON.parse(hoistMedia(JSON.stringify(state), media)) as AgentState,
        blobs,
        truncated,
        media,
        architecture: opts.architecture,
        memory: opts.memory ? await remembered(opts.memory, state, media, opts) : undefined,
    };
}

/** Every memory node the run touched, branches included. */
function memoryIds(nodes: readonly TrajectoryNode[], into: Set<string>): Set<string> {
    for (const node of nodes) {
        if (node.type === 'memory_recall' || node.type === 'memory_op') {
            for (const n of node.nodes) {
                into.add(n.id);
            }
        } else if (node.type === 'join') {
            for (const branch of node.branches) {
                memoryIds(branch.nodes, into);
            }
        }
    }
    return into;
}

async function remembered(
    store: MemoryStore,
    state: AgentState,
    media: string[],
    opts: ReportOptions,
): Promise<RunMemory | undefined> {
    const ids = memoryIds(state.trajectory, new Set());
    if (!ids.size) {
        return undefined;
    }
    let slice;
    try {
        slice = await buildMemorySlice(store, [...ids], {
            maxContentBytes: opts.maxMemoryFileBytes ?? MAX_MEMORY_FILE_BYTES,
        });
    } catch {
        // A memory that cannot be read is a view the page does without; it is
        // not a reason to lose the record of the run.
        return undefined;
    }
    return {
        dir: store.dir,
        // Remembered images go through the same table as the run's own, so a
        // picture the agent both saw and filed is carried once.
        nodes: slice.nodes.map((n) => (n.image ? { ...n, image: hoistMedia(n.image, media) } : n)),
        edges: slice.edges,
    };
}
