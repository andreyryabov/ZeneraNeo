import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Skill, SkillProvider, SkillSummary } from '../skills.ts';
import type { AnyTool } from '../types.ts';

// ---------------------------------------------------------------------------
// Filesystem-backed skill provider
// ---------------------------------------------------------------------------

const SKILL_FILE = 'SKILL.md';

export interface FileSkillProviderOptions {
    /** one or more root directories holding `<name>.md` files and/or `<name>/SKILL.md` folders */
    dir: string | string[];
    /** logical provider id agents bind to; defaults to `file` */
    id?: string;
    /**
     * Tools a skill may unlock, by name. Instructions can live in a file but
     * code cannot, so a markdown skill declares `tools: [a, b]` in its
     * frontmatter and the names are resolved against this registry.
     */
    tools?: AnyTool<any>[];
}

interface Entry {
    summary: SkillSummary;
    /** absolute path of the markdown file */
    file: string;
    /** the folder to scan for resources, or undefined for a flat `<name>.md` */
    folder?: string;
    content: string;
    toolNames: string[];
}

/**
 * Reads skills from disk. Two layouts, both discovered in one scan:
 *
 * ```
 * <dir>/budget_travel.md          flat: frontmatter + body
 * <dir>/budget_travel/SKILL.md    folder: sibling files become `resources`
 * ```
 *
 * Frontmatter is a small subset of YAML — `key: value`, plus `[a, b]` lists
 * for `tags` and `tools`. `name` defaults to the file or folder name and
 * `description` to the first line of the body, so the minimum viable skill is
 * a markdown file with no frontmatter at all.
 */
export class FileSkillProvider implements SkillProvider {
    readonly id: string;
    readonly #dirs: string[];
    readonly #tools = new Map<string, AnyTool<any>>();
    #index?: Promise<Map<string, Entry>>;

    constructor(opts: FileSkillProviderOptions | string) {
        const o = typeof opts === 'string' ? { dir: opts } : opts;
        const raw = Array.isArray(o.dir) ? o.dir : [o.dir];
        this.#dirs = raw.map((d) => resolve(d));
        this.id = o.id ?? 'file';
        for (const t of o.tools ?? []) {
            this.#tools.set(t.name, t);
        }
    }

    /** The first configured directory (kept for backwards compatibility). */
    get dir(): string {
        return this.#dirs[0];
    }

    /** All configured directories. */
    get dirs(): string[] {
        return [...this.#dirs];
    }

    /** Drops the cached scan; call after editing skills on disk. */
    refresh(): void {
        this.#index = undefined;
    }

    async list(): Promise<SkillSummary[]> {
        const index = await this.#scan();
        return [...index.values()]
            .map((e) => e.summary)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async search(query: string, limit = 8): Promise<SkillSummary[]> {
        const q = query.toLowerCase();
        const all = await this.list();
        return all
            .filter(
                (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.description.toLowerCase().includes(q) ||
                    (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
            )
            .slice(0, limit);
    }

    async load(name: string, version?: string): Promise<Skill> {
        const entry = (await this.#scan()).get(name);
        if (!entry) {
            throw new Error(`unknown skill: ${name}`);
        }
        const { version: found } = entry.summary;
        if (version && found && found !== version) {
            throw new Error(`skill ${name} is at ${found}, ${version} was requested`);
        }
        const tools = entry.toolNames.map((n) => {
            const t = this.#tools.get(n);
            if (!t) {
                throw new Error(
                    `skill "${name}" declares tool "${n}", which is not registered on ` +
                        `provider "${this.id}"`,
                );
            }
            return t;
        });
        return {
            ...entry.summary,
            content: entry.content,
            file: entry.file,
            ...(tools.length ? { tools } : {}),
            ...(entry.folder ? { resources: await readResources(entry.folder) } : {}),
        };
    }

    /** One scan, memoized: `list` runs on every `skill_load`. */
    #scan(): Promise<Map<string, Entry>> {
        this.#index ??= this.#read();
        return this.#index;
    }

    async #read(): Promise<Map<string, Entry>> {
        const index = new Map<string, Entry>();
        for (const dir of this.#dirs) {
            let items;
            try {
                items = await readdir(dir, { withFileTypes: true });
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw err;
            }
            for (const item of items) {
                const folder = item.isDirectory() ? join(dir, item.name) : undefined;
                const file = folder ? join(folder, SKILL_FILE) : join(dir, item.name);
                if (!folder && !(item.isFile() && item.name.endsWith('.md'))) {
                    continue;
                }
                const raw = await readOptional(file);
                if (raw === undefined) {
                    continue;
                }
                const base = folder ? item.name : item.name.slice(0, -'.md'.length);
                const entry = parse(raw, base, file, folder);
                index.set(entry.summary.name, entry);
            }
        }
        return index;
    }
}

function parse(raw: string, base: string, file: string, folder?: string): Entry {
    const { data, body } = frontmatter(raw);
    const tags = toList(data.tags);
    return {
        file,
        folder,
        content: body,
        toolNames: toList(data.tools),
        summary: {
            name: data.name || base,
            description: data.description || firstLine(body),
            ...(tags.length ? { tags } : {}),
            ...(data.version ? { version: data.version } : {}),
        },
    };
}

/** Sibling files of a `SKILL.md`, top level only, keyed by filename. */
async function readResources(folder: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const item of await readdir(folder, { withFileTypes: true })) {
        if (!item.isFile() || item.name === SKILL_FILE) {
            continue;
        }
        const value = await readOptional(join(folder, item.name));
        if (value !== undefined) {
            out[item.name] = value;
        }
    }
    return out;
}

async function readOptional(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT: a folder without a SKILL.md is simply not a skill.
        // EISDIR: a `<name>.md` directory is not one either.
        if (code === 'ENOENT' || code === 'EISDIR') {
            return undefined;
        }
        throw err;
    }
}

/**
 * Deliberately not a YAML parser: `key: value` and flow lists cover what a
 * skill header needs, and a real dependency would buy nothing.
 */
function frontmatter(raw: string): { data: Record<string, string>; body: string } {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
    if (!m) {
        return { data: {}, body: raw.trim() };
    }
    const data: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const i = line.indexOf(':');
        const key = i < 0 ? '' : line.slice(0, i).trim();
        if (!key || key.startsWith('#')) {
            continue;
        }
        data[key] = unquote(line.slice(i + 1).trim());
    }
    return { data, body: raw.slice(m[0].length).trim() };
}

function toList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    return inner
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
}

function unquote(value: string): string {
    const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
    return quoted && value.length > 1 ? value.slice(1, -1) : value;
}

function firstLine(body: string): string {
    return (
        body
            .split(/\r?\n/)
            .find((l) => l.trim())
            ?.replace(/^#+\s*/, '')
            .trim() ?? ''
    );
}
