import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Case } from './dataset/types.ts';
import type { Phase } from './feedback.ts';
import { Improvements } from './improvements.ts';
import { Memories } from './memories.ts';
import { writeStatus } from './report.ts';
import { SystemVersions } from './system.ts';

// ---------------------------------------------------------------------------
// One tuning, in progress
//
// Everything the workers and the applier share: where things go, the settings,
// how `zen` is run, and what each worker is doing right now. Each case's own
// progress is not held here - it is on disk, one folder per attempt.
// ---------------------------------------------------------------------------

export const FINETUNE_DIR = 'finetune';

/** Where a tuning was kept before it moved to {@link FINETUNE_DIR}. */
export const LEGACY_FINETUNE_DIR = '.finetune';

export interface Config {
    workers: number;
    /** apply once this many requests are waiting */
    applyAt: number;
    tries: number;
    memTries: number;
    /** merge the submitted memories after this many more arrive */
    mergeEvery: number;
    seed: number;
    classes?: string[];
    ids?: string[];
    rubric?: boolean;
    limit?: number;
}

export const DEFAULTS: Config = {
    workers: 4,
    applyAt: 4,
    tries: 4,
    memTries: 3,
    mergeEvery: 3,
    seed: 1,
};

export type Step = 'idle' | 'run' | 'analyze' | 'parked';

export interface Worker {
    slot: number;
    case?: Case;
    phase?: Phase;
    attempt?: number;
    step: Step;
    since: number;
}

/** A case in flight. It holds a worker only while it runs or is analyzed; parked, it holds none. */
export interface Seat {
    case: Case;
    worker?: Worker;
    phase?: Phase;
}

/** Runs `zen <args>` in the project, stderr into `log`; stdout is returned. */
export type Zen = (args: string[], log: string) => Promise<{ code: number; stdout: string }>;

export class Stopped extends Error {
    constructor() {
        super('stopped');
    }
}

export interface Event {
    at: string;
    what: string;
    worker?: number;
    case?: string;
    rev?: number;
    phase?: Phase;
    attempt?: number;
    detail?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export class Tuning {
    readonly root: string;
    readonly dir: string;
    readonly config: Config;
    readonly zen: Zen;
    readonly tickMs: number;
    readonly workers: Worker[];
    readonly claimed = new Set<string>();
    readonly startedAt = Date.now();
    readonly recent: Event[] = [];
    readonly system: SystemVersions;
    readonly improvements: Improvements;
    readonly memories: Memories;
    stopping = false;
    finished = false;
    fatal: Error | undefined;
    /** woken cases waiting for a worker: they go before any new case */
    resuming = 0;
    /** every case of the selection has been started */
    drained = false;

    constructor(root: string, config: Config, zen: Zen, tickMs = 1000) {
        this.root = root;
        this.dir = join(root, FINETUNE_DIR);
        this.config = config;
        this.zen = zen;
        this.tickMs = tickMs;
        this.workers = Array.from({ length: config.workers }, (_, slot) => ({
            slot: slot + 1,
            step: 'idle' as Step,
            since: Date.now(),
        }));
        this.system = new SystemVersions(root, join(this.dir, 'systems'));
        this.improvements = new Improvements(this);
        this.memories = new Memories(this);
    }

    get stopFile(): string {
        return join(this.dir, 'stop');
    }

    async tick(): Promise<void> {
        await sleep(this.tickMs);
        if (!this.stopping && existsSync(this.stopFile)) {
            this.stop('stop requested');
        }
    }

    stop(why: string): void {
        if (!this.stopping) {
            this.stopping = true;
            this.event({ what: 'stopping', detail: why });
        }
    }

    /** Between steps: a stop takes effect here, never in the middle of one. */
    checkStopping(): void {
        if (this.stopping) {
            throw new Stopped();
        }
    }

    caseDir(c: { id: string; rev: number }): string {
        return join(this.dir, 'cases', c.id, `r${c.rev}`);
    }

    attemptDir(c: { id: string; rev: number }, phase: Phase, attempt: number): string {
        return join(this.caseDir(c), `${pad(attempt)}-${phase}`);
    }

    freeWorker(): Worker | undefined {
        return this.workers.find((w) => !w.case);
    }

    busy(): number {
        return this.workers.filter((w) => w.case).length;
    }

    /** Puts a case on a free worker, waiting for one; a woken case goes before a new one. */
    async seat(s: Seat, woken: boolean): Promise<void> {
        if (woken) {
            this.resuming++;
        }
        try {
            for (;;) {
                const w = this.freeWorker();
                if (w && (woken || this.resuming === 0)) {
                    Object.assign(w, {
                        case: s.case,
                        phase: undefined,
                        attempt: undefined,
                        step: 'idle',
                        since: Date.now(),
                    });
                    s.worker = w;
                    return;
                }
                this.checkStopping();
                await this.tick();
            }
        } finally {
            if (woken) {
                this.resuming--;
            }
        }
    }

    /** Gives the case's worker back, for another case to use. */
    unseat(s: Seat): void {
        if (!s.worker) {
            return;
        }
        Object.assign(s.worker, {
            case: undefined,
            phase: undefined,
            attempt: undefined,
            step: 'idle',
            since: Date.now(),
        });
        s.worker = undefined;
    }

    /** A case moved to another step on its worker. */
    at(s: Seat, phase: Phase, attempt: number, step: Step): void {
        const w = s.worker!;
        s.phase = phase;
        Object.assign(w, { case: s.case, phase, attempt, step, since: Date.now() });
        this.event({
            what: step,
            worker: w.slot,
            case: s.case.id,
            rev: s.case.rev,
            phase,
            attempt,
        });
    }

    event(e: Omit<Event, 'at'>): void {
        const row: Event = { at: new Date().toISOString(), ...e };
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(row)}\n`);
        this.recent.unshift(row);
        this.recent.length = Math.min(this.recent.length, 50);
        this.report();
    }

    report(): void {
        try {
            writeStatus(this);
        } catch {
            // A status page that failed to render must not stop the tuning.
        }
    }
}

/** The real `zen`: this same binary, in its own process group so Ctrl-C reaches only us. */
export function spawnZen(root: string, children: Set<ChildProcess>): Zen {
    return (args, log) =>
        new Promise((resolve) => {
            mkdirSync(dirname(log), { recursive: true });
            const fd = openSync(log, 'a');
            const child = spawn(process.execPath, [process.argv[1], ...args], {
                cwd: root,
                stdio: ['ignore', 'pipe', fd],
                detached: true,
            });
            children.add(child);
            let stdout = '';
            child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            let finished = false;
            const done = (code: number): void => {
                if (finished) {
                    return;
                }
                finished = true;
                children.delete(child);
                closeSync(fd);
                resolve({ code, stdout });
            };
            child.on('error', () => done(1));
            child.on('close', (code) => done(code ?? 1));
        });
}

export function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}
