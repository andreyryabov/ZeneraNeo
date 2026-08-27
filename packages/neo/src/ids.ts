import { randomBytes } from 'node:crypto';

/**
 * All nondeterminism that the kernel needs (ids and wall clock) enters through
 * this one interface, passed explicitly as an argument. Reading a clock from
 * module scope would make replay-based hosts (Temporal) nondeterministic and
 * would leak state between concurrent runs.
 */
export interface IdClock {
    newId(): string;
    now(): string;
}

// Crockford base32 — the ULID alphabet (no I, L, O, U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
    let out = '';
    let rest = ms;
    for (let i = 0; i < TIME_LEN; i++) {
        out = ALPHABET[rest % 32] + out;
        rest = Math.floor(rest / 32);
    }
    return out;
}

function encodeRandom(): string {
    // One byte per character wastes 3 bits each, which is irrelevant here and
    // keeps the mapping obvious (no bit-packing arithmetic to get wrong).
    const bytes = randomBytes(RANDOM_LEN);
    let out = '';
    for (const b of bytes) {
        out += ALPHABET[b % 32];
    }
    return out;
}

/** Lexicographically sortable, collision-resistant id (ULID layout). */
export function ulid(now = Date.now()): string {
    return encodeTime(now) + encodeRandom();
}

export const systemClock: IdClock = {
    newId: () => ulid(),
    now: () => new Date().toISOString(),
};
