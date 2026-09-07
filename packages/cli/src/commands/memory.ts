import {
    ALL_AGENTS,
    buildMemoryReport,
    hostPath,
    memoryDir,
    MemoryIndex,
    MemoryStore,
    readProjectConfig,
    renderMemoryHtml,
    type MemoryNode,
} from '@zenera/neo';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    ago,
    bold,
    bytes,
    confirm,
    count,
    cyan,
    dim,
    green,
    isInteractive,
    json,
    note,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen memory [stats|ls|show|export|forget] [args] [options]';

interface Flags {
    project?: string;
    kind?: string;
    audience?: string;
    files?: boolean;
    stale?: boolean;
    limit?: string;
    out?: string;
    open?: boolean;
    yes?: boolean;
}

const SUBCOMMANDS = ['stats', 'ls', 'show', 'export', 'forget'];

/** Enough to see the shape of it; the rest is a number. */
const LISTED = 30;

// ---------------------------------------------------------------------------
// zen memory
//
// The graph from outside the agents, and the reason it needs a command is that
// there is otherwise no way to answer the question memory always eventually
// raises: *why did it recall that?* Recall is masked, ranked and truncated by
// design, so what an agent sees is never the whole picture — and when the
// picture is what is wrong, you need the part that was hidden.
//
// So everything here reads the graph unmasked. That is safe because it is
// local: this command is a person at a terminal in the project directory, not
// an agent inside a run, and the mask exists to keep agents apart rather than
// to keep secrets from the person who owns the files.
//
// Nothing here contacts a model. The store is opened without an embedder, so
// inspection is free and works offline; the price is that `ls` filters by text
// rather than by meaning, which is the right trade for a debugging tool.
// ---------------------------------------------------------------------------

