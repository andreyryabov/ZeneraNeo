#!/usr/bin/env node
// Parse every ```mermaid block in markdown with mermaid's own parser, so a broken
// diagram in a doc or a shipped template fails here and not in someone's preview.
//
//   node scripts/mermcheck.mjs                 every tracked .md
//   node scripts/mermcheck.mjs docs/a.md ...   just these

import { JSDOM } from 'jsdom';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Parsing is headless, but mermaid sanitizes label text through DOMPurify, which
// wants a window. Setting `navigator` too would throw: it is read-only on Node.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false });

const files = process.argv.slice(2);
const listed = () =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
        encoding: 'utf8',
    })
        .split('\n')
        .filter(Boolean);
const targets = files.length ? files : listed();

const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```/gm;

let blocks = 0;
let bad = 0;
for (const file of targets) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(FENCE)) {
        blocks++;
        const line = text.slice(0, match.index).split('\n').length;
        try {
            await mermaid.parse(match[1]);
        } catch (error) {
            bad++;
            console.error(`${file}:${line}  ${error instanceof Error ? error.message : error}`);
        }
    }
}

console.log(`mermcheck: ${blocks} diagram(s) in ${targets.length} file(s), ${bad} broken`);
process.exit(bad ? 1 : 0);
