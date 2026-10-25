import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { FILE_ENVS } from './keys.ts';

// ---------------------------------------------------------------------------
// The project's `.env`
//
// A project is a directory, and some of what it needs to run is particular to
// it: the token for the service it talks to, the base url of the environment
// it talks to it in. The keyring answers "what can this machine pay for"; this
// answers "what does this project need", and the two are different questions
// often enough to be worth two places.
//
// Precedence is the same one everything else here uses — the real environment
// always wins. What is already set in the shell is left alone, this file fills
// the gaps, and the keyring fills whatever is still missing after that. So a
// variable exported for one command still overrides the file, which is the
// behaviour anybody typing `FOO=bar zen run` is expecting.
//
// The names, not the values, are what leaves this module: they are what the
// sandbox forwards, and forwarding by name is what keeps a secret out of an
// argv. See `forwarded()` in sandbox.ts for the rest of that story.
// ---------------------------------------------------------------------------

/** The file, relative to the project directory. */
export const ENV_FILE = '.env';

export interface ProjectEnv {
    /** the file it was read from */
    path: string;
    /** every name the file declares, whether or not its value won */
    names: string[];
}

/**
 * Reads `<dir>/.env` into `process.env`, without overwriting anything already
 * set, and returns the names it found. A project with no such file is not a
 * problem to report — most have none — so the answer is simply `undefined`.
 *
 * The names are returned in full, including the ones the environment already
 * answered: the variable is in play either way, and the sandbox forwards by
 * name, so what it needs to know is which names matter and not which of the
 * two sources supplied them.
 */
export function loadProjectEnv(dir: string): ProjectEnv | undefined {
    const path = join(dir, ENV_FILE);
    if (!existsSync(path)) {
        return undefined;
    }
    const names: string[] = [];
    for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
        if (value === undefined) {
            continue;
        }
        names.push(name);
        // An empty string is not an answer: tools test for absence, and a
        // commented-out line someone half-filled in should not shadow a key
        // the keyring has.
        if (!process.env[name]) {
            process.env[name] = located(dir, name, value);
        }
    }
    return { path, names };
}

/**
 * A service-account file is normally kept beside the `.env` that names it, so
 * a relative path there means relative to the *project* — not to wherever the
 * command happened to be run, which is what both the Google SDK and podman's
 * bind mount would otherwise make of it.
 */
function located(dir: string, name: string, value: string): string {
    return FILE_ENVS.includes(name) && !isAbsolute(value) ? resolve(dir, value) : value;
}
