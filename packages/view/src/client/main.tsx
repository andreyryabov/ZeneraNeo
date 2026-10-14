import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Heading, View } from '../types.ts';
import { Hast } from './Hast.tsx';
import './style.css';

// One page for every path: it asks the server for the file the address names
// and redraws whenever the server sends it again. Links between drawn files
// change the address without a reload; anything else is left to the browser.

type Link = 'connecting' | 'live' | 'lost';

/** What the browser shows better itself - the server hands these over raw. */
const NATIVE = /\.(html?|svg|pdf|png|jpe?g|gif|webp|avif|bmp|ico)$/i;

function jump(hash: string): void {
    const id = decodeURIComponent(hash.slice(1));
    if (id) {
        document.getElementById(id)?.scrollIntoView();
    }
}

function clock(ms: number | undefined): string {
    return ms ? new Date(ms).toLocaleTimeString() : '';
}

function Crumbs({ path }: { path: string }): JSX.Element {
    const parts = path.split('/').filter(Boolean);
    return (
        <span className="crumbs">
            <a href="/">top</a>
            {parts.map((p, i) => (
                <span key={i}>
                    {' / '}
                    {i === parts.length - 1 ? (
                        <b>{p}</b>
                    ) : (
                        <a
                            href={`/${parts
                                .slice(0, i + 1)
                                .map(encodeURIComponent)
                                .join('/')}/`}
                        >
                            {p}
                        </a>
                    )}
                </span>
            ))}
        </span>
    );
}

function Toc({ toc }: { toc: Heading[] }): JSX.Element {
    const [active, setActive] = useState<string>();
    const nav = useRef<HTMLElement>(null);
    useEffect(() => {
        const mark = (): void => {
            let current = toc[0]?.id;
            for (const h of toc) {
                const at = document.getElementById(h.id);
                if (at && at.getBoundingClientRect().top > 80) {
                    break;
                }
                current = h.id;
            }
            setActive(current);
        };
        mark();
        addEventListener('scroll', mark, { passive: true });
        return () => removeEventListener('scroll', mark);
    }, [toc]);
    useEffect(() => {
        const on = nav.current?.querySelector<HTMLElement>('a.on');
        const box = nav.current;
        if (
            on &&
            box &&
            (on.offsetTop < box.scrollTop ||
                on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight)
        ) {
            box.scrollTop = on.offsetTop - box.clientHeight / 2;
        }
    }, [active]);
    return (
        <nav id="toc" ref={nav}>
            {toc.map((h) => (
                <a
                    key={h.id}
                    href={`#${encodeURIComponent(h.id)}`}
                    title={h.text}
                    className={[
                        h.depth === 1 ? 'top' : h.depth === 3 ? 'sub' : '',
                        h.id === active ? 'on' : '',
                    ]
                        .join(' ')
                        .trim()}
                >
                    {h.text}
                </a>
            ))}
        </nav>
    );
}

function App(): JSX.Element {
    const [path, setPath] = useState(location.pathname);
    const [view, setView] = useState<View>();
    const [link, setLink] = useState<Link>('connecting');
    const hash = useRef<string | undefined>(location.hash);

    useEffect(() => {
        setView(undefined);
        setLink('connecting');
        const source = new EventSource(`/_view/events?path=${encodeURIComponent(path)}`);
        source.addEventListener('view', (e) =>
            setView(JSON.parse((e as MessageEvent<string>).data) as View),
        );
        source.onopen = () => setLink('live');
        source.onerror = () =>
            setLink(source.readyState === EventSource.CLOSED ? 'lost' : 'connecting');
        return () => source.close();
    }, [path]);

    useEffect(() => {
        const onPop = (): void => {
            hash.current = location.hash;
            setPath(location.pathname);
        };
        const onClick = (e: MouseEvent): void => {
            if (
                e.defaultPrevented ||
                e.button !== 0 ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey
            ) {
                return;
            }
            const a = (e.target as Element | null)?.closest('a');
            const href = a?.getAttribute('href') ?? a?.getAttribute('xlink:href');
            if (!a || !href || a.getAttribute('target')) {
                return;
            }
            const url = new URL(href, location.href);
            if (
                url.origin !== location.origin ||
                url.pathname.startsWith('/_view/') ||
                url.searchParams.has('raw') ||
                NATIVE.test(url.pathname)
            ) {
                return;
            }
            e.preventDefault();
            history.pushState(null, '', url);
            if (url.pathname === path) {
                jump(url.hash);
                return;
            }
            hash.current = url.hash;
            setPath(url.pathname);
        };
        addEventListener('popstate', onPop);
        document.addEventListener('click', onClick);
        return () => {
            removeEventListener('popstate', onPop);
            document.removeEventListener('click', onClick);
        };
    }, [path]);

    // Only the first arrival of a page moves the scroll; later ones are edits.
    useLayoutEffect(() => {
        if (!view || hash.current === undefined) {
            return;
        }
        const target = hash.current;
        hash.current = undefined;
        if (target) {
            jump(target);
        } else {
            scrollTo(0, 0);
        }
    }, [view]);

    useEffect(() => {
        document.title = view?.title ?? 'view';
    }, [view?.title]);

    const toc = view && view.toc.length > 1 ? view.toc : undefined;
    const file = view && view.kind !== 'directory' && view.kind !== 'missing';
    return (
        <>
            {toc ? <Toc toc={toc} /> : null}
            <div id="page" className={toc ? 'with-toc' : ''}>
                <header>
                    <Crumbs path={view?.path ?? decodeURIComponent(path)} />
                    <span className="aside">
                        {file ? (
                            <a
                                href={`${encodeURI(view.path)}?raw`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                raw
                            </a>
                        ) : null}
                        {view?.mtimeMs ? <span>changed {clock(view.mtimeMs)}</span> : null}
                        <span className={`link ${link}`}>
                            {link === 'live'
                                ? 'live'
                                : link === 'connecting'
                                  ? 'reconnecting…'
                                  : 'not available'}
                        </span>
                    </span>
                </header>
                <main id="doc" className={view?.kind ?? ''}>
                    {view ? (
                        <Hast key={view.path} tree={view.hast} />
                    ) : (
                        <p className="note">loading…</p>
                    )}
                    {view?.truncated ? (
                        <p className="note">
                            Showing the first {view.truncated.shown} of {view.truncated.bytes}{' '}
                            bytes.
                        </p>
                    ) : null}
                </main>
            </div>
        </>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
