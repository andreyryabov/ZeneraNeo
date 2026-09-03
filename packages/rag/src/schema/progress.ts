import { CliError, EXIT } from '@zenera/cli/lib';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import type { Counts, Manifest, SourceRecord } from './files.ts';

// ---------------------------------------------------------------------------
// A build that says what it is doing
//
// Indexing a large document is minutes of silence with a directory slowly
// filling up, and the directory is the only thing a second person — or a second
// process, or an agent reading the tree — ever sees. So the build writes two
// files into it and keeps them true:
//
//   .lock       who is building this, right now. Gone when nothing is.
//   README.md   a progress report while it runs, and a description of what the
//               index holds once it does not.
//
// Nothing in either file is an absolute path. A project's `assets/` directory
// is mounted at `/assets` inside an agent's sandbox, so an index built there is
// read under a name this process never sees; a host path would be a lie there.
// ---------------------------------------------------------------------------

export const LOCK_FILE = '.lock';
export const README_FILE = 'README.md';

/** The floor on how often README.md is rewritten. */
const INTERVAL_MS = 5000;

export type Phase = 'reading' | 'graph' | 'embedding' | 'writing';

const PHASES: Record<Phase, string> = {
    reading: 'reading the documents',
    graph: 'building the graph',
    embedding: 'embedding',
    writing: 'writing the store',
};

export interface BuildPlan {
    /** where the index goes */
    dir: string;
    files: readonly string[];
    /** the embedding reference as it was typed */
    embedding: string;
    indexer: string;
}

export interface Journal {
    phase(name: Phase): void;
    /** what the documents turned out to hold, once they have been read */
    read(counts: Counts): void;
    progress(done: number, total: number): void;
    finish(manifest: Manifest): void;
    fail(reason: unknown): void;
}

interface Lock {
    pid: number;
    host: string;
    startedAt: string;
    indexer: string;
    embedding: string;
    documents: string[];
}

/**
 * Takes the directory, or refuses it. Two builds writing one index would
 * interleave their LanceDB writes and leave a store neither of them describes.
 */
export function beginBuild(plan: BuildPlan): Journal {
    const documents = plan.files.map((file) => basename(file));
    const started = Date.now();
    const lock: Lock = {
        pid: process.pid,
        host: hostname(),
        startedAt: new Date(started).toISOString(),
        indexer: plan.indexer,
        embedding: plan.embedding,
        documents,
    };

    mkdirSync(plan.dir, { recursive: true });
    claim(join(plan.dir, LOCK_FILE), lock);

    let phase: Phase = 'reading';
    let counts: Counts | undefined;
    let done = 0;
    let total = 0;
    let wroteAt = 0;
    let closed = false;

    const write = (body: string): void => {
        // Through a temp name, so a reader never catches half a file.
        const target = join(plan.dir, README_FILE);
        const temp = `${target}.tmp`;
        writeFileSync(temp, body);
        renameSync(temp, target);
        wroteAt = Date.now();
    };

    const report = (): void =>
        write(
            building({
                documents,
                embedding: plan.embedding,
                started,
                phase,
                done,
                total,
                counts,
            }),
        );

    const maybe = (): void => {
        if (!closed && Date.now() - wroteAt >= INTERVAL_MS) {
            report();
        }
    };

    // The first embedding request can block for ten seconds or more, so a purely
    // event-driven throttle would leave the elapsed line frozen through it.
    const ticker = setInterval(maybe, INTERVAL_MS);
    ticker.unref();

    const close = (body: string): void => {
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(ticker);
        write(body);
        rmSync(join(plan.dir, LOCK_FILE), { force: true });
    };

    report();

    return {
        phase(name) {
            phase = name;
            maybe();
        },
        read(seen) {
            counts = seen;
            total = seen.entities;
            maybe();
        },
        progress(at, of) {
            done = at;
            total = of;
            maybe();
        },
        finish(manifest) {
            close(complete(plan.dir, manifest, Date.now() - started));
        },
        fail(reason) {
            close(failed({ documents, phase, reason, started }));
        },
    };
}

/**
 * `wx` makes the create and the check one operation, so two builds racing for
 * the same directory cannot both win. A lock whose process is gone is stale by
 * definition and is taken rather than respected — a crashed build must not make
 * a directory permanently unbuildable.
 */
function claim(path: string, lock: Lock): void {
    const body = `${JSON.stringify(lock, null, 4)}\n`;
    try {
        writeFileSync(path, body, { flag: 'wx' });
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }
    const held = readLock(path);
    if (held && held.host === hostname() && alive(held.pid)) {
        throw new CliError(
            `this index is already being built (pid ${held.pid}, since ${held.startedAt})`,
            EXIT.failed,
            `wait for it, or build elsewhere with --out`,
        );
    }
    writeFileSync(path, body);
}

function readLock(path: string): Lock | undefined {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Lock;
    } catch {
        return undefined;
    }
}

