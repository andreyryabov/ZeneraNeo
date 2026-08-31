import type { Message, Model, ModelRequest, ModelResponse } from '@zenera/core';
import type { Box } from './box.ts';
import { echoIssues, probesFor } from './probe.ts';
import { instruction, retry, SYSTEM } from './prompt.ts';
import type { Operation } from './spec.ts';
import { describeIssues, issues, type Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// Writing the generator
//
// A bounded loop the host drives, rather than an agent turned loose with the
// file and shell tools. The difference is termination: this asks, runs,
// judges, and either has a working file or has spent a known number of turns.
// An agent editing the file itself would be more autonomous and would also have
// no natural stopping point, which is the wrong trade for something that
// happens on the critical path of an HTTP request.
//
// The judgement is deliberately harsher than the schema. A body can validate
// and still be wrong — see the echo rule in probe.ts — and a generator that
// only ever satisfies the validator is one that returns constants.
// ---------------------------------------------------------------------------

export interface BuildOptions {
    model: Model;
    box: Box;
    checks: Checks;
    /** how many times the model may be asked before giving up */
    attempts?: number;
    onAttempt?: (attempt: number, diagnostics: readonly string[]) => void;
    signal?: AbortSignal;
}

export interface Built {
    source: string;
    attempts: number;
}

export class BuildFailed extends Error {
    readonly operation: Operation;
    readonly diagnostics: readonly string[];

    constructor(operation: Operation, diagnostics: readonly string[]) {
        super(
            `could not write a generator for ${operation.method.toUpperCase()} ${operation.path}`,
        );
        this.name = 'BuildFailed';
        this.operation = operation;
        this.diagnostics = diagnostics;
    }
}

/**
 * Why something failed, in one line, including the part that is usually hidden.
 *
 * `fetch failed` is undici's word for a dozen different problems — a DNS
 * miss, a refused connection, a TLS error, a timeout — and which one it was is
 * only ever in `cause`. Reporting the top-level message alone turns every
 * network fault into the same useless sentence.
 */
export function reason(err: unknown): string {
    if (err instanceof BuildFailed && err.diagnostics.length > 0) {
        return `${err.message}: ${err.diagnostics.join(' ')}`;
    }
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let at: unknown = err;

    while (at instanceof Error && !seen.has(at)) {
        seen.add(at);
        const e = at as Error & { code?: string; status?: number; statusCode?: number };
        const head = [e.status ?? e.statusCode, e.code].filter(Boolean).join(' ');
        const line = `${head} ${e.message.split('\n')[0].trim()}`.trim();
        if (line && !parts.includes(line)) {
            parts.push(line);
        }
        at = e.cause;
    }
    return parts.join(' — ') || String(err);
}

export async function build(operation: Operation, opts: BuildOptions): Promise<Built> {
    const limit = Math.max(1, opts.attempts ?? 3);
    const probes = probesFor(operation);
    const response = opts.checks.for(operation).response;
    const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: instruction(operation) }] },
    ];
    let last: string[] = [];

    for (let attempt = 1; attempt <= limit; attempt++) {
        const answer = await ask(opts, {
            system: SYSTEM,
            messages,
            tools: [],
            signal: opts.signal,
        });
        const source = unfence(answer.text);
        if (!source.trim()) {
            last = ['the answer was empty'];
        } else {
            await opts.box.write(operation.key, source);
            last = await judge(operation, probes, response, opts.box);
            if (last.length === 0) {
                return { source, attempts: attempt };
            }
        }

        opts.onAttempt?.(attempt, last);
        messages.push(
            { role: 'assistant', content: source },
            { role: 'user', content: [{ type: 'text', text: retry(last) }] },
        );
    }

    throw new BuildFailed(operation, last);
}

/**
 * Streamed when the adapter can, and every delta is dropped: nothing here
 * renders progress. It is the *socket* that needs them.
 *
 * A generator is a few hundred lines, and a model asked for one in a single
 * non-streaming call sends nothing at all while it thinks. Something upstream
 * closes a connection that has been idle for a minute, and the whole attempt
 * dies with `UND_ERR_SOCKET other side closed` at ~61 s — not a timeout anyone
 * here set, and not the SDK's, which is ten minutes. Tokens on the wire keep
 * it open.
 */
function ask(opts: BuildOptions, request: ModelRequest): Promise<ModelResponse> {
    return opts.model.stream ? opts.model.stream(request, discard) : opts.model.generate(request);
}

const discard = (): void => {};

/** Every probe, run and checked. Empty means the generator is good. */
async function judge(
    operation: Operation,
    probes: readonly ReturnType<typeof probesFor>[number][],
    response: ReturnType<Checks['for']>['response'],
    box: Box,
): Promise<string[]> {
    const out: string[] = [];

    for (const probe of probes) {
        const outcome = await box.run(operation.key, probe);
        const called = `input ${JSON.stringify({ pathParams: probe.pathParams, query: probe.query })}`;

        if (!outcome.ok) {
            out.push(`- ${called}: the file ${outcome.fault}.`);
            if (outcome.stderr) {
                out.push(`  stderr: ${tail(outcome.stderr)}`);
            }
            // A file that will not run says nothing about the next probe.
            break;
        }
        if (response && !response(outcome.value)) {
            out.push(
                `- ${called}: the output does not match the response schema — ${describeIssues(issues('', response.errors))}.`,
            );
        }
        const echo = echoIssues(probe, outcome.value, operation.success.schema);
        if (echo.length > 0) {
            out.push(`- ${called}: ${describeIssues(echo)}.`);
        }
    }
    return out;
}

/**
 * Models fence code even when told not to, and a stray ```python line is a
 * syntax error rather than a bad answer — not worth a round trip.
 */
export function unfence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) {
        return trimmed;
    }
    const body = trimmed.slice(trimmed.indexOf('\n') + 1);
    const close = body.lastIndexOf('```');
    return (close === -1 ? body : body.slice(0, close)).trimEnd();
}

const tail = (s: string): string => s.trim().split('\n').slice(-6).join('\n  ');
