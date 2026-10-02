import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyTree, MEMORY_RULES, TEMPLATES } from './host.ts';

// ---------------------------------------------------------------------------
// Telling the editor which instructions are not for it
//
// The project's house rules are `agents/instructions.md`, deliberately not
// `AGENTS.md`: every coding assistant now reads that name out of an open
// folder and feeds it to itself as always-on instructions, and `zen open`
// opens exactly this directory. A name nobody else claims means the two are
// never confused, and `chat.useAgentsMdFile` no longer has to be switched off
// to keep them apart.
//
// They sit under `agents/` because there is rarely only one of them. Anything
// named `agents/<topic>-instructions.md` is read too, in filename order, so a
// subject that is true for every agent but is about one capability — memory,
// say — gets its own document instead of another section in a file that keeps
// growing.
//
// `chat.useNestedAgentsMdFiles` is still written. It is already false by
// default, but it is opt-in globally, and this is a directory the agent itself
// writes into — someone who turned it on would otherwise have the editor pick
// up whatever `AGENTS.md` a run happened to leave behind. It is a *restricted*
// setting, so it applies only in a trusted workspace; that is the right way
// round, since an untrusted folder is not one to run agents in either.
//
// `agents/instructions.md` addresses the *project's* agents. The editor's
// assistant still needs a brief of its own, and what it needs to know is how
// this kind of project is put together — the file formats, how a prompt is
// written, when to add a skill rather than an agent. That is what the
// `.github/` tree is: the standing brief, plus the prompt files and skills the
// editor picks up from the same place.
// ---------------------------------------------------------------------------

/** The same bytes, kept in the `zen-memory` skill to restore or diff against. */
const MEMORY_REFERENCE = join(
    '.github',
    'skills',
    'zen-memory',
    'references',
    'memory-instructions.md',
);

/**
 * Writes the editor's files under `dir`, replacing what is there. They are
 * ours: they say how the editor is to treat a directory the agents write into,
 * and they describe the file formats of the version of `zen` in hand, so the
 * current answer is the only one worth having and a stale one is worse than
 * none. Returns the relative paths written.
 */
export function editorFiles(dir: string): string[] {
    const written = copyTree(join(TEMPLATES, 'editor'), dir, '', {});

    // The one file that belongs to both trees. It is a project file first —
    // house rules reaching every agent that can see the graph — and it is
    // written once and edited from then on, like every other project file. But
    // a project whose copy drifted, or that deleted it and turned memory back
    // on later, needs somewhere to get the current text from, and the editor
    // tree is replaced on every `init` and `open`. Copying the same bytes into
    // the skill's references is what makes `diff` between the two mean
    // something, and what stops a second copy of these rules existing in the
    // repository to fall out of step with the first.
    const reference = join(dir, MEMORY_REFERENCE);
    mkdirSync(dirname(reference), { recursive: true });
    copyFileSync(join(TEMPLATES, 'project', MEMORY_RULES), reference);
    written.push(MEMORY_REFERENCE);

    return written;
}
