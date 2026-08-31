import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The `model:` section, which is one line until it has to say more.
 *
 * A shorthand cannot carry options, and the object form cannot carry a
 * shorthand — its `model:` is the bare id the API is sent — so asking for
 * reasoning means splitting the ref back into the two fields and giving the
 * configuration a name to be referred to by.
 */
const MODEL_SECTION = (ref: string, options?: string): string => {
    const colon = ref.indexOf(':');
    if (!options || colon < 0) {
        return (
            '# The model an agent uses when it does not pin its own. Change it here and the\n' +
            '# whole project moves. The prefix is the *provider* name, not the vendor — drop\n' +
            '# it and the id goes to the default provider, whatever the id looks like.\n' +
            `model: ${ref}`
        );
    }
    const indented = options
        .trimEnd()
        .split('\n')
        .map((line) => (line ? `        ${line}` : ''))
        .join('\n');
    return (
        '# The model an agent uses when it does not pin its own. Change it here and the\n' +
        '# whole project moves. A named configuration is what gives the knobs below\n' +
        '# somewhere to live; a bare `model: <provider>:<id>` works when there are none.\n' +
        'models:\n' +
        '    main:\n' +
        `        provider: ${ref.slice(0, colon)}\n` +
        `        model: ${ref.slice(colon + 1)}\n` +
        `${indented}\n` +
        '\n' +
        'model: main'
    );
};
/**
 * Added above the tool list when the project is scaffolded with web access.
 * The group is registered whether or not a key exists, so this only ever
 * changes what the agent is allowed to reach for.
 */
const EXA_NOTE = `
      #
      # exa:* is web search and page reading, here because this machine has an
      # Exa key. The key is read from the environment when a tool is called,
      # so a clone of this project without one still loads and only the call
      # fails.`;

const AGENTS_YAML = (
    model: string,
    options?: string,
    web?: boolean,
): string => `# Who exists, and what they may reach for.
#
version: 1

${MODEL_SECTION(model, options)}

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
      # would rather this agent never reached a shell.${web ? EXA_NOTE : ''}
      tools:
          - workspace:*
          - sandbox:*${web ? '\n          - exa:*' : ''}
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
    "chat.useNestedAgentsMdFiles": false,
    "chat.tools.terminal.autoApprove": {
        "zen": true
    }
}
`;

/**
 * Writes `.vscode/settings.json` under `dir`, replacing what is there. The file
 * is ours: it says how the editor is to treat a directory the agents write
 * into, and a stale copy of that answer is worse than none. Returns the
 * relative path.
 */
export function editorSettings(dir: string): string {
    const rel = join('.vscode', 'settings.json');
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    writeFileSync(join(dir, rel), VSCODE_SETTINGS);
    return rel;
}

// ---------------------------------------------------------------------------
// The other half of the editor story
//
// `INSTRUCTIONS.md` addresses the *project's* agents. The editor's assistant
// still needs a brief of its own, and what it needs to know is how this kind
// of project is put together — the file formats, how a prompt is written, when
// to add a skill rather than an agent. That is a whole `.github/` tree — the
// standing brief, plus the prompt files and skills the editor picks up from
// the same place — kept as files rather than template literals in here: they
// are full of backticks and `${...}` examples, which a TS template literal
// cannot hold without escaping every one of them into illegibility.
//
// `templates/.github/` mirrors what lands in the project one for one, so
// adding a skill or a prompt file is adding a file there and nothing else.
// ---------------------------------------------------------------------------

const GITHUB_TEMPLATE = fileURLToPath(new URL('../templates/.github', import.meta.url));

/**
 * Writes the `.github/` tree under `dir`, replacing what is there — it
 * describes the file formats of the version of `zen` in hand, so the current
 * one is the only one worth having. Returns the relative paths written.
 */
export function copilotInstructions(dir: string): string[] {
    return copyTree(GITHUB_TEMPLATE, dir, '.github');
}

/**
 * Copies one template directory into `dir` at `rel`, depth first, sorted so
 * the list it returns is the same on every machine.
 */
function copyTree(from: string, dir: string, rel: string): string[] {
    const written: string[] = [];
    mkdirSync(join(dir, rel), { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const child = join(rel, entry.name);
        if (entry.isDirectory()) {
            written.push(...copyTree(join(from, entry.name), dir, child));
        } else {
            writeFileSync(join(dir, child), readFileSync(join(from, entry.name)));
            written.push(child);
        }
    }
    return written;
}

export interface ScaffoldOptions {
    /** the project directory */
    dir: string;
    model: string;
    /** extra lines for the model's configuration; their presence picks the object form */
    modelOptions?: string;
    /** give the default agent `exa:*` — set when a key for it is on hand */
    web?: boolean;
}

/**
 * Writes a project. Never overwrites the project's own files: the caller
 * decides whether it may. The editor files are the exception — they are ours,
 * and are replaced.
 */
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
    put('agents.yaml', AGENTS_YAML(opts.model, opts.modelOptions, opts.web));
    put(join('agents', 'prompts', 'default.md'), PROMPT);
    put('.gitignore', GITIGNORE);

    // The project directory is what `zen open` opens, so this is where the
    // editor actually reads them.
    written.push(editorSettings(opts.dir), ...copilotInstructions(opts.dir));
    return written;
}
