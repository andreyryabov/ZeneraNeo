import { isAbort, statusOf } from './embeddings/rate-limit.ts';

// ---------------------------------------------------------------------------
// What the runtime was doing when a provider refused
//
// A vendor error says what was wrong with the request and nothing at all about
// which request it was. Google throws with its whole response body as the
// message, and that body carries another JSON document inside its own
// `message`, so what reaches a person is:
//
//   {"error":{"message":"{\n \"error\": {\n \"code\": 400, …","code":400,…}}
//
// A turn generates, streams and embeds against several models, and that
// sentence names none of them — which of the calls failed, on which
// connection, and against which model id are all missing.
//
// So every SDK call runs through `called()` (and every stream body through
// `reading()`), which re-throws a `ProviderError` carrying the half of the
// sentence the vendor left out and keeps the original as `cause`. The status is
// copied onto the wrapper because everything that classifies a failure — the
// embedding limiter here, the CLI's liveness probe — reads it off the error it
// was handed.
// ---------------------------------------------------------------------------

/** What was being asked of a provider, in the runtime's own words. */
export type Doing = 'llm generation' | 'llm streaming' | 'embedding';

/** Which call, on whose connection, for which model. */
export interface CallSite {
    doing: Doing;
    /** the SDK call actually made, spelled the way the vendor spells it */
    api: string;
    /** the model or embedding id it was spent on */
    model: string;
    /** the declared provider name, when a registry built the adapter */
    provider?: string;
}

/**
 * The half of a call site an adapter knows before it is called, bound once so
 * that each call names only itself.
 */
export type CallSites = (doing: Doing, api: string) => CallSite;

export const callSites =
    (model: string, provider?: string): CallSites =>
    (doing, api) => ({ doing, api, model, provider });

/**
 * Carried by every adapter's options so a failure can name the connection.
 * Reporting only: the client is already built by the time an adapter sees it,
 * so the name is here to be printed, not to be resolved.
 */
export interface ProviderNamed {
    /** the registered provider name this adapter speaks through */
    provider?: string;
}

/** A provider call that failed, with the call it was. */
export class ProviderError extends Error {
    readonly site: CallSite;
    /** the vendor's own sentence, unwrapped out of whatever it arrived in */
    readonly detail: string;
    /** the HTTP status, wherever the SDK or the body left it */
    readonly status?: number;

    constructor(site: CallSite, detail: string, status: number | undefined, cause: unknown) {
        super(`${site.doing} failed — ${where(site)}: ${detail}`, { cause });
        this.name = 'ProviderError';
        this.site = site;
        this.detail = detail;
        this.status = status;
    }
}

const where = (site: CallSite): string =>
    `${site.provider ? `${site.provider} ` : ''}${site.api}, model "${site.model}"`;

/** Runs one provider call, and makes sure a refusal says what it refused. */
export async function called<T>(site: CallSite, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        throw failed(site, err);
    }
}

/**
 * The same for a response body: an HTTP error, and every mid-stream failure,
 * arrives while the stream is being read — long after the call that opened it
 * returned successfully.
 */
export async function* reading<T>(site: CallSite, source: AsyncIterable<T>): AsyncIterable<T> {
    try {
        yield* source;
    } catch (err) {
        throw failed(site, err);
    }
}

/** Names for "the caller stopped waiting", which are not the provider's doing. */
const INTERRUPTED = new Set(['AbortError', 'TimeoutError']);

/** The error to throw in place of `err`, which may be `err` itself. */
export function failed(site: CallSite, err: unknown): unknown {
    // An abort is the caller's own decision and a deadline is the caller's own
    // clock. Both are recognised by name upstream, so neither is rewritten.
    const name = (err as { name?: unknown } | null)?.name;
    if (
        err instanceof ProviderError ||
        isAbort(err) ||
        (typeof name === 'string' && INTERRUPTED.has(name))
    ) {
        return err;
    }
    const { detail, status } = explain(err);
    return new ProviderError(site, detail, status, err);
}

/** Bodies nest at most this deep before the unwrapping is the bug. */
const MAX_UNWRAP = 4;

/** Words that name a category of failure without naming the failure. */
const OPAQUE = /^(fetch failed|failed to fetch|terminated|internal error)\.?$/i;

/** Longer than this is a document, not a sentence. */
const MAX_DETAIL = 500;

interface Said {
    message: string;
    /** the HTTP status, when the body repeats it */
    status?: number;
    /** the vendor's symbolic name for the refusal — `INVALID_ARGUMENT` */
    code?: string;
    /** what the vendor's `details` add, which is usually the argument's name */
    about?: string;
}

/**
 * The sentence a vendor buried, and the status it came with. Exported because
 * it is useful anywhere a raw provider error has to be shown to someone.
 */
