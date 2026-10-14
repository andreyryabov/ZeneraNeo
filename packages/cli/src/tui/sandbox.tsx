// ---------------------------------------------------------------------------
// zen sandbox top
//
// The resource report, redrawn on a timer. Nothing here measures anything or
// decides what a figure means: resources.ts samples and lays out, and this
// file only colours the lines it is handed and owns the keys.
//
// The frame is cut to the terminal's height before Ink sees it — a frame
// taller than the screen scrolls its own top away and every repaint leaves a
// copy of it behind (see tui/app.tsx).
// ---------------------------------------------------------------------------

import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';

import {
    layout,
    SORTS,
    type Line,
    type ResourceSampler,
    type ResourceView,
    type Sort,
    type Tone,
} from '../resources.ts';
import { resolveTheme, type Theme } from './theme.ts';

export interface WatchOptions {
    sampler: ResourceSampler;
    intervalMs: number;
    explain: boolean;
    theme?: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function styleOf(tone: Tone | undefined, theme: Theme): { color?: string; bold?: boolean } {
    switch (tone) {
        case 'strong':
            return { bold: true };
        case 'heading':
            return { bold: true, color: theme.accent };
        case 'dim':
            return { color: theme.chrome.color };
        case 'good':
            return { color: theme.code.color };
        case 'warn':
            return { color: theme.warn };
        case 'bad':
            return { color: theme.line.error.color };
        case 'accent':
            return { color: theme.accent };
        default:
            return {};
    }
}

function Painted({ line, theme }: { line: Line; theme: Theme }): React.JSX.Element {
    if (line.length === 0) {
        return <Text> </Text>;
    }
    return (
        <Text wrap="truncate-end">
            {line.map((span, i) => (
                <Text key={i} {...styleOf(span.tone, theme)}>
                    {span.text}
                </Text>
            ))}
        </Text>
    );
}

interface TopProps extends WatchOptions {
    palette: Theme;
}

function Top({ sampler, intervalMs, explain: start, palette }: TopProps): React.JSX.Element {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    useEffect(() => {
        const resized = (): void =>
            setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        stdout.on('resize', resized);
        return () => {
            stdout.off('resize', resized);
        };
    }, [stdout]);

    const [view, setView] = useState<ResourceView>();
    const [failure, setFailure] = useState<string>();
    const [explain, setExplain] = useState(start);
    const [sort, setSort] = useState<Sort>('memory');
    const [paused, setPaused] = useState(false);

    useEffect(() => {
        if (paused) {
            return;
        }
        let stopped = false;
        let timer: NodeJS.Timeout | undefined;
        const tick = async (): Promise<void> => {
            try {
                const next = await sampler.next();
                if (!stopped) {
                    setView(next);
                    setFailure(undefined);
                }
            } catch (err) {
                if (!stopped) {
                    setFailure(message(err));
                }
            }
            if (!stopped) {
                timer = setTimeout(() => void tick(), intervalMs);
            }
        };
        void tick();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [sampler, intervalMs, paused]);

    useInput((input, key) => {
        // A pasted or piped key can arrive with a newline behind it.
        const k = input.trim()[0];
        if (k === 'q' || key.escape) {
            exit();
        } else if (k === 'e' || k === '?') {
            setExplain((on) => !on);
        } else if (k === 's') {
            setSort((now) => SORTS[(SORTS.indexOf(now) + 1) % SORTS.length]!);
        } else if (k === 'p' || input === ' ') {
            setPaused((on) => !on);
        }
    });

    // One row for the keys, one spare so the frame never reaches the bottom.
    const rows = Math.max(4, size.rows - 2);
    const lines: Line[] = view
        ? layout(view, {
              width: size.columns - 1,
              rows: failure ? rows - 1 : rows,
              explain,
              sort,
              live: intervalMs / 1000,
          })
        : [[{ text: 'asking podman…', tone: 'dim' }]];

    const keys = [
        `e notes ${explain ? 'off' : 'on'}`,
        `s sort: ${sort}`,
        paused ? 'p resume' : 'p pause',
        'q quit',
    ].join(' · ');

    return (
        <Box flexDirection="column">
            {lines.map((line, i) => (
                <Painted key={i} line={line} theme={palette} />
            ))}
            {failure ? (
                <Text wrap="truncate-end" color={palette.line.error.color}>
                    {`  ✗ ${failure}`}
                </Text>
            ) : null}
            <Text wrap="truncate-end" color={palette.chrome.color}>
                {paused ? `paused · ${keys}` : keys}
            </Text>
        </Box>
    );
}

/** Runs the live screen until the person leaves it. */
export async function watch(options: WatchOptions): Promise<void> {
    // Asked before Ink takes the terminal, as tui/app.tsx does.
    const palette = await resolveTheme(options.theme);
    const instance = render(<Top {...options} palette={palette} />);
    await instance.waitUntilExit();
}
