import type { ModelUsage, TokenUsage } from '@zenera/neo';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { warn } from './term.ts';

// ---------------------------------------------------------------------------
// The usage ledger
//
// One JSON line per thing that spent tokens: a meta agent call, a run, a batch,
// an `inspect ask`. Append-only, so several processes - the meta agent, the
// batch it started, the ask it is grading with - can write to one file at once.
// Reports are folded out of it later; nothing here aggregates.
// ---------------------------------------------------------------------------

/** Set by `zen meta` for everything its agent runs, so all of it lands in one ledger. */
export const LEDGER_ENV = 'ZENERA_USAGE_LEDGER';
/** The meta session whose agent started this process, if one did. */
export const META_SESSION_ENV = 'ZENERA_META_SESSION';
/** The stored prompt that meta session was started with, if any. */
export const META_PROMPT_ENV = 'ZENERA_META_PROMPT';

/**
 * Where this project's usage goes: the variable when set, else the fine-tuning's
 * own ledger when the project is being tuned. Elsewhere nothing is recorded.
 */
export function ledgerPath(projectDir: string): string | undefined {
    const set = process.env[LEDGER_ENV]?.trim();
    if (set) {
        return set;
    }
    return existsSync(join(projectDir, 'finetune'))
        ? join(projectDir, 'finetune', 'usage', 'ledger.jsonl')
        : undefined;
}

interface RowBase {
    /** when the thing ended */
    ts: string;
}

export interface MetaCallRow extends RowBase {
    kind: 'meta.call';
    session?: string;
    model: string;
    usage: TokenUsage;
    cacheWriteTokens?: number;
    startedAt: string;
    durationMs: number;
    traceId?: string;
    spanId?: string;
}

export interface MetaSessionRow extends RowBase {
    kind: 'meta.session';
    session: string;
    /** copilot's own totals for the whole session so far - cumulative across resumes */
    models: ModelUsage[];
    exitCode: number;
    resumes: number;
    startedAt: string;
    durationMs: number;
}

export interface RunRow extends RowBase {
    kind: 'run';
    runDir?: string;
    session?: string;
    batchDir?: string;
    item?: string;
    ok: boolean;
    error?: string;
    stopReason?: string;
    durationMs?: number;
    models: ModelUsage[];
}

export interface BatchRow extends RowBase {
    kind: 'batch';
    batchDir: string;
    input: string;
    items: number;
    ok: number;
    failed: number;
    concurrency: number;
    memory: string;
    startedAt: string;
    durationMs: number;
    models: ModelUsage[];
}

export interface AskRow extends RowBase {
    kind: 'ask';
    runDir: string;
    node: string;
    nodeAgent: string;
    nodeModel: string;
    model: string;
    usage?: TokenUsage;
    startedAt: string;
    durationMs: number;
}

export type UsageRow = MetaCallRow | MetaSessionRow | RunRow | BatchRow | AskRow;

let warned = false;

/** Appends one row. Never throws: losing a line of accounting must not fail a run. */
export function appendUsage(projectDir: string, row: UsageRow): void {
    const path = ledgerPath(projectDir);
    if (!path) {
        return;
    }
    const meta = process.env[META_SESSION_ENV]?.trim();
    const line = { v: 1, ...row, project: projectDir, pid: process.pid, ...(meta ? { meta } : {}) };
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(line)}\n`);
    } catch (err) {
        if (!warned) {
            warned = true;
            warn(`could not record usage in ${path} - ${(err as Error).message}`);
        }
    }
}
