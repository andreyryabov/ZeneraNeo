import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Case } from './dataset/types.ts';
import { readFeedback } from './feedback.ts';
import { resultOf, selection } from './sampler.ts';
import { keepAnalysis, type Run, runOnce } from './train.ts';
import { readJson, type Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The guard: cases that passed, run again on an apply's edit
//
// The cases an apply was written for run again anyway; what it may have broken
// is everything else. A few completed cases are drawn per apply - seeded, so a
// restart draws the same, and keyed on the apply, so each apply draws others -
// and run once more without memory. A case is broken only if it fails twice: a
// single failure may be the model's noise, not the edit.
// ---------------------------------------------------------------------------

export interface GuardTry {
    dir: string;
    verdict: string;
    passed: boolean;
    summary?: string;
}

export interface GuardResult {
    case: string;
    tries: GuardTry[];
    broken: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Completed cases outside `exclude`, in an order fixed by the seed and the apply. */
export function guardCases(t: Tuning, apply: string, exclude: Set<string>): Case[] {
    const key = (id: string): string =>
        createHash('sha256').update(`${t.config.seed}:${apply}:${id}`).digest('hex');
    return selection(t)
        .filter((c) => !exclude.has(c.id) && resultOf(t, c)?.state === 'completed')
        .sort((a, b) => key(a.id).localeCompare(key(b.id)))
        .slice(0, t.config.guard);
}

/** Runs the guard for one attempt of an apply; `patch` is that attempt's diff. */
export async function guard(
    t: Tuning,
    dir: string,
    attempt: number,
    exclude: Set<string>,
    patch: string,
): Promise<GuardResult[]> {
    const cases = guardCases(t, basename(dir), exclude);
    if (cases.length === 0) {
        return [];
    }
    t.event({
        what: 'guard',
        detail: `${basename(dir)}: ${cases.map((c) => c.id).join(', ')} run again on the edit`,
    });
    const results = await Promise.all(
        cases.map((c) => guardOne(t, join(dir, 'guard', `a${attempt}`, c.id), c, patch)),
    );
    writeFileSync(join(dir, 'guard.json'), `${JSON.stringify(results, null, 2)}\n`);
    return results;
}

async function guardOne(t: Tuning, dir: string, c: Case, patch: string): Promise<GuardResult> {
    const tries: GuardTry[] = [];
    for (let n = 1; n <= 2; n++) {
        const at = join(dir, `${pad(n)}-nomem`);
        const one = await tryOne(t, c, at, n, patch);
        tries.push(one);
        if (one.passed) {
            break;
        }
    }
    const broken = tries.length === 2 && tries.every((x) => !x.passed);
    t.event({
        what: broken ? 'guard broken' : 'guard passed',
        case: c.id,
        rev: c.rev,
        detail: tries.map((x) => x.verdict).join(', '),
    });
    return { case: c.id, tries, broken };
}

/** A run or an analysis that says nothing about the prose counts as a pass: only a graded failure undoes an apply. */
async function tryOne(
    t: Tuning,
    c: Case,
    dir: string,
    n: number,
    patch: string,
): Promise<GuardTry> {
    mkdirSync(dir, { recursive: true });
    const why = await runOnce(t, c, dir);
    if (why) {
        return { dir, verdict: 'void', passed: true, summary: why };
    }
    const run = readJson<Run>(join(dir, 'run.json'))!;
    const file = join(dir, 'feedback.json');
    const res = await t.zen(
        [
            'meta',
            'run',
            '--no-refresh',
            '--json',
            '--events',
            join(dir, 'analyze.events.jsonl'),
            '--session-id',
            randomUUID(),
            '/analyze',
            run.dir,
            `case=${c.id}`,
            `rev=${c.rev}`,
            'phase=nomem',
            `attempt=${n}`,
            `feedback=${file}`,
            `guard=${patch}`,
        ],
        join(dir, 'analyze.log'),
    );
    keepAnalysis(dir, res.stdout);
    const read = readFeedback(
        file,
        { case: c.id, caseRev: c.rev, phase: 'nomem', attempt: n },
        c.rubric.map((r) => r.id),
    );
    if (!('feedback' in read)) {
        return { dir, verdict: 'unread', passed: true, summary: read.problem };
    }
    const f = read.feedback;
    if (f.verdict === 'void') {
        return { dir, verdict: 'void', passed: true, summary: f.infra };
    }
    const passed = f.verdict === 'right' && !Object.values(f.rubric).includes('fail');
    return { dir, verdict: f.verdict, passed, summary: f.summary };
}
