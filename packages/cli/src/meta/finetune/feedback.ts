import { readFileSync } from 'node:fs';
import { VERDICTS, type Verdict } from './dataset/types.ts';

// ---------------------------------------------------------------------------
// What an analysis hands back to the loop
//
// The report is for a person; this is the part the loop acts on. It is written
// by a model, so it is read defensively: anything the loop already knows - which
// case, which attempt - is taken from the loop, never from the file.
// ---------------------------------------------------------------------------

export type Phase = 'nomem' | 'mem';

export interface Improvement {
    id: string;
    kind?: string;
    file?: string;
    change: string;
    why?: string;
    expect?: string;
}

export interface Feedback {
    /** `<case>@<phase>-<attempt>`, `<case>#<round>@...` after a retry; unique across the tuning */
    id: string;
    case: string;
    caseRev: number;
    /** absent in the first round */
    round?: number;
    phase: Phase;
    attempt: number;
    verdict: Verdict;
    rubric: Record<string, 'pass' | 'fail'>;
    /** right, and nothing left worth changing */
    done: boolean;
    summary: string;
    improvements: Improvement[];
    /** what outside the project made the run void: the sandbox, the network, a provider */
    infra?: string;
}

// Round 1 keeps the bare form, so the ids applies already took still match.
export const feedbackId = (caseId: string, phase: Phase, attempt: number, round = 1): string =>
    `${caseId}${round > 1 ? `#${round}` : ''}@${phase}-${attempt}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The feedback, or what is wrong with the file - said so a model can fix it.
 * `rubric` is the case's rubric ids: given, every one must be graded.
 */
export function readFeedback(
    file: string,
    known: { case: string; caseRev: number; round?: number; phase: Phase; attempt: number },
    rubricIds: readonly string[] = [],
): { feedback: Feedback } | { problem: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        return {
            problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not JSON',
        };
    }
    if (!isObject(raw)) {
        return { problem: 'not a JSON object' };
    }
    if (!VERDICTS.includes(raw.verdict as Verdict)) {
        return { problem: `"verdict" must be one of ${VERDICTS.join(', ')}` };
    }
    if (typeof raw.done !== 'boolean') {
        return { problem: '"done" must be true or false' };
    }
    if (!Array.isArray(raw.improvements)) {
        return { problem: '"improvements" must be a list (empty when there is nothing to change)' };
    }
    const improvements: Improvement[] = [];
    for (const [i, item] of raw.improvements.entries()) {
        if (!isObject(item) || typeof item.change !== 'string' || !item.change.trim()) {
            return { problem: `improvements[${i}] needs a "change"` };
        }
        const text = (key: string) =>
            typeof item[key] === 'string' ? (item[key] as string) : undefined;
        improvements.push({
            id: text('id') ?? `i${i + 1}`,
            change: item.change,
            ...(text('kind') ? { kind: text('kind') } : {}),
            ...(text('file') ? { file: text('file') } : {}),
            ...(text('why') ? { why: text('why') } : {}),
            ...(text('expect') ? { expect: text('expect') } : {}),
        });
    }
    const rubric: Record<string, 'pass' | 'fail'> = {};
    if (isObject(raw.rubric)) {
        for (const [id, result] of Object.entries(raw.rubric)) {
            if (result === 'pass' || result === 'fail') {
                rubric[id] = result;
            }
        }
    }
    const verdict = raw.verdict as Verdict;
    const infra = typeof raw.infra === 'string' ? raw.infra.trim() : '';
    if (verdict === 'void' && !infra) {
        return {
            problem:
                'void without "infra" - say what outside the project failed (the sandbox, the ' +
                'network, a provider, a service the case needs), with node ids',
        };
    }
    const ungraded = rubricIds.filter((id) => !(id in rubric));
    if (verdict !== 'void' && ungraded.length > 0) {
        return {
            problem:
                `missing grades for rubric lines ${ungraded.join(', ')} - grade every line of ` +
                `\`zen meta dataset show ${known.case}@${known.caseRev}\` "pass" or "fail" under "rubric"`,
        };
    }
    const failed = Object.values(rubric).includes('fail');
    return {
        feedback: {
            id: feedbackId(known.case, known.phase, known.attempt, known.round),
            ...known,
            verdict,
            rubric,
            // `done` on a wrong answer or a failed rubric line is a contradiction; those win.
            done: raw.done && verdict === 'right' && !failed,
            summary: typeof raw.summary === 'string' ? raw.summary : '',
            improvements,
            ...(verdict === 'void' ? { infra } : {}),
        },
    };
}
