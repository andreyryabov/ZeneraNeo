import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { errorIn, sizeOf } from './failure.ts';
import type { Feedback } from './feedback.ts';
import { writeApply } from './report.ts';
import { readJson, type Seat, Stopped, type Tuning } from './tuning.ts';
import { envelopesIn, spent } from './usage.ts';

// ---------------------------------------------------------------------------
// The improvement queue
//
// A case that has feedback parks here until an apply has taken it, and gives its
// worker back meanwhile, so another case runs in its place. Applies are
// batched: one fires when `applyAt` cases are parked, or once nothing is running
// and no case is left to start - waiting longer would wait for nothing.
//
// An apply edits the prose runs read, so no run starts while one is pending and
// those already going are let finish first. Analyses carry on; what they find
// joins the next batch. A woken case takes a worker before any new case does.
// ---------------------------------------------------------------------------

export interface AppliedFile {
    ids: string[];
    from: number;
    to: number;
    at: string;
    startedAt?: string;
    skipped?: boolean;
}

const pad = (n: number): string => String(n).padStart(3, '0');

export class Improvements {
    readonly #t: Tuning;
    readonly pending: Feedback[] = [];
    /** the batch an apply is working on */
    inApply: Feedback[] = [];
    readonly #applied = new Set<string>();
    /** cases parked right now */
    parked = 0;
    /** `zen run`s in flight */
    runs = 0;
    applying = false;
    /** the apply under way; `name` once it has a folder, before that it waits for runs */
    current: { since: number; name?: string; dir?: string; requests?: number } | undefined;
    /** applies started in this process */
    started = 0;
    /** applies finished in this process - an analysis spanning one may see edits */
    count = 0;

    constructor(t: Tuning) {
        this.#t = t;
        this.reload();
    }

    /** Re-reads which requests the applies took - a recovery may have removed one. */
    reload(): void {
        this.#applied.clear();
        for (const name of this.#names()) {
            for (const id of readJson<AppliedFile>(join(this.dir, name, 'applied.json'))?.ids ??
                []) {
                this.#applied.add(id);
            }
        }
    }

    get dir(): string {
        return join(this.#t.dir, 'applies');
    }

    #names(): string[] {
        try {
            return readdirSync(this.dir)
                .filter((n) => /^\d{3}$/.test(n))
                .sort();
        } catch {
            return [];
        }
    }

    isApplied(id: string): boolean {
        return this.#applied.has(id);
    }

