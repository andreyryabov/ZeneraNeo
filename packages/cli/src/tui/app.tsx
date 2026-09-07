import { TextInput } from '@inkjs/ui';
import {
    addUsage,
    isCheckpoint,
    turns,
    zeroUsage,
    type AgentEvent,
    type TokenUsage,
} from '@zenera/neo';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { pathToFileURL } from 'node:url';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Engine from '../engine.ts';
import { History } from '../history.ts';
import { format } from '../narrate.ts';
import { display } from '../session.ts';
import { CliError } from '../term.ts';
import { resolveTheme, THEMES, type Kind, type Theme } from './theme.ts';
import { budgetOf, clip, segmentsOf, windowOf } from './wrap.ts';

// ---------------------------------------------------------------------------
// The drawing surface
//
// This is the CLI's one dependency, and it is behind a dynamic import in the
// `run` command: nothing else in the tool loads React, so `zen list` and
// `zen key ls` stay as fast as they would be without it.
//
// It is a *view*. Every turn goes through `Engine.run`, exactly as the one-shot
// path does, so a session started here is indistinguishable from one started in
// a script — nothing is recorded only when someone is watching.
// ---------------------------------------------------------------------------

interface Line {
    key: string;
    kind: Kind;
    text: string;
    detail?: string;
}

/**
 * What `Static` prints. The banner is the first of them because it is printed
 * once, exactly like a finished turn: see the note on the frame below.
 */
type Item = Line | { key: 'banner' };

const BANNER: Item = { key: 'banner' };

const isBanner = (item: Item): item is { key: 'banner' } => item.key === 'banner';

const MARK: Record<Kind, string> = {
    you: '›',
    agent: ' ',
    tool: '·',
    note: ' ',
    error: '!',
};

// ---------------------------------------------------------------------------
// What is happening right now
//
// A finished turn is a `Line` in the scrollback. These two are the other half:
// work that has started and not yet landed, which the transcript cannot show
// because it is not over. They live in refs rather than state — the activity
// region repaints on a timer anyway, because a spinner and a clock have to move
// whether or not an event arrived.
// ---------------------------------------------------------------------------

/** A tool call that has gone out and not come back. */
interface Running {
    callId: string;
    name: string;
    args: string;
    startedAt: number;
    /** the branch that called it; absent on the trunk */
    branch?: string;
}

/** A branch of a fork, while it runs. */
interface Branch {
    name: string;
    agent: string;
    startedAt: number;
    /** model calls, which is what a branch's progress is measured in */
    steps: number;
    tools: number;
}

/** Proof of life. Ten frames at 100ms is a turn of the wheel per second. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Redraw cadence for the activity region, independent of events. */
const FRAME_MS = 100;

// The theme is decided once, before the first frame, and never changes while
// the app is up — a terminal does not repaint its own scheme underneath us.
// A context rather than props only because every part of the view wants it.
const ThemeContext = React.createContext<Theme>(THEMES.dark);
const useTheme = (): Theme => useContext(ThemeContext);

function Row({ line }: { line: Line }): React.ReactElement {
    const style = useTheme().line[line.kind];
    return (
        <Box flexDirection="row" marginTop={line.kind === 'you' ? 1 : 0}>
            <Text color={style.color} dimColor={style.dim}>
                {MARK[line.kind]}{' '}
            </Text>
            <Box flexDirection="column">
                {line.kind === 'agent' ? (
                    <Answer text={line.text} />
                ) : (
                    <Text color={style.color} dimColor={style.dim} bold={line.kind === 'you'}>
                        {line.text}
                    </Text>
                )}
                {line.detail ? <Text dimColor>{line.detail}</Text> : null}
            </Box>
        </Box>
    );
}

