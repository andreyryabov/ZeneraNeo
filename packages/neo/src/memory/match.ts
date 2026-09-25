// ---------------------------------------------------------------------------
// Matching, with nothing learned in between
//
// Everything here is exact. A substring is a substring, which is the whole
// point of the surface built on it: the vector index answers "what is near
// this", and near is a ranking, so it can only ever return the top of a list.
// When the question is "does the word `password` appear anywhere at all", a
// ranking is the wrong instrument and no amount of tuning makes it the right
// one.
//
// This is a copy of `common/match.ts` in @zenera/rag, and has to be: the
// dependency runs rag → cli → neo, so neo importing rag would close a cycle.
// Two differences earn their place rather than being drift. A matcher returns
// the offset it matched at, because grep reports *where*, not merely whether;
// and there are no globs, because the haystack here is prose and a glob is
// anchored to the whole string, so `error*` would match a line only when the
// line began with the word.
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

/** The offset of the first match in `text`, or -1. */
export type Matcher = (text: string) => number;

/**
 * A finder over a string. Literal by default: someone typing `user.id` means
 * those seven characters, and a dot that quietly matched anything would be a
 * worse answer than no answer.
 */
export function matcher(pattern: string, options: MatchOptions = {}): Matcher {
    guard(pattern);
    if (!options.regex) {
        if (options.caseSensitive) {
            return (text) => text.indexOf(pattern);
        }
        const needle = pattern.toLowerCase();
        return (text) => text.toLowerCase().indexOf(needle);
    }
    const expression = compile(pattern, options.caseSensitive ? '' : 'i');
    // `lastIndex` is not carried between calls: the flags never include `g`.
    return (text) => text.search(expression);
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
