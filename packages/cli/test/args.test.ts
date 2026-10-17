import { describe, expect, it } from 'vitest';
import { parse } from '../src/args.ts';
import { CliError, EXIT } from '../src/term.ts';

function failure(fn: () => unknown): CliError {
    try {
        fn();
    } catch (e) {
        return e as CliError;
    }
    throw new Error('expected parse to throw');
}

describe('parse', () => {
    it('names an unknown option without Node’s advice about --', () => {
        const err = failure(() => parse(['--banana'], {}, 'zen demo [options]'));

        expect(err).toBeInstanceOf(CliError);
        expect(err.message).toBe("Unknown option '--banana'");
        expect(err.code).toBe(EXIT.usage);
        expect(err.hint).toBe('zen demo [options]');
    });

    it('still reports other mistakes as usage errors', () => {
        const err = failure(() => parse(['--name'], { name: { type: 'string' } }, 'zen demo'));

        expect(err.code).toBe(EXIT.usage);
        expect(err.hint).toBe('zen demo');
    });
});
