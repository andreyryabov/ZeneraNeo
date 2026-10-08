import type { AgentEvent } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentEventLog, copilotEventLog, heading, type EventLine } from '../src/eventlog.ts';

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zen-eventlog-'));
    file = join(dir, 'sub', 'events.jsonl');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const lines = (): EventLine[] =>
    readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as EventLine);

const ev = (e: object): AgentEvent => ({ runId: 'r', agent: 'a', ...e }) as AgentEvent;
const cp = (e: object): AgentEvent => ev({ state: {}, ...e });

describe('event log', () => {
    it('folds a zen run into model calls, tools and what was said', () => {
        const record = agentEventLog(file);
        record(cp({ type: 'before_llm_call' }));
        record(ev({ type: 'thinking_delta', delta: '**Reading the task**\n\nThe user wants' }));
        record(
            ev({ type: 'thinking_delta', delta: ' alarms.\n\n**Searching for alarms**\n\nI will' }),
        );
        record(ev({ type: 'text_delta', delta: 'Looking ' }));
        record(ev({ type: 'text_delta', delta: 'it up.' }));
        record(
            cp({
                type: 'after_llm_call',
                node: {
                    model: 'gemini-a',
                    usage: {
                        inputTokens: 100,
                        cachedInputTokens: 40,
                        outputTokens: 9,
                        reasoningTokens: 2,
                    },
                },
            }),
        );
        record(
            cp({
                type: 'before_tool_call',
                call: { callId: 'c1', name: 'search', args: { preview: 'alarms\nDFW' } },
            }),
        );
        record(
            cp({
                type: 'after_tool_call',
                node: { callId: 'c1', name: 'search', isError: true, durationMs: 30 },
            }),
        );
        expect(lines().map(({ t: _, ...l }) => l)).toEqual([
            {
                type: 'llm',
                model: 'gemini-a',
                in: 100,
                cached: 40,
                out: 9,
                reasoning: 2,
                ms: expect.any(Number),
            },
            { type: 'think', text: 'Searching for alarms' },
            { type: 'say', text: 'Looking it up.' },
            { type: 'tool', phase: 'start', id: 'c1', name: 'search', subject: 'alarms DFW' },
            { type: 'tool', phase: 'end', id: 'c1', name: 'search', ok: false, ms: 30 },
        ]);
    });

    it('heads a thought by its last bold heading, else its first sentence', () => {
        expect(heading('**A**\n\nfirst.\n\n**B step**\n\nsecond.')).toBe('B step');
        expect(heading('Need the rules. Then the groups.')).toBe('Need the rules.');
        expect(heading('no stop at all')).toBe('no stop at all');
    });

    it('folds copilot events and spans into the same lines', () => {
        const record = copilotEventLog(file);
        record.event({ type: 'assistant.message', data: { content: 'Reading the graph.' } });
        record.event({
            type: 'tool.execution_start',
            data: {
                toolCallId: 'k',
                toolName: 'bash',
                arguments: { command: 'zen inspect graph' },
            },
        });
        record.event({ type: 'tool.execution_complete', data: { toolCallId: 'k', success: true } });
        record.event({ type: 'session.tools_updated', data: { model: 'm' } });
        record.call({
            model: 'claude',
            usage: {
                inputTokens: 50,
                cachedInputTokens: 10,
                outputTokens: 5,
                reasoningTokens: 0,
            },
            durationMs: 1200,
        });
        expect(
            lines().map((l) => [l.type, 'phase' in l ? l.phase : '', 'name' in l ? l.name : '']),
        ).toEqual([
            ['say', '', ''],
            ['tool', 'start', 'bash'],
            ['tool', 'end', 'bash'],
            ['llm', '', ''],
        ]);
        expect(lines()[1]).toMatchObject({ subject: 'zen inspect graph' });
        expect(lines()[3]).toMatchObject({ model: 'claude', in: 50, cached: 10, ms: 1200 });
    });
});
