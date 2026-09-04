import { bold, cyan, dim, note, write } from '@zenera/cli/lib';
import { createInterface } from 'node:readline/promises';
import { assemble, type AssembleOptions } from './assemble.ts';
import { CHUNK_KINDS } from './chunk.ts';
import { renderAssembly } from './render.ts';
import { SEARCH_MODES, type DocsIndex, type DocsQuery, type SearchMode } from './search.ts';

// ---------------------------------------------------------------------------
// The prompt loop
//
// Readline, not a framed UI: the answer here is a run of quoted lines and the
// terminal already knows how to scroll one. A window would only have to be
// scrolled again.
//
// The loop is the refinement loop the whole subject is shaped around — ask,
// read, narrow, ask again. `file`, `section` and `kind` set the narrowing and
// keep it; everything already shown is pushed onto the exclusions, so asking
// the same question twice moves on rather than repeating itself.
// ---------------------------------------------------------------------------

export interface ReplSettings extends AssembleOptions {
    quiet?: boolean;
}

export async function repl(
    index: DocsIndex,
    initial: DocsQuery,
    settings: ReplSettings = {},
): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let query: DocsQuery = { ...initial };

    note(
        bold(
            `${index.manifest.counts.documents} document(s), ${index.manifest.counts.chunks} chunks`,
        ),
    );
    note(dim('  a bare line searches; `help` lists the rest.'));

    try {
        if (query.query) {
            query = await run(index, query, settings);
        }
        for (;;) {
            const line = (await rl.question(cyan('docs> '))).trim();
            if (line === '') {
                continue;
            }
            if (line === 'quit' || line === 'exit') {
                return;
            }
            if (line === 'help') {
                help();
                continue;
            }
            if (line === 'reset') {
                query = {};
                note(dim('  cleared, narrowings and exclusions alike'));
                continue;
            }
            if (line === 'show') {
                note(dim(`  ${JSON.stringify(query)}`));
                continue;
            }
            if (line === 'files') {
                for (const name of index.resolveFiles(query.files, query.exclude_files)) {
                    note(dim(`  ${name}`));
                }
                continue;
            }

            const [head, ...rest] = line.split(' ');
            const tail = rest.join(' ').trim();
            const narrowed = narrow(query, head ?? '', tail);
            if (narrowed) {
                query = narrowed;
                continue;
            }
            query = await run(index, { ...query, query: line }, settings);
        }
    } finally {
        rl.close();
    }
}

/**
 * The narrowing verbs. Each one replaces its own field rather than adding to
 * it — `file guides/**` twice in a row means the second pattern, which is what
 * anyone typing it meant. An empty argument clears the field.
 */
function narrow(query: DocsQuery, head: string, tail: string): DocsQuery | undefined {
    const set = (key: keyof DocsQuery, value: unknown): DocsQuery => {
        note(dim(`  ${head} is ${tail || 'anything'}`));
        return { ...query, [key]: value };
    };

    switch (head) {
        case 'file':
            return set('files', tail ? [tail] : undefined);
        case 'not':
            return set('exclude_files', tail ? [tail] : undefined);
        case 'section':
            return set('section', tail ? [tail] : undefined);
        case 'kind':
            if (tail && !(CHUNK_KINDS as readonly string[]).includes(tail)) {
                note(dim(`  kind is one of ${CHUNK_KINDS.join(', ')}`));
                return query;
            }
            return set('kinds', tail ? [tail] : undefined);
        case 'mode':
            if (tail && !(SEARCH_MODES as readonly string[]).includes(tail)) {
                note(dim(`  mode is one of ${SEARCH_MODES.join(', ')}`));
                return query;
            }
            return set('mode', (tail || undefined) as SearchMode | undefined);
        case 'limit': {
            const limit = Number(tail);
            if (!Number.isInteger(limit) || limit < 1) {
                note(dim('  limit is a whole number of at least 1'));
                return query;
            }
            return set('limit', limit);
        }
        default:
            return undefined;
    }
}

async function run(index: DocsIndex, query: DocsQuery, settings: ReplSettings): Promise<DocsQuery> {
    const result = await index.search(query);
    const excerpt = await assemble(index, result.matches, settings);

    if (excerpt.files.length > 0) {
        write(renderAssembly(excerpt, {}));
    }
    note(
        dim(
            `  ${result.matches.length} passage(s) in ${excerpt.files.length} document(s)` +
                ` · ${excerpt.shown} line(s) · ${result.files.length} document(s) in scope`,
        ),
    );
    if (result.matches.length === 0) {
        return query;
    }
    const seen = new Set([...(query.exclude_ids ?? []), ...result.matches.map((m) => m.id)]);
    note(dim(`  ${seen.size} passage(s) now excluded — \`reset\` to see them again`));
    return { ...query, exclude_ids: [...seen] };
}

function help(): void {
    for (const line of [
        '  <text>            search',
        '  file <pattern>    only documents matching it; blank for all',
        '  not <pattern>     drop documents matching it',
        '  section <name>    only under this heading, by title, id or path',
        `  kind <k>          ${CHUNK_KINDS.join(' | ')}`,
        `  mode <m>          ${SEARCH_MODES.join(' | ')}`,
        '  limit <n>         passages per search',
        '  files             the documents currently in scope',
        '  show              the query as it stands',
        '  reset             forget it, narrowings and exclusions alike',
        '  quit',
    ]) {
        note(dim(line));
    }
}
