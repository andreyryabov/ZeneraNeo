import { collectPayloads, type Payload, type PayloadResolver } from '../payload.ts';
import type { AgentState } from '../state.ts';

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
    for (const ref of refs) {
        const value = values.get(ref.sha256) ?? '';
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
        state,
        blobs,
        truncated,
    };
}
