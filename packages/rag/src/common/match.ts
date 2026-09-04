// ---------------------------------------------------------------------------
// Matching, with nothing learned in between
//
// Everything here is exact. A glob matches the characters it names and a
// substring is a substring, which is the whole point of the surfaces built on
// it: a vector index answers "what is near this", and near is a ranking, so it
// can only ever return the top of a list. When the question is "does the word
// `password` appear anywhere at all", a ranking is the wrong instrument and no
// amount of tuning makes it the right one.
//
// A pattern may arrive from a model, so a regex is a bounded promise: the
// length is capped here and the scan that uses it keeps a deadline.
// ---------------------------------------------------------------------------

/** Long enough for any honest pattern, short enough to bound a bad one. */
export const MAX_PATTERN = 200;

export class PatternError extends Error {}

export interface MatchOptions {
    /** read the pattern as a regular expression rather than as a literal */
    regex?: boolean;
    caseSensitive?: boolean;
}

export type Matcher = (text: string) => boolean;

/**
 * A predicate over a string. Literal by default: someone typing `user.id` means
 * those seven characters, and a dot that quietly matched anything would be a
 * worse answer than no answer.
 */
export function matcher(pattern: string, options: MatchOptions = {}): Matcher {
    guard(pattern);
    if (!options.regex) {
        if (options.caseSensitive) {
            return (text) => text.includes(pattern);
        }
        const needle = pattern.toLowerCase();
        return (text) => text.toLowerCase().includes(needle);
    }
    const expression = compile(pattern, options.caseSensitive ? '' : 'i');
    // `lastIndex` is not carried between calls: the flags never include `g`.
    return (text) => expression.test(text);
}

/**
 * A glob, matched against the whole string. Globs rather than regexes because
 * these are for naming things — a path, a schema — and a star is what everyone
 * reaches for first.
 */
export function wildcard(pattern: string, options: { caseSensitive?: boolean } = {}): Matcher {
    guard(pattern);
    const source = [...pattern]
        .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escape(char)))
        .join('');
    const expression = compile(`^${source}$`, options.caseSensitive ? '' : 'i');
    return (text) => expression.test(text);
}

/** Whether a pattern is asking to be read as a glob at all. */
export const isGlob = (pattern: string): boolean => /[*?]/.test(pattern);

/**
 * What someone means when they type a name into a filter. With a star in it,
 * a glob; without one, a substring — because `password` typed into `--name` is
 * a search for the word, and a whole-string match would answer nothing and
 * look like the field does not exist.
 *
 * `regex` settles it outright, and has to: a star is punctuation in both
 * languages, so `^/(users|teams)/.*` read as a glob would match nothing and
 * never say why.
 */
export function loose(pattern: string, options: MatchOptions = {}): Matcher {
    if (options.regex) {
        return matcher(pattern, options);
    }
    return isGlob(pattern) ? wildcard(pattern, options) : matcher(pattern, options);
}

/** True when any of the patterns matches; no patterns means no opinion. */
export function anyOf(matchers: readonly Matcher[]): Matcher | undefined {
    if (matchers.length === 0) {
        return undefined;
    }
    return (text) => matchers.some((match) => match(text));
}

// ---------------------------------------------------------------------------

function guard(pattern: string): void {
    if (pattern.length === 0) {
        throw new PatternError('the pattern is empty');
    }
    if (pattern.length > MAX_PATTERN) {
        throw new PatternError(`the pattern is longer than ${MAX_PATTERN} characters`);
    }
}

function compile(source: string, flags: string): RegExp {
    try {
        return new RegExp(source, flags);
    } catch (err) {
        throw new PatternError(`invalid pattern: ${(err as Error).message}`);
    }
}

const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
