#!/usr/bin/env node
// Bundles the browser half (src/client) into dist/client/app.js + app.css.
// tsc never emits it: it needs the DOM, React and a bundler, the server needs none of them.

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));

// esbuild honours any Yarn PnP manifest in a PARENT directory (a stray ~/.pnp.cjs
// is enough) and then refuses node_modules; resolve bare imports the way Node does.
const nodeResolution = {
    name: 'node-resolution',
    setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => ({
            path: createRequire(join(args.resolveDir, 'x.js')).resolve(args.path),
        }));
    },
};

await build({
    absWorkingDir: pkg,
    entryPoints: { app: 'src/client/main.tsx' },
    outdir: 'dist/client',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [nodeResolution],
    logLevel: 'warning',
});
