import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Identifiers
//
// `YYYYMMDD-HHMMSS-xxxx`, local time, four hex characters of entropy.
//
// Sortable as a plain string, readable without a decoder, and collision-free
// when two runs start inside the same second. An epoch integer gives up the
// first two properties and a uuid gives up all three.
// ---------------------------------------------------------------------------

const STAMP = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function stamp(now = new Date()): string {
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
    const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}

/**
 * Ids arrive from `--session` and `--run` and become path segments, so they are
 * checked rather than trusted. The shape has no `.` and no separator, which
 * makes traversal unrepresentable rather than merely rejected.
 */
export function isStamp(value: string): boolean {
    return STAMP.test(value);
}

/** Human-readable form of a stamp: `2026-08-25 14:30:12`. */
export function stampDate(id: string): string {
    if (!isStamp(id)) {
        return id;
    }
    const [d, t] = id.split('-');
    return (
        `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ` +
        `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
    );
}

/** ISO instant a stamp names, for `ago()`. Local time in, local time out. */
export function stampInstant(id: string): string | undefined {
    if (!isStamp(id)) {
        return undefined;
    }
    const [d, t] = id.split('-');
    const at = new Date(
        Number(d.slice(0, 4)),
        Number(d.slice(4, 6)) - 1,
        Number(d.slice(6, 8)),
        Number(t.slice(0, 2)),
        Number(t.slice(2, 4)),
        Number(t.slice(4, 6)),
    );
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
