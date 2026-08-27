import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Scaffolding
//
// What `zen init` writes. Deliberately close to empty: a template full of
// commented-out options is a template nobody reads and everybody deletes. The
// one agent here works as written, and every other knob is in `docs/`.
// ---------------------------------------------------------------------------

const INSTRUCTIONS_MD = `# House rules

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

# The container \`sandbox:*\` commands run in. \`persist: true\` keeps it between
# runs instead of throwing it away, so what the agent installs is still there
# next time — otherwise only /workspace and its home directory survive, and an
# \`apt-get\` or a root \`pip install\` is repeated on every run. \`zen sandbox
# clean\` removes the ones left behind. Everything else has a default; see the
# sandbox: block in docs/agents-yaml.md to size or pin the image.
sandbox:
    persist: true

agents:
    - name: default
      description: The entry point.
      # Instructions live in agents/prompts/<name>.md and are picked up by
      # convention — no need to name the file here.
      #
      # workspace:* is every file tool at once, sandbox:* is the shell. Name
      # them one by one to be narrower, or subtract: [workspace:*, -delete_file]
      #
      # sandbox:* runs commands in a container, not on this machine, so it
      # needs podman — \`zen run\` installs and starts what it can on its own,
      # and \`zen sandbox status\` says where that got to. Drop the line if you
      # would rather this agent never reached a shell.
      tools:
          - workspace:*
          - sandbox:*
`;

const PROMPT = `You are a helpful assistant working inside a project workspace.

You have tools to read, search and edit files. The workspace is the only
place you can see; paths are relative to its root.

You can also run shell commands. They run in a container over the same
workspace, not on the user's machine, so a command that fails there has cost
them nothing — but it is still their work in the directory, so read before you
overwrite and say what you ran.

Read a file before you change it: \`apply_patch\` matches the surrounding text
exactly, so a patch written from memory will not apply. Use \`apply_patch\` to
change part of a file and \`write_file\` only for a new one.

Say what you changed.
`;

const GITIGNORE = `# Sessions hold run state, memory, blobs and whatever the agent wrote.
# None of it is source.
sessions/
`;

// ---------------------------------------------------------------------------
// Telling the editor which instructions are not for it
//
// The project's house rules are `INSTRUCTIONS.md`, deliberately not
// `AGENTS.md`: every coding assistant now reads that name out of an open
// folder and feeds it to itself as always-on instructions, and `zen open`
// opens exactly this directory. A name nobody else claims means the two are
// never confused, and `chat.useAgentsMdFile` no longer has to be switched off
// to keep them apart.
//
// `chat.useNestedAgentsMdFiles` is still written. It is already false by
// default, but it is opt-in globally, and this is a directory the agent itself
// writes into — someone who turned it on would otherwise have the editor pick
// up whatever `AGENTS.md` a run happened to leave behind. It is a *restricted*
// setting, so it applies only in a trusted workspace; that is the right way
// round, since an untrusted folder is not one to run agents in either.
// ---------------------------------------------------------------------------

const VSCODE_SETTINGS = `{
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

// ---------------------------------------------------------------------------
// The other half of the editor story
//
// `INSTRUCTIONS.md` addresses the *project's* agents. The editor's assistant
// still needs a brief of its own, and what it needs to know is how this kind
// of project is put together — the file formats, how a prompt is written, when
// to add a skill rather than an agent. That is one long document, kept as a
// file rather than a template literal in here: it is full of backticks and
// `${...}` examples, which a TS template literal cannot hold without escaping
// every one of them into illegibility.
// ---------------------------------------------------------------------------

const COPILOT_TEMPLATE = new URL('../templates/copilot-instructions.md', import.meta.url);

/**
 * Writes `.github/copilot-instructions.md` under `dir` unless one is already
 * there. Returns the relative path when it wrote one.
 */
export function copilotInstructions(dir: string): string | undefined {
    const rel = join('.github', 'copilot-instructions.md');
    if (existsSync(join(dir, rel))) return undefined;
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, rel), readFileSync(COPILOT_TEMPLATE, 'utf8'), { flag: 'wx' });
    return rel;
}

export interface ScaffoldOptions {
    /** the project directory */
    dir: string;
    model: string;
}

/** Writes a project. Never overwrites: the caller decides whether it may. */
export function scaffold(opts: ScaffoldOptions): string[] {
    const written: string[] = [];
    const put = (rel: string, body: string): void => {
        const path = join(opts.dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, body, { flag: 'wx' });
        written.push(rel);
    };

    mkdirSync(join(opts.dir, 'agents', 'prompts'), { recursive: true });
    mkdirSync(join(opts.dir, 'agents', 'skills'), { recursive: true });
    mkdirSync(join(opts.dir, 'sessions'), { recursive: true });

    put('INSTRUCTIONS.md', INSTRUCTIONS_MD);
    put('agents.yaml', AGENTS_YAML(opts.model));
    put(join('agents', 'prompts', 'default.md'), PROMPT);
    put('.gitignore', GITIGNORE);

    // The project directory is what `zen open` opens, so this is where the
    // editor actually reads them.
    for (const rel of [editorSettings(opts.dir), copilotInstructions(opts.dir)]) {
        if (rel !== undefined) written.push(rel);
    }
    return written;
}
