import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { type Feedback, type Phase, readFeedback } from './feedback.ts';
import type { AppliedFile } from './improvements.ts';
import { resultOf, selection } from './sampler.ts';
import type { Run } from './train.ts';
import { readJson, type Tuning, type Worker } from './tuning.ts';
import {
    type ByModel,
    type ByStage,
    envelopesIn,
    mergeModels,
    mergeStages,
    runTokens,
    short,
    STAGES,
    total,
} from './usage.ts';

// ---------------------------------------------------------------------------
// What a person reads
//
// Two pages, both written by code from what is on disk and in hand, never by
// an agent: STATUS.md for the whole tuning, FEEDBACK.md for one case. Diagrams
// carry only ids, numbers and fixed words - free text goes in tables, escaped -
// so nothing a model wrote can break a render.
// ---------------------------------------------------------------------------

export interface Attempt {
    phase: Phase;
    attempt: number;
    dir: string;
    run?: Run;
    feedback?: Feedback;
}

type Decisions = Record<string, Record<string, { decision?: string; note?: string }>>;

const PHASE_WORD: Record<Phase, string> = { nomem: 'no memory', mem: 'with memory' };

function atomic(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
}

/** A table cell: one line, no column breaks. */
export const cell = (text: string | number | undefined): string =>
    String(text ?? '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim() || '-';

/** A link from `from` (a directory) to `to`, safe for spaces. */
const link = (label: string, from: string, to: string): string =>
    `[${label}](<${relative(from, to).split(sep).join('/')}>)`;

export function since(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    }
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function attemptsOf(t: Tuning, c: Case): Attempt[] {
    const dir = t.caseDir(c);
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => /^\d{2}-(nomem|mem)$/.test(n));
    } catch {
        return [];
    }
    return names
        .map((name) => {
            const [n, phase] = name.split('-') as [string, Phase];
            const at = join(dir, name);
            const read = readFeedback(join(at, 'feedback.json'), {
                case: c.id,
                caseRev: c.rev,
                phase,
                attempt: Number(n),
            });
            return {
                phase,
                attempt: Number(n),
                dir: at,
                run: readJson<Run>(join(at, 'run.json')),
                ...('feedback' in read ? { feedback: read.feedback } : {}),
            };
        })
        .sort(
            (a, b) =>
                Number(a.phase === 'mem') - Number(b.phase === 'mem') || a.attempt - b.attempt,
        );
}

function decisions(t: Tuning): Decisions {
    const all: Decisions = {};
    for (const a of t.improvements.applies()) {
        Object.assign(all, readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {});
    }
    return all;
}

/** A run's tokens per model: recorded at the run, or read from its trajectory. */
function runByModel(run: Run | undefined): ByModel | undefined {
    if (!run) {
        return undefined;
    }
    const by = run.tokens ?? runTokens(run.dir);
    if (by && Object.keys(by).length > 0) {
        return by;
    }
    return run.usage
        ? {
              '?': {
                  calls: run.turns ?? 0,
                  input: run.usage.inputTokens,
                  cached: run.usage.cachedInputTokens ?? 0,
                  output: run.usage.outputTokens,
                  reasoning: run.usage.reasoningTokens ?? 0,
              },
          }
        : undefined;
}

/** Every try of a case, per stage and model. Applies serve many cases at once, so they are not split. */
export function caseTokens(t: Tuning, c: Case): ByStage {
    const attempts = attemptsOf(t, c);
    return mergeStages(
        ...attempts.map((a) => ({
            run: runByModel(a.run),
            analyze: envelopesIn(a.dir, 'analyze'),
        })),
    );
}

/** `in / out`, the input counting cached tokens. */
const inOut = (by: ByModel | undefined): string => {
    const s = total(by);
    return s.input + s.output > 0 ? `${short(s.input)} / ${short(s.output)}` : '-';
};

