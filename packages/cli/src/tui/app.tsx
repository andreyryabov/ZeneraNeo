import { TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useRef, useState } from 'react';
import { isCheckpoint, zeroUsage, type AgentEvent, type TokenUsage } from 'zenera-neo';
import * as Engine from '../engine.ts';
import { format } from '../narrate.ts';
import { display } from '../session.ts';

// ---------------------------------------------------------------------------
// The drawing surface
//
// This is the CLI's one dependency, and it is behind a dynamic import in the
// `run` command: nothing else in the tool loads React, so `zn list` and
// `zn key ls` stay as fast as they would be without it.
//
// It is a *view*. Every turn goes through `Engine.run`, exactly as the one-shot
// path does, so a session started here is indistinguishable from one started in
// a script — nothing is recorded only when someone is watching.
// ---------------------------------------------------------------------------

type Kind = 'you' | 'agent' | 'tool' | 'note' | 'error';

interface Line {
    key: string;
    kind: Kind;
    text: string;
    detail?: string;
}

const COLOUR: Record<Kind, string> = {
    you: 'cyan',
    agent: 'white',
    tool: 'gray',
    note: 'gray',
    error: 'red',
};

const MARK: Record<Kind, string> = {
    you: '›',
    agent: ' ',
    tool: '·',
    note: ' ',
    error: '!',
};

function Row({ line }: { line: Line }): React.ReactElement {
    return (
        <Box flexDirection="row" marginTop={line.kind === 'you' ? 1 : 0}>
            <Text color={COLOUR[line.kind]} dimColor={line.kind === 'tool'}>
                {MARK[line.kind]}{' '}
            </Text>
            <Box flexDirection="column">
                <Text color={COLOUR[line.kind]} bold={line.kind === 'you'}>
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
}

interface Props {
    engine: Engine.Engine;
    options: AppOptions;
}

function App({ engine, options }: Props): React.ReactElement {
    const { exit } = useApp();
    const { stdout } = useStdout();

    const [lines, setLines] = useState<Line[]>([]);
    const [live, setLive] = useState('');
    const [busy, setBusy] = useState(false);
    const [agent, setAgent] = useState(engine.state?.agentName ?? engine.project.entry);
    const [usage, setUsage] = useState<TokenUsage>(engine.state?.usage ?? zeroUsage());
    const [tool, setTool] = useState<string | undefined>(undefined);

    const stopping = useRef<AbortController | undefined>(undefined);
    const seq = useRef(0);

    const push = useCallback((kind: Kind, text: string, detail?: string): void => {
        setLines((prev) => [...prev, { key: `${seq.current++}`, kind, text, detail }]);
    }, []);

    // Deltas arrive far faster than a terminal can usefully redraw, so text is
    // accumulated in one string and React coalesces the repaints. The finished
    // answer replaces it in one piece when the turn lands.
    const onEvent = useCallback(
        (event: AgentEvent): void => {
            if (!isCheckpoint(event)) {
                if (event.type === 'text_delta') {
                    setLive((prev) => prev + event.delta);
                }
                return;
            }
            switch (event.type) {
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
            if (!text || busy) {
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
            const controller = new AbortController();
            stopping.current = controller;

            void (async () => {
                try {
                    const outcome = await Engine.run(engine, text, onEvent, controller.signal);
                    push('agent', outcome.text);
                    setUsage(outcome.result.usage);
                    setAgent(outcome.result.agent);
                    if (outcome.result.stopReason === 'aborted') {
                        push('note', 'stopped');
                    }
                } catch (err) {
                    push('error', err instanceof Error ? err.message : String(err));
                } finally {
                    setBusy(false);
                    setLive('');
                    setTool(undefined);
                    stopping.current = undefined;
                }
            })();
        },
        [busy, engine, exit, onEvent, push, stdout],
    );

    // Escape stops the turn; ctrl-c leaves. They are different things, and a
    // run that is asked to stop still writes its state, so the session survives
    // either one.
    useInput((_input, keys) => {
        if (keys.escape && stopping.current) {
            stopping.current.abort();
        }
        if (keys.ctrl && _input === 'c') {
            stopping.current?.abort();
            exit();
        }
    });

    return (
        <Box flexDirection="column">
            <Header engine={engine} agent={agent} readOnly={options.readOnly} />

            {/* `Static` prints once and never repaints, so finished turns
                scroll away into real terminal scrollback instead of being
                redrawn on every keystroke. */}
            <Static items={lines}>{(line) => <Row key={line.key} line={line} />}</Static>

            {live ? (
                <Box marginTop={0} flexDirection="row">
                    <Text dimColor> </Text>
                    <Text>{live}</Text>
                </Box>
            ) : null}

            <Footer busy={busy} tool={tool} usage={usage} />

            {busy ? null : (
                <Box>
                    <Text color="cyan">› </Text>
                    <TextInput placeholder="Ask something… (/exit to leave)" onSubmit={submit} />
                </Box>
            )}
        </Box>
    );
}

function Header({
    engine,
    agent,
    readOnly,
}: {
    engine: Engine.Engine;
    agent: string;
    readOnly: boolean;
}): React.ReactElement {
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold>{engine.name}</Text>
                <Text dimColor> {engine.session.id}</Text>
                <Text color="cyan"> {agent}</Text>
                {readOnly ? <Text color="yellow"> read-only</Text> : null}
            </Box>
            <Text dimColor>{display(engine.workspace)}</Text>
        </Box>
    );
}

function Footer({
    busy,
    tool,
    usage,
}: {
    busy: boolean;
    tool?: string;
    usage: TokenUsage;
}): React.ReactElement {
    return (
        <Box marginTop={1}>
            {busy ? <Text color="yellow">{tool ? `running ${tool}` : 'thinking'}… </Text> : null}
            <Text dimColor>
                {format(usage.inputTokens)} in · {format(usage.outputTokens)} out
                {busy ? '  esc to stop' : ''}
            </Text>
        </Box>
    );
}

function durationOf(ms?: number): string | undefined {
    return ms === undefined ? undefined : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------

export async function start(engine: Engine.Engine, options: AppOptions): Promise<void> {
    const { render } = await import('ink');
    // Ctrl-C is handled above so an in-flight turn can be aborted and recorded
    // rather than the process simply vanishing mid-write.
    const instance = render(<App engine={engine} options={options} />, { exitOnCtrlC: false });
    await instance.waitUntilExit();
}
