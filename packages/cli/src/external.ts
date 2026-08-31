import type { Command } from './command.ts';
import type { External } from './commands/index.ts';
import { CliError, EXIT, bold } from './term.ts';

// ---------------------------------------------------------------------------
// Loading a command out of a sibling package
//
// The specifier is built rather than written, and that is the whole mechanism:
// a literal `import('@zenera/faker/command')` would make the sibling a
// compile-time dependency of `zen` — a project reference, a package.json entry,
// and a cycle, since the sibling already depends on `zen`. Built, it is
// resolved by Node at the moment the user asks for it and by nobody before.
//
// So `zen --help` costs nothing whether or not the package is there, and a
// machine without it gets the same answer the SDK loader gives: the line to run.
// ---------------------------------------------------------------------------

const entry = (ext: External): string => `${ext.package}/command`;

/**
 * Whether the package is installed. Resolution only — nothing is loaded, and
 * `import.meta.resolve` is the same resolver the import below will use, so it
 * cannot say yes to something that then fails to load.
 */
export function hasExternal(ext: External): boolean {
    try {
        import.meta.resolve(entry(ext));
        return true;
    } catch {
        return false;
    }
}

export async function loadExternal(name: string, ext: External): Promise<Command> {
    let module: unknown;
    try {
        module = await import(entry(ext));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
            throw new CliError(
                `zen ${name} needs ${ext.package}`,
                EXIT.usage,
                `run ${bold(ext.install)}`,
            );
        }
        throw err;
    }

    // A sibling built against another version of this package is a version
    // problem, and saying so beats `undefined is not a function`.
    const command = (module as { command?: Command }).command;
    if (typeof command?.run !== 'function') {
        throw new CliError(
            `${ext.package} does not export a command`,
            EXIT.failed,
            `it may be older than this ${bold('zen')} — try ${bold(ext.install)}`,
        );
    }
    return command;
}
