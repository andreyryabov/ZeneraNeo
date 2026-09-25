import { media, text, type ContentPart, type Input, type MediaKind } from '@zenera/neo';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { readStdin, usageError, warn } from './term.ts';

// ---------------------------------------------------------------------------
// A run request in a file
//
// `zen run --input case.json` is the whole invocation written down: which
// project, what to ask, where it may write, what it remembers into. It exists
// because the command line cannot carry an image, and because a test case that
// is a file can be checked in, diffed and re-run — which is the difference
// between a suite and a shell history.
//
// The format is a JSON projection of `Input` from @zenera/neo and nothing more.
// Anything the runtime accepts, the file accepts; anything it does not, this
// refuses by name rather than passing it down to fail somewhere deeper.
// ---------------------------------------------------------------------------

export interface RunRequest {
    /** a registered name, or a directory — paths resolved against the file */
    project?: string;
    input: Input;
    /** absolute */
    workspace?: string;
    /** absolute */
    memory?: string;
}

/**
 * Local media is read and inlined, so the state a run is resumed from carries
 * the picture rather than a path that meant something on another machine. That
 * also puts the bytes in `state.json`, rewritten at every checkpoint of every
 * later turn — hence a ceiling, and a word of warning well before it.
 */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const WARN_MEDIA_BYTES = 2 * 1024 * 1024;

/** Enough to name what people actually attach; anything else says `mimeType`. */
const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.avif': 'image/avif',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
};

const MEDIA_KEYS: MediaKind[] = ['image', 'audio', 'video', 'file'];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * `-` is stdin, and then there is no file to resolve paths against, so the cwd
 * answers instead — the only place a piped request could have meant.
 */
export async function readRequest(file: string, cwd: string, piped?: string): Promise<RunRequest> {
    if (file === '-') {
        const body = piped ?? (await readStdin());
        if (body === undefined) {
            throw usageError('--input - expects the request on stdin', 'pipe a JSON object in');
        }
        return parseRequest(body, cwd, '<stdin>');
    }
    const at = resolve(cwd, file);
    let body: string;
    try {
        body = readFileSync(at, 'utf8');
    } catch {
        throw usageError(`cannot read ${at}`);
    }
    return parseRequest(body, dirname(at), at);
}

/**
 * `base` is the directory every relative path in the request is resolved
 * against — the file's own, so a case travels with the images beside it.
 */
export function parseRequest(body: string, base: string, where: string): RunRequest {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(body) as Record<string, unknown>;
    } catch (err) {
        throw usageError(`${where}: ${(err as Error).message}`, 'the request must be JSON');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw usageError(`${where}: expected a JSON object`, 'see: zen run --help');
    }
    if (raw.input === undefined) {
        throw usageError(`${where}: no "input"`, 'a request has to say what to ask');
    }
    return {
        project: project(raw.project, base, where),
        input: toInput(raw.input, base, where),
        workspace: path(raw.workspace, base, where, 'workspace'),
        memory: path(raw.memory, base, where, 'memory'),
    };
}

/**
 * A registered name is not a path and must not be resolved into one; a name
 * that looks like a path is one. `Projects.open` takes either.
 */
function project(value: unknown, base: string, where: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !value) {
        throw usageError(`${where}: "project" must be a name or a directory`);
    }
    return value.startsWith('.') || isAbsolute(value) ? resolve(base, value) : value;
}

function path(value: unknown, base: string, where: string, field: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !value) {
        throw usageError(`${where}: "${field}" must be a directory`);
    }
    return resolve(base, value);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Canonical `ContentPart[]` out, whatever went in: the shorthands exist for
 * whoever writes the file, and stop existing the moment it is read.
 */
export function toInput(raw: unknown, base: string, where: string): Input {
    if (typeof raw === 'string') {
        return raw;
    }
    if (!Array.isArray(raw)) {
        throw usageError(`${where}: "input" must be a string or an array of parts`);
    }
    return raw.map((part, i) => toPart(part, base, `${where}: input[${i}]`));
}

function toPart(part: unknown, base: string, at: string): ContentPart {
    if (typeof part === 'string') {
        return text(part);
    }
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        throw usageError(`${at}: expected a string or an object`);
    }
    const obj = part as Record<string, unknown>;
    const mimeType = mime(obj.mimeType, at);

    if (typeof obj.type === 'string') {
        if (obj.type === 'text') {
            return text(str(obj.text, at, 'text'));
        }
        if ((MEDIA_KEYS as string[]).includes(obj.type)) {
            const kind = obj.type as MediaKind;
            return url(kind, str(obj.url, at, 'url'), mimeType, base, at);
        }
        throw usageError(
            `${at}: unknown part type "${obj.type}"`,
            `text, ${MEDIA_KEYS.join(', ')}`,
        );
    }

    if (typeof obj.text === 'string') {
        return text(obj.text);
    }
    for (const kind of MEDIA_KEYS) {
        if (obj[kind] !== undefined) {
            return url(kind, str(obj[kind], at, kind), mimeType, base, at);
        }
    }
    throw usageError(`${at}: no text, ${MEDIA_KEYS.join(', ')} or type`, 'see: zen run --help');
}

/**
 * A url the model can already fetch is left exactly as it is; anything else is
 * a path on this machine, and a path is only a url once it carries its bytes.
 */
function url(
    kind: MediaKind,
    value: string,
    mimeType: string | undefined,
    base: string,
    at: string,
): ContentPart {
    if (/^(https?|data):/.test(value)) {
        return media(kind, value, mimeType);
    }
    const file = resolve(base, value);
    const type = mimeType ?? MIME[extname(file).toLowerCase()];
    if (!type) {
        throw usageError(
            `${at}: nothing known about "${extname(file) || value}"`,
            'name the type with "mimeType"',
        );
    }
    let size: number;
    try {
        size = statSync(file).size;
    } catch {
        throw usageError(`${at}: cannot read ${file}`);
    }
    if (size > MAX_MEDIA_BYTES) {
        throw usageError(
            `${at}: ${file} is ${Math.round(size / 1024 / 1024)} MB`,
            `inlined media lives in the run state — the limit is ${MAX_MEDIA_BYTES / 1024 / 1024} MB`,
        );
    }
    if (size > WARN_MEDIA_BYTES) {
        warn(`${file} is large; it is written into the session state on every later turn`);
    }
    const bytes = readFileSync(file);
    return media(kind, `data:${type};base64,${bytes.toString('base64')}`, type);
}

function str(value: unknown, at: string, field: string): string {
    if (typeof value !== 'string' || !value) {
        throw usageError(`${at}: "${field}" must be a non-empty string`);
    }
    return value;
}

function mime(value: unknown, at: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !value) {
        throw usageError(`${at}: "mimeType" must be a string`);
    }
    return value;
}