    /** Parks until an apply has taken this feedback, the worker free meanwhile. Taken already - after a restart - returns at once. */
    async apply(feedback: Feedback, s: Seat): Promise<void> {
        if (this.#applied.has(feedback.id)) {
            return;
        }
        if (!this.pending.some((f) => f.id === feedback.id)) {
            this.pending.push(feedback);
        }
        this.parked++;
        this.#t.event({
            what: 'parked',
            worker: s.worker?.slot,
            case: feedback.case,
            phase: feedback.phase,
            attempt: feedback.attempt,
            detail: `${feedback.improvements.length} improvement(s), worker freed`,
        });
        this.#t.unseat(s);
        try {
            while (!this.#applied.has(feedback.id)) {
                if (this.#t.stopping) {
                    throw new Stopped();
                }
                await this.#t.tick();
            }
        } finally {
            this.parked--;
        }
        await this.#t.seat(s, true);
    }

    /** Before a run starts: wait out an apply, or stop. */
    async notApplying(): Promise<void> {
        while (this.applying) {
            this.#t.checkStopping();
            await this.#t.tick();
        }
        this.#t.checkStopping();
    }

    /** The applier: runs until the tuning is finished. */
    async loop(): Promise<void> {
        while (!this.#t.finished) {
            await this.#t.tick();
            if (this.#t.stopping || this.pending.length === 0) {
                continue;
            }
            if (
                this.pending.length < this.#t.config.applyAt &&
                (this.#t.busy() > 0 || !this.#t.drained)
            ) {
                continue;
            }
            try {
                await this.#applyNow();
            } catch (err) {
                this.#t.fatal = err as Error;
                this.#t.stop(`apply failed: ${(err as Error).message}`);
            }
        }
    }

    async #applyNow(): Promise<void> {
        const t = this.#t;
        this.applying = true;
        this.current = { since: Date.now() };
        this.started++;
        t.event({ what: 'apply waiting', detail: `${this.runs} run(s) to finish` });
        try {
            while (this.runs > 0) {
                await t.tick();
            }
            const batch = this.pending.splice(0);
            this.inApply = batch;
            const name = pad(Math.max(0, ...this.#names().map(Number)) + 1);
            const dir = join(this.dir, name);
            const from = t.system.record('external').v;
            await t.journal.step({ kind: 'apply', dir, from }, () =>
                this.#applyBatch(batch, name, dir, from),
            );
        } finally {
            this.applying = false;
            this.current = undefined;
            this.inApply = [];
        }
    }

    async #applyBatch(batch: Feedback[], name: string, dir: string, from: number): Promise<void> {
        const t = this.#t;
        const startedAt = new Date().toISOString();
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'inputs.json'),
            `${JSON.stringify(
                batch.map((f) => ({
                    ...f,
                    file: join(
                        t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt),
                        'feedback.json',
                    ),
                })),
                null,
                2,
            )}\n`,
        );
        const total = batch.reduce((n, f) => n + f.improvements.length, 0);
        this.current = { since: Date.now(), name, dir, requests: batch.length };
        let to = from;
        if (total > 0) {
            t.event({
                what: 'apply',
                detail: `${name}: ${batch.length} request(s), ${total} improvement(s)`,
            });
            writeApply(t, dir);
            try {
                await this.#edit(dir, from);
            } catch (err) {
                writeFileSync(
                    join(dir, 'failed.json'),
                    `${JSON.stringify({ at: new Date().toISOString(), startedAt, error: (err as Error).message }, null, 2)}\n`,
                );
                writeApply(t, dir);
                throw err;
            }
            to = t.system.record('apply', name).v;
            if (to !== from) {
                writeFileSync(join(dir, 'diff.patch'), t.system.diff(from, to));
            }
        }
        const applied: AppliedFile = {
            ids: batch.map((f) => f.id),
            from,
            to,
            at: new Date().toISOString(),
            startedAt,
            ...(total === 0 ? { skipped: true } : {}),
        };
        writeFileSync(join(dir, 'applied.json'), `${JSON.stringify(applied, null, 2)}\n`);
        writeApply(t, dir);
        for (const f of batch) {
            this.#applied.add(f.id);
        }
        this.count++;
        this.current = undefined;
        t.event({
            what: 'applied',
            detail: `${name}: v${from} -> v${to}, see applies/${name}/APPLY.md`,
            result: total === 0 ? 'nothing to change' : `v${from} → v${to}`,
            took: Date.now() - Date.parse(startedAt),
            tokens: spent(envelopesIn(dir, 'apply')),
        });
    }

    /** The meta agent edits; `zen check` must pass, or the edit is undone and tried once more. */
    async #edit(dir: string, from: number): Promise<void> {
        const t = this.#t;
        for (let attempt = 1; ; attempt++) {
            const session = randomUUID();
            writeFileSync(join(dir, 'session'), `${session}\n`);
            const applyLog = join(dir, 'apply.log');
            const checkLog = join(dir, 'check.log');
            const offset = { apply: sizeOf(applyLog), check: sizeOf(checkLog) };
            const res = await t.zen(
                [
                    'meta',
                    'run',
                    '--no-refresh',
                    '--json',
                    '--session-id',
                    session,
                    '--events',
                    join(dir, 'apply.events.jsonl'),
                    '/finetune-apply',
                    dir,
                ],
                applyLog,
            );
            writeFileSync(
                join(dir, attempt === 1 ? 'apply.json' : `apply-${attempt}.json`),
                res.stdout,
            );
            const check = await t.zen(['check', '--no-models', '--no-sandbox'], checkLog);
            if (res.code === 0 && check.code === 0) {
                return;
            }
            const e =
                res.code !== 0 ? errorIn(applyLog, offset.apply) : errorIn(checkLog, offset.check);
            t.error(
                `apply ${basename(dir)}${attempt > 1 ? ` try ${attempt}` : ''}`,
                `${res.code !== 0 ? 'the apply failed' : 'zen check failed after the apply'}${e.message ? `: ${e.message}` : ''}`,
                e.log,
            );
            t.system.restore(from);
            if (attempt === 2) {
                throw new Error(`apply ${dir} left the project broken twice - see check.log`);
            }
            t.event({
                what: 'apply retry',
                detail: res.code !== 0 ? 'the apply failed' : 'zen check failed',
            });
        }
    }

    /** Requests every apply so far took, for the report. */
    applies(): { name: string; dir: string; applied?: AppliedFile; inputs?: Feedback[] }[] {
        return this.#names().map((name) => {
            const dir = join(this.dir, name);
            return {
                name,
                dir,
                applied: readJson<AppliedFile>(join(dir, 'applied.json')),
                inputs: existsSync(join(dir, 'inputs.json'))
                    ? readJson<Feedback[]>(join(dir, 'inputs.json'))
                    : undefined,
            };
        });
    }
}