/**
 * `kill(pid, 0)` sends no signal and only asks whether the process exists.
 * EPERM means it exists and belongs to someone else, which still counts.
 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

// ---------------------------------------------------------------------------
// The three states of README.md
// ---------------------------------------------------------------------------

interface Building {
    documents: readonly string[];
    embedding: string;
    started: number;
    phase: Phase;
    done: number;
    total: number;
    counts: Counts | undefined;
}

function building(state: Building): string {
    const now = Date.now();
    const rows: string[][] = [
        ['documents', state.documents.join(', ')],
        ['embedding', state.embedding],
        [
            'started',
            `${new Date(state.started).toISOString()} (${duration(now - state.started)} ago)`,
        ],
        ['step', PHASES[state.phase]],
    ];
    if (state.counts) {
        rows.push(['found', entities(state.counts)]);
    }
    if (state.total > 0) {
        const percent = Math.round((state.done / state.total) * 100);
        rows.push(['embedded', `${state.done} of ${state.total} · ${percent}%`]);
    }
    rows.push(['updated', new Date(now).toISOString()]);

    return [
        '# Schema index — being built',
        '',
        'A searchable index of the API documents named below, written by `zen rag schema index`.',
        '**It is incomplete. Nothing should read it yet.**',
        '',
        ...fields(rows),
        '',
        `These lines are refreshed at most every ${INTERVAL_MS / 1000} seconds while the build runs, and`,
        'the whole file is replaced by a description of the index when it finishes. If it still says',
        '"being built" and `.lock` names no living process, the build died part way.',
        '',
    ].join('\n');
}

function complete(dir: string, manifest: Manifest, ms: number): string {
    const titles = manifest.sources.map((s) => s.title).filter(Boolean);
    const what = titles.length > 0 ? titles.join(', ') : basename(dir);

    return [
        `# Schema index — ${what}`,
        '',
        `A searchable index of ${plural(manifest.sources.length, 'API document')}, built with`,
        `${manifest.embedding.ref} (${manifest.embedding.dimensions}d) in ${duration(ms)}.`,
        'Ask it for the operations and types behind a question and it answers with a subgraph:',
        'the endpoints that match, the schemas they carry, and the fields inside those — printed',
        'as text, Mermaid, TypeScript or OpenAPI.',
        '',
        '## What it covers',
        '',
        ...sourceTable(manifest.sources),
        '',
        `${entities(manifest.counts)},`,
        `${searched(manifest.indexes)}.`,
        '',
        '## Files',
        '',
        ...fields([
            ['manifest.json', 'what this index is and what built it — read this first'],
            ['graph.json', 'the nodes and edges: operations, types, fields'],
            ['schemas.json', 'the JSON Schema of every type'],
            ['operations.json', 'every operation, with its parameters and responses'],
            ...(manifest.sources.some((s) => s.path)
                ? [['sources/', 'the documents themselves, bundled, exactly as indexed']]
                : []),
            ['lance/', 'the LanceDB table: the search text, the vectors, the filter columns'],
        ]),
        '',
        '## Asking it something',
        '',
        'From this directory:',
        '',
        '```',
        'zen rag schema search --dir . --all "how do I cancel a subscription"',
        '```',
        '',
        `Built by ${manifest.indexer} on ${manifest.createdAt}.`,
        '',
    ].join('\n');
}

interface Failure {
    documents: readonly string[];
    phase: Phase;
    reason: unknown;
    started: number;
}

function failed(state: Failure): string {
    return [
        '# Schema index — failed',
        '',
        'This index was not finished and what is here is incomplete. Nothing should read it;',
        'build it again with `zen rag schema index`.',
        '',
        ...fields([
            ['documents', state.documents.join(', ')],
            ['step', PHASES[state.phase]],
            ['reason', message(state.reason)],
            ['started', new Date(state.started).toISOString()],
            [
                'failed',
                `${new Date().toISOString()} (after ${duration(Date.now() - state.started)})`,
            ],
        ]),
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Small renderings
// ---------------------------------------------------------------------------

/** An indented block, which markdown renders verbatim and an agent reads as a table. */
function fields(rows: readonly string[][]): string[] {
    const width = Math.max(...rows.map((r) => (r[0] ?? '').length));
    return rows.map(([name, value]) => `    ${(name ?? '').padEnd(width)}  ${value ?? ''}`);
}

const HEADERS = ['document', 'dialect', 'paths', 'operations', 'schemas', 'fields'] as const;

function sourceTable(sources: readonly SourceRecord[]): string[] {
    const rows = sources.map((s) => [
        s.file,
        s.dialect,
        String(s.paths),
        String(s.methods),
        String(s.types),
        String(s.properties),
    ]);
    const widths = HEADERS.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    );
    const line = (cells: readonly string[]): string =>
        `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;

    return [
        line(HEADERS),
        `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
        ...rows.map(line),
    ];
}

function entities(counts: Counts): string {
    return (
        `${plural(counts.entities, 'entity', 'entities')}: ` +
        `${counts.methods} operations, ${counts.types} schemas, ${counts.properties} fields`
    );
}

function searched(indexes: Manifest['indexes']): string {
    if (!indexes.fts && !indexes.vector) {
        return 'scanned flat: neither index was built';
    }
    if (!indexes.vector) {
        // Below a couple of thousand rows an IVF index has nothing to train on.
        return 'searched by full text and by vector, the latter as a flat scan';
    }
    return indexes.fts
        ? 'searched by full text and by vector'
        : 'searched by vector, with no full-text index';
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

function duration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 1) {
        return 'under a second';
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60
        ? `${minutes}m${seconds % 60}s`
        : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function message(reason: unknown): string {
    const text = reason instanceof Error ? reason.message : String(reason);
    return text.split('\n')[0]?.trim() || 'no reason given';
}