export function explain(err: unknown): { detail: string; status?: number } {
    let status = statusOf(err);
    let code: string | undefined;
    let about: string | undefined;
    let text = messageOf(err);

    // Unwrapping once is not enough — Google's body holds a body — and
    // unwrapping until it stops is a loop waiting for a self-quoting error.
    for (let depth = 0; depth < MAX_UNWRAP; depth++) {
        const said = body(text);
        if (!said) {
            break;
        }
        // The innermost wins: the outer layer says `Bad Request`, the inner one
        // says which argument was invalid.
        status = said.status ?? status;
        code = said.code ?? code;
        about = said.about ?? about;
        text = said.message;
    }

    // `Request contains an invalid argument` names no argument. The vendor's
    // `details` are where the field that was wrong is, when it is anywhere.
    text = collapse(about ? `${text.trim()} — ${about}` : text);
    if (!text || OPAQUE.test(text)) {
        // `fetch failed` is undici's word for DNS, refused, TLS and timeout
        // alike; the reason is only ever in the cause.
        const because = blamed(err, text);
        text = because ? (text ? `${text} — ${because}` : because) : text;
    }
    return { detail: mark(text || String(err), status, code), status };
}

const messageOf = (err: unknown): string =>
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);

/** A JSON error body, wherever the message happens to begin with one. */
function body(text: string): Said | undefined {
    const start = text.indexOf('{');
    if (start === -1) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.slice(start));
    } catch {
        // Not JSON, or a body cut short. What is already in hand is the answer.
        return undefined;
    }
    const root = parsed as { error?: unknown; message?: unknown };
    const error = root?.error ?? root;
    if (typeof error === 'string') {
        return { message: error };
    }
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const said = error as {
        message?: unknown;
        code?: unknown;
        status?: unknown;
        details?: unknown;
        param?: unknown;
    };
    if (typeof said.message !== 'string') {
        return undefined;
    }
    return {
        message: said.message,
        // `code` is the status on Google and a symbol on OpenAI; `status` is
        // the other way round. Which is which is decided by the type, not by
        // the vendor.
        status: typeof said.code === 'number' ? said.code : undefined,
        code:
            typeof said.status === 'string'
                ? said.status
                : typeof said.code === 'string'
                  ? said.code
                  : undefined,
        about: aboutOf(said.details) ?? (typeof said.param === 'string' ? said.param : undefined),
    };
}

/** Names of the field a `google.rpc` detail is about, and of what was wrong with it. */
const VIOLATION = ['field', 'description', 'reason', 'detail', 'message'] as const;

/**
 * What a vendor's `details` array says, flattened to one clause.
 *
 * This is where a 400 keeps the part a person needs: the top-level message is
 * `Request contains an invalid argument`, and `fieldViolations[0].field` is the
 * argument. The shapes are `google.rpc.BadRequest`, `ErrorInfo` and `DebugInfo`
 * — read by the field names they have in common rather than by `@type`, since
 * a detail nobody anticipated is still worth printing.
 */
function aboutOf(details: unknown): string | undefined {
    if (!Array.isArray(details)) {
        return undefined;
    }
    const clauses: string[] = [];
    for (const entry of details.flatMap(violations)) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const said = entry as Record<string, unknown>;
        const parts = VIOLATION.map((key) => said[key]).filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (parts.length) {
            clauses.push(parts.join(': '));
        }
    }
    return clauses.length ? clauses.join('; ') : undefined;
}

/** A detail entry, or the violations inside it when it carries a list of them. */
function violations(entry: unknown): unknown[] {
    const list = (entry as { fieldViolations?: unknown } | null)?.fieldViolations;
    return Array.isArray(list) ? list : [entry];
}

/** One line, however many the vendor sent, and never a whole document. */
function collapse(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

/** What an opaque failure blames, from the first cause that says something else. */
function blamed(err: unknown, said: string): string | undefined {
    const seen = new Set<unknown>();
    let at: unknown = (err as { cause?: unknown } | null)?.cause;
    while (at && typeof at === 'object' && !seen.has(at)) {
        seen.add(at);
        const link = at as { message?: unknown; code?: unknown; cause?: unknown };
        const message = collapse(typeof link.message === 'string' ? link.message : '');
        if (message && message !== said) {
            return typeof link.code === 'string' ? `${message} (${link.code})` : message;
        }
        at = link.cause;
    }
    return undefined;
}

/** Appends the status and the vendor's symbol, unless the sentence has them. */
function mark(text: string, status: number | undefined, code: string | undefined): string {
    const marks: string[] = [];
    if (status !== undefined && !text.includes(String(status))) {
        marks.push(String(status));
    }
    if (code && !text.toLowerCase().includes(code.toLowerCase())) {
        marks.push(code);
    }
    return marks.length ? `${text} (${marks.join(' ')})` : text;
}
