import {
    MEMORY_COMMIT_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_LOAD_TOOL,
    MEMORY_SEARCH_TOOL,
} from '../types.ts';
import { RECOLLECTION_TAG } from './render.ts';
import { canForget, canWrite, type MemoryNode, type ResolvedMemoryBinding } from './types.ts';

// ---------------------------------------------------------------------------
// Teaching the model to read and write memory
//
// The tool schemas say what the arguments are; none of them says when a thing
// is worth remembering, or that a recollection is a subgraph rather than a
// ranked list. That is policy, it is the same for every agent, and it belongs
// in the system prompt — which is also the only place it can be stated once
// per run instead of once per call.
//
// Both halves go in through `composePrompt`'s `derived` array, so they sit in
// the cacheable prefix and are recorded in the `system_prompt` node like every
// other part of what the model read.
//
// The text is gated on the binding, not on the project: an agent that cannot
// write is never told how to commit. A rule it cannot act on is a rule it can
// only be confused by, and an unusable tool name in the prompt invites a call
// that will be refused.
// ---------------------------------------------------------------------------

export const PREFERENCES_TAG = 'memory-preferences';

/**
 * Deliberately not a function of `sees`: those labels come from the run's
 * context, and naming them here would rewrite the prompt whenever the context
 * moved. It also tells an agent the shape of a slice it was not given.
 */
export function memoryInstructions(binding: ResolvedMemoryBinding): string {
    const parts = [READING];
    if (canWrite(binding)) {
        parts.push(WRITING);
    }
    if (canForget(binding)) {
        parts.push(FORGETTING);
    }
    return parts.join('\n\n');
}

const READING = `Memory is a graph shared with other agents, and it outlives this run.

A <${RECOLLECTION_TAG}> block is a subgraph, not a ranked list — the links are
as much of the answer as the nodes. It has two halves. The first is a mermaid
\`graph LR\` whose node ids are memory ids and whose labels are only the kind:
\`(fact)\` is an ordinary note, \`[/file/]\` is an artifact kept under /memory
that you can open or run. Arrows carry the relation between two ids.

Below the blank line is one row per node: id, score, kind, summary. A score of
\`--\` means the node was not itself a match — it is there because it links to
one. Summaries are clipped, and a file row also shows its path, its size and
how often it has been read. Copy an id into \`${MEMORY_LOAD_TOOL}\` to read a
node whole; \`${MEMORY_SEARCH_TOOL}\` finds ids, it does not return contents.

You see part of the graph, not all of it. Finding nothing means nothing you can
see, not that it never happened.`;

const WRITING = `Commit when a run produced something a later run would otherwise have to work
out again: a script that ran, an interface that behaved differently from its
documentation, a call sequence that turned out to be necessary. Commit it in
one \`${MEMORY_COMMIT_TOOL}\` call — the artifact and what explains it are one
memory, and splitting them leaves a later run holding a script with no idea why
it exists.

Do not commit the request restated, progress notes, anything you have not
verified, or anything a search already returned.

Never edit a memory to correct it. Add the new one and link it to the old with
SUPERSEDES; the wrong answer is evidence too, and the link is what hides it
from later recalls without destroying the history.

Commit a preference only when the user's own words generalise — "always", "from
now on", "I prefer", "never". A single request being fulfilled is not a
standing instruction.`;

const FORGETTING = `Forget only what is wrong and has no successor. A superseded memory is already
hidden from recall and should stay for the history, so \`${MEMORY_FORGET_TOOL}\`
is for what should never have been written, not for what has been replaced.`;

/**
 * The id on each line is what makes a preference revisable rather than merely
 * readable: without it the model can read the instruction but cannot name the
 * thing it would supersede.
 */
export function renderPreferences(nodes: readonly MemoryNode[]): string {
    if (!nodes.length) {
        return '';
    }
    const lines = nodes.map((n) => `- ${oneLine(n.text)} [${n.id}]`);
    return [
        `<${PREFERENCES_TAG}>`,
        "Standing instructions from earlier runs. They apply unless this run's",
        'request contradicts them; to change one, commit the replacement and link',
        'it to the id here with SUPERSEDES.',
        ...lines,
        `</${PREFERENCES_TAG}>`,
    ].join('\n');
}

/** Never clipped: half an instruction is a different instruction. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}
