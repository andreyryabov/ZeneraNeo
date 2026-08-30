import { AVAILABLE } from './image.ts';
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
    '   controlling the call.',
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

    lines.push('', `RESPONSE SCHEMA (status ${operation.success.status})`);
    lines.push(operation.success.schema ? json(operation.success.schema) : '  (no body)');
    return lines.join('\n');
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
