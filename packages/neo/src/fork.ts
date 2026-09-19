import type { JsonSchema } from './types.ts';

// ---------------------------------------------------------------------------
// Teaching the model to fan out and to delegate
//
// The tool schema says what the arguments are; none of it says what survives a
// join, that a branch cannot be corrected once it starts, or which `context`
// mode fits which shape of work. That is policy, it is the same for every
// agent, and it belongs in the system prompt.
//
// It is not here. It is the project's own house rules, in
// `agents/fork-instructions.md` under `requires: [fork]`, so the one document
// is the only place it is written and a project can say something different.
// An agent with the fork tool and no such file gets the schema and nothing
// else - `zen check` refuses it, the runtime does not invent a replacement.
// ---------------------------------------------------------------------------

/**
 * Mechanics only — the policy is in the system prompt of every agent that can
 * call this, so repeating it here would cost tokens in two places at once.
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
