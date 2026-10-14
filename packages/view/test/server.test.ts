import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveView, stablePort, type ViewServer } from '../src/server.ts';
import type { View } from '../src/types.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'zenera-view-server-')));
const root = join(base, 'root');
let server: ViewServer;

interface Reply {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

/** A raw request: `fetch` would normalise `..` out of the path before it left. */
function get(path: string, host = `127.0.0.1:${server.port}`): Promise<Reply> {
    return new Promise((done, fail) => {
        const req = request(
            { host: '127.0.0.1', port: server.port, path, headers: { host } },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (d: string) => (body += d));
                res.on('end', () =>
                    done({ status: res.statusCode ?? 0, headers: res.headers, body }),
                );
            },
        );
        req.on('error', fail);
        req.end();
    });
}

/** Subscribes to a path; `views` fills as the server pushes. */
function subscribe(path: string): { views: View[]; close: () => void } {
    const views: View[] = [];
    let buffer = '';
    const req = request({
        host: '127.0.0.1',
        port: server.port,
        path: `/_view/events?path=${encodeURIComponent(path)}`,
        headers: { host: `127.0.0.1:${server.port}` },
    });
    req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
            buffer += d;
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = /^data: (.*)$/m.exec(block)?.[1];
                if (/^event: view$/m.test(block) && data) {
                    views.push(JSON.parse(data) as View);
                }
            }
        });
    });
    req.on('error', () => {});
    req.end();
    return { views, close: () => req.destroy() };
}

async function until(test: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!test()) {
        if (Date.now() > deadline) {
            throw new Error('timed out');
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

const text = (v: View | undefined): string => JSON.stringify(v?.hast ?? '');

beforeAll(async () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Hello\n\nUpdated: 1\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    writeFileSync(join(root, 'report.html'), '<script>1</script>');
    writeFileSync(join(root, 'sub', 'data.json'), '{"a":1}\n');
    writeFileSync(join(base, 'outside.md'), '# outside\n');
    symlinkSync(join(base, 'outside.md'), join(root, 'escape.md'));
    server = await serveView({ root, port: 0, start: '/README.md', pollMs: 200 });
});

afterAll(async () => {
    await server.close();
    rmSync(base, { recursive: true, force: true });
});

describe('the view server', () => {
    it('answers with the page shell, and names the start page in its url', async () => {
        expect(server.url).toBe(`http://127.0.0.1:${server.port}/README.md`);
        const r = await get('/README.md');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toMatch(/text\/html/);
        expect(r.body).toContain('/_view/app.js');
        expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    });

    it('renders a file as a tree on request', async () => {
        const r = await get('/_view/render?path=/README.md');
        const view = JSON.parse(r.body) as View;
        expect(view.kind).toBe('markdown');
        expect(view.title).toBe('Hello');
    });

    it('serves a file raw when asked, and html only in a sandbox', async () => {
        const json = await get('/sub/data.json?raw');
        expect(json.body).toBe('{"a":1}\n');
        expect(json.headers['content-security-policy']).toBe('sandbox');
        const html = await get('/report.html');
        expect(html.body).toBe('<script>1</script>');
        expect(html.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    });

    it('refuses anything outside the root, and secrets inside it', async () => {
        for (const path of [
            '/../outside.md',
            '/sub/../../outside.md',
            '/%2e%2e/outside.md',
            '/..%2foutside.md',
            '/escape.md',
            '/.env',
            '/.env?raw',
            '/_view/render?path=/.env',
            '/_view/render?path=/../outside.md',
        ]) {
            const r = await get(path);
            expect([
                path,
                r.status,
                r.body.includes('outside') || r.body.includes('SECRET'),
            ]).toEqual([path, r.status === 200 ? 200 : 404, false]);
            if (r.status === 200) {
                expect(r.body).toContain('/_view/app.js');
            }
        }
    });

    it('refuses a Host that is not this server', async () => {
        expect((await get('/README.md', 'evil.example:80')).status).toBe(403);
        expect((await get('/README.md', `localhost:${server.port}`)).status).toBe(200);
    });

    it('pushes a file again when it is replaced by a rename', async () => {
        const sub = subscribe('/README.md');
        try {
            await until(() => sub.views.length === 1);
            expect(text(sub.views[0])).toContain('Updated: 1');
            writeFileSync(join(root, 'README.md.tmp'), '# Hello\n\nUpdated: 2\n');
            renameSync(join(root, 'README.md.tmp'), join(root, 'README.md'));
            await until(() => sub.views.some((v) => text(v).includes('Updated: 2')));
        } finally {
            sub.close();
        }
    });

    it('fills a page in when its file is first written', async () => {
        const sub = subscribe('/sub/later.md');
        try {
            await until(() => sub.views.length === 1);
            expect(sub.views[0]!.kind).toBe('missing');
            writeFileSync(join(root, 'sub', 'later.md'), '# Later\n');
            await until(() => sub.views.some((v) => v.kind === 'markdown'));
        } finally {
            sub.close();
        }
    });
});

describe('the port', () => {
    it('is the same for the same root', () => {
        const port = stablePort(root);
        expect(port).toBe(stablePort(`${root}/`));
        expect(port).toBeGreaterThanOrEqual(20000);
        expect(port).toBeLessThan(40000);
    });

    it('falls back to any free port when its own is taken', async () => {
        const blocker = createServer();
        await new Promise<void>((r) => blocker.listen(stablePort(base), '127.0.0.1', () => r()));
        try {
            const other = await serveView({ root: base });
            expect(other.port).not.toBe(stablePort(base));
            await other.close();
        } finally {
            blocker.close();
        }
    });
});
