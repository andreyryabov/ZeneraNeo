import { createInterface } from 'node:readline/promises';
import { bold, cyan, dim, note, write } from '@zenera/cli/lib';
import { isFormat, present, type Format, type OutputOptions } from './present.ts';
import { isEmpty, parseQuery, QueryError } from './query.ts';
import type { SchemaIndex, SchemaQuery } from './search.ts';

// ---------------------------------------------------------------------------
// The prompt loop
//
// Readline, not a full-screen renderer: the answer to a search here is a
// fifty-row Mermaid diagram or a declaration file, and the terminal already
// knows how to scroll one of those. A framed UI would have to window it, and
// then `> types.d.ts` would capture the window.
//
// The loop it exists for is the one the exclusion lists were designed for:
// look, discard what was not it, ask again — with everything already seen
// pushed onto `exclude_ids` so the next answer is genuinely new.
// ---------------------------------------------------------------------------

interface Settings extends OutputOptions {
    format: Format;
}

const FIELDS: Record<string, keyof SchemaQuery> = {
    all: 'all',
    method: 'methods',
    type: 'types',
    'input-type': 'input_types',
    'output-type': 'output_types',
    property: 'properties',
    'input-property': 'input_properties',
    'output-property': 'output_properties',
};

export async function repl(
    index: SchemaIndex,
    initial: SchemaQuery,
    settings: Settings,
): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let query: SchemaQuery = { ...initial };
    let format = settings.format;
    const options: OutputOptions = { docs: settings.docs, onlyHits: settings.onlyHits };

    note(bold(`${index.manifest.sources.map((s) => s.title).join(', ')}`));
    note(dim('  a bare line searches every kind; `help` lists the rest.'));

    try {
        if (!isEmpty(query)) {
            query = await run(index, query, format, options);
        }
        for (;;) {
            const line = (await rl.question(cyan('rag> '))).trim();
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
                note(dim('  cleared, exclusions and all'));
                continue;
            }
            if (line === 'show') {
                note(dim(`  ${JSON.stringify(query)}`));
                continue;
            }

            const [head, ...rest] = line.split(' ');
            const tail = rest.join(' ').trim();

            if (head === 'format') {
                if (isFormat(tail)) {
                    format = tail;
                    note(dim(`  format is ${tail}`));
                } else {
                    note(dim('  expected text, mermaid, mermaid-flowchart, ts or openapi'));
                }
                continue;
            }
            if (head === 'direction' || head === 'method-type') {
                query = patch(query, head === 'direction' ? 'direction' : 'method_type', tail);
                continue;
            }
            if (head && head in FIELDS && tail) {
                query = { ...query, [FIELDS[head]!]: [tail] };
                query = await run(index, query, format, options);
                continue;
            }
            query = await run(index, { ...query, all: [line] }, format, options);
        }
    } finally {
        rl.close();
    }
}

/**
 * Runs the search, prints it, and hands back the query with everything just
 * shown added to the exclusions — so asking the same thing twice moves on
 * instead of repeating itself.
 */
async function run(
    index: SchemaIndex,
    query: SchemaQuery,
    format: Format,
    options: OutputOptions,
): Promise<SchemaQuery> {
    const result = await index.search(query);
    const text = await present(index, result.subgraphs, format, options);

    if (text) {
        write(text);
    }
    note(
        dim(
            `  ${result.seeds.length} seed(s) · ${result.subgraphs.length} result(s)` +
                (result.empty.length > 0 ? ` · nothing for: ${result.empty.join(', ')}` : ''),
        ),
    );
    if (result.seeds.length === 0) {
        return query;
    }
    const seen = new Set([...(query.exclude_ids ?? []), ...result.seeds.map((s) => s.id)]);
    note(dim(`  ${seen.size} node(s) now excluded — \`reset\` to see them again`));
    return { ...query, exclude_ids: [...seen] };
}

function patch(query: SchemaQuery, key: 'direction' | 'method_type', value: string): SchemaQuery {
    try {
        return { ...query, ...parseQuery({ [key]: value }) };
    } catch (err) {
        note(dim(`  ${err instanceof QueryError ? err.message : String(err)}`));
        return query;
    }
}

function help(): void {
    for (const line of [
        '  <text>                  search everything',
        '  all|method|type <text>  search one field',
        '  input-property <text>   also: output-property, property, input-type, output-type',
        '  direction <d>           input | output | any',
        '  method-type <t>         read_only | read_write | any',
        '  format <f>              text | mermaid | mermaid-flowchart | ts | openapi',
        '  show                    the query as it stands',
        '  reset                   forget it, exclusions included',
        '  quit',
    ]) {
        note(dim(line));
    }
}
