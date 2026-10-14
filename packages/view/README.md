# @zenera/view

A live local viewer for a folder. Markdown is drawn with GitHub tables and
[Mermaid](https://mermaid.js.org) diagrams, code (`.json`, `.jsonl`, `.py`, `.ts`,
`.yaml`, `.patch`, …) is highlighted, a directory is a listing - and an open page
follows its file: when the file changes, only what changed is redrawn. No reload,
no lost scroll position, no flicker of diagrams that did not change.

```sh
npm i @zenera/view
```

```ts
import { serveView } from '@zenera/view';

const server = await serveView({ root: './reports', start: '/STATUS.md' });
console.log(server.url); // http://127.0.0.1:<port>/STATUS.md
// ...
await server.close();
```

With `@zenera/cli` installed the same thing is `zen view [path]`.

## How it works

The server parses each file into a sanitized HTML syntax tree (remark + GFM for
markdown, lowlight for code) and pushes it to the page over server-sent events -
on connect, and again whenever the file changes. The page is a small React app
that turns the tree into elements, so an update repaints only the nodes that
differ. Mermaid runs in the browser, from the copy installed with this package,
so nothing is fetched from the network.

Files are watched through their directory, so a writer that replaces a file by
renaming a temporary over it is followed; a slow poll backs up `fs.watch`.

## Options

| option       | default                        | meaning                                     |
| ------------ | ------------------------------ | ------------------------------------------- |
| `root`       | -                              | the directory served; nothing outside it    |
| `port`       | derived from `root`, else free | a page left open reconnects after a restart |
| `start`      | `/`                            | the page `url` opens                        |
| `hidden`     | `false`                        | serve dotfiles; `.env`, `.git` never are    |
| `maxBytes`   | 2 MB                           | the most of one file rendered               |
| `maxClients` | 64                             | pages open at once                          |

## Safety

- Listens on `127.0.0.1` only, and answers only requests whose `Host` names it,
  so a web page cannot reach it through a DNS name pointed at loopback.
- Every path is resolved to a real path under the root; `..`, symlinks out of
  the root, dotfiles and secrets are refused.
- Markdown is sanitized and raw HTML in it is dropped; the page runs under a
  strict Content-Security-Policy. Files served as they are (HTML, SVG, …) carry
  a `sandbox` CSP, so they run - if at all - in an origin of their own.

## License

MIT
