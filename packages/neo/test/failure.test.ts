import type { GenerateContentResponse, GoogleGenAI } from '@google/genai';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { OpenAIEmbedder } from '../src/embeddings/openai.ts';
import { explain, ProviderError } from '../src/failure.ts';
import { ModelRegistry } from '../src/models/factory.ts';

// ---------------------------------------------------------------------------
// What a failed provider call says
//
// The question every one of these asks is the same: given only the line that
// reaches a person, can they tell which call failed. A vendor's own error
// answers none of it — the body Google throws is a JSON document quoting
// another JSON document, and neither one names the model, the connection or
// the API that was called.
// ---------------------------------------------------------------------------

/** Verbatim, quoting included: what `@google/genai` throws on a 400. */
const GOOGLE_400 =
    '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    ' +
    '\\"message\\": \\"Request contains an invalid argument.\\",\\n    ' +
    '\\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":"Bad Request"}}';

const request = { messages: [], tools: [] };

/** A GenAI client that refuses, either at the call or part-way through the body. */
function refusing(message: string, when: 'call' | 'stream' = 'call') {
    const fail = () => {
        throw new Error(message);
    };
    return {
        models: {
            generateContent: async () => fail(),
            generateContentStream: async () =>
                (async function* () {
                    if (when === 'stream') {
                        yield {} as GenerateContentResponse;
                        fail();
                    }
                    fail();
                })(),
        },
    } as unknown as GoogleGenAI;
}

function gemini(client: GoogleGenAI) {
    return new ModelRegistry()
        .provider('vx', { kind: 'vertex', client })
        .model('vx:gemini-3.5-flash');
}

describe('a provider refusal', () => {
    it('names what was being done, the api, the provider and the model', async () => {
        const err = await gemini(refusing(GOOGLE_400))
            .generate(request)
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        expect((err as Error).message).toBe(
            'llm generation failed — vx models.generateContent, model "gemini-3.5-flash": ' +
                'Request contains an invalid argument. (400 INVALID_ARGUMENT)',
        );
    });

    it('says streaming when the body is what failed', async () => {
        const model = gemini(refusing(GOOGLE_400, 'stream'));
        const err = await model.stream!(request, () => {}).catch((e: unknown) => e);

        expect((err as Error).message).toContain('llm streaming failed');
        expect((err as Error).message).toContain('models.generateContentStream');
    });

    it('says embedding, and names the embedding api', async () => {
        const client = {
            embeddings: {
                create: async () => {
                    throw new Error('{"error":{"message":"Incorrect API key provided: sk-xxx"}}');
                },
            },
        } as unknown as OpenAI;
        const err = await new OpenAIEmbedder('text-embedding-3-small', client)
            .embed({ input: ['a'] })
            .catch((e: unknown) => e);

        expect((err as Error).message).toBe(
            'embedding failed — embeddings.create, model "text-embedding-3-small": ' +
                'Incorrect API key provided: sk-xxx',
        );
    });

    it('keeps the vendor error, and the status everything else classifies on', async () => {
        const err = (await gemini(refusing(GOOGLE_400))
            .generate(request)
            .catch((e: unknown) => e)) as ProviderError;

        expect(err.status).toBe(400);
        expect(err.cause).toBeInstanceOf(Error);
        expect((err.cause as Error).message).toBe(GOOGLE_400);
    });

    it('leaves an abort alone — stopping is not a failure to explain', async () => {
        const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        const model = gemini({
            models: {
                generateContent: async () => {
                    throw abort;
                },
            },
        } as unknown as GoogleGenAI);
        await expect(model.generate(request)).rejects.toBe(abort);
    });
});

describe('unwrapping what a vendor said', () => {
    it('digs the sentence out of a body quoting another body', () => {
        expect(explain(new Error(GOOGLE_400))).toEqual({
            detail: 'Request contains an invalid argument. (400 INVALID_ARGUMENT)',
            status: 400,
        });
    });

    it('does not repeat a status the sentence already carries', () => {
        const said = explain(
            Object.assign(new Error('404 The model `gpt-9` does not exist'), { status: 404 }),
        );
        expect(said.detail).toBe('404 The model `gpt-9` does not exist');
    });

    it('names the argument, which the sentence never does', () => {
        // `Request contains an invalid argument` on its own is unactionable:
        // the field that was wrong is in `details`, and nowhere else.
        const body = JSON.stringify({
            error: {
                code: 400,
                message: 'Request contains an invalid argument.',
                status: 'INVALID_ARGUMENT',
                details: [
                    {
                        '@type': 'type.googleapis.com/google.rpc.BadRequest',
                        fieldViolations: [
                            {
                                field: 'tools[0].function_declarations[2].parameters',
                                description: 'Invalid JSON schema: unsupported keyword "$ref"',
                            },
                        ],
                    },
                ],
            },
        });
        expect(explain(new Error(body)).detail).toBe(
            'Request contains an invalid argument. — tools[0].function_declarations[2]' +
                '.parameters: Invalid JSON schema: unsupported keyword "$ref" ' +
                '(400 INVALID_ARGUMENT)',
        );
    });

    it('takes whatever a detail says when it names no field', () => {
        const body = JSON.stringify({
            error: {
                code: 429,
                message: 'Quota exceeded.',
                details: [
                    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT' },
                ],
            },
        });
        expect(explain(new Error(body)).detail).toBe('Quota exceeded. — RATE_LIMIT (429)');
    });

    it('names the parameter openai objected to', () => {
        const body = JSON.stringify({
            error: { message: 'Unknown parameter.', type: 'invalid_request_error', param: 'top_k' },
        });
        expect(explain(new Error(body)).detail).toBe(
            'Unknown parameter. — top_k (400 invalid_request_error)',
        );
    });

    it('reads a status off the vendor word when a stream carried none', () => {
        // A refusal raised from inside a stream arrives in a 200: the SDK has
        // no status to put on it, and everything that decides whether to retry
        // reads the status.
        const err = Object.assign(new Error('Your input exceeds the context window.'), {
            code: 'context_length_exceeded',
            type: 'invalid_request_error',
        });
        expect(explain(err)).toEqual({
            detail: 'Your input exceeds the context window. (400 context_length_exceeded)',
            status: 400,
        });
    });

    it('does not invent a status for a word it does not know', () => {
        const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        expect(explain(err)).toEqual({
            detail: 'socket hang up (ECONNRESET)',
            status: undefined,
        });
    });

    it('blames the cause when the message is only `fetch failed`', () => {
        const err = new Error('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), {
                code: 'ENOTFOUND',
            }),
        });
        expect(explain(err).detail).toBe(
            'fetch failed — getaddrinfo ENOTFOUND api.example (ENOTFOUND)',
        );
    });

    it('leaves an error that is already a sentence as it is', () => {
        expect(explain(new Error('socket hang up'))).toEqual({
            detail: 'socket hang up',
            status: undefined,
        });
    });
});
