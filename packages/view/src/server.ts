import { spawn } from 'node:child_process';
import {
    closeSync,
    createReadStream,
    existsSync,
    openSync,
    readSync,
    realpathSync,
    statSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locate } from './paths.ts';
import { drawn, MAX_BYTES, renderPath } from './render.ts';
import type { View } from './types.ts';
import { Watcher } from './watch.ts';

// ---------------------------------------------------------------------------
// The server
//
// Loopback only. Every path is a file under the root or nothing; the Host
// header must name this server, so a page elsewhere cannot reach it through a
// DNS name pointed at 127.0.0.1. A file the page draws is pushed to it over
// server-sent events as a sanitized tree, again each time the file changes; any
// other file is served as it is, under a sandboxing CSP.
// ---------------------------------------------------------------------------

export interface ViewOptions {
    /** the directory served; nothing outside it is read */
    root: string;
    /** default: a port derived from the root, or any free one if that is taken */
    port?: number;
    /** the page the returned `url` opens, as a URL path */
    start?: string;
    /** serve dotfiles too; `.env`, `.git` and the like never are */
    hidden?: boolean;
    /** most of one file rendered, in bytes */
    maxBytes?: number;
    /** most pages open at once */
    maxClients?: number;
    pollMs?: number;
}

export interface ViewServer {
    readonly url: string;
    readonly origin: string;
    readonly port: number;
    readonly root: string;
    close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PORT_BASE = 20000;
const PORT_SPAN = 20000;
const BEAT_MS = 25_000;

/** The same root asks for the same port, so an open tab reconnects after a restart. */
export function stablePort(root: string): number {
    let h = 0x811c9dc5;
    for (const ch of realpathSync(resolve(root))) {
        h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    }
    return PORT_BASE + (h % PORT_SPAN);
}

/** The platform opener, without a shell, so the URL stays one argument. */
export function openBrowser(url: string): void {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    spawn(command, [url], { stdio: 'ignore', detached: true })
        .on('error', () => {})
        .unref();
}

export async function serveView(options: ViewOptions): Promise<ViewServer> {
    const root = realpathSync(resolve(options.root));
    if (!statSync(root).isDirectory()) {
        throw new Error(`not a directory: ${root}`);
    }
    const hidden = options.hidden ?? false;
    const render = { maxBytes: options.maxBytes ?? MAX_BYTES, hidden };
    const maxClients = options.maxClients ?? 64;
    const watcher = new Watcher({ pollMs: options.pollMs });
    const clients = new Set<ServerResponse>();
    let hosts = new Set<string>();

    const server = createServer((req, res) => {
        try {
            handle(req, res);
        } catch (err) {
            if (!res.headersSent) {
                plain(res, 500, err instanceof Error ? err.message : String(err));
            } else {
                res.end();
            }
        }
    });

    function handle(req: IncomingMessage, res: ServerResponse): void {
        if (!hosts.has(req.headers.host ?? '')) {
            return plain(res, 403, 'unknown host');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return plain(res, 405, 'read only');
        }
        const url = new URL(req.url ?? '/', 'http://view');
        if (url.pathname.startsWith('/_view/')) {
            return internal(req, res, url);
        }
        const at = locate(root, url.pathname, hidden);
        if (!at) {
            return plain(res, 404, 'not found');
        }
        const file = isFile(at.abs);
        if (url.searchParams.has('raw') || (file && !drawn(at.abs))) {
            return file ? sendFile(res, at.abs, rawHeaders(at.abs)) : plain(res, 404, 'not found');
        }
        return page(res);
    }

    function internal(req: IncomingMessage, res: ServerResponse, url: URL): void {
        const name = url.pathname.slice('/_view/'.length);
        if (name === 'events') {
            return events(req, res, url);
        }
        if (name === 'render') {
            const at = locate(root, url.searchParams.get('path') ?? '/', hidden);
            return at
                ? send(res, 200, 'application/json', JSON.stringify(view(at.abs, at.path)))
                : plain(res, 404, 'not found');
        }
        if (name === 'health') {
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, root }));
        }
        if (name === 'app.js' || name === 'app.css') {
            const file = join(clientDir(), name);
            return existsSync(file)
                ? sendFile(res, file, {
                      'content-type': TYPES[extname(name)]!,
                      'cache-control': 'no-cache',
                  })
                : plain(res, 404, `${name} is not built: npm run build`);
        }
        if (name.startsWith('mermaid/')) {
            const dir = mermaidDir();
            const at = dir && locate(dir, name.slice('mermaid/'.length));
            return at && isFile(at.abs)
                ? sendFile(res, at.abs, {
                      'content-type': TYPES[extname(at.abs)] ?? 'text/javascript',
                      'cache-control': 'max-age=3600',
                  })
                : plain(res, 404, 'not found');
        }
        return plain(res, 404, 'not found');
    }

    function view(abs: string, path: string): View {
        try {
            return renderPath(abs, path, render);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                path,
                kind: 'text',
                title: path,
                toc: [],
                hast: {
                    type: 'root',
                    children: [
                        {
                            type: 'element',
                            tagName: 'pre',
                            properties: {},
                            children: [{ type: 'text', value: `cannot read it: ${message}` }],
                        },
                    ],
                },
            };
        }
    }

    function events(req: IncomingMessage, res: ServerResponse, url: URL): void {
        const at = locate(root, url.searchParams.get('path') ?? '/', hidden);
        if (!at) {
            return plain(res, 404, 'not found');
        }
        if (clients.size >= maxClients) {
            return plain(res, 503, 'too many pages open');
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
        });
        res.write('retry: 1000\n\n');
        let last = '';
        const push = (): void => {
            const json = JSON.stringify(view(at.abs, at.path));
            if (json !== last) {
                last = json;
                res.write(`event: view\ndata: ${json}\n\n`);
            }
        };
        push();
        const off = watcher.subscribe(at.abs, push);
        const beat = setInterval(() => res.write(': beat\n\n'), BEAT_MS);
        beat.unref();
        clients.add(res);
        req.on('close', () => {
            off();
            clearInterval(beat);
            clients.delete(res);
        });
    }

    const preferred = options.port ?? stablePort(root);
    let port: number;
    try {
        port = await listen(server, preferred);
    } catch (err) {
        if (options.port !== undefined || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            throw err;
        }
        port = await listen(server, 0);
    }
    hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
    const origin = `http://${HOST}:${port}`;
    return {
        url: `${origin}${encodeURI(options.start ?? '/')}`,
        origin,
        port,
        root,
        close: async () => {
            watcher.close();
            for (const res of clients) {
                res.end();
            }
            clients.clear();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

function listen(server: Server, port: number): Promise<number> {
    return new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(port, HOST, () => {
            server.off('error', fail);
            done((server.address() as AddressInfo).port);
        });
    });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.json': 'application/json; charset=utf-8',
};