function Answer({ text }: { text: string }): React.ReactElement {
    const theme = useTheme();
    const segments = segmentsOf(text);
    return (
        <Box flexDirection="column">
            {segments.map((s, i) =>
                s.code ? (
                    <Box key={i} flexDirection="column" marginY={1}>
                        <Text color={theme.rule} dimColor>
                            {`\u250c\u2500${s.title ? ` ${s.title}` : ''}`}
                        </Text>
                        {s.lines.map((l, j) => (
                            <Box key={j} flexDirection="row">
                                <Text color={theme.rule} dimColor>
                                    {'\u2502 '}
                                </Text>
                                <Text>{l || ' '}</Text>
                            </Box>
                        ))}
                        <Text color={theme.rule} dimColor>
                            {'\u2514\u2500'}
                        </Text>
                    </Box>
                ) : (
                    <Text key={i}>{s.lines.join('\n')}</Text>
                ),
            )}
        </Box>
    );
}

// ---------------------------------------------------------------------------

export interface AppOptions {
    readOnly: boolean;
    /** `dark`, `light` or `auto`. Unset means `auto`. */
    theme?: string;
}

interface Props {
    engine: Engine.Engine;
    options: AppOptions;
    theme: Theme;
}

/**
 * What the footer knows.
 *
 * `session` is what the run state carries: the whole conversation, including
 * every turn taken before this process started. `turn` is the difference the
 * last turn made. Both are worth seeing and they are not remotely the same
 * number — with a warm cache a long session's total says almost nothing about
 * what the last question cost.
 */
interface Stats {
    session: TokenUsage;
    turn?: TokenUsage;
    /** model calls in the session, which is not the number of questions asked */
    calls: number;
    durationMs?: number;
}

