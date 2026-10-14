import type { Element, ElementContent, Root } from 'hast';
import { type Components, type ExtraProps, toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { ComponentProps, JSX } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { Mermaid } from './Mermaid.tsx';

// The server's tree, as React elements. Index keys are what let React keep
// every unchanged node when the same file arrives again with one number moved.

function textOf(nodes: ElementContent[]): string {
    return nodes
        .map((n) => (n.type === 'text' ? n.value : n.type === 'element' ? textOf(n.children) : ''))
        .join('');
}

function isMermaid(node: Element | undefined): node is Element {
    const c = node?.properties.className;
    return Array.isArray(c) && c.includes('language-mermaid');
}

function Pre({ node, ...props }: ComponentProps<'pre'> & ExtraProps): JSX.Element {
    const code = node?.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
    );
    return isMermaid(code) ? <Mermaid source={textOf(code.children)} /> : <pre {...props} />;
}

function Table({ node: _, ...props }: ComponentProps<'table'> & ExtraProps): JSX.Element {
    return (
        <div className="table-wrap">
            <table {...props} />
        </div>
    );
}

const components: Partial<Components> = { pre: Pre, table: Table };

export function Hast({ tree }: { tree: Root }): JSX.Element {
    return toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        components,
        passNode: true,
        passKeys: true,
    });
}
