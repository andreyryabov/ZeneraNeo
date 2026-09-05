// ---------------------------------------------------------------------------
// Small renderings, shared by every README a build writes
//
// These are markdown that an agent reads as often as a person does, so the
// phrasing is plain and the shapes are stable. Nothing here knows what was
// indexed.
// ---------------------------------------------------------------------------

/** An indented block, which markdown renders verbatim and an agent reads as a table. */
export function fields(rows: readonly string[][]): string[] {
    const width = Math.max(...rows.map((r) => (r[0] ?? '').length));
    return rows.map(([name, value]) => `    ${(name ?? '').padEnd(width)}  ${value ?? ''}`);
}

/** A markdown table, padded so the source is readable unrendered. */
export function grid(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    );
    const line = (cells: readonly string[]): string =>
        `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;

    return [
        line(headers),
        `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
        ...rows.map(line),
    ];
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

export function duration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 1) {
        return 'under a second';
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60
        ? `${minutes}m${seconds % 60}s`
        : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Sub-second, because a phase breakdown is read to compare phases against each other. */
export function span(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Where the time went, which is the only way to know what is worth making faster. */
export const breakdown = (timings: readonly { name: string; ms: number }[]): string =>
    timings.map((t) => `${t.name} ${span(t.ms)}`).join(' · ');

/** The first line only: a stack trace in a README helps nobody. */
export function message(reason: unknown): string {
    const text = reason instanceof Error ? reason.message : String(reason);
    return text.split('\n')[0]?.trim() || 'no reason given';
}

export function searched(indexes: { fts: boolean; vector: boolean }): string {
    if (!indexes.fts && !indexes.vector) {
        return 'scanned flat: neither index was built';
    }
    if (!indexes.vector) {
        // Below a couple of thousand rows an IVF index has nothing to train on.
        return 'searched by full text and by vector, the latter as a flat scan';
    }
    return indexes.fts
        ? 'searched by full text and by vector'
        : 'searched by vector, with no full-text index';
}
