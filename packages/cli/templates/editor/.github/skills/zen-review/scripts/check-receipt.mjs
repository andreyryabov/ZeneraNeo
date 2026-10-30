import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [action, mode = 'full', fix] = process.argv.slice(2);
const modes = {
    full: [],
    'no-sandbox': ['--no-sandbox'],
    fast: ['--no-models', '--no-sandbox'],
};
const receipt = '.tmp/review-check.json';

function fingerprint() {
    const hash = createHash('sha256');
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
            if (dir === '.' && ['.git', '.tmp', '.spec-sync'].includes(entry.name)) continue;
            const path = `${dir}/${entry.name}`;
            hash.update(JSON.stringify([path, entry.isDirectory(), lstatSync(path).mode]));
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile())
                hash.update(createHash('sha256').update(readFileSync(path)).digest('hex'));
            else throw new Error(`cannot reuse validation with a symlink or special file: ${path}`);
        }
    }
    walk('.');
    return hash.digest('hex');
}

function version() {
    const result = spawnSync('zen', ['--version'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('zen --version failed');
    return result.stdout.trim();
}

try {
    if (
        !Object.hasOwn(modes, mode) ||
        !['run', 'verify'].includes(action) ||
        (fix !== undefined && (action !== 'run' || fix !== '--fix')) ||
        process.argv.length > 5
    ) {
        throw new Error('usage: check-receipt.mjs run|verify full|no-sandbox|fast [--fix]');
    }
    if (action === 'run') {
        mkdirSync('.tmp', { recursive: true });
        // Invalidate the previous result before trying a new check.
        writeFileSync(receipt, 'null\n');
        const before = fingerprint();
        const result = spawnSync('zen', ['check', ...modes[mode], ...(fix ? [fix] : [])], {
            stdio: 'inherit',
        });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status ?? 1);
        const after = fingerprint();
        if (mode !== 'full' && before !== after) {
            throw new Error(
                'files changed during a partial check (possibly a sandbox pin repair); run check full before reusing validation',
            );
        }
        writeFileSync(
            receipt,
            JSON.stringify({
                root: resolve('.'),
                mode,
                version: version(),
                fingerprint: after,
            }) + '\n',
        );
        console.log(`check receipt: ${receipt}`);
    } else {
        const saved = JSON.parse(readFileSync(receipt, 'utf8'));
        const covers =
            saved &&
            (saved.mode === 'full' ||
                saved.mode === mode ||
                (saved.mode === 'no-sandbox' && mode === 'fast'));
        if (
            !covers ||
            saved.root !== resolve('.') ||
            saved.version !== version() ||
            saved.fingerprint !== fingerprint()
        ) {
            throw new Error('check receipt is stale or lacks required probes; run a fresh check');
        }
        console.log(`zen check: reusing successful ${saved.mode} check`);
    }
} catch (error) {
    console.error(`check receipt: ${error.message}`);
    process.exitCode = 1;
}
