import { existsSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { dim, json, note, usageError, write } from '../term.ts';

// ---------------------------------------------------------------------------
// zen view - a folder in the browser, redrawn as its files change
// ---------------------------------------------------------------------------

const USAGE = 'zen view [path] [--port <n>] [--open] [--hidden]';

interface Flags {
    port?: string;
    open?: boolean;
    hidden?: boolean;
}

const OPTIONS = {
    port: { type: 'string' },
    open: { type: 'boolean' },
    hidden: { type: 'boolean' },
} as const;

/** Resolves when one of the signals arrives, and stops listening for them. */
function until(signals: readonly NodeJS.Signals[]): Promise<void> {
    return new Promise<void>((settle) => {
        const done = (): void => {
            for (const s of signals) {
                process.off(s, done);
            }
            settle();
        };
        for (const s of signals) {
            process.once(s, done);
        }
    });
}

/** A file inside the cwd is served from the cwd, so its links up the tree still resolve. */
export function placeOf(cwd: string, target: string): { root: string; start: string } {
    if (statSync(target).isDirectory()) {
        return { root: target, start: '/' };
    }
    const rel = relative(cwd, target);
    const parts = rel.split(sep);
    // A dot-folder on the way would be refused as hidden, so serve from the file's own folder.
    const within =
        rel !== '' &&
        rel !== '..' &&
        !rel.startsWith(`..${sep}`) &&
        !parts.slice(0, -1).some((p) => p.startsWith('.'));
    const root = within ? cwd : dirname(target);
    const path = within ? parts : [basename(target)];
    return { root, start: `/${path.join('/')}` };
}

export const view: Command = {
    summary: 'Show a folder in the browser: markdown, diagrams and code, redrawn as files change.',
    usage: USAGE,
    details: [
        'Serves [path] (default: here) on 127.0.0.1 until Ctrl-C and prints its address.',
        'Markdown is drawn with its tables and mermaid diagrams; json, jsonl, python and',
        'other code is highlighted; a directory is a listing. An open page follows its',
        'file: when the file changes, only what changed is redrawn. Images, html and pdf',
        'are handed to the browser as they are. Dotfiles are not served without --hidden,',
        'and .env and .git never are.',
        '',
        'Options:',
        '  --port <n>     This port. Default: one derived from the folder, so a page left',
        '                 open reconnects after a restart; any free one if it is taken.',
        '  --open         Open the page in the browser.',
        '  --hidden       Serve dotfiles too.',
        '',
        'Examples:',
        '  zen view',
        '  zen view finetune/STATUS.md --open',
    ],
    banner: { head: 'Zenera', accent: 'View', subtitle: 'Live File Viewer', hue: 'pink' },
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(ctx.args, OPTIONS, USAGE);
        if (positionals.length > 1) {
            throw usageError('zen view takes one path', USAGE);
        }
        const target = resolve(ctx.cwd, positionals[0] ?? '.');
        if (!existsSync(target)) {
            throw usageError(`no such file or directory: ${target}`);
        }
        let port: number | undefined;
        if (values.port !== undefined) {
            port = Number(values.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                throw usageError('--port takes a port number', `got "${values.port}"`);
            }
        }
        const { root, start } = placeOf(ctx.cwd, target);
        const { openBrowser, serveView } = await import('@zenera/view');
        const server = await serveView({
            root,
            start,
            hidden: values.hidden ?? false,
            ...(port !== undefined ? { port } : {}),
        });
        if (ctx.json) {
            json({ url: server.url, root: server.root, port: server.port });
        } else {
            write(server.url);
            note(dim(`serving ${server.root} · Ctrl-C stops it`));
        }
        if (values.open) {
            openBrowser(server.url);
        }
        await until(['SIGINT', 'SIGTERM']);
        await server.close();
    },
};
