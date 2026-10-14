import { type JSX, memo, useEffect, useState } from 'react';

// Mermaid needs a real DOM to measure text, so diagrams are drawn here, not on
// the server. A diagram redraws only when its own source changes, and keeps
// the last picture on screen while the next one is drawn.

interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<{ svg: string }>;
}

const KEEP = 64;
const drawn = new Map<string, string>();
let api: Promise<MermaidApi> | undefined;
let seq = 0;

function load(): Promise<MermaidApi> {
    // Built at run time, so the bundler leaves Mermaid to the server's copy.
    const url = new URL('/_view/mermaid/mermaid.esm.min.mjs', location.origin).href;
    api ??= (import(/* @vite-ignore */ url) as Promise<{ default: MermaidApi }>).then((m) => {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        m.default.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: dark ? 'dark' : 'default',
        });
        return m.default;
    });
    return api;
}

function remember(source: string, svg: string): void {
    drawn.set(source, svg);
    if (drawn.size > KEEP) {
        drawn.delete(drawn.keys().next().value!);
    }
}

export const Mermaid = memo(function Mermaid({ source }: { source: string }): JSX.Element {
    const [svg, setSvg] = useState(() => drawn.get(source));
    const [error, setError] = useState<string>();
    useEffect(() => {
        const known = drawn.get(source);
        if (known) {
            setSvg(known);
            setError(undefined);
            return;
        }
        let live = true;
        const id = `mermaid-${++seq}`;
        load()
            .then((m) => m.render(id, source))
            .then(
                (out) => {
                    remember(source, out.svg);
                    if (live) {
                        setSvg(out.svg);
                        setError(undefined);
                    }
                },
                (err: unknown) => {
                    document.getElementById(`d${id}`)?.remove();
                    if (live) {
                        setError(err instanceof Error ? err.message : String(err));
                    }
                },
            );
        return () => {
            live = false;
        };
    }, [source]);
    return (
        <div className="mermaid">
            {svg ? (
                <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
                <pre className="mermaid-source">{source}</pre>
            )}
            {error ? <div className="mermaid-error">diagram error: {error}</div> : null}
        </div>
    );
});