function App({ engine, options, theme }: Props): React.ReactElement {
    const { exit } = useApp();
    const { stdout } = useStdout();

    const [lines, setLines] = useState<Line[]>([]);
    const [live, setLive] = useState('');
    const [thinking, setThinking] = useState('');
    const [busy, setBusy] = useState(false);
    const [agent, setAgent] = useState(engine.state?.agentName ?? engine.project.entry);
    const [stats, setStats] = useState<Stats>({
        session: engine.state?.usage ?? zeroUsage(),
        calls: engine.state ? turns(engine.state) : 0,
    });
    /** Model calls in the turn now running, and what answered the last one. */
    const [step, setStep] = useState(0);
    const [model, setModel] = useState<string | undefined>(undefined);

    // In flight, and therefore not in the transcript yet. Refs, because the
    // activity region below is redrawn by the frame timer regardless.
    const running = useRef(new Map<string, Running>());
    const branches = useRef(new Map<string, Branch>());
    const lane = useLanes(theme);

    // What the turn now running has cost so far, summed per model call rather
    // than read off the state: it is wanted between calls, not after them. The
    // exact figure replaces it when the turn lands.
    const spent = useRef(zeroUsage());
    const startedAt = useRef(0);

    const stopping = useRef<AbortController | undefined>(undefined);
    const seq = useRef(0);

    // The prompt, and how to get back into it what was asked before.
    //
    // `TextInput` is uncontrolled: it takes a starting value and owns it from
    // there. So recalling a line means handing it a new starting value and a
    // new `key`, which mounts a fresh input — that is also what puts the cursor
    // at the end of the recalled text, where it is wanted.
    const [history] = useState(() => History.open(engine.project.root));
    const [draft, setDraft] = useState('');
    const [generation, setGeneration] = useState(0);
    /** Where in the history the prompt is; `entries.length` is the live line. */
    const at = useRef(history.entries.length);
    /** What the input holds right now, which nothing else can see. */
    const typed = useRef('');
    /** The half-written line browsing started from, returned to by walking back down. */
    const pending = useRef('');

    const remember = useCallback((value: string): void => {
        typed.current = value;
    }, []);

    const reset = useCallback((): void => {
        at.current = history.entries.length;
        pending.current = '';
        typed.current = '';
        setDraft('');
        setGeneration((g) => g + 1);
    }, [history]);

    const recall = useCallback(
        (delta: number): void => {
            const items = history.entries;
            const end = items.length;
            if (end === 0) {
                return;
            }
            if (at.current === end) {
                if (delta > 0) {
                    return;
                }
                pending.current = typed.current;
            }
            const next = Math.min(end, Math.max(0, at.current + delta));
            if (next === at.current) {
                return;
            }
            at.current = next;
            const value = next === end ? pending.current : (items[next] ?? '');
            typed.current = value;
            setDraft(value);
            setGeneration((g) => g + 1);
        },
        [history],
    );

    // A spinner and a clock have to move on their own, so the frame is driven
    // by a timer rather than by events — but only while there is something to
    // watch, so an idle prompt repaints exactly never.
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!busy) {
            return;
        }
        const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS);
        return () => clearInterval(timer);
    }, [busy]);

    // Read during render so a resize, which re-renders the root, resizes the
    // windows below with it. The three repainting blocks share one budget: what
    // is left of the terminal once the chrome has had its rows.
    const rows = stdout?.rows ?? 24;
    const columns = stdout?.columns ?? 80;
    const spin = SPINNER[frame % SPINNER.length] as string;
    const activity = busy
        ? activityOf(running.current, branches.current, Date.now(), columns - GUTTER - 2, lane)
        : [];
    const budget = budgetOf(rows, activity.length, Boolean(thinking));
    // Priced as far as it has got. Read during render, so the frame timer is
    // what advances the clock.
    const inflight = busy
        ? { usage: spent.current, durationMs: Date.now() - startedAt.current }
        : undefined;

    const push = useCallback((kind: Kind, text: string, detail?: string): void => {
        setLines((prev) => [...prev, { key: `${seq.current++}`, kind, text, detail }]);
    }, []);

    // Deltas arrive far faster than a terminal can usefully redraw, so text is
    // accumulated in one string and React coalesces the repaints. The finished
    // answer replaces it in one piece when the turn lands.
    //
    // Reasoning is accumulated the same way but never enters `lines`: it is a
    // progress indicator, not part of the conversation. The full chain is in
    // the trajectory (`LlmCallNode.thinking`) and the run's report, so nothing
    // is lost when it is cleared at the start of the next model call.
    const onEvent = useCallback(
        (event: AgentEvent): void => {
            if (!isCheckpoint(event)) {
                // Only the trunk's own streams are drawn. A fork has several
                // running at once, and appending them all to one string is not
                // a transcript of anything: it is several answers interleaved
                // token by token. Each branch's distilled result arrives at the
                // join, and the whole of it is in the report.
                if (event.branch) {
                    return;
                }
                if (event.type === 'text_delta') {
                    setLive((prev) => prev + event.delta);
                } else if (event.type === 'thinking_delta') {
                    setThinking((prev) => prev + event.delta);
                }
                return;
            }
            const from = event.branch?.name;
            switch (event.type) {
                case 'before_llm_call':
                    if (from) {
                        const b = branches.current.get(from);
                        if (b) {
                            b.steps++;
                        }
                    } else {
                        setThinking('');
                        setStep((n) => n + 1);
                    }
                    break;
                case 'after_llm_call':
                    // Branches included: they are what this turn is spending on.
                    spent.current = addUsage(spent.current, event.node.usage);
                    if (!from) {
                        setModel(event.node.model);
                    }
                    break;
                case 'before_tool_call':
                    running.current.set(event.call.callId, {
                        callId: event.call.callId,
                        name: event.call.name,
                        args: event.call.args.preview ?? '',
                        startedAt: Date.now(),
                        branch: from,
                    });
                    break;
                case 'after_tool_call': {
                    const { node } = event;
                    const call = running.current.get(node.callId);
                    running.current.delete(node.callId);
                    if (from) {
                        const b = branches.current.get(from);
                        if (b) {
                            b.tools++;
                        }
                    }
                    // What it was asked and what it answered, which is the
                    // difference between knowing a tool ran and knowing what
                    // the agent did. Both are previews already; a whole file
                    // read belongs in the report, not in the scrollback.
                    push(
                        'tool',
                        clip(`${node.name}(${call?.args ?? ''})`, columns - 4),
                        detailOf(node, from, columns - 4),
                    );
                    break;
                }
                case 'handoff':
                    setAgent(event.to);
                    push('note', `→ ${event.to}`, `handed off from ${event.from}`);
                    break;
                case 'before_fork':
                    push(
                        'note',
                        `⑂ ${event.node.branches.length} branches`,
                        `${event.node.branches.map((b) => b.name).join(', ')} · context ${
                            event.node.contextMode
                        }`,
                    );
                    break;
                case 'branch_started':
                    branches.current.set(event.child.name, {
                        name: event.child.name,
                        agent: event.childState.agentName,
                        startedAt: Date.now(),
                        steps: 0,
                        tools: 0,
                    });
                    break;
                case 'branch_finished': {
                    const b = branches.current.get(event.child.name);
                    branches.current.delete(event.child.name);
                    const spent = b ? ` · ${durationOf(Date.now() - b.startedAt) ?? ''}` : '';
                    const did = b ? ` · ${b.steps} steps · ${b.tools} tools` : '';
                    push('tool', `⑂ ${event.child.name}`, `${event.status}${spent}${did}`);
                    break;
                }
                default:
                    break;
            }
        },
        [columns, push],
    );

    const submit = useCallback(
        (value: string): void => {
            const text = value.trim();
            if (busy) {
                return;
            }
            // Recorded before it is acted on, so a question that fails — or
            // one that quits — is still one arrow key away next time.
            history.add(text);
            reset();
            if (!text) {
                return;
            }
            if (text === '/exit' || text === '/quit') {
                exit();
                return;
            }
            if (text === '/help') {
                push('note', 'commands', '/help  /clear  /exit · ↑ recalls, esc stops a turn');
                push(
                    'note',
                    'the footer',
                    'in = what was sent · out = what came back · a number in brackets is part' +
                        ' of the one before it, not an extra',
                );
                return;
            }
            if (text === '/clear') {
                setLines([]);
                stdout?.write('\u001b[2J\u001b[H');
                return;
            }

            push('you', text);
            setBusy(true);
            setLive('');
            setThinking('');
            setStep(0);
            spent.current = zeroUsage();
            startedAt.current = Date.now();
            running.current.clear();
            branches.current.clear();
            const controller = new AbortController();
            stopping.current = controller;

            void (async () => {
                try {
                    const outcome = await Engine.run(engine, text, onEvent, controller.signal);
                    push('agent', outcome.text);
                    // The previous total is the only thing that can say what
                    // this turn cost, and reading it out of the updater is what
                    // makes that true regardless of when the turn lands.
                    setStats((prev) => ({
                        session: outcome.result.usage,
                        turn: since(prev.session, outcome.result.usage),
                        calls: turns(outcome.result.state),
                        durationMs: outcome.durationMs,
                    }));
                    setAgent(outcome.result.agent);
                    if (outcome.result.stopReason === 'aborted') {
                        push('note', 'stopped');
                    }
                    if (outcome.report) {
                        push('note', `↗ report ${pathToFileURL(outcome.report).href}`);
                    }
                } catch (err) {
                    const hint = err instanceof CliError ? err.hint : undefined;
                    push('error', err instanceof Error ? err.message : String(err), hint);
                } finally {
                    setBusy(false);
                    setLive('');
                    setThinking('');
                    running.current.clear();
                    branches.current.clear();
                    stopping.current = undefined;
                }
            })();
        },
        [busy, engine, exit, history, onEvent, push, reset, stdout],
    );

    // Escape stops the turn; ctrl-c leaves. They are different things, and a
    // run that is asked to stop still writes its state, so the session survives
    // either one.
    //
    // The arrows are ours because `TextInput` explicitly ignores them; a turn
    // in flight owns the keyboard, so they only walk the history while idle.
    useInput((input, keys) => {
        if (keys.escape && stopping.current) {
            stopping.current.abort();
        }
        if (keys.ctrl && input === 'c') {
            stopping.current?.abort();
            exit();
            return;
        }
        if (busy) {
            return;
        }
        if (keys.upArrow) {
            recall(-1);
        } else if (keys.downArrow) {
            recall(1);
        }
    });

    return (
        <ThemeContext.Provider value={theme}>
            <Box flexDirection="column">
                {/* `Static` prints once and never repaints, so the banner and
                    finished turns scroll away into real terminal scrollback
                    instead of being redrawn on every keystroke. */}
                <Static items={[BANNER, ...lines]}>
                    {(item) =>
                        isBanner(item) ? (
                            <Header key={item.key} engine={engine} readOnly={options.readOnly} />
                        ) : (
                            <Row key={item.key} line={item} />
                        )
                    }
                </Static>

                <Activity rows={activity.slice(0, budget.activity)} />

                {thinking ? (
                    <Thinking text={thinking} columns={columns} rows={budget.thinking} />
                ) : null}

                {/* The answer as it arrives, in the terminal's own foreground:
                    it is the text, not a highlight on it. */}
                {live ? <Live text={live} columns={columns} rows={budget.live} /> : null}

                <Footer
                    agent={agent}
                    busy={busy}
                    spin={spin}
                    running={[...running.current.values()]}
                    step={step}
                    model={model}
                    stats={stats}
                    inflight={inflight}
                    thinking={Boolean(thinking)}
                />

                {busy ? null : (
                    <Box>
                        <Text color={theme.accent}>› </Text>
                        <TextInput
                            key={generation}
                            defaultValue={draft}
                            placeholder="Ask something… (↑ for history, /help for commands)"
                            onChange={remember}
                            onSubmit={submit}
                        />
                    </Box>
                )}
            </Box>
        </ThemeContext.Provider>
    );
}

