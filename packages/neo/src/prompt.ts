import { readFileSync } from 'node:fs';
import type { Payload } from './payload.ts';
import type { RunSpec } from './state.ts';

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/**
 * A block of prompt text, optionally tagged with where it came from.
 *
 * `path` is metadata, not an instruction to go and read something: the text is
 * already here. It exists so the trajectory can answer "which file do I edit to
 * change this?" — the one question a rendered prompt cannot answer by itself.
 */
export interface PromptText {
    text: string;
    /** the editable document this text came from, if any */
    path?: string;
    /** opt-in wrapper tag, e.g. `intent` → `<intent>…</intent>` */
    section?: string;
}

/**
 * One contributor to a system prompt: literal text, text computed from the run
 * context, or a tagged block (usually a file loaded by `promptFile`).
 *
 * The function form gets `RunSpec`, not `AgentState`, on purpose. The system
 * prompt is the provider's cache prefix; one that varied with mutable state
 * would invalidate that prefix every turn and append a node every turn. A
 * `RunSpec` is fixed at `createState`, so `forkDepth` and the output contract
 * are available while "prompt that grows with the conversation" is not
 * expressible — per-turn content belongs at the tail, as input and results.
 */
export type PromptPart<TCtx = unknown> =
    string | ((ctx: TCtx, spec: RunSpec) => string) | PromptText;

export type Instructions<TCtx = unknown> =
    string | ((ctx: TCtx, spec: RunSpec) => string) | PromptPart<TCtx>[];

/**
 * Loads a prompt file and remembers where it came from.
 *
 * Read once, at agent construction, and synchronously: this is setup, the same
 * moment a module is imported or a config parsed, so a bad path fails at
 * startup with a stack trace pointing at the agent — not on the first LLM call
 * of a run in production. It also keeps the prompt genuinely constant for the
 * life of the agent, which is what the provider's cache assumes anyway.
 *
 * A prompt that must change without a restart is a different feature: rebuild
 * the agent, or use the function form.
 */
export function promptFile(path: string, section?: string): PromptText {
    const text = readFileSync(path, 'utf8');
    return section === undefined ? { text, path } : { text, path, section };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** A document that fed a prompt, with the exact bytes it contributed. */
export interface PromptSource {
    path: string;
    content: Payload;
}

export interface ComposedPrompt {
    /** exactly what the provider will receive */
    text: string;
    /** the editable contributors, in the order they were rendered */
    sources: PromptSource[];
}

const SEPARATOR = '\n\n';

/**
 * Markers are opt-in because they are tokens the model reads: a wrapper that
 * "does not influence the content" does not exist for an LLM.
 */
function wrap(part: PromptText): string {
    return part.section ? `<${part.section}>\n${part.text}\n</${part.section}>` : part.text;
}

/**
 * Renders the authored parts, then the kernel's derived text, into one string —
 * and reports which documents went into it.
 *
 * `derived` (the skill index, the `final_output` instruction) is appended last
 * so the volatile tail never invalidates the cacheable prefix, and it is *not*
 * reported as a source: neither is a file anyone edits.
 *
 * The only async here is `put`: the composer does no I/O of its own, because by
 * this point every part already carries its text.
 */
export async function composePrompt<TCtx>(
    instructions: Instructions<TCtx> | undefined,
    ctx: TCtx,
    spec: RunSpec,
    put: (text: string) => Promise<Payload>,
    derived: string[] = [],
): Promise<ComposedPrompt> {
    const parts: PromptPart<TCtx>[] =
        instructions === undefined
            ? []
            : Array.isArray(instructions)
              ? instructions
              : [instructions];

    const chunks: string[] = [];
    const sources: PromptSource[] = [];

    for (const part of parts) {
        if (typeof part === 'string') {
            chunks.push(part);
        } else if (typeof part === 'function') {
            chunks.push(part(ctx, spec));
        } else {
            if (part.path && part.text) {
                sources.push({ path: part.path, content: await put(part.text) });
            }
            chunks.push(wrap(part));
        }
    }

    chunks.push(...derived);
    return { text: chunks.filter(Boolean).join(SEPARATOR), sources };
}
