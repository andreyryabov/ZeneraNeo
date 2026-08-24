import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Scaffolding
//
// What `zen init` writes. Deliberately close to empty: a template full of
// commented-out options is a template nobody reads and everybody deletes. The
// one agent here works as written, and every other knob is in `docs/`.
// ---------------------------------------------------------------------------

const AGENTS_MD = `# House rules

Everything in this file is prepended to every agent's prompt, so it is the
place for the things that are true regardless of who is answering: tone,
constraints, what to do when the answer is not knowable.

Replace this with yours.
`;

const AGENTS_YAML = (model: string): string => `# Who exists, and what they may reach for.
#
# Reference: docs/agents-yaml.md
version: 1

# The model an agent uses when it does not pin its own. Change it here and the
# whole project moves.
model: ${model}

agents:
    - name: default
      description: The entry point.
      # Instructions live in .agents/prompts/<name>.md and are picked up by
      # convention — no need to name the file here.
      tools:
          - read_file
          - list_dir
          - find_files
          - write_file
          - delete_file
`;

const PROMPT = `You are a helpful assistant working inside a project workspace.

You have tools to read, search and write files. The workspace is the only
place you can see; paths are relative to its root.

Prefer reading before writing, and say what you changed.
`;

const SKILLS_README = `Skills go here, one directory each:

    <name>/SKILL.md

A skill is a bundle of instructions the agent loads on demand rather than
carrying in every prompt. The front matter names it and says when to reach for
it; anything else in the directory is the skill's own material.

See docs/projects.md.
`;

const GITIGNORE = `# Sessions hold run state, memory, blobs and whatever the agent wrote.
# None of it is source.
sessions/
`;

// ---------------------------------------------------------------------------
// Telling the editor this AGENTS.md is not for it
//
// VS Code reads an `AGENTS.md` at the root of an open folder and feeds it to
// its own assistant as always-on instructions. A version's AGENTS.md is the
// house rules for *this project's* agents — addressed to them, about their
// tools and their workspace — and `zen open` opens exactly that directory, so
// left alone the two would be confused every single time.
//
// `chat.useAgentsMdFile` defaults to true, so switching it off is the part
// that does the work. `chat.useNestedAgentsMdFiles` is already false by
// default and is written anyway: it is opt-in globally, and someone who turned
// it on would otherwise pull in every version's AGENTS.md at once when they
// opened the project root.
//
// Both are *restricted* settings, so they apply only in a trusted workspace.
// That is the right way round — an untrusted folder is not one you should be
// running agents in either.
// ---------------------------------------------------------------------------

const VSCODE_SETTINGS = `{
    "chat.useAgentsMdFile": false,
    "chat.useNestedAgentsMdFiles": false
}
`;

/**
 * Writes `.vscode/settings.json` under `dir` unless one is already there — an
 * existing file is somebody's, and a project directory may predate the project.
 * Returns the relative path when it wrote one.
 */
export function editorSettings(dir: string): string | undefined {
    const rel = join('.vscode', 'settings.json');
    if (existsSync(join(dir, rel))) return undefined;
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    writeFileSync(join(dir, rel), VSCODE_SETTINGS, { flag: 'wx' });
    return rel;
}

export interface ScaffoldOptions {
    /** the version directory, e.g. <project>/v1 */
    dir: string;
    model: string;
}

/** Writes a version. Never overwrites: the caller decides whether it may. */
export function scaffold(opts: ScaffoldOptions): string[] {
    const written: string[] = [];
    const put = (rel: string, body: string): void => {
        const path = join(opts.dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, body, { flag: 'wx' });
        written.push(rel);
    };

    mkdirSync(join(opts.dir, '.agents', 'prompts'), { recursive: true });
    mkdirSync(join(opts.dir, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(opts.dir, 'sessions'), { recursive: true });

    put('AGENTS.md', AGENTS_MD);
    put('agents.yaml', AGENTS_YAML(opts.model));
    put(join('.agents', 'prompts', 'default.md'), PROMPT);
    put(join('.agents', 'skills', 'README.md'), SKILLS_README);
    put('.gitignore', GITIGNORE);

    // The version directory is what `zen open` opens, so this is the copy that
    // matters most: here, AGENTS.md *is* the workspace root's.
    const settings = editorSettings(opts.dir);
    if (settings !== undefined) written.push(settings);
    return written;
}
