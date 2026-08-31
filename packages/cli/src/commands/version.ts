import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Command } from '../command.ts';
import { dim, json, pad, write } from '../term.ts';

/** A package's version, read from its manifest rather than inlined at build time. */
export async function versionOf(manifest: URL): Promise<string> {
    const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    return version;
}

export const cliManifest = new URL('../../package.json', import.meta.url);

/**
 * Where the library actually resolved from — the workspace symlink in
 * development, `node_modules` once installed. Going through its `exports` map
 * rather than a guessed path means this also fails loudly if that map is ever
 * broken, which is the one packaging mistake nothing else catches.
 */
function libraryManifest(): URL {
    const resolve = createRequire(import.meta.url).resolve;
    return new URL(`file://${resolve('@zenera/neo/package.json')}`);
}

export const version: Command = {
    summary: 'Print the CLI, library and Node versions.',
    usage: 'zen version',
    run: async (ctx) => {
        const versions = {
            cli: await versionOf(cliManifest),
            '@zenera/neo': await versionOf(libraryManifest()),
            node: process.versions.node,
        };
        if (ctx.json) {
            json(versions);
            return;
        }
        const width = Math.max(...Object.keys(versions).map((k) => k.length));
        for (const [name, value] of Object.entries(versions)) {
            write(`${dim(pad(name, width))}  ${value}`);
        }
    },
};
