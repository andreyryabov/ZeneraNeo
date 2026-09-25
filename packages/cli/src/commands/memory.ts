import {
    ALL_AGENTS,
    buildMemoryReport,
    GREP_FIELDS,
    grepMemory,
    hostPath,
    memoryDir,
    MemoryError,
    MemoryIndex,
    MemoryStore,
    MergeConflicts,
    mergeMemories,
    readProjectConfig,
    renderMemoryHtml,
    type GrepField,
    type MemoryNode,
    type MergeReport,
    type SkippedFile,
} from '@zenera/neo';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    ago,
    bold,
    bytes,
    CliError,
    confirm,
    count,
    cyan,
    dim,
    EXIT,
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

const USAGE = 'zen memory [stats|ls|grep|show|export|merge|forget] [args] [options]';

interface Flags {
    project?: string;
    dir?: string;
    kind?: string;
    audience?: string;
    files?: boolean;
    stale?: boolean;
    all?: boolean;
    regex?: boolean;
    'case-sensitive'?: boolean;
    in?: string[];
    'ids-only'?: boolean;
    limit?: string;
    out?: string;
    open?: boolean;
    yes?: boolean;
    force?: boolean;
    'dry-run'?: boolean;
    'no-dedupe'?: boolean;
}

const SUBCOMMANDS = ['stats', 'ls', 'grep', 'show', 'export', 'merge', 'forget'];

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
    banner: { head: 'Zenera', accent: 'Memory', subtitle: 'Knowledge Graph', hue: 'purple' },
    details: [
        '  stats                  Size, vocabulary, and whether it is embedded.',
        '  ls                     Nodes, newest first. Changes nothing.',
        '  grep <pattern>         Every node containing it, with the matching lines.',
        '  show <id>              One node in full, with what it links to.',
        '  export [file]          The whole graph as one HTML page.',
        '  merge <dir...>         Fold other memories into this one.',
        '  forget <id...>         Remove nodes, their vectors and their files.',
        '',
        '  --project <name|dir>   Which project. Defaults to the one you are in.',
        '  --dir <dir>            Read this memory directory instead of the project’s.',
        '  --kind <name>          Only this kind of node.',
        '  --audience <name>      Only nodes committed under this label.',
        '  --files                Only nodes that remember a file.',
        '  --stale                Only nodes something has superseded.',
        '  --all                  For `grep`: superseded nodes too, marked as such.',
        '  --regex                Read the pattern as a regular expression, per line.',
        '  --case-sensitive       Match case exactly. Off by default.',
        '  --in <text|metadata|file>  Where to look. Repeatable. All three by default.',
        '  --ids-only             Print bare ids, for piping into `zen memory show`.',
        '  --limit <n>            Rows to list. Default 30.',
        '  --out <file>           Where `export` writes. Default memory.html.',
        '  --open                 Open the exported page.',
        '  --dry-run              Say what `merge` would do, and stop.',
        '  --no-dedupe            Keep memories `merge` would otherwise fold together.',
        '  --force                Let `merge` pick a winner where two copies disagree.',
        '  --yes                  Do not ask before removing or merging.',
        '',
        'Everything here reads the graph *unmasked* — every audience, including',
        'what no agent can see. That is the point: when a mask is the thing',
        'that is wrong, the hidden part is what you need to look at.',
        '',
        '`export` is the one to reach for. It writes a single self-contained',
        'page: the node list on the left, the graph in the middle, and whatever',
        'you click on the right, file contents and all.',
        '',
        '`grep` is the other one. Recall ranks, so it answers “what is closest”',
        'and can never answer “is this in here at all”; `grep` reads every node',
        'exactly — text, metadata and the bytes of remembered files — and the',
        'count it reports is the true one even when the list was cut:',
        '',
        '  zen memory grep ‘staging.example.com’ --in metadata --in file',
        '',
        'It is the only subcommand that does not take the directory lock, so it',
        'works on a memory a run is writing, and on the read-only /memory mount',
        'inside a sandbox.',
        '',
        '`merge` is for warming a memory in parallel. The lock is per directory,',
        'so N runs write N memories; this folds them back into one:',
        '',
        '  zen memory merge .tmp/warmup-*/memory',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                dir: { type: 'string' },
                kind: { type: 'string' },
                audience: { type: 'string' },
                files: { type: 'boolean' },
                stale: { type: 'boolean' },
                all: { type: 'boolean' },
                regex: { type: 'boolean' },
                'case-sensitive': { type: 'boolean' },
                in: { type: 'string', multiple: true },
                'ids-only': { type: 'boolean' },
                limit: { type: 'string' },
                out: { type: 'string' },
                open: { type: 'boolean' },
                yes: { type: 'boolean' },
                force: { type: 'boolean' },
                'dry-run': { type: 'boolean' },
                'no-dedupe': { type: 'boolean' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'stats';
        if (!SUBCOMMANDS.includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        const rest = positionals.slice(1);
        // `merge` is the one subcommand that may write a memory into existence;
        // every other one is an inspector and a missing manifest is a mistake.
        // And `grep` is the one that declines the lock: the two moments it is
        // most wanted are while a run is writing, and against the read-only
        // /memory mount — in both of which claiming it fails.
        const opened = await open(ctx.cwd, values.project, values.dir, {
            create: what === 'merge',
            lock: what !== 'grep',
        });

        try {
            switch (what) {
                case 'stats':
                    return stats(opened, ctx.json);
                case 'ls':
                    return list(opened, values, ctx.json);
                case 'grep':
                    return await grep(opened, rest, values, ctx.json);
                case 'show':
                    return show(opened, rest, ctx.json);
                case 'export':
                    return await write_(opened, rest, values, ctx.cwd, ctx.json);
                case 'merge':
                    return await merge(opened, rest, values, ctx.cwd, ctx.json);
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
 *
 * A named directory is opened as it stands, project or no project: a graph
 * copied out of a running session is the one most worth looking at, and it
 * should not have to be given an `agents.yaml` first.
 *
 * `create` drops the requirement that anything be there yet, for `merge`,
 * which has somewhere to put what it reads even when the destination is a name
 * nothing has written to.
 *
 * `lock` is off for a read that must not fail on a busy or read-only memory.
 * The lock exists to stop two writers losing each other's edges; a reader that
 * took it would only be refusing itself.
 */
async function open(
    cwd: string,
    want: string | undefined,
    at: string | undefined,
    opts: { create?: boolean; lock?: boolean } = {},
): Promise<Opened> {
    const { create = false, lock = true } = opts;
    if (at) {
        const dir = resolve(cwd, at);
        if (!create && !existsSync(join(dir, 'manifest.json'))) {
            throw usageError(`${dir} is not a memory`, 'no manifest.json in it');
        }
        return { store: await MemoryStore.open(dir, { lock }), dir, project: basename(dir) };
    }
    const project = await resolveProject({ cwd, project: want });
    const { config } = readProjectConfig(project.dir);
    const dir = memoryDir(project.dir, config);
    if (!dir) {
        throw usageError(
            `${project.name} has no memory`,
            'give an agent `memory: true` in agents.yaml, or add a `memory:` block',
        );
    }
    if (!create && !existsSync(join(dir, 'manifest.json'))) {
        throw usageError(
            `${project.name} has a memory configured but nothing in it yet`,
            'it is written the first time an agent commits something',
        );
    }
    return { store: await MemoryStore.open(dir, { lock }), dir, project: project.name };
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
// grep
// ---------------------------------------------------------------------------

/**
 * The exhaustive read, and the counterpart to recall rather than a variant of
 * it. Recall ranks, and a ranking returns the top of a list, so it cannot tell
 * "there is nothing" from "nothing was close enough" — which is the question
 * anyone actually has when they come to a memory looking for a name, a path or
 * a command they think an agent wrote down.
 */
async function grep(o: Opened, rest: string[], flags: Flags, asJson: boolean): Promise<void> {
    const pattern = rest[0];
    if (!pattern || rest.length > 1) {
        throw usageError('grep takes exactly one pattern', 'zen memory grep <pattern>');
    }
    const limit = Number(flags.limit ?? LISTED);
    if (!Number.isInteger(limit) || limit < 1) {
        throw usageError(`--limit wants a positive whole number, got ${flags.limit}`, USAGE);
    }
    for (const field of flags.in ?? []) {
        if (!(GREP_FIELDS as readonly string[]).includes(field)) {
            throw usageError(`--in wants one of ${GREP_FIELDS.join(', ')}, got ${field}`, USAGE);
        }
    }

    let res;
    try {
        res = await grepMemory(o.store, pattern, {
            // Unmasked, like everything else here: this is the person who owns
            // the files, not an agent inside a run.
            kinds: flags.kind ? [flags.kind] : undefined,
            audience: flags.audience,
            files: flags.files,
            in: flags.in as GrepField[] | undefined,
            stale: flags.stale ? 'only' : flags.all ? 'include' : 'exclude',
            regex: flags.regex,
            caseSensitive: flags['case-sensitive'],
            limit,
        });
    } catch (err) {
        if (err instanceof MemoryError) {
            throw new CliError(err.message, EXIT.usage, err.hint);
        }
        throw err;
    }

    if (asJson) {
        json({
            found: res.found,
            truncated: res.truncated,
            matches: res.matches.map((m) => ({
                id: m.node.id,
                kind: m.node.kind,
                stale: m.stale,
                file: m.node.file ? hostPath(o.dir, m.node.file) : undefined,
                hits: m.hits,
                more: m.more,
            })),
            unsearched: res.skipped,
        });
        return;
    }
    if (flags['ids-only']) {
        writeAll(res.matches.map((m) => m.node.id));
        return;
    }
    if (!res.found) {
        note(`nothing matches ${pattern}`);
        unsearched(res.skipped);
        return;
    }

    for (const m of res.matches) {
        write(
            cyan(m.node.id) +
                ' ' +
                m.node.kind +
                (m.stale ? ' ' + yellow('superseded') : '') +
                (m.node.file ? ' ' + dim(m.node.file.path) : ''),
        );
        writeAll(table(m.hits.map((h) => [`  ${dim(h.where + ':' + h.line)}`, clip(h.text, 120)])));
        if (m.more) {
            write(dim(`  … ${count(m.more, 'more line')} in this node`));
        }
        write();
    }
    if (res.truncated) {
        note(dim(`${res.found - res.matches.length} more nodes — raise --limit`));
    }
    unsearched(res.skipped);
}

/**
 * Named rather than counted. A file that was not read is a hole in an answer
 * whose whole value is that it has none, so the ids have to be printable.
 */
function unsearched(skipped: readonly SkippedFile[]): void {
    if (!skipped.length) {
        return;
    }
    write();
    note(yellow(`${count(skipped.length, 'file')} not searched`));
    writeAll(table(skipped.map((s) => [`  ${cyan(s.id)}`, dim(s.reason), s.path])));
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
// merge
// ---------------------------------------------------------------------------

/**
 * Warming a memory is parallel work, and the lock is per directory, so N runs
 * produce N memories rather than one. This is the other half of that: it folds
 * them back together, offline and without a model.
 *
 * Divergence refuses rather than guesses. Two copies of the same memory that
 * disagree are a question about which piece of work was right, and answering
 * it silently is how a merge loses the answer.
 */
async function merge(
    o: Opened,
    dirs: string[],
    flags: Flags,
    cwd: string,
    asJson: boolean,
): Promise<void> {
    if (!dirs.length) {
        throw usageError(
            'merge takes at least one memory directory',
            'zen memory merge <dir...> [--dir <into>]',
        );
    }
    const dryRun = flags['dry-run'] === true;
    const held = o.store.graph.order;

    if (held && !dryRun && !flags.yes) {
        if (!isInteractive()) {
            throw usageError(
                `${o.project} already remembers ${count(held, 'node')}`,
                'pass --yes, or --dry-run to see what would change first',
            );
        }
        note(
            `${count(dirs.length, 'memory', 'memories')} into ${bold(o.dir)} ` +
                dim(`· ${count(held, 'node')} already there`),
        );
        if (!(await confirm('Merge?'))) {
            note('nothing merged');
            return;
        }
    }

    let report: MergeReport;
    try {
        report = await mergeMemories(
            o.store,
            dirs.map((d) => resolve(cwd, d)),
            { dedupe: !flags['no-dedupe'], force: flags.force, dryRun },
        );
    } catch (err) {
        if (err instanceof MergeConflicts) {
            throw diverged(err, cwd, asJson);
        }
        throw err;
    }

    if (asJson) {
        json(report);
        return;
    }
    writeAll(
        table([
            [dim('memory'), dim('nodes'), dim('new'), dim('shared'), dim('folded'), dim('files')],
            ...report.sources.map((s) => [
                near(s.dir, cwd),
                String(s.nodes),
                s.added ? green(String(s.added)) : '0',
                String(s.shared),
                s.twins ? yellow(String(s.twins)) : '0',
                String(s.files),
            ]),
        ]),
    );
    write();
    const summary = [
        count(report.added, 'node'),
        `${count(report.edges, 'edge')}`,
        `${report.twins} folded`,
    ].join(', ');
    note(dryRun ? `${yellow('would add')} ${summary}` : `${green('merged')} ${summary}`);
}

/**
 * A refusal with the ids to look at. It is deliberately not a summary: the
 * point of stopping is that a person decides, and they cannot decide from a
 * count.
 */
function diverged(err: MergeConflicts, cwd: string, asJson: boolean): CliError {
    if (asJson) {
        json({ error: err.message, conflicts: err.conflicts });
    } else {
        writeAll(
            table(
                err.conflicts.map((c) => [
                    cyan(c.id),
                    dim(`r${c.mine} ↔ r${c.theirs}`),
                    clip(c.text, 48),
                    dim(near(c.dir, cwd)),
                ]),
            ),
        );
        write();
    }
    return new CliError(err.message, EXIT.failed, err.hint);
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

/** A path as it was probably typed: relative when it is below here, absolute when it is not. */
function near(dir: string, cwd: string): string {
    const rel = relative(cwd, dir);
    return rel && !rel.startsWith('..') ? rel : dir;
}
