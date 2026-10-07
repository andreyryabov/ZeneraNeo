import { claimLock, ownLock } from '@zenera/neo';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../host.ts';
import { recover } from './journal.ts';
import { nextCase } from './sampler.ts';
import { markDifficult, train, VoidRun } from './train.ts';
import { Stopped, type Seat, type Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The loop: N workers, cases started as they come free, one applier
//
// Whenever a worker is free - and no woken case is waiting for one - the next
// case starts on it and is trained to the end. A parked case gives its worker
// back, so a lane never sits idle waiting for an apply. A stop never interrupts
// a step: it is noticed between steps, and the case resumes next time.
// ---------------------------------------------------------------------------

const REPORT_EVERY_MS = 15_000;

export async function runLoop(t: Tuning): Promise<void> {
    mkdirSync(t.dir, { recursive: true });
    const lock = join(t.dir, 'loop.lock');
    claimLock(
        lock,
        ownLock(),
        (held) =>
            new CliError(
                `a tuning is already running here (pid ${held.pid}, since ${held.startedAt})`,
                EXIT.failed,
                `stop it with: zen meta finetune stop - or remove ${lock} if it crashed`,
            ),
    );
    rmSync(t.stopFile, { force: true });
    const timer = setInterval(() => t.report(), REPORT_EVERY_MS);
    try {
        await recover(t);
        const start = t.system.record('start');
        t.event({ what: 'started', detail: `system v${start.v}, ${t.workers.length} workers` });
        const applier = t.improvements.loop();
        await dispatch(t);
        t.finished = true;
        await applier;
        await t.memories.finish();
        t.event({ what: t.stopping ? 'stopped' : 'finished' });
    } finally {
        clearInterval(timer);
        try {
            unlinkSync(lock);
        } catch {
            // Taken over as stale; nothing to give back.
        }
    }
    if (t.fatal) {
        throw t.fatal;
    }
}

async function dispatch(t: Tuning): Promise<void> {
    const running = new Set<Promise<void>>();
    while (!t.stopping) {
        if (t.improvements.applying || t.resuming > 0 || !t.freeWorker()) {
            await t.tick();
            continue;
        }
        const c = nextCase(t);
        if (!c) {
            t.drained = true;
            break;
        }
        const seat: Seat = { case: c };
        t.claimed.add(c.id);
        await t.seat(seat, false);
        const task: Promise<void> = trainCase(t, seat).finally(() => running.delete(task));
        running.add(task);
    }
    await Promise.all(running);
}

async function trainCase(t: Tuning, s: Seat): Promise<void> {
    const c = s.case;
    try {
        await train(t, s, c);
    } catch (err) {
        if (!(err instanceof Stopped)) {
            const why =
                err instanceof VoidRun
                    ? `void: ${err.message}`
                    : `error: ${(err as Error).message}`;
            markDifficult(t, c, s.phase ?? 'nomem', why);
        }
    } finally {
        t.unseat(s);
        t.claimed.delete(c.id);
        t.report();
    }
}
