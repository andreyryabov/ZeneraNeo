import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Hast } from '../src/client/Hast.tsx';
import { markdown } from '../src/render.ts';

const draw = (md: string): string =>
    renderToStaticMarkup(createElement(Hast, { tree: markdown(md) }));

describe('the page', () => {
    it('puts a table in its own scrolling box', () => {
        expect(draw('| a |\n| - |\n| 1 |\n')).toMatch(/^<div class="table-wrap"><table><thead>/);
    });

    it('turns a mermaid fence into a diagram, shown as its source until drawn', () => {
        const html = draw('```mermaid\nflowchart LR\n  A --> B\n```\n');
        expect(html).toContain('<div class="mermaid"><pre class="mermaid-source">flowchart LR');
        expect(html).not.toContain('language-mermaid');
    });

    it('keeps highlighted code and links as they came', () => {
        const html = draw('[next](cases/a/FEEDBACK.md#history)\n\n```json\n{"a": 1}\n```\n');
        expect(html).toContain('<a href="cases/a/FEEDBACK.md#history">next</a>');
        expect(html).toContain('<span class="hljs-attr">&quot;a&quot;</span>');
    });
});
