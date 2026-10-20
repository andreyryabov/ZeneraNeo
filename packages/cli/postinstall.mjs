// dist/ is absent when the workspace is installed from source (before the first build).
import { existsSync } from 'node:fs';

const entry = new URL('./dist/postinstall.js', import.meta.url);
if (existsSync(entry)) {
    await import(entry.href);
}
