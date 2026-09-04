import { TextInput } from '@inkjs/ui';
import { isCheckpoint, turns, zeroUsage, type AgentEvent, type TokenUsage } from '@zenera/neo';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { pathToFileURL } from 'node:url';
import React, { useCallback, useContext, useRef, useState } from 'react';
import * as Engine from '../engine.ts';
import { History } from '../history.ts';
import { format } from '../narrate.ts';
import { display } from '../session.ts';
import { CliError } from '../term.ts';
import { resolveTheme, THEMES, type Kind, type Theme } from './theme.ts';
import { windowOf } from './wrap.ts';

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
                <Text color={style.color} dimColor={style.dim} bold={line.kind === 'you'}>
                    {line.text}
                </Text>
                {line.detail ? <Text dimColor>{line.detail}</Text> : null}
            </Box>
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
    const [tool, setTool] = useState<string | undefined>(undefined);

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

    // Read during render so a resize, which re-renders the root, resizes the
    // windows below with it. The two streaming blocks share one budget: what
    // is left of the terminal once the chrome has had its rows.
    const rows = stdout?.rows ?? 24;
    const columns = stdout?.columns ?? 80;
    const budget = Math.max(2, rows - CHROME_ROWS);
    const thinkingRows = thinking ? Math.min(THINKING_ROWS, Math.max(1, budget - 2)) : 0;
    const liveRows = Math.max(1, budget - thinkingRows);

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
                if (event.type === 'text_delta') {
                    setLive((prev) => prev + event.delta);
                } else if (event.type === 'thinking_delta') {
                    setThinking((prev) => prev + event.delta);
                }
                return;
            }
            switch (event.type) {
                case 'before_llm_call':
                    setThinking('');
                    break;
                case 'before_tool_call':
                    setTool(event.call.name);
                    break;
                case 'after_tool_call':
                    setTool(undefined);
                    push(
                        'tool',
                        event.node.name,
                        event.node.isError ? 'failed' : durationOf(event.node.durationMs),
                    );
                    break;
                case 'handoff':
                    setAgent(event.to);
                    push('note', `→ ${event.to}`, `handed off from ${event.from}`);
                    break;
                case 'before_fork':
                    push('note', `⑂ ${event.node.branches.map((b) => b.name).join(', ')}`);
                    break;
                case 'branch_finished':
                    push('tool', `⑂ ${event.child.name}`, event.status);
                    break;
                default:
                    break;
            }
        },
        [push],
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
            if (text === '/clear') {
                setLines([]);
                stdout?.write('\u001b[2J\u001b[H');
                return;
            }

            push('you', text);
            setBusy(true);
            setLive('');
            setThinking('');
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
                    setTool(undefined);
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

                {thinking ? (
                    <Thinking text={thinking} columns={columns} rows={thinkingRows} />
                ) : null}

                {/* The answer as it arrives, in the terminal's own foreground:
                    it is the text, not a highlight on it. */}
                {live ? <Live text={live} columns={columns} rows={liveRows} /> : null}

                <Footer
                    agent={agent}
                    busy={busy}
                    tool={tool}
                    stats={stats}
                    thinking={Boolean(thinking)}
                />

                {busy ? null : (
                    <Box>
                        <Text color={theme.accent}>› </Text>
                        <TextInput
                            key={generation}
                            defaultValue={draft}
                            placeholder="Ask something… (↑ for history, /exit to leave)"
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
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold>{engine.name}</Text>
                <Text dimColor> {engine.session.id}</Text>
                {readOnly ? <Text color={theme.warn}> read-only</Text> : null}
            </Box>
            <Text dimColor>{display(engine.workspace)}</Text>
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
// ---------------------------------------------------------------------------

/** How much of the reasoning stream is worth showing. It is a progress bar. */
const THINKING_ROWS = 6;

/** The two footer rows, its margin, the prompt, and a row in hand. */
const CHROME_ROWS = 6;

/** The gutter every streaming block is indented behind. */
const GUTTER = 2;

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

function Footer({
    agent,
    busy,
    tool,
    stats,
    thinking,
}: {
    agent: string;
    busy: boolean;
    tool?: string;
    stats: Stats;
    thinking: boolean;
}): React.ReactElement {
    const what = tool ? `running ${tool}` : thinking ? 'reasoning' : 'thinking';
    const theme = useTheme();
    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                {busy ? <Text color={theme.warn}>{what}… </Text> : null}
                <Text color={theme.accent} dimColor>
                    {agent}
                </Text>
                {stats.turn ? (
                    <Text dimColor>
                        {'  turn '}
                        {tokens(stats.turn)}
                        {stats.durationMs === undefined
                            ? ''
                            : ` · ${durationOf(stats.durationMs) ?? ''}`}
                    </Text>
                ) : null}
                {busy ? <Text dimColor>{'  esc to stop'}</Text> : null}
            </Box>
            <Text dimColor>
                {'session '}
                {tokens(stats.session)}
                {stats.calls ? ` · ${stats.calls} ${stats.calls === 1 ? 'call' : 'calls'}` : ''}
            </Text>
        </Box>
    );
}

/**
 * Cache and reasoning are subsets of the numbers beside them, not additions to
 * them, and they are only worth the width when a provider actually reports one
 * — most do not, and a row of zeroes teaches nobody anything.
 */
function tokens(usage: TokenUsage): string {
    const parts = [`${format(usage.inputTokens)} in`];
    if (usage.cachedInputTokens) {
        parts.push(`${format(usage.cachedInputTokens)} cached`);
    }
    parts.push(`${format(usage.outputTokens)} out`);
    if (usage.reasoningTokens) {
        parts.push(`${format(usage.reasoningTokens)} thinking`);
    }
    return parts.join(' · ');
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
