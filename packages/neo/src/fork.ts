import type { JsonSchema } from './types.ts';

// ---------------------------------------------------------------------------
// Teaching the model to fan out and to delegate
//
// The tool schema says what the arguments are; none of it says what survives a
// join, that a branch cannot be corrected once it starts, or which `context`
// mode fits which shape of work. That is policy, it is the same for every
// agent, and it belongs in the system prompt — the only place it can be stated
// once per run instead of once per call.
//
// It goes in through `composePrompt`'s `derived` array, so it sits in the
// cacheable prefix and is recorded on the `system_prompt` node like every other
// part of what the model read. The text is gated on the agent holding a fork
// binding *and* being below the depth cap — the same condition that decides
// whether the tool is offered at all, because a rule about a tool the model
// does not have is a rule it can only be confused by.
// ---------------------------------------------------------------------------

/**
 * Deliberately not a function of the agent list or the branch cap: both are
 * already on the tool schema, where the provider enforces them during decoding,
 * and naming them twice buys nothing but two places to drift.
 */
export function forkInstructions(): string {
    return FORKING;
}

const FORKING = `Forking runs work in separate conversations and brings back only the answers.

A branch is a run of its own: its own conversation, its own tool calls, its own
reasoning. None of that returns. What returns is each branch's final answer, as
the result of your \`fork\` call — so whatever you will need afterwards has to be
*in* that answer, and the branch only knows it if your instructions say so. Work
whose value is the trace rather than the conclusion should not be forked at all.

The instructions you write are the entire assignment. A branch cannot ask you a
question, cannot see what its siblings are doing, and cannot be corrected once
it starts. Say what it must do, what it must leave alone, and the exact shape of
what it must hand back.

**One branch is delegation**: the work happens elsewhere and you get the
conclusion instead of the transcript. Use it when another agent is better suited
to the job, or when the job would otherwise fill this conversation with material
you have no use for afterwards — a long file survey, a noisy build loop, an
exploration down a path that may go nowhere. **Several branches are a fan-out**:
independent parts of one task, worked at the same time, merged by you. It is the
same call either way; the number of branches is the only difference.

Do not fork a sequence. Branches run at once and can exchange nothing, so a step
that needs the step before it has to stay in this conversation.

\`context\` decides what each branch starts from, and you choose it per call:
- \`inherit\` — everything said here so far. For work that only makes sense
  against the case as it stands.
- \`compact\` — the same, without the tool traffic: what was decided, not how it
  was found out. The usual choice for a wide fan-out.
- \`none\` — nothing but its own instructions. The cheapest, and the honest one
  when the assignment is self-contained.

A branch can fail, or answer badly. Its row says which, and what the final
answer is remains your decision, not the join's.`;

/**
 * Mechanics only — the policy above is in the system prompt of every agent that
 * can call this, so repeating it here would cost tokens in two places at once.
 */
export const FORK_DESCRIPTION = [
    'Run work in separate conversations and get back only the answers.',
    '',
    'Each branch needs a unique name and complete, self-contained instructions: it runs on ' +
        'its own, cannot ask questions, and cannot see the other branches. One branch delegates ' +
        'a job; several run in parallel and rejoin together.',
    '',
    'The branches\u2019 answers come back as the result of this call, and what the final answer ' +
        'is remains yours to decide.',
].join('\n');

/**
 * Derived from the registry rather than a constant, because the one thing a
 * weak model reliably gets wrong here is inventing an agent name. An `enum` of
 * the agents that actually exist is a constraint the provider enforces during
 * decoding, which no amount of prose in the description can match.
 *
 * `minItems`/`maxItems` are stated too, but they are advisory — most providers
 * ignore them under strict decoding — so `parseForkArgs` and `forkProblem`
 * still check both, and their messages are written to be read by the model.
 */
export function forkParameters(agents: string[], self: string, maxBranches?: number): JsonSchema {
    const max = maxBranches ?? 0;
    // When the author's list excludes the current agent there is no sane
    // default, so the model has to name one.
    const selfAllowed = agents.includes(self);
    return {
        type: 'object',
        properties: {
            branches: {
                type: 'array',
                minItems: 1,
                ...(max >= 1 ? { maxItems: max } : {}),
                description:
                    `One branch per job that can be carried out on its own${
                        max >= 1 ? `, at most ${max}` : ''
                    }. ` +
                    'One delegates that job elsewhere; several work independent parts of the ' +
                    'task at the same time.',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Short, unique label for this branch, e.g. "eu-tariffs".',
                        },
                        instructions: {
                            type: 'string',
                            description:
                                'The complete assignment for this branch. It runs in a separate ' +
                                'conversation and cannot ask questions, so state everything it ' +
                                'needs and exactly what it must return.',
                        },
                        agent: {
                            type: 'string',
                            enum: agents,
                            description:
                                'Which agent runs this branch. Must be one of: ' +
                                agents.join(', ') +
                                (selfAllowed ? `. Omit to use "${self}".` : '.'),
                        },
                    },
                    required: selfAllowed
                        ? ['name', 'instructions']
                        : ['name', 'instructions', 'agent'],
                    additionalProperties: false,
                },
            },
            context: {
                type: 'string',
                enum: ['inherit', 'compact', 'none'],
                description:
                    'How much of this conversation each branch starts with: "inherit" (all of ' +
                    'it, the default), "compact" (messages only, no tool traffic), "none" ' +
                    '(nothing but its own instructions).',
            },
        },
        required: ['branches'],
        additionalProperties: false,
    };
}