function tokenTable(by: ByStage): string[] {
    const rows: string[] = [];
    for (const stage of STAGES) {
        const models = Object.entries(by[stage] ?? {}).sort(([a], [b]) => a.localeCompare(b));
        for (const [model, s] of models) {
            rows.push(
                `| ${stage} | ${cell(model)} | ${s.calls} | ${short(s.input)} | ${short(s.cached)} | ${short(s.output)} | ${short(s.reasoning)} |`,
            );
        }
    }
    if (rows.length === 0) {
        return [];
    }
    return [
        '| Stage | Model | Calls | Input | Cached | Output | Reasoning |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ];
}

const rubricScore = (f: Attempt['feedback']): string => {
    const r = Object.values(f?.rubric ?? {});
    return r.length ? `${r.filter((x) => x === 'pass').length}/${r.length}` : '-';
};

function stateOf(t: Tuning, c: Case): string {
    const r = resultOf(t, c);
    if (r) {
        return r.state === 'completed' ? 'completed' : `difficult (${r.reason ?? r.phase})`;
    }
    const w = t.workers.find((x) => x.case?.id === c.id);
    if (w) {
        return `${PHASE_WORD[w.phase ?? 'nomem']} · try ${w.attempt} · ${w.step}`;
    }
    const parked = t.improvements.pending.find((f) => f.case === c.id);
    if (parked) {
        return `${PHASE_WORD[parked.phase]} · try ${parked.attempt} · parked`;
    }
    const applying = t.improvements.inApply.find((f) => f.case === c.id);
    if (applying) {
        return `${PHASE_WORD[applying.phase]} · try ${applying.attempt} · parked, being applied`;
    }
    if (t.claimed.has(c.id)) {
        return 'waiting for a worker';
    }
    return attemptsOf(t, c).length > 0 ? 'stopped' : 'queued';
}

// ---------------------------------------------------------------------------
// FEEDBACK.md - one case
// ---------------------------------------------------------------------------

export function feedbackPath(t: Tuning, c: { id: string }): string {
    return join(t.dir, 'cases', c.id, 'FEEDBACK.md');
}

export function writeFeedback(t: Tuning, c: Case): void {
    const file = feedbackPath(t, c);
    const here = dirname(file);
    const attempts = attemptsOf(t, c);
    const latest = [...attempts].reverse().find((a) => a.feedback);
    const decided = decisions(t);
    const session = existsSync(join(t.caseDir(c), 'session'))
        ? readFileSync(join(t.caseDir(c), 'session'), 'utf8').trim()
        : undefined;
    const lines: string[] = [];
    const say = (...more: string[]): void => {
        lines.push(...more);
    };

    say(`# ${c.id}`, '', `${link('← status', here, join(t.dir, 'STATUS.md'))}`, '');
    say(
        '| Class | Complexity | Dataset rev | State | System | Session |',
        '| --- | --- | --- | --- | --- | --- |',
        `| ${cell(c.class)} | ${cell(c.complexity)} | ${c.rev} | ${cell(stateOf(t, c))} | v${t.system.version()} | ${
            session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'
        } |`,
        '',
    );
    if (c.rubric.length > 0) {
        say('## Rubric', '', ...c.rubric.map((r) => `- **${r.id}** ${r.text}`), '');
    }
    const input =
        typeof c.input === 'string'
            ? c.input
            : c.input
                  .map((p) =>
                      typeof p === 'string' ? p : 'text' in p ? p.text : `[${Object.keys(p)[0]}]`,
                  )
                  .join(' ');
    say(
        '## Input',
        '',
        ...input
            .slice(0, 800)
            .split('\n')
            .map((l) => `> ${l}`),
        '',
    );

    if (latest?.feedback) {
        const f = latest.feedback;
        say(
            `## Latest analysis - ${PHASE_WORD[latest.phase]}, try ${latest.attempt}: ${f.verdict ?? '?'}, rubric ${rubricScore(f)}${f.done ? ', done' : ''}`,
            '',
        );
        if (f.summary) {
            say(`> ${cell(f.summary)}`, '');
        }
        const id = `${c.id}@${latest.phase}-${latest.attempt}`;
        const improvements = f.improvements ?? [];
        if (improvements.length > 0) {
            say(
                '### Improvements',
                '',
                '| # | Change | File | Decision |',
                '| --- | --- | --- | --- |',
            );
            for (const i of improvements) {
                const d = decided[id]?.[i.id];
                const decision = d?.decision
                    ? `${d.decision}${d.note ? `: ${d.note}` : ''}`
                    : t.improvements.isApplied(id)
                      ? 'applied (no decision recorded)'
                      : 'waiting for an apply';
                say(`| ${cell(i.id)} | ${cell(i.change)} | ${cell(i.file)} | ${cell(decision)} |`);
            }
            say('');
        }
        const analysis = join(latest.dir, 'analysis.md');
        if (existsSync(analysis)) {
            say('### The analysis', '', readFileSync(analysis, 'utf8').trim(), '');
        }
    }

    if (attempts.length > 0) {
        say(
            '## History',
            '',
            '| Phase | Try | Verdict | Rubric | LLM calls | Run tokens | Analyze tokens | Seconds | System | Links |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...attempts].reverse()) {
            const links = [
                a.run ? link('run', here, a.run.dir) : '',
                a.run?.report ? link('report', here, a.run.report) : '',
                existsSync(join(a.dir, 'analysis.md'))
                    ? link('analysis', here, join(a.dir, 'analysis.md'))
                    : '',
                existsSync(join(a.dir, 'feedback.json'))
                    ? link('feedback', here, join(a.dir, 'feedback.json'))
                    : '',
            ].filter(Boolean);
            say(
                `| ${PHASE_WORD[a.phase]} | ${a.attempt} | ${cell(a.feedback?.verdict ?? (a.run ? 'analyzing' : 'running'))} | ${rubricScore(a.feedback)} | ${cell(a.run?.turns)} | ${inOut(runByModel(a.run))} | ${inOut(envelopesIn(a.dir, 'analyze'))} | ${a.run?.durationMs ? Math.round(a.run.durationMs / 1000) : '-'} | ${a.run ? `v${a.run.system}` : '-'} | ${links.join(' · ') || '-'} |`,
            );
        }
        say('');
    }
    const byStage = caseTokens(t, c);
    if (Object.keys(byStage).length > 0) {
        say('## Tokens', '', ...tokenTable(byStage));
    }
    const submitted = t.memories.submissions().find((s) => s.key === `${c.id}@r${c.rev}`);
    if (submitted) {
        const merges = t.memories
            .merges()
            .filter((m) => m.ok && m.includes.includes(submitted.key));
        say(
            '## Memory',
            '',
            submitted.empty
                ? `The passing run with memory (try ${submitted.attempt}) committed nothing, so there was nothing to keep.`
                : `Kept ${submitted.at.slice(0, 16).replace('T', ' ')} from the passing run with memory (try ${submitted.attempt}): ${link('the copy', here, submitted.dir)}.`,
            '',
        );
        if (!submitted.empty) {
            say(
                merges.length > 0
                    ? `In merges: ${merges.map((m) => link(m.name, here, m.dir)).join(', ')}.`
                    : 'Not merged yet.',
                '',
            );
        }
    }
    atomic(file, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// APPLY.md - one apply: every request, every decision, every file it changed
// ---------------------------------------------------------------------------

/** A fence longer than any run of backticks in `text`, so nothing inside can close it. */
function fence(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

export function patchFiles(
    patch: string,
): { file: string; added: number; removed: number; text: string }[] {
    return patch
        .split(/^(?=diff --git )/m)
        .filter((p) => p.startsWith('diff --git '))
        .map((text) => {
            const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(text);
            const file = (m?.[2] ?? '?').replace(/^v\d+\//, '');
            let added = 0;
            let removed = 0;
            for (const line of text.split('\n')) {
                if (line.startsWith('+++') || line.startsWith('---')) {
                    continue;
                }
                if (line.startsWith('+')) {
                    added++;
                } else if (line.startsWith('-')) {
                    removed++;
                }
            }
            return { file, added, removed, text: text.trimEnd() };
        });
}

export function applyPath(dir: string): string {
    return join(dir, 'APPLY.md');
}

export function writeApply(t: Tuning, dir: string): void {
    const name = basename(dir);
    const here = dir;
    const inputs = readJson<(Feedback & { file?: string })[]>(join(dir, 'inputs.json')) ?? [];
    const applied = readJson<AppliedFile>(join(dir, 'applied.json'));
    const failed = readJson<{ at: string; startedAt?: string; error: string }>(
        join(dir, 'failed.json'),
    );
    const decided = readJson<Decisions>(join(dir, 'decisions.json')) ?? {};
    const envelope = readJson<{ sessionId?: string; answer?: string }>(join(dir, 'apply.json'));
    const retried = existsSync(join(dir, 'apply-2.json'));
    const patch = existsSync(join(dir, 'diff.patch'))
        ? readFileSync(join(dir, 'diff.patch'), 'utf8')
        : '';
    const files = patchFiles(patch);
    const improvements = inputs.reduce((n, f) => n + f.improvements.length, 0);
    const status = failed
        ? 'failed - the project was put back as it was'
        : applied
          ? applied.skipped
              ? 'nothing to change'
              : 'applied'
          : 'in progress';
    const started =
        applied?.startedAt ??
        failed?.startedAt ??
        (existsSync(join(dir, 'inputs.json'))
            ? statSync(join(dir, 'inputs.json')).mtime.toISOString()
            : undefined);
    const finished = applied?.at ?? failed?.at;
    const when = (iso: string | undefined): string =>
        iso ? iso.slice(0, 19).replace('T', ' ') : '-';
    const took = started && finished ? since(Date.parse(finished) - Date.parse(started)) : '-';

    const tally: Record<string, number> = {};
    for (const f of inputs) {
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id]?.decision ?? 'undecided';
            tally[d] = (tally[d] ?? 0) + 1;
        }
    }

    const out: string[] = [
        `# Apply ${name}${applied ? ` - v${applied.from} → v${applied.to}` : ''}`,
        '',
        link('← status', here, join(t.dir, 'STATUS.md')),
        '',
        '| Status | Started | Finished | Took | Requests | Improvements | Files changed | Retried |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${status} | ${when(started)} | ${when(finished)} | ${took} | ${inputs.length} | ${improvements} | ${files.length} | ${retried ? 'yes - the first attempt failed zen check' : 'no'} |`,
        '',
    ];
    if (failed) {
        out.push(`> ${cell(failed.error)}`, '');
    }
    if (envelope?.sessionId) {
        out.push(
            `The apply session: \`zen meta resume ${basename(t.root)} ${envelope.sessionId}\` - ask it why it changed what it changed.`,
            '',
        );
    }
    out.push(
        '## Decisions',
        '',
        '| Applied | Merged | Rejected | Structural | Undecided |',
        '| --- | --- | --- | --- | --- |',
        `| ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.structural ?? 0} | ${tally.undecided ?? 0} |`,
        '',
        '## Requests',
        '',
    );
    inputs.forEach((f, n) => {
        const tryDir = f.file
            ? dirname(f.file)
            : t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt);
        const run = readJson<Run>(join(tryDir, 'run.json'));
        const links = [
            link('case', here, feedbackPath(t, { id: f.case })),
            existsSync(join(tryDir, 'analysis.md'))
                ? link('analysis', here, join(tryDir, 'analysis.md'))
                : '',
            existsSync(join(tryDir, 'feedback.json'))
                ? link('feedback', here, join(tryDir, 'feedback.json'))
                : '',
            run ? link('run', here, run.dir) : '',
            run?.report ? link('report', here, run.report) : '',
        ].filter(Boolean);
        out.push(
            `### ${n + 1}. ${f.case} - ${PHASE_WORD[f.phase]}, try ${f.attempt}: ${f.verdict}, rubric ${rubricScore(f)}`,
            '',
            `\`${f.id}\` · ${links.join(' · ')}`,
            '',
        );
        if (f.summary) {
            out.push(`> ${cell(f.summary)}`, '');
        }
        if (f.improvements.length === 0) {
            out.push('No improvements asked for.', '');
            return;
        }
        out.push(
            '| # | Kind | File | Change | Why | Expect | Decision | Note |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id];
            out.push(
                `| ${cell(i.id)} | ${cell(i.kind)} | ${cell(i.file)} | ${cell(i.change)} | ${cell(i.why)} | ${cell(i.expect)} | ${cell(d?.decision ?? (applied || failed ? 'undecided' : 'pending'))} | ${cell(d?.note)} |`,
            );
        }
        out.push('');
    });

    out.push('## What the apply agent did', '');
    const changes = join(dir, 'changes.md');
    out.push(
        existsSync(changes)
            ? readFileSync(changes, 'utf8').trim().replace(/^#/gm, '###')
            : '_The apply agent wrote no changes.md._',
        '',
    );
    if (envelope?.answer) {
        out.push(
            '### Its answer',
            '',
            ...envelope.answer
                .trim()
                .split('\n')
                .map((l) => `> ${l}`),
            '',
        );
    }

    out.push('## Files changed', '');
    if (files.length === 0) {
        out.push(applied ? '_None: the system is unchanged._' : '_Not yet._', '');
    } else {
        out.push(
            '| File | Added | Removed |',
            '| --- | --- | --- |',
            ...files.map((f) => `| \`${f.file}\` | +${f.added} | -${f.removed} |`),
            '',
        );
        for (const f of files) {
            const tick = fence(f.text);
            out.push(`### \`${f.file}\``, '', `${tick}diff`, f.text, tick, '');
        }
    }

    out.push('## zen check', '');
    const check = join(dir, 'check.log');
    if (existsSync(check)) {
        const tail = readFileSync(check, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
        const verdict = failed
            ? 'failed on both attempts'
            : retried
              ? 'failed once; the edit was undone and the second attempt passed'
              : applied
                ? 'passed'
                : 'running';
        const tick = fence(tail);
        out.push(verdict, '', `${tick}text`, tail || '(no output)', tick, '');
    } else {
        out.push(applied?.skipped ? '_Not run: nothing was changed._' : '_Not run yet._', '');
    }

    if (applied) {
        out.push(
            '## Cases sent back to run',
            '',
            ...inputs.map(
                (f) =>
                    `- ${link(f.case, here, feedbackPath(t, { id: f.case }))} - ${PHASE_WORD[f.phase]}, try ${f.attempt + 1} on v${applied.to}`,
            ),
            '',
        );
    }
    atomic(applyPath(dir), `${out.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// The memory section of STATUS.md
// ---------------------------------------------------------------------------

function memorySection(t: Tuning, here: string): string[] {
    const m = t.memories;
    const submissions = m.submissions();
    const merges = m.merges();
    if (submissions.length === 0 && merges.length === 0) {
        return [];
    }
    const caseLink = (key: string): string => {
        const id = key.replace(/@r\d+$/, '');
        return link(id, here, feedbackPath(t, { id }));
    };
    const waiting = m.unmerged();
    const out = [
        '## Memory',
        '',
        'No run shares a memory: every try runs on its own private directory. A case whose',
        `with-memory run passes keeps a copy of that memory; every ${t.config.mergeEvery} kept memories are`,
        'merged, with the last merge, into a new numbered graph.',
        '',
        `kept **${submissions.length}** (${submissions.filter((s) => s.empty).length} committed nothing) · merges **${merges.filter((x) => x.ok).length}** · waiting to merge **${waiting.length} of ${t.config.mergeEvery}**${waiting.length ? `: ${waiting.map((s) => caseLink(s.key)).join(', ')}` : ''}`,
        '',
    ];
    if (merges.length > 0) {
        out.push(
            '| Merge | At | Cases in it | New in this merge | Nodes | Edges | Graph | Log |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const x of [...merges].reverse()) {
            out.push(
                `| ${x.name}${x.ok ? '' : ' (failed)'} | ${x.at.slice(11, 16)} | ${x.includes.length}: ${x.includes.map(caseLink).join(', ')} | ${x.added.map(caseLink).join(', ')} | ${x.nodes ?? '-'} | ${x.edges ?? '-'} | ${x.ok ? link('graph', here, x.dir) : '-'} | ${link('log', here, x.log)} |`,
            );
        }
        out.push('');
    }
    return out;
}

// ---------------------------------------------------------------------------
// STATUS.md - the whole tuning
// ---------------------------------------------------------------------------

const STEP_CLASS: Record<Worker['step'], string> = {
    idle: 'idle',
    run: 'run',
    analyze: 'analyze',
    parked: 'parked',
};

// One diagram per worker: the path its case takes through both phases, with
// the step it is on now filled in.
function idleWord(t: Tuning): string {
    if (t.improvements.applying) {
        return 'idle - no run starts during an apply';
    }
    return t.drained ? 'idle - no case left to start' : 'idle';
}

function workerDiagram(t: Tuning, w: Worker): string[] {
    if (!w.case) {
        return [
            '```mermaid',
            'flowchart LR',
            `    w["worker ${w.slot} · ${idleWord(t)} · ${since(Date.now() - w.since)}"]`,
            '    classDef idle fill:#6e7781,color:#fff',
            '    class w idle',
            '```',
        ];
    }
    const phase = w.phase ?? 'nomem';
    const p = phase === 'mem' ? 'm' : 'n';
    const current = `${p}${w.step === 'analyze' ? 'a' : w.step === 'parked' ? 'p' : 'r'}`;
    const q = t.improvements;
    const tries = phase === 'mem' ? t.config.memTries : t.config.tries;
    const extra = (id: string): string => {
        if (id !== current) {
            return '';
        }
        const now = ` · try ${w.attempt} of ${tries} · ${since(Date.now() - w.since)}`;
        return w.step === 'parked'
            ? `${now} · queue ${q.pending.length} of ${t.config.applyAt}${q.applying ? ' · applying' : ''}`
            : now;
    };
    const node = (id: string, text: string): string => `    ${id}["${text}${extra(id)}"]`;
    const out = [
        '```mermaid',
        'flowchart LR',
        node('nr', 'no memory run'),
        node('na', 'no memory analyze'),
        node('np', 'no memory parked'),
        node('mr', 'with memory run'),
        node('ma', 'with memory analyze'),
        node('mp', 'with memory parked'),
        '    cd["completed"]',
        '    df["difficult"]',
        '    nr --> na',
        '    na -->|"passed"| mr',
        '    na -->|"failed, tries left"| np',
        '    np -->|"applied"| nr',
        '    na -->|"no tries left"| df',
        '    mr --> ma',
        '    ma -->|"cheaper"| cd',
        '    ma -->|"failed, tries left"| mp',
        '    mp -->|"applied"| mr',
        '    ma -->|"no tries left"| df',
        '    classDef run fill:#0969da,color:#fff',
        '    classDef analyze fill:#8250df,color:#fff',
        '    classDef parked fill:#9a6700,color:#fff',
        '    classDef past fill:#d0d7de,color:#24292f',
        '    classDef done fill:#1a7f37,color:#fff',
        '    classDef bad fill:#cf222e,color:#fff',
        '    class cd done',
        '    class df bad',
    ];
    if (phase === 'mem') {
        out.push('    class nr,na,np past');
    }
    out.push(`    class ${current} ${STEP_CLASS[w.step]}`, '```');
    return out;
}

function overviewDiagram(counts: Record<string, number>): string[] {
    return [
        '```mermaid',
        'flowchart LR',
        `    Q["queued · ${counts.queued}"] --> N["no memory · ${counts.nomem}"]`,
        `    N --> M["with memory · ${counts.mem}"]`,
        `    M --> C["completed · ${counts.completed}"]`,
        `    N --> D["difficult · ${counts.difficult}"]`,
        '    M --> D',
        `    Q -.-> S["stopped · ${counts.stopped}"]`,
        '    classDef done fill:#1a7f37,color:#fff',
        '    classDef bad fill:#cf222e,color:#fff',
        '    classDef live fill:#0969da,color:#fff',
        '    class C done',
        '    class D bad',
        '    class N,M live',
        '```',
    ];
}

export function writeStatus(t: Tuning): void {
    const here = t.dir;
    const cases = selection(t);
    const store = DatasetStore.open(t.root);
    const counts = { queued: 0, nomem: 0, mem: 0, completed: 0, difficult: 0, stopped: 0 };
    const rows: string[] = [];
    const difficult: string[] = [];
    let everything: ByStage = {};
    for (const c of cases) {
        const w = t.workers.find((x) => x.case?.id === c.id);
        const parked =
            t.improvements.pending.find((f) => f.case === c.id) ??
            t.improvements.inApply.find((f) => f.case === c.id);
        const r = resultOf(t, c);
        const attempts = attemptsOf(t, c);
        if (r) {
            counts[r.state]++;
        } else if (w) {
            counts[w.phase ?? 'nomem']++;
        } else if (parked) {
            counts[parked.phase]++;
        } else if (attempts.length > 0 && !t.claimed.has(c.id)) {
            counts.stopped++;
        } else {
            counts.queued++;
        }
        const nomem = attempts.filter((a) => a.phase === 'nomem');
        const mem = attempts.filter((a) => a.phase === 'mem');
        const last = [...attempts].reverse().find((a) => a.feedback);
        const calls = nomem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const memCalls = mem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const caseBy = caseTokens(t, c);
        everything = mergeStages(everything, caseBy);
        rows.push(
            `| ${link(c.id, here, feedbackPath(t, c))} | ${cell(c.class)} | ${c.rubric.length} | ${cell(stateOf(t, c))} | ${nomem.length} / ${mem.length} | ${cell(last?.feedback?.verdict)} ${rubricScore(last?.feedback)} | ${calls.length ? `${calls[0]} → ${calls.at(-1)}` : '-'} | ${memCalls.length ? memCalls.at(-1) : '-'} | ${inOut(caseBy.run)} | ${inOut(caseBy.analyze)} | ${attempts.at(-1)?.run ? `v${attempts.at(-1)!.run!.system}` : '-'} |`,
        );
        if (r?.state === 'difficult') {
            difficult.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${PHASE_WORD[r.phase]} | ${cell(r.reason)} | ${r.phase === 'nomem' ? nomem.length : mem.length} | ${cell(last?.feedback?.summary)} | ${last && existsSync(join(last.dir, 'analysis.md')) ? link('last analysis', here, join(last.dir, 'analysis.md')) : '-'} |`,
            );
        }
    }

    const done = counts.completed + counts.difficult;
    const bar = cases.length ? Math.round((done / cases.length) * 20) : 0;
    const state = t.finished ? 'finished' : t.stopping ? 'stopping' : 'running';
    const q = t.improvements;
    const out: string[] = [
        `# Fine-tuning - ${basename(t.root)}`,
        '',
        `**${state}** · started ${new Date(t.startedAt).toISOString().slice(0, 16).replace('T', ' ')} · elapsed ${since(Date.now() - t.startedAt)} · updated ${new Date().toISOString().slice(11, 19)}`,
        `system **v${t.system.version()}** (applies: ${q.applies().length}) · dataset rev **${store.manifest.revision}** · workers **${t.workers.filter((w) => w.case).length} / ${t.workers.length}** · apply at **${t.config.applyAt}** · tries ${t.config.tries} without memory, ${t.config.memTries} with`,
        '',
        `\`${'█'.repeat(bar)}${'░'.repeat(20 - bar)}\` ${done} of ${cases.length} cases done - ${counts.completed} completed, ${counts.difficult} difficult`,
        '',
        '## Overview',
        '',
        ...overviewDiagram(counts),
        '',
        '## Workers',
        '',
        ...t.workers.flatMap((w) => [
            `### Worker ${w.slot}${w.case ? ` - ${link(w.case.id, here, feedbackPath(t, w.case))}` : ''}`,
            '',
            ...workerDiagram(t, w),
            '',
            ...(w.case ? tokenTable(caseTokens(t, w.case)) : []),
        ]),
        '| Worker | Case | Class | Phase | Try | Step | Since | Run | Analysis | Session |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const w of t.workers) {
        if (!w.case) {
            out.push(
                `| ${w.slot} | - | - | - | - | ${idleWord(t)} | ${since(Date.now() - w.since)} | - | - | - |`,
            );
            continue;
        }
        const dir = t.attemptDir(w.case, w.phase ?? 'nomem', w.attempt ?? 1);
        const run = readJson<Run>(join(dir, 'run.json'));
        const session = existsSync(join(t.caseDir(w.case), 'session'))
            ? readFileSync(join(t.caseDir(w.case), 'session'), 'utf8').trim()
            : undefined;
        out.push(
            `| ${w.slot} | ${link(w.case.id, here, feedbackPath(t, w.case))} | ${cell(w.case.class)} | ${PHASE_WORD[w.phase ?? 'nomem']} | ${w.attempt} / ${w.phase === 'mem' ? t.config.memTries : t.config.tries} | ${w.step} | ${since(Date.now() - w.since)} | ${run ? `${link('run', here, run.dir)}${run.report ? ` · ${link('report', here, run.report)}` : ''}` : '-'} | ${existsSync(join(dir, 'analysis.md')) ? link('analysis', here, join(dir, 'analysis.md')) : '-'} | ${session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'} |`,
        );
    }

    out.push('', `## Improvement queue - ${q.pending.length} of ${t.config.applyAt} parked`, '');
    out.push(
        q.applying
            ? 'Applying now: no new run starts until it is done.'
            : `A parked case gives its worker back, so another case runs meanwhile. The next apply comes when ${Math.max(0, t.config.applyAt - q.pending.length)} more park, or once nothing is running and no case is left to start; woken cases take a worker before new ones.`,
        '',
    );
    if (q.pending.length > 0) {
        out.push(
            '| Request | Case | Phase | Try | Improvements | Summary |',
            '| --- | --- | --- | --- | --- | --- |',
        );
        for (const f of q.pending) {
            out.push(
                `| ${cell(f.id)} | ${link(f.case, here, feedbackPath(t, { id: f.case }))} | ${PHASE_WORD[f.phase]} | ${f.attempt} | ${f.improvements.length} | ${cell(f.summary)} |`,
            );
        }
        out.push('');
    }

    const applies = q.applies();
    if (applies.length > 0) {
        out.push(
            '## Applies',
            '',
            'Each apply links to its own page: every request, every decision, every file changed and why.',
            '',
            '| Apply | Versions | At | Requests | Applied | Merged | Rejected | Structural | Files changed | Tokens | Details |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...applies].reverse()) {
            const d = readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {};
            const tally: Record<string, number> = {};
            for (const byImprovement of Object.values(d)) {
                for (const x of Object.values(byImprovement)) {
                    tally[x.decision ?? '?'] = (tally[x.decision ?? '?'] ?? 0) + 1;
                }
            }
            const patch = join(a.dir, 'diff.patch');
            const files = existsSync(patch)
                ? (readFileSync(patch, 'utf8').match(/^diff --git /gm) ?? []).length
                : 0;
            const details = [
                existsSync(join(a.dir, 'changes.md'))
                    ? link('changes', here, join(a.dir, 'changes.md'))
                    : '',
                existsSync(patch) ? link('diff', here, patch) : '',
                existsSync(join(a.dir, 'decisions.json'))
                    ? link('decisions', here, join(a.dir, 'decisions.json'))
                    : '',
            ].filter(Boolean);
            out.push(
                `| ${link(a.name, here, applyPath(a.dir))} | ${a.applied ? `v${a.applied.from} → v${a.applied.to}` : existsSync(join(a.dir, 'failed.json')) ? 'failed' : 'in progress'} | ${a.applied?.at.slice(11, 16) ?? '-'} | ${a.inputs?.length ?? 0} | ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.structural ?? 0} | ${files} | ${inOut(envelopesIn(a.dir, 'apply'))} | ${details.join(' · ') || (a.applied?.skipped ? 'nothing to change' : '-')} |`,
            );
        }
        out.push('');
    }

    const allStages = mergeStages(everything, {
        apply: mergeModels(...applies.map((a) => envelopesIn(a.dir, 'apply'))),
    });
    const tokenRows = tokenTable(allStages);
    if (tokenRows.length > 0) {
        out.push(
            '## Tokens',
            '',
            'Every try of every case so far, and every apply.',
            '',
            ...tokenRows,
        );
    }

    out.push(...memorySection(t, here));

    out.push(
        '## Cases',
        '',
        '| Case | Class | Rubric | State | Tries without / with | Last verdict | LLM calls without memory | With memory | Run tokens | Analyze tokens | System |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    );
    if (difficult.length > 0) {
        out.push(
            '## Difficult cases',
            '',
            '| Case | Phase | Reason | Tries | Last summary | Details |',
            '| --- | --- | --- | --- | --- | --- |',
            ...difficult,
            '',
        );
    }
    out.push('## Recent events', '');
    for (const e of t.recent.slice(0, 20)) {
        const who = [
            e.worker ? `worker ${e.worker}` : '',
            e.case ?? '',
            e.phase ? `${PHASE_WORD[e.phase]}${e.attempt ? ` try ${e.attempt}` : ''}` : '',
        ].filter(Boolean);
        out.push(
            `- ${e.at.slice(11, 19)} · ${[...who, e.what].join(' · ')}${e.detail ? ` - ${cell(e.detail)}` : ''}`,
        );
    }
    out.push(
        `- … everything in ${link('events.jsonl', here, join(t.dir, 'events.jsonl'))}`,
        '',
        '## Files',
        '',
        '- `cases/<id>/FEEDBACK.md` - one case: rubric, latest analysis, decisions, history',
        '- `cases/<id>/r<rev>/<NN>-<phase>/` - one try: `request.json`, `run.json`, `memory/`, `workspace/`, `feedback.json`, `analysis.md`, logs',
        '- `applies/<NNN>/APPLY.md` - one apply: requests, decisions, files changed with their diffs, zen check',
        '- `applies/<NNN>/` - `inputs.json`, `apply.log`, `check.log`, `changes.md`, `decisions.json`, `diff.patch`',
        '- `memories/` - `submissions.jsonl`, `merges.jsonl`, `submitted/<case>@r<rev>/`, `merged/mNN/`',
        '- `systems/` - `systems.jsonl` and a copy of `agents.yaml` + `agents/` per version',
        '- `events.jsonl` - every step, in order; `loop.json` - the settings',
        '- `journal.jsonl` - steps begun and not yet closed; a restart rolls back what a kill cut off',
        '',
    );
    atomic(join(t.dir, 'STATUS.md'), `${out.join('\n')}\n`);
}