function Header({
    engine,
    readOnly,
}: {
    engine: Engine.Engine;
    readOnly: boolean;
}): React.ReactElement {
    const theme = useTheme();
    const model = engine.project.config.model;
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold>{engine.name}</Text>
                <Text dimColor> {engine.session.id}</Text>
                {readOnly ? <Text color={theme.warn}> read-only</Text> : null}
            </Box>
            <Text dimColor>
                {display(engine.workspace)}
                {model ? ` · ${model}` : ''}
            </Text>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// The repainting frame
//
// Everything below `Static` is redrawn on every event, and it has one hard
// constraint: **it must never be taller than the terminal.** Ink erases the
// previous frame by moving the cursor up over it, which only works while that
// frame is still on screen. A frame that outgrows the viewport scrolls its own
// top away, the erase falls short, and every repaint strands another copy of
// its first line in the scrollback — the same line, over and over, with the
// text creeping sideways as the stream advances.
//
// The unit that matters here is the **row the terminal draws**, not the line
// the model wrote. A reasoning stream is one enormous paragraph with almost no
// newlines in it, so counting `\n` says "six lines" while the terminal draws
// sixty. So `windowOf` wraps the text itself, to a width it knows, and takes
// the last N wrapped rows — and then the same number is given again as an
// explicit `height` with `overflow="hidden"`, so a miscount clips instead of
// corrupting.
//
// Nothing is lost by any of it: the finished answer lands in `Static` whole,
// and the full reasoning chain is in the trajectory and the run's report.
//
// How the rows are divided between the three blocks is `budgetOf` in wrap.ts.
// ---------------------------------------------------------------------------

/** The gutter every streaming block is indented behind. */
const GUTTER = 2;

// ---------------------------------------------------------------------------
// The activity region
//
// The gap this fills: a turn that spends ninety seconds in one tool call used
// to draw a static word in the footer and nothing else, so the only honest
// reading of the screen was that the thing had hung. What is missing from a
// transcript is never the finished work — that scrolls past — it is the work
// that has started, which has no line yet because it has no outcome yet.
// ---------------------------------------------------------------------------

/** One row of it: something in flight, and how long it has been. */
interface ActivityRow {
    key: string;
    label: string;
    detail: string;
    /** its branch's lane, absent on the trunk */
    color?: string;
}

/**
 * Branches first, then tools. A fork's branches are the shape of what is
 * happening and their tools are detail within it, so the ordering survives
 * being cut off at `ACTIVITY_ROWS`.
 */
function activityOf(
    tools: ReadonlyMap<string, Running>,
    branches: ReadonlyMap<string, Branch>,
    now: number,
    width: number,
    lane: (name?: string) => string | undefined,
): ActivityRow[] {
    const rows: ActivityRow[] = [];
    for (const b of branches.values()) {
        const detail =
            `  ${b.steps} ${b.steps === 1 ? 'step' : 'steps'}` +
            (b.tools ? `  ${b.tools} ${b.tools === 1 ? 'tool' : 'tools'}` : '') +
            `  ${secs(now - b.startedAt)}`;
        rows.push({
            key: `b:${b.name}`,
            label: clip(`⑂ ${b.name}${b.agent ? ` · ${b.agent}` : ''}`, width - detail.length),
            detail,
            color: lane(b.name),
        });
    }
    for (const t of tools.values()) {
        const detail = `  ${secs(now - t.startedAt)}`;
        rows.push({
            key: `t:${t.callId}`,
            label: clip(`${t.name}(${t.args})`, width - detail.length),
            detail,
            color: lane(t.branch),
        });
    }
    return rows;
}

function Activity({ rows }: { rows: ActivityRow[] }): React.ReactElement | null {
    const theme = useTheme();
    if (!rows.length) {
        return null;
    }
    return (
        <Box flexDirection="column" height={rows.length} overflow="hidden">
            {rows.map((r) => (
                <Text key={r.key} wrap="truncate-end">
                    <Text color={theme.rule} dimColor>
                        {'  '}
                    </Text>
                    <Text color={r.color} dimColor={r.color === undefined}>
                        {r.label}
                    </Text>
                    <Text dimColor>{r.detail}</Text>
                </Text>
            ))}
        </Box>
    );
}

/**
 * A stable colour per branch, handed out in order of first sight. Held in a ref
 * so a branch keeps its colour for the whole turn rather than being recoloured
 * every time the map is rebuilt.
 */
function useLanes(theme: Theme): (name?: string) => string | undefined {
    const assigned = useRef(new Map<string, string>());
    return useCallback(
        (name?: string): string | undefined => {
            if (!name) {
                return undefined;
            }
            const seen = assigned.current.get(name);
            if (seen !== undefined) {
                return seen;
            }
            const next = theme.lanes[assigned.current.size % theme.lanes.length] as string;
            assigned.current.set(name, next);
            return next;
        },
        [theme],
    );
}

interface StreamProps {
    text: string;
    /** Terminal width. */
    columns: number;
    /** The most rows this block may occupy. */
    rows: number;
}

function Thinking({ text, columns, rows }: StreamProps): React.ReactElement {
    const theme = useTheme();
    const shown = windowOf(text, columns - GUTTER, rows);
    return (
        <Box flexDirection="row" height={shown.length} overflow="hidden">
            <Box flexDirection="column" width={GUTTER}>
                {shown.map((_, i) => (
                    <Text key={i} color={theme.rule} dimColor>
                        {i === 0 ? '◇ ' : '  '}
                    </Text>
                ))}
            </Box>
            <Box flexDirection="column">
                {shown.map((row, i) => (
                    <Text key={i} dimColor italic wrap="truncate-end">
                        {row}
                    </Text>
                ))}
            </Box>
        </Box>
    );
}

function Live({ text, columns, rows }: StreamProps): React.ReactElement {
    const shown = windowOf(text, columns - GUTTER, rows);
    return (
        <Box flexDirection="column" paddingLeft={GUTTER} height={shown.length} overflow="hidden">
            {shown.map((row, i) => (
                <Text key={i} wrap="truncate-end">
                    {row}
                </Text>
            ))}
        </Box>
    );
}

/** The label column the two number rows line up behind. */
const LABEL = 10;

function Footer({
    agent,
    busy,
    spin,
    running,
    step,
    model,
    stats,
    inflight,
    thinking,
}: {
    agent: string;
    busy: boolean;
    spin: string;
    running: Running[];
    step: number;
    model?: string;
    stats: Stats;
    inflight?: { usage: TokenUsage; durationMs: number };
    thinking: boolean;
}): React.ReactElement {
    const theme = useTheme();
    // Named tools beat the generic words: "thinking" while three shell commands
    // are out is the least informative thing the footer could say.
    const what = running.length
        ? running.length === 1
            ? `running ${running[0]?.name}`
            : `running ${running.length} tools`
        : thinking
          ? 'reasoning'
          : 'thinking';
    // Who before what. The agent is the subject of the sentence, and in a
    // handoff it is the thing that changed.
    const aside = [
        ...(step ? [`step ${step}`] : []),
        ...(model ? [model] : []),
        'esc to stop',
    ].join(' · ');
    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text color={theme.accent} dimColor>
                    {agent}
                </Text>
                {busy ? (
                    <Text color={theme.warn}>
                        {'  '}
                        {spin} {what}…
                    </Text>
                ) : null}
                {busy ? <Text dimColor>{`  ${aside}`}</Text> : null}
            </Box>
            {inflight ? (
                <Text dimColor>
                    {'this turn'.padEnd(LABEL)}
                    {tokens(inflight.usage)}
                    {` · ${secs(inflight.durationMs)}`}
                </Text>
            ) : stats.turn ? (
                <Text dimColor>
                    {'last turn'.padEnd(LABEL)}
                    {tokens(stats.turn)}
                    {stats.durationMs === undefined
                        ? ''
                        : ` · ${durationOf(stats.durationMs) ?? ''}`}
                </Text>
            ) : null}
            <Text dimColor>
                {'session'.padEnd(LABEL)}
                {tokens(stats.session)}
                {stats.calls ? ` · ${stats.calls} ${stats.calls === 1 ? 'call' : 'calls'}` : ''}
            </Text>
        </Box>
    );
}

