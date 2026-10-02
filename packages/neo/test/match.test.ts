import { describe, expect, it } from 'vitest';
import {
    anyOf,
    isGlob,
    loose,
    matcher,
    MAX_PATTERN,
    PatternError,
    wildcard,
} from '../src/common/match.ts';

// ---------------------------------------------------------------------------
// The rules a pattern is read by
//
// These are the primitives underneath `list` and `grep`, and the whole reason
// those commands exist is that their answers are certain. So the certainty has
// to start here: a pattern means one thing, it means it whether or not the
// caller guessed the capitalisation, and a pattern that cannot be compiled is
// an error rather than a silent match of nothing.
// ---------------------------------------------------------------------------

describe('matcher', () => {
    it('matches anywhere in the text, which is what a search for a word means', () => {
        const has = matcher('password');
        expect(has('resetPasswordPayload')).toBe(true);
        expect(has('the password field')).toBe(true);
        expect(has('passphrase')).toBe(false);
    });

    it('ignores case, because nobody knows how a field was capitalised', () => {
        expect(matcher('PASSWORD')('user_password')).toBe(true);
        expect(matcher('password', { caseSensitive: true })('Password')).toBe(false);
    });

    it('takes the pattern literally unless told it is a regex', () => {
        // A dot is a dot to someone typing a field path, not "any character".
        expect(matcher('user.name')('userXname')).toBe(false);
        expect(matcher('user.name')('user.name')).toBe(true);
        expect(matcher('user.name', { regex: true })('userXname')).toBe(true);
    });

    it('reads a regex when asked, and blames the pattern when it will not compile', () => {
        expect(matcher('pass(word|phrase)', { regex: true })('passphrase')).toBe(true);
        expect(() => matcher('(unclosed', { regex: true })).toThrow(PatternError);
        expect(() => matcher('(unclosed', { regex: true })).toThrow(/invalid pattern/);
    });
});

describe('wildcard', () => {
    it('matches the whole string, so a glob is a shape and not a substring', () => {
        expect(wildcard('*/pets*')('/pets/{petId}')).toBe(true);
        expect(wildcard('/pets')('/pets/{petId}')).toBe(false);
        expect(wildcard('/pets*')('/pets/{petId}')).toBe(true);
    });

    it('gives * and ? their meanings and takes everything else literally', () => {
        expect(wildcard('user?')('users')).toBe(true);
        expect(wildcard('user?')('user')).toBe(false);
        // Regex punctuation in a glob is just punctuation.
        expect(wildcard('a.b')('axb')).toBe(false);
        expect(wildcard('a.b')('a.b')).toBe(true);
        expect(wildcard('*')('anything at all')).toBe(true);
    });

    it('ignores case like every other filter here', () => {
        expect(wildcard('*password*')('ResetPasswordPayload')).toBe(true);
    });
});

describe('loose', () => {
    it('is a glob when there are wildcards and a substring when there are none', () => {
        expect(isGlob('*Pet*')).toBe(true);
        expect(isGlob('Pet')).toBe(false);

        // The reason the distinction exists: a bare word must find something,
        // or an existing field looks absent.
        expect(loose('Password')('ResetPasswordPayload')).toBe(true);
        expect(loose('Password*')('ResetPasswordPayload')).toBe(false);
        expect(loose('*Password*')('ResetPasswordPayload')).toBe(true);
    });
});

describe('the guard on a pattern', () => {
    it('refuses an empty pattern rather than matching everything', () => {
        expect(() => matcher('')).toThrow(PatternError);
        expect(() => wildcard('')).toThrow(PatternError);
        // A pattern of spaces is not empty: someone grepping for indentation
        // or a two-word phrase means it.
        expect(() => matcher(' ')).not.toThrow();
    });

    it('refuses one long enough to be a mistake', () => {
        expect(() => matcher('x'.repeat(MAX_PATTERN + 1))).toThrow(/longer than 200/);
        expect(() => matcher('x'.repeat(MAX_PATTERN))).not.toThrow();
    });
});

describe('anyOf', () => {
    it('has no opinion when given nothing, so an absent filter filters nothing', () => {
        expect(anyOf([])).toBeUndefined();
    });

    it('accepts a text that any one of them accepts', () => {
        const either = anyOf([matcher('cat'), matcher('dog')])!;
        expect(either('a dog')).toBe(true);
        expect(either('a cat')).toBe(true);
        expect(either('a bird')).toBe(false);
    });
});
