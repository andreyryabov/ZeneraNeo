import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Scaffolding
//
// What `zen init` writes and `zen open` refreshes — none of which is in this
// file. `templates/` holds the real thing, laid out the way it lands, so
// changing what a project starts life as is editing a file rather than a string
// literal escaping every backtick and `${...}` it contains:
//
//   templates/project/   the project's own files. Written once and edited from
//                        then on, so anything already there is left alone.
//   templates/editor/    ours: `.vscode/settings.json` and the `.github/` tree,
//                        which describe this version of `zen` to the editor and
//                        are replaced every time.
//   templates/parts/     fragments spliced into a template above.
//
// The trees are copied whole and nothing enumerates them, so adding a file to
// a new project is adding a file to `templates/project/` and nothing else.
//
// What is there is deliberately close to empty: a template full of
// commented-out options is a template nobody reads and everybody deletes. The
// one agent works as written, and every other knob is in `docs/`.
// ---------------------------------------------------------------------------

const TEMPLATES = fileURLToPath(new URL('../templates', import.meta.url));

/** The suffix on a file with `{{...}}` in it, dropped when the file lands. */
const TEMPLATE = '.tmpl';

type Vars = Record<string, string>;

/**
 * Fills the `{{name}}` in a template, in the two shapes templates use.
 *
 * A placeholder alone on a line takes a whole fragment: its own indentation is
 * applied to every line of the value, and an empty value takes the line with
 * it — which is how an optional block leaves nothing behind. Anywhere else it
 * takes a word. A name nothing supplies throws, so a typo in a template is a
 * failing test rather than a `{{provider}}` sitting in somebody's agents.yaml.
 */
function render(text: string, vars: Vars): string {
    const value = (name: string): string => {
        const found = vars[name];
        if (found === undefined) {
            throw new Error(`template asks for {{${name}}}, which nothing supplies`);
        }
        return found;
    };
    return text
        .replace(/^([ \t]*)\{\{(\w+)\}\}[ \t]*\r?\n/gm, (_, indent: string, name: string) => {
            const body = value(name).trimEnd();
            if (!body) {
                return '';
            }
            const lines = body.split('\n').map((line) => (line ? indent + line : ''));
            return `${lines.join('\n')}\n`;
        })
        .replace(/\{\{(\w+)\}\}/g, (_, name: string) => value(name));
}

/** Reads one fragment from `templates/parts/`, without its trailing newline. */
function part(name: string, vars: Vars = {}): string {
    const text = readFileSync(join(TEMPLATES, 'parts', `${name}${TEMPLATE}`), 'utf8');
    return render(text, vars).trimEnd();
}

/**
 * The `model:` section, which is one line until it has to say more.
 *
 * A shorthand cannot carry options, and the object form cannot carry a
 * shorthand — its `model:` is the bare id the API is sent — so asking for
 * reasoning means splitting the ref back into the two fields and giving the
 * configuration a name to be referred to by.
 */
function modelSection(ref: string, options?: string): string {
    const colon = ref.indexOf(':');
    if (!options || colon < 0) {
        return part('model.yaml', { ref });
    }
    return part('models.yaml', {
        provider: ref.slice(0, colon),
        id: ref.slice(colon + 1),
        options,
    });
}

interface CopyOptions {
    /** values for the `{{...}}` in any template under this tree */
    vars?: Vars;
    /** leave a file that is already there alone rather than replacing it */
    keep?: boolean;
}

/**
 * The name a template file lands under.
 *
 * `gitignore` gains its dot here because it cannot have one in the repository:
 * npm strips a `.gitignore` out of a published tarball, and git would read this
 * one as rules about `packages/cli/templates/` rather than as content.
 */
function target(name: string): string {
    if (name.endsWith(TEMPLATE)) {
        return name.slice(0, -TEMPLATE.length);
    }
    return name === 'gitignore' ? '.gitignore' : name;
}

/**
 * Copies one template directory into `dir` at `rel`, depth first, sorted so the
 * list it returns is the same on every machine. Only a `.tmpl` is read as text;
 * everything else is copied byte for byte.
 */
function copyTree(from: string, dir: string, rel: string, opts: CopyOptions): string[] {
    const written: string[] = [];
    mkdirSync(join(dir, rel), { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const source = join(from, entry.name);
        if (entry.isDirectory()) {
            written.push(...copyTree(source, dir, join(rel, entry.name), opts));
            continue;
        }
        const child = join(rel, target(entry.name));
        if (opts.keep && existsSync(join(dir, child))) {
            continue;
        }
        const body = entry.name.endsWith(TEMPLATE)
            ? render(readFileSync(source, 'utf8'), opts.vars ?? {})
            : readFileSync(source);
        writeFileSync(join(dir, child), body);
        written.push(child);
    }
    return written;
}

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
//
// `INSTRUCTIONS.md` addresses the *project's* agents. The editor's assistant
// still needs a brief of its own, and what it needs to know is how this kind
// of project is put together — the file formats, how a prompt is written, when
// to add a skill rather than an agent. That is what the `.github/` tree is: the
// standing brief, plus the prompt files and skills the editor picks up from the
// same place.
// ---------------------------------------------------------------------------

/**
 * Writes the editor's files under `dir`, replacing what is there. They are
 * ours: they say how the editor is to treat a directory the agents write into,
 * and they describe the file formats of the version of `zen` in hand, so the
 * current answer is the only one worth having and a stale one is worse than
 * none. Returns the relative paths written.
 */
export function editorFiles(dir: string): string[] {
    return copyTree(join(TEMPLATES, 'editor'), dir, '', {});
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
 * Writes a project. Never overwrites the project's own files — a second `init`
 * over a directory fills in what is missing and leaves the rest alone — but the
 * editor files are ours, and are replaced.
 */
export function scaffold(opts: ScaffoldOptions): string[] {
    const written = copyTree(join(TEMPLATES, 'project'), opts.dir, '', {
        keep: true,
        vars: {
            model: modelSection(opts.model, opts.modelOptions),
            exa: opts.web ? part('exa.yaml') : '',
        },
    });

    // The two directories with no file to put in them: a skill is a folder
    // someone adds, and sessions is written into on the first run.
    mkdirSync(join(opts.dir, 'agents', 'skills'), { recursive: true });
    mkdirSync(join(opts.dir, 'sessions'), { recursive: true });

    // The project directory is what `zen open` opens, so this is where the
    // editor actually reads them.
    written.push(...editorFiles(opts.dir));
    return written;
}