/**
 * Cache and reasoning are SUBSETS of the number beside them, so they are drawn
 * inside it. On one dotted line they read as four things to add up, which is
 * the single reading that is wrong. Both are skipped when the provider reports
 * nothing — most do not, and a row of zeroes teaches nobody anything.
 */
function tokens(usage: TokenUsage): string {
    const cached = usage.cachedInputTokens ? ` (${format(usage.cachedInputTokens)} cached)` : '';
    const think = usage.reasoningTokens ? ` (${format(usage.reasoningTokens)} thinking)` : '';
    return `${format(usage.inputTokens)} in${cached} · ${format(usage.outputTokens)} out${think}`;
}

/** What the last turn added. Usage only ever grows, so a subtraction is safe. */
function since(before: TokenUsage, after: TokenUsage): TokenUsage {
    return {
        inputTokens: after.inputTokens - before.inputTokens,
        cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
        outputTokens: after.outputTokens - before.outputTokens,
        reasoningTokens: after.reasoningTokens - before.reasoningTokens,
    };
}

function durationOf(ms?: number): string | undefined {
    return ms === undefined ? undefined : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A clock that is being watched. Always seconds, so the digits do not jump. */
function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

/** What a finished tool call has to say for itself, under its own name. */
function detailOf(
    node: { isError: boolean; durationMs?: number; result: { preview?: string } },
    branch: string | undefined,
    width: number,
): string {
    const parts = [
        ...(branch ? [`⑂ ${branch}`] : []),
        ...(node.isError ? ['failed'] : []),
        ...(durationOf(node.durationMs) ? [durationOf(node.durationMs) as string] : []),
        ...(node.result.preview ? [node.result.preview] : []),
    ];
    // Two rows of it. A preview is already a preview; the whole result is a
    // click away in the report, and a wall of it here buries the next answer.
    return clip(parts.join(' · '), Math.max(40, width * 2));
}

// ---------------------------------------------------------------------------

export async function start(engine: Engine.Engine, options: AppOptions): Promise<void> {
    // Asked before Ink takes the terminal: the query talks to stdin directly,
    // and there is exactly one moment when nothing else is holding it.
    const theme = await resolveTheme(options.theme);
    const { render } = await import('ink');
    // Ctrl-C is handled above so an in-flight turn can be aborted and recorded
    // rather than the process simply vanishing mid-write.
    const instance = render(<App engine={engine} options={options} theme={theme} />, {
        exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
}
