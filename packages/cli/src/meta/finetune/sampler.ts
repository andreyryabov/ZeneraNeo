import { anyOf, wildcard } from '@zenera/neo';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sample } from './dataset/sample.ts';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { readJson, type Tuning } from './tuning.ts';
import type { ByStage } from './usage.ts';

// ---------------------------------------------------------------------------
// Which case next
//
// No judgement here: the dataset's own draw - classes taking turns, cases with
// a rubric first, the rest in seeded random order - cut to the limit. A case
// is taken when it has no result at its current revision and no worker holds
// it, so a case added or changed in the dataset is picked up on the way.
// ---------------------------------------------------------------------------

export interface Result {
    state: 'completed' | 'difficult';
    phase: 'nomem' | 'mem';
    reason?: string;
    caseRev: number;
    at: string;
    /** per stage and model, over every try of the case */
    tokens?: ByStage;
}

/** The cases this tuning covers, in the order they are taken. */
export function selection(t: Tuning): Case[] {
    const store = DatasetStore.open(t.root);
    const cases = store.all();
    const ids = anyOf((t.config.ids ?? []).map((p) => wildcard(p)));
    const drawn = sample(
        cases,
        {
            status: 'active',
            ...(t.config.classes?.length ? { classes: t.config.classes } : {}),
            ...(t.config.rubric !== undefined ? { rubric: t.config.rubric } : {}),
            ...(ids ? { ids } : {}),
        },
        { by: ['class'], weights: new Map(), order: ['rubric'], seed: t.config.seed },
        () => [],
    );
    const byId = new Map(cases.map((c) => [c.id, c]));
    const ordered = drawn.ids.map((id) => byId.get(id)!);
    return t.config.limit ? ordered.slice(0, t.config.limit) : ordered;
}

export function resultOf(t: Tuning, c: Case): Result | undefined {
    const file = join(t.caseDir(c), 'result.json');
    return existsSync(file) ? readJson<Result>(file) : undefined;
}

export function nextCase(t: Tuning): Case | undefined {
    return selection(t).find((c) => !t.claimed.has(c.id) && !resultOf(t, c));
}