const PAGE_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    // Mermaid writes a <style> into every diagram it draws.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

/** A served file is untrusted: it runs, if at all, in an origin of its own. */
function rawHeaders(abs: string): Record<string, string> {
    const ext = extname(abs).toLowerCase();
    const type =
        TYPES[ext] ?? (looksBinary(abs) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    const html = ext === '.html' || ext === '.htm';
    return {
        'content-type': type,
        'content-security-policy': html ? 'sandbox allow-scripts allow-popups' : 'sandbox',
        'cache-control': 'no-cache',
    };
}

function page(res: ServerResponse): void {
    send(
        res,
        200,
        'text/html; charset=utf-8',
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>view</title>
<link rel="stylesheet" href="/_view/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/_view/app.js"></script>
</body>
</html>
`,
        { 'content-security-policy': PAGE_CSP, 'cache-control': 'no-cache' },
    );
}

function send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string,
    headers: Record<string, string> = {},
): void {
    res.writeHead(status, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...headers,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
}

function plain(res: ServerResponse, status: number, text: string): void {
    send(res, status, 'text/plain; charset=utf-8', `${text}\n`);
}

function sendFile(res: ServerResponse, abs: string, headers: Record<string, string>): void {
    const size = statSync(abs).size;
    res.writeHead(200, {
        'content-length': size,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...headers,
    });
    if (res.req.method === 'HEAD') {
        res.end();
        return;
    }
    createReadStream(abs)
        .on('error', () => res.destroy())
        .pipe(res);
}

function isFile(abs: string): boolean {
    try {
        return statSync(abs).isFile();
    } catch {
        return false;
    }
}

function looksBinary(abs: string): boolean {
    let fd: number | undefined;
    try {
        fd = openSync(abs, 'r');
        const head = Buffer.alloc(8192);
        return head.subarray(0, readSync(fd, head, 0, head.length, 0)).includes(0);
    } catch {
        return true;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

// ---------------------------------------------------------------------------
// Where the browser half and Mermaid come from
// ---------------------------------------------------------------------------

function clientDir(): string {
    // dist/client beside the compiled server; ../dist/client when run from source.
    for (const rel of ['./client/', '../dist/client/']) {
        const dir = fileURLToPath(new URL(rel, import.meta.url));
        if (existsSync(join(dir, 'app.js'))) {
            return dir;
        }
    }
    return fileURLToPath(new URL('./client/', import.meta.url));
}

let mermaidAt: string | null | undefined;

function mermaidDir(): string | undefined {
    if (mermaidAt === undefined) {
        try {
            mermaidAt = realpathSync(dirname(fileURLToPath(import.meta.resolve('mermaid'))));
        } catch {
            mermaidAt = null;
        }
    }
    return mermaidAt ?? undefined;
}
