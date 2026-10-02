import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { usageError } from './host.ts';

// ---------------------------------------------------------------------------
// Stored prompts
//
// Copilot reads `AGENTS.md`, `.github/skills/` and `.github/agents/`, but it
// has no notion of `.github/prompts/*.prompt.md` — the files an editor offers
// as slash commands. Reading one and handing over its body is the whole of
// `zen meta run`, and it is why that subcommand exists.
// ---------------------------------------------------------------------------

export const PROMPT_DIR = '.github/prompts';
const PROMPT_SUFFIX = '.prompt.md';

/** `/project-review`, `project-review`, `project-review.prompt.md` or a path. */
export function promptPath(dir: string, name: string): string {
    const bare = name.replace(/^\//, '');
    if (bare.includes('/') || bare.endsWith('.md')) {
        return `${dir}/${bare}`;
    }
    return `${dir}/${PROMPT_DIR}/${bare}${PROMPT_SUFFIX}`;
}

export interface StoredPrompt {
    name: string;
    path: string;
    description?: string;
    body: string;
}

/**
 * Frontmatter is the editor's business — `mode`, `tools`, `description` — and
 * none of it means anything to copilot, so only the body is sent. `description`
 * is kept for the one line of narration that says which prompt is running.
 */
export function readPrompt(path: string, name: string, text: string): StoredPrompt {
    let body = text;
    let description: string | undefined;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match) {
        body = text.slice(match[0].length);
        const found = /^description:\s*(.+)$/m.exec(match[1]);
        description = found?.[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return { name, path, description, body: body.trim() };
}

export async function loadPrompt(dir: string, name: string): Promise<StoredPrompt> {
    const path = promptPath(dir, name);
    if (!existsSync(path)) {
        const known = await listPrompts(dir);
        throw usageError(
            `no prompt named ${name.replace(/^\//, '')}`,
            known.length > 0
                ? `try: ${known.map((p) => `/${p}`).join(', ')}`
                : `put one in ${PROMPT_DIR}/`,
        );
    }
    return readPrompt(path, name.replace(/^\//, ''), await readFile(path, 'utf8'));
}

export async function listPrompts(dir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
        const names = await readdir(`${dir}/${PROMPT_DIR}`);
        return names
            .filter((n) => n.endsWith(PROMPT_SUFFIX))
            .map((n) => n.slice(0, -PROMPT_SUFFIX.length))
            .sort();
    } catch {
        return [];
    }
}
