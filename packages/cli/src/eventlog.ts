import { isCheckpoint, type AgentEvent } from '@zenera/neo';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The event log
//
// One JSON line per thing worth seeing while an agent is still at work: a model
// call that finished, a tool going out and coming back, what the agent said.
// `zen run --events` and `zen meta run --events` write the same lines, so
// whatever watches a run reads one format whichever agent did the work. Only
// appended to: whoever owns the file clears it before the step that writes it.
// ---------------------------------------------------------------------------

export type EventBody =
    | {
          type: 'llm';
          model: string;
          in: number;
          cached: number;
          out: number;
          reasoning: number;
          ms?: number;
      }
    | { type: 'tool'; phase: 'start'; id: string; name: string; subject: string }
    | { type: 'tool'; phase: 'end'; id: string; name: string; ok: boolean; ms?: number }
    | { type: 'say'; text: string };

export type EventLine = EventBody & { t: string };

const MAX_TEXT = 400;

const clip = (text: string): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};

/** A line that cannot be written is dropped: watching a run must not break it. */
export function eventLog(path: string): (body: EventBody) => void {
    mkdirSync(dirname(path), { recursive: true });
    return (body) => {
        try {
            appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), ...body })}\n`);
        } catch {
            // See above.
        }
    };
}

/** For `zen run`: the runtime's own events, folded to the shared lines. */
export function agentEventLog(path: string): (event: AgentEvent) => void {
    const write = eventLog(path);
    // Keyed by branch, since a fork has several model calls open at once.
    const began = new Map<string, number>();
    const said = new Map<string, string>();
    return (event) => {
        const key = event.branch?.name ?? '';
        if (!isCheckpoint(event)) {
            if (event.type === 'text_delta') {
                said.set(key, (said.get(key) ?? '') + event.delta);
            }
            return;
        }
        switch (event.type) {
            case 'before_llm_call':
                began.set(key, Date.now());
                said.delete(key);
                break;
            case 'after_llm_call': {
                const u = event.node.usage;
                const at = began.get(key);
                write({
                    type: 'llm',
                    model: event.node.model,
                    in: u.inputTokens,
                    cached: u.cachedInputTokens ?? 0,
                    out: u.outputTokens,
                    reasoning: u.reasoningTokens ?? 0,
                    ...(at !== undefined ? { ms: Date.now() - at } : {}),
                });
                const text = said.get(key)?.trim();
                said.delete(key);
                if (text) {
                    write({ type: 'say', text: clip(text) });
                }
                break;
            }
            case 'before_tool_call':
                write({
                    type: 'tool',
                    phase: 'start',
                    id: event.call.callId,
                    name: event.call.name,
                    subject: clip(event.call.args.preview ?? ''),
                });
                break;
            case 'after_tool_call':
                write({
                    type: 'tool',
                    phase: 'end',
                    id: event.node.callId,
                    name: event.node.name,
                    ok: !event.node.isError,
                    ...(event.node.durationMs !== undefined ? { ms: event.node.durationMs } : {}),
                });
                break;
            default:
                break;
        }
    };
}

/** One line of copilot's JSONL, as much of it as is read here. */
export interface CopilotEvent {
    type: string;
    data?: Record<string, unknown>;
}

/** A model call read off copilot's span file - see `meta/tokens.ts`. */
export interface CopilotCall {
    model: string;
    usage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
    };
    durationMs: number;
}

/**
 * For `zen meta run`: copilot's events and spans, folded to the same lines.
 * Its JSONL has no token counts, so `llm` lines come from the spans instead,
 * about a second after each call.
 */
export function copilotEventLog(path: string): {
    event: (event: CopilotEvent) => void;
    call: (call: CopilotCall) => void;
} {
    const write = eventLog(path);
    // Its completion names no tool, so the start is remembered by call id.
    const began = new Map<string, { at: number; name: string }>();
    return {
        event: (event) => {
            const data = event.data ?? {};
            const id = String(data.toolCallId ?? '');
            switch (event.type) {
                case 'assistant.message': {
                    const text = String(data.content ?? '').trim();
                    if (text) {
                        write({ type: 'say', text: clip(text) });
                    }
                    break;
                }
                case 'tool.execution_start': {
                    const args = (data.arguments ?? {}) as Record<string, unknown>;
                    const subject =
                        args.command ?? args.description ?? args.path ?? args.skill ?? '';
                    const name = String(data.toolName ?? 'tool');
                    began.set(id, { at: Date.now(), name });
                    write({
                        type: 'tool',
                        phase: 'start',
                        id,
                        name,
                        subject: clip(
                            typeof subject === 'string' ? subject : JSON.stringify(subject),
                        ),
                    });
                    break;
                }
                case 'tool.execution_complete': {
                    const start = began.get(id);
                    began.delete(id);
                    write({
                        type: 'tool',
                        phase: 'end',
                        id,
                        name: start?.name ?? String(data.toolName ?? 'tool'),
                        ok: data.success !== false,
                        ...(start ? { ms: Date.now() - start.at } : {}),
                    });
                    break;
                }
                default:
                    break;
            }
        },
        call: (call) =>
            write({
                type: 'llm',
                model: call.model,
                in: call.usage.inputTokens,
                cached: call.usage.cachedInputTokens,
                out: call.usage.outputTokens,
                reasoning: call.usage.reasoningTokens,
                ms: call.durationMs,
            }),
    };
}
