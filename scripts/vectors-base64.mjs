#!/usr/bin/env node
/**
 * Rewrites cached vectors from a JSON array of numbers to base64 of their bytes.
 *
 * The cache heals itself without this: an entry in the old shape is a miss, and
 * the put that follows overwrites it. But the miss costs an embedding, and a
 * store built from a large corpus is tens of gigabytes and hours of billing
 * that nobody should pay twice. This walks it once and converts in place.
 *
 * Only the value changes, never the key, so every entry keeps its path and the
 * mtime it was found with — the store reads mtime as *last used*, and a
 * migration is not a use. Anything already converted, or not a vector at all,
 * is left exactly as it was, so running this twice is the same as running it
 * once.
 *
 *   node scripts/vectors-base64.mjs [--dry-run] [--dir <cache dir>]
 */

import { randomUUID } from 'node:crypto';
import {
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KIND = 'vectors';
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const at = args.indexOf('--dir');
const root = at === -1 ? join(homedir(), '.zenera', 'neo', 'cache') : args[at + 1];

if (root === undefined) {
    console.error('vectors-base64: --dir needs a path');
    process.exit(1);
}

const dirents = (dir) => {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
};

/** Every entry file of the vectors kind, one shard directory at a time. */
function* walk(dir) {
    for (const shard of dirents(dir)) {
        if (!shard.isDirectory()) {
            continue;
        }
        for (const file of dirents(join(dir, shard.name))) {
            if (file.isFile() && file.name.endsWith('.json')) {
                yield join(dir, shard.name, file.name);
            }
        }
    }
}

const encode = (numbers) => Buffer.from(Float32Array.from(numbers).buffer).toString('base64');

const size = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let at = 0;
    let n = bytes;
    while (n >= 1024 && at < units.length - 1) {
        n /= 1024;
        at++;
    }
    return `${at === 0 ? n : n.toFixed(1)} ${units[at]}`;
};

const counts = { converted: 0, already: 0, skipped: 0, failed: 0, before: 0, after: 0 };

for (const path of walk(join(root, KIND))) {
    let info;
    let stored;
    try {
        info = statSync(path);
        stored = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        counts.failed++;
        continue;
    }

    if (typeof stored?.value === 'string') {
        counts.already++;
        continue;
    }
    if (!Array.isArray(stored?.value) || !stored.value.every((n) => typeof n === 'number')) {
        counts.skipped++;
        continue;
    }

    const text = JSON.stringify({ ...stored, value: encode(stored.value) }, null, 2) + '\n';

    if (!dry) {
        // Written beside and renamed over, so a build reading the store at the
        // same time sees the old entry or the new one and never half of either.
        const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
            writeFileSync(tmp, text, { mode: info.mode & 0o777 });
            renameSync(tmp, path);
            utimesSync(path, info.atime, info.mtime);
        } catch (err) {
            rmSync(tmp, { force: true });
            counts.failed++;
            console.error(`vectors-base64: ${path}: ${err.message}`);
            continue;
        }
    }

    counts.converted++;
    counts.before += info.size;
    counts.after += Buffer.byteLength(text);
}

const saved = counts.before - counts.after;
console.log(
    [
        `${dry ? 'would convert' : 'converted'} ${counts.converted}`,
        `already base64 ${counts.already}`,
        `not a vector ${counts.skipped}`,
        `unreadable ${counts.failed}`,
    ].join(', '),
);
if (counts.converted > 0) {
    const percent = ((saved / counts.before) * 100).toFixed(0);
    console.log(
        `${size(counts.before)} -> ${size(counts.after)}, ${size(saved)} smaller (${percent}%)`,
    );
}