export const memory: Command = {
    summary: 'What the agents remember, and getting rid of it.',
    usage: USAGE,
    details: [
        '  stats                  Size, vocabulary, and whether it is embedded.',
        '  ls                     Nodes, newest first. Changes nothing.',
        '  show <id>              One node in full, with what it links to.',
        '  export [file]          The whole graph as one HTML page.',
        '  forget <id...>         Remove nodes, their vectors and their files.',
        '',
        '  --project <name|dir>   Which project. Defaults to the one you are in.',
        '  --kind <name>          Only this kind of node.',
        '  --audience <name>      Only nodes committed under this label.',
        '  --files                Only nodes that remember a file.',
        '  --stale                Only nodes something has superseded.',
        '  --limit <n>            Rows to list. Default 30.',
        '  --out <file>           Where `export` writes. Default memory.html.',
        '  --open                 Open the exported page.',
        '  --yes                  Do not ask before removing.',
        '',
        'Everything here reads the graph *unmasked* — every audience, including',
        'what no agent can see. That is the point: when a mask is the thing',
        'that is wrong, the hidden part is what you need to look at.',
        '',
        '`export` is the one to reach for. It writes a single self-contained',
        'page: the node list on the left, the graph in the middle, and whatever',
        'you click on the right, file contents and all.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                kind: { type: 'string' },
                audience: { type: 'string' },
                files: { type: 'boolean' },
                stale: { type: 'boolean' },
                limit: { type: 'string' },
                out: { type: 'string' },
                open: { type: 'boolean' },
                yes: { type: 'boolean' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'stats';
        if (!SUBCOMMANDS.includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        const rest = positionals.slice(1);
        const opened = await open(ctx.cwd, values.project);

        try {
            switch (what) {
                case 'stats':
                    return stats(opened, ctx.json);
                case 'ls':
                    return list(opened, values, ctx.json);
                case 'show':
                    return show(opened, rest, ctx.json);
                case 'export':
                    return await write_(opened, rest, values, ctx.cwd, ctx.json);
                default:
                    return await forget(opened, rest, values, ctx.json);
            }
        } finally {
            opened.store.release();
        }
    },
};

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

interface Opened {
    store: MemoryStore;
    dir: string;
    project: string;
}

/**
 * The store, opened directly rather than through `loadProject`. Loading the
 * project would resolve models and read every prompt file to inspect a graph
 * that needs none of it — and would fail on a project whose credentials are
 * missing, which is exactly when someone is debugging.
 */
async function open(cwd: string, want: string | undefined): Promise<Opened> {
    const project = await resolveProject({ cwd, project: want });
    const { config } = readProjectConfig(project.dir);
    const dir = memoryDir(project.dir, config);
    if (!dir) {
        throw usageError(
            `${project.name} has no memory`,
            'give an agent `memory: true` in agents.yaml, or add a `memory:` block',
        );
    }
    if (!existsSync(join(dir, 'manifest.json'))) {
        throw usageError(
            `${project.name} has a memory configured but nothing in it yet`,
            'it is written the first time an agent commits something',
        );
    }
    return { store: await MemoryStore.open(dir), dir, project: project.name };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function stats(o: Opened, asJson: boolean): void {
    const nodes = o.store.graph.nodes();
    const edges = o.store.graph.edges();
    const stale = o.store.graph.superseded();
    const vectors = o.store.vectors;
    const files = nodes.filter((n) => n.file);
    const byKind = tally(nodes.map((n) => n.kind));
    const byRelation = tally(edges.map((e) => e.relation));
    const byAudience = tally(nodes.flatMap((n) => n.audience));

    if (asJson) {
        json({
            dir: o.dir,
            nodes: nodes.length,
            edges: edges.length,
            superseded: stale.size,
            files: {
                count: files.length,
                bytes: files.reduce((t, n) => t + (n.file?.bytes ?? 0), 0),
            },
            embedding: o.store.embedding,
            vectors: vectors ? { rows: vectors.rows, dims: vectors.dims } : undefined,
            kinds: byKind,
            relations: byRelation,
            audiences: byAudience,
        });
        return;
    }

    if (!nodes.length) {
        note(`nothing remembered yet ${dim(o.dir)}`);
        return;
    }

    write(bold(o.project) + dim(' · ' + o.dir));
    write();
    writeAll(
        table([
            [dim('nodes'), String(nodes.length)],
            [dim('edges'), String(edges.length)],
            [dim('superseded'), String(stale.size)],
            [
                dim('files'),
                files.length
                    ? `${files.length} · ${bytes(files.reduce((t, n) => t + (n.file?.bytes ?? 0), 0))}`
                    : '0',
            ],
            [
                dim('embedding'),
                o.store.embedding
                    ? `${o.store.embedding.model} ${dim(o.store.embedding.dimensions + 'd')}`
                    : yellow('none — recall falls back to term overlap'),
            ],
            [dim('vectors'), vectors ? `${vectors.rows} rows` : dim('—')],
        ]),
    );

    // A node without a vector cannot be found by meaning, only by luck. It is
    // the one silent failure this store has, so it is called out by name.
    if (vectors && vectors.rows < nodes.length) {
        write();
        note(yellow(`${count(nodes.length - vectors.rows, 'node')} with no vector`));
    }

    section('kinds', byKind);
    section('relations', byRelation);
    section('audiences', byAudience);
}

function section(title: string, counts: Record<string, number>): void {
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!rows.length) {
        return;
    }
    write();
    write(dim(title));
    writeAll(table(rows.map(([k, n]) => [`  ${cyan(k)}`, String(n)])));
}

function tally(values: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of values) {
        out[v] = (out[v] ?? 0) + 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function list(o: Opened, flags: Flags, asJson: boolean): void {
    const stale = o.store.graph.superseded();
    const limit = Number(flags.limit ?? LISTED);
    if (!Number.isInteger(limit) || limit < 1) {
        throw usageError(`--limit wants a positive whole number, got ${flags.limit}`, USAGE);
    }

    const all = o.store.graph
        .nodes()
        .filter((n) => !flags.kind || n.kind === flags.kind)
        .filter((n) => !flags.audience || n.audience.includes(flags.audience))
        .filter((n) => !flags.files || n.file)
        .filter((n) => !flags.stale || stale.has(n.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (asJson) {
        json({ total: all.length, nodes: all.slice(0, limit) });
        return;
    }
    if (!all.length) {
        note('nothing matches');
        return;
    }

    writeAll(
        table(
            all
                .slice(0, limit)
                .map((n) => [
                    cyan(n.id),
                    n.kind,
                    n.file ? dim('⎘ ' + n.file.format) : '',
                    clip(n.text, 56),
                    dim(ago(n.createdAt)),
                    stale.has(n.id) ? yellow('superseded') : '',
                ]),
        ),
    );
    if (all.length > limit) {
        write();
        note(dim(`${all.length - limit} more — raise --limit, or use \`zen memory export\``));
    }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function show(o: Opened, ids: string[], asJson: boolean): void {
    const id = ids[0];
    if (!id || ids.length > 1) {
        throw usageError('show takes exactly one id', 'zen memory show <id>');
    }
    const node = o.store.graph.get(id);
    if (!node) {
        throw usageError(`no node ${id}`, 'list them with `zen memory ls`');
    }
    const links = o.store.graph.neighbors(id);

    if (asJson) {
        json({ node, links, file: node.file ? hostPath(o.dir, node.file) : undefined });
        return;
    }

    write(bold(node.id) + ' ' + cyan(node.kind));
    write();
    writeAll(
        table([
            [dim('revision'), String(node.revision)],
            [dim('used'), `${node.useCount}× · last ${ago(node.lastUsedAt)}`],
            [dim('created'), `${node.createdAt} ${dim(ago(node.createdAt))}`],
            [dim('updated'), node.updatedAt],
            [dim('audience'), node.audience.join(', ')],
        ]),
    );
    write();
    write(node.text);

    if (node.metadata) {
        write();
        write(dim('metadata'));
        write(JSON.stringify(node.metadata, null, 2));
    }
    if (node.file) {
        write();
        write(dim('file'));
        writeAll(
            table([
                [dim('  path'), hostPath(o.dir, node.file)],
                [dim('  size'), bytes(node.file.bytes)],
                [dim('  sha256'), node.file.sha256],
            ]),
        );
    }
    write();
    write(dim(`links (${links.length})`));
    if (!links.length) {
        note(dim('  nothing points here and it points nowhere'));
        return;
    }
    writeAll(
        table(
            links.map((e) => {
                const out = e.source === id;
                const other = out ? e.target : e.source;
                return [
                    `  ${out ? '→' : '←'} ${yellow(e.relation)}`,
                    cyan(other),
                    clip(o.store.graph.get(other)?.text ?? '', 48),
                ];
            }),
        ),
    );
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function write_(
    o: Opened,
    rest: string[],
    flags: Flags,
    cwd: string,
    asJson: boolean,
): Promise<void> {
    if (rest.length > 1) {
        throw usageError('export takes at most one file name', 'zen memory export [file]');
    }
    const named = rest[0] ?? flags.out ?? 'memory.html';
    const target = isAbsolute(named) ? named : resolve(cwd, named);

    const report = await buildMemoryReport(o.store, { title: `${o.project} · memory` });
    await writeFile(target, renderMemoryHtml(report), 'utf8');

    if (asJson) {
        json({ path: target, nodes: report.nodes.length, edges: report.edges.length });
    } else {
        note(
            `${green('wrote')} ${target} ${dim(
                `· ${count(report.nodes.length, 'node')}, ${count(report.edges.length, 'edge')}`,
            )}`,
        );
    }
    if (flags.open) {
        reveal(target);
    }
}

/**
 * Handing a path to the platform opener. `spawn` without a shell, so the path
 * is an argument rather than something a shell gets to interpret.
 */
function reveal(target: string): void {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    spawn(command, [target], { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/**
 * The only destructive thing here, and it is deliberately not the way to fix a
 * memory that turned out wrong — that is a new node and a `SUPERSEDES` edge,
 * which keeps the reason it changed. This is for what should never have been
 * written down: it takes the node, its vector and its file bytes together.
 */
async function forget(o: Opened, ids: string[], flags: Flags, asJson: boolean): Promise<void> {
    if (!ids.length) {
        throw usageError('forget takes at least one id', 'zen memory forget <id...>');
    }
    const found: MemoryNode[] = [];
    for (const id of ids) {
        const node = o.store.graph.get(id);
        if (!node) {
            throw usageError(`no node ${id}`, 'list them with `zen memory ls`');
        }
        found.push(node);
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            throw usageError('refusing to remove without confirmation', 'pass --yes');
        }
        writeAll(table(found.map((n) => [cyan(n.id), n.kind, clip(n.text, 56)])));
        write();
        if (!(await confirm(`Forget ${count(found.length, 'node')}?`))) {
            note('nothing removed');
            return;
        }
    }

    // The vector and the bytes go with the node, which `MemoryIndex` already
    // guarantees; `sees` is every audience in the graph, because this command
    // is the person who owns the files rather than an agent inside a run.
    const index = new MemoryIndex({ store: o.store });
    await index.forget(
        found.map((n) => n.id),
        [ALL_AGENTS, ...new Set(o.store.graph.nodes().flatMap((n) => n.audience))],
    );

    if (asJson) {
        json({ forgotten: found.map((n) => n.id) });
    } else {
        note(`${green('forgot')} ${count(found.length, 'node')}`);
    }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function clip(text: string, n: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
