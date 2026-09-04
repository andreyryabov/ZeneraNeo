import { AVAILABLE } from './image.ts';
import type { Paging } from './paging.ts';
import type { Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// What the model is told
//
// A contract, not a request. The generator is a program with a fixed calling
// convention that this package depends on in three places — the entry point,
// the input shape, the output file — so those are stated as rules rather than
// as suggestions, and everything discretionary is stated as taste.
//
// The one rule worth its own paragraph is the echo: a mock that answers
// `GET /users/12324` with somebody else's id is worse than useless, because it
// validates and quietly breaks whatever is being developed against it.
// ---------------------------------------------------------------------------

export const SYSTEM = [
    'You write one Python 3 file that fabricates a plausible HTTP response body.',
    '',
    'CALLING CONVENTION',
    '- `sys.argv[1]` is a path to a JSON file to read; `sys.argv[2]` is a path to write to.',
    '- Write exactly one JSON document to `sys.argv[2]` and print nothing to stdout.',
    '- Exit non-zero with a message on stderr if you cannot produce a valid body.',
    '',
    'THE INPUT FILE holds:',
    '  operationId, method, path, pathParams, query, headers, body, seed',
    '',
    'ENVIRONMENT',
    `- These libraries are installed: ${AVAILABLE.join(', ')}, plus the standard library.`,
    '- There is no network and no pip. Importing anything else fails the file.',
    '- Seed both `random.seed(seed)` and `Faker.seed(seed)` from the input, first thing.',
    '',
    'RULES',
    '1. The output must validate against the response schema given below. Build the',
    '   object, then check it with `jsonschema.validate` before writing, and fix it',
    '   rather than emitting something that fails.',
    '2. Echo the request. Where a path parameter has the same name as a property',
    "   in the response schema, that property must carry the request's value,",
    '   converted to the type the schema declares. `GET /users/{user_id}` called',
    '   with `user_id=12324` answers with `user_id` 12324, not a random one. Do',
    '   this generically, by looking the names up at run time. Do the same for a',
    '   query parameter where it plainly describes the content rather than',
    '   controlling the call. A paging control — a cursor, page, offset or',
    '   page-size parameter — is never content and must not be copied into the',
    '   body; see PAGINATION below where the operation has one.',
    '3. Every required property must be present. Optional ones may be omitted',
    '   sometimes; that is what makes a mock useful.',
    '4. Values must suit their names, not just their types. Use `faker` for anything',
    '   a person would recognise — names, emails, addresses, companies, phone',
    '   numbers, sentences. Use `exrex.getone(pattern)` when a string schema has a',
    '   `pattern`. Respect `enum`, `format`, `minimum`, `maxLength` and friends.',
    '5. Arrays get 1 to 5 items unless the schema says otherwise.',
    '6. The file is run once per request and must be deterministic for a given seed.',
    '',
    'ANSWER WITH THE FILE AND NOTHING ELSE. No explanation, no markdown fence.',
].join('\n');

export function brief(operation: Operation): string {
    const lines: string[] = [
        `OPERATION  ${operation.method.toUpperCase()} ${operation.path}`,
        `operationId: ${operation.operationId}`,
    ];
    if (operation.summary) {
        lines.push(`summary: ${operation.summary}`);
    }
    if (operation.description && operation.description !== operation.summary) {
        lines.push(`description: ${operation.description.slice(0, 600)}`);
    }

    lines.push('', 'PARAMETERS');
    if (operation.params.length === 0) {
        lines.push('  (none)');
    }
    for (const p of operation.params) {
        const note = p.description ? `  # ${p.description.split('\n')[0].slice(0, 100)}` : '';
        lines.push(
            `  ${p.name} (in ${p.in}${p.required ? ', required' : ''}): ${JSON.stringify(p.schema)}${note}`,
        );
    }

    if (operation.requestBody) {
        lines.push(
            '',
            'REQUEST BODY SCHEMA (arrives as `body`)',
            json(operation.requestBody.schema),
        );
    }

    if (operation.paging) {
        lines.push('', ...pagination(operation.paging));
    }

    lines.push('', `RESPONSE SCHEMA (status ${operation.success.status})`);
    lines.push(operation.success.schema ? json(operation.success.schema) : '  (no body)');
    return lines.join('\n');
}

/**
 * Said only to the operations that page, and said in terms of their own
 * property names. The rule that earns the paragraph is the third one: a body
 * offering the token it was just given passes the schema, passes the echo rule,
 * and hangs every client that walks the list.
 */
function pagination(paging: Paging): string[] {
    const advance =
        paging.style === 'cursor'
            ? 'the base64 of a small JSON object holding the next page index, such as {"p": 2}'
            : "the offset of the next page — this page's offset plus its size";
    const lines = [
        'PAGINATION',
        `  This operation is paged. \`${paging.param}\` asks for a page;`,
        '  absent or empty means the first one.',
        '  - Fabricate three pages in total and no more.',
    ];
    if (paging.next) {
        lines.push(
            `  - \`${paging.next}\` carries the token for the page after this one.`,
            `    Build it out of \`${paging.param}\`:`,
            `    ${advance}.`,
            '  - Never build it out of `seed`. Unpinned, the seed changes on every',
            '    request; pinned, it is a function of the query. A token made from it',
            '    either wanders or never changes.',
            '  - It must strictly advance. Answering with the token you were given is',
            '    the one failure that matters: a client following it loops forever.',
        );
    }
    if (paging.more && !stuck(paging)) {
        lines.push(`  - \`${paging.more}\` is false on the last page and true before it.`);
    }
    if (paging.next) {
        lines.push(...last(paging));
    }
    lines.push(
        '  - A token you cannot read, or one past the end, is the last page,',
        `    ended the same way and with ${paging.items ? `\`${paging.items}\` empty` : 'nothing listed'}.`,
        '    Never an error, and never the first page again.',
    );
    return lines;
}

/**
 * How the last page says so. A token that is required and cannot be null has
 * nowhere to put the ending, so the ending has to be said some other way —
 * telling the model to null it anyway would only ask for an invalid body.
 */
const stuck = (paging: Paging): boolean => !paging.nextNullable && paging.nextRequired === true;

function last(paging: Paging): string[] {
    if (paging.nextNullable) {
        return [`  - On the last page set \`${paging.next}\` to null.`];
    }
    if (!stuck(paging)) {
        return [`  - On the last page leave \`${paging.next}\` out.`];
    }
    const otherwise = [paging.more && `\`${paging.more}\` false`, paging.items && 'nothing listed']
        .filter(Boolean)
        .join(' and ');
    return [
        `  - The schema requires \`${paging.next}\` on every page, so the last page`,
        `    ends the list the other way: ${otherwise || 'an empty page'}.`,
    ];
}

/**
 * Repeated in the file the model writes, so it is worth spelling out: the
 * schema it validates against must be the one it was shown, embedded, not
 * loaded from anywhere.
 */
export function instruction(operation: Operation): string {
    return [
        brief(operation),
        '',
        'Embed the response schema in the file as a literal and validate against it.',
    ].join('\n');
}

export function retry(diagnostics: readonly string[]): string {
    return [
        'That file did not pass. Fix it and answer with the whole file again.',
        '',
        ...diagnostics,
    ].join('\n');
}

const json = (value: unknown): string => JSON.stringify(value, null, 1);
