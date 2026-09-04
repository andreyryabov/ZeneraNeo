import { randomUUID } from 'node:crypto';
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionsDir } from './projects.ts';

// ---------------------------------------------------------------------------
// The prompt's history
//
// The same contract a shell offers: what you asked before is one arrow key
// away, and it is still there tomorrow. It belongs to the **project**, not to
// a session — the question you want back is usually the one you asked in the
// session you just finished, while starting the next one.
//
// The file is what `.bash_history` is: one line per entry, oldest last,
// appended to. A prompt line cannot contain a newline, so nothing has to be
// escaped and the file stays greppable and hand-editable.
//
// Nothing here may ever stop someone typing. Every filesystem call is guarded
// and a failure degrades to an in-memory history for the rest of the run.
// ---------------------------------------------------------------------------

/** Entries kept in memory and after a trim. */
export const MAX_ENTRIES = 500;

/** Lines tolerated in the file before it is rewritten, so appending stays the common case. */
const TRIM_AT = MAX_ENTRIES * 2;

const FILE_MODE = 0o600;

/** Beside the sessions, so it outlives any one of them and is already ignored by git. */
export const historyPath = (projectDir: string): string =>
    join(sessionsDir(projectDir), '.history');

export class History {
    readonly #path: string;
    #entries: string[];

    constructor(path: string) {
        this.#path = path;
        this.#entries = read(path);
    }

    static open(projectDir: string): History {
        return new History(historyPath(projectDir));
    }

    /** Oldest first, which is the order the arrow keys walk. */
    get entries(): readonly string[] {
        return this.#entries;
    }

    /**
     * Records one line. Blanks and a repeat of the line just before it are
     * dropped — holding the arrow key down to get past six identical retries
     * is the thing that makes a history annoying rather than useful.
     */
    add(text: string): void {
        const line = text.trim();
        if (!line || line.includes('\n') || this.#entries.at(-1) === line) {
            return;
        }
        this.#entries.push(line);
        if (this.#entries.length > MAX_ENTRIES) {
            this.#entries.shift();
        }
        try {
            mkdirSync(dirname(this.#path), { recursive: true });
            appendFileSync(this.#path, `${line}\n`, { mode: FILE_MODE });
        } catch {
            // A prompt that cannot remember is still a prompt.
        }
    }
}

function read(path: string): string[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    const lines = text
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
    const kept = lines.slice(-MAX_ENTRIES);
    if (lines.length > TRIM_AT) {
        rewrite(path, kept);
    }
    return kept;
}

/** Through a sibling and a rename: a crash leaves the old history, never half of one. */
function rewrite(path: string, lines: string[]): void {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, lines.map((line) => `${line}\n`).join(''), { mode: FILE_MODE });
        renameSync(tmp, path);
    } catch {
        rmSync(tmp, { force: true });
    }
}
