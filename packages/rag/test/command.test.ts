import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, EXIT } from 'zenera-cli/lib';
import { command } from '../src/command.ts';
import { isEmpty, parseQuery, QueryError } from '../src/query.ts';
import { buildIndex } from '../src/schema/build.ts';
import { StubEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// The command line as an interface for programs
//
// Non-interactive `search` is the mode an agent drives, so what is asserted
// here is the contract it depends on: a query can arrive whole as JSON, a
// field nobody defined is refused rather than ignored, the exit codes mean
// what they say, and none of it wants a terminal.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-cli-'));

await buildIndex({
    files: [spec('petstore.yaml')],
    out: dir,
    embedder: new StubEmbedder(),
    indexer: 'test',
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

interface Run {
    out: string;
    err: string;
}

/** Captures both streams, and keeps them when the command throws. */
async function invoke(args: string[], json: boolean): Promise<Run & { error?: unknown }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
    });
    let error: unknown;
    try {
        await command.run({ args, json, cwd: process.cwd() });
    } catch (thrown) {
        error = thrown;
    }
    return { out: out.join(''), err: err.join(''), error };
}

async function run(args: string[], json = false): Promise<Run> {
    const result = await invoke(args, json);
    if (result.error) {
        throw result.error;
    }
    return result;
}

async function fails(args: string[]): Promise<CliError> {
    const { error } = await invoke(args, false);
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
}

describe('dispatch', () => {
    it('names the commands it has when given none', async () => {
        expect((await fails([])).code).toBe(EXIT.usage);
        expect((await fails(['schema'])).code).toBe(EXIT.usage);
    });

    it('refuses a command it does not have', async () => {
        expect((await fails(['schema', 'wat'])).message).toContain('unknown command "wat"');
    });

    it('takes `schema` as optional, since it is the only subject', async () => {
        const withGroup = await run(['schema', 'stats', '--dir', dir]);
        const without = await run(['stats', '--dir', dir]);
        expect(without.err).toBe(withGroup.err);
    });
});

describe('index', () => {
    it('needs a document before it needs anything else', async () => {
        const err = await fails(['schema', 'index', '--embedding', 'openai:x']);
        expect(err.code).toBe(EXIT.usage);
        expect(err.message).toContain('no document given');
    });

    it('lists what it could embed with when no embedder is named', async () => {
        const { error, err } = await invoke(['schema', 'index', spec('petstore.yaml')], false);

        expect((error as CliError).code).toBe(EXIT.usage);
        expect((error as CliError).message).toContain('no embedder named');
        expect(err).toContain('Embeddings');
        expect(err).toContain('openai:text-embedding-3-small');
        // Anthropic publishes no embeddings API, so it is not on the list.
        expect(err).not.toContain('anthropic:');
    });
});

describe('stats', () => {
    it('says what built the index and what is in it', async () => {
        const { err } = await run(['schema', 'stats', '--dir', dir]);

        expect(err).toContain('stub:bag-of-words');
        expect(err).toContain('petstore.yaml');
        expect(err).toContain('openapi-3.1');
    });

    it('answers a machine on stdout', async () => {
        const { out } = await run(['schema', 'stats', '--dir', dir], true);
        expect(JSON.parse(out)).toMatchObject({ indexer: 'test', counts: { methods: 4 } });
    });

    it('says an index is missing rather than reporting nothing', async () => {
        const err = await fails(['schema', 'stats', '--dir', join(dir, 'nowhere')]);
        expect(err.code).toBe(EXIT.invalid);
        expect(err.hint).toContain('zen rag schema index');
    });
});

describe('search arguments', () => {
    it('takes a bare phrase as the unfiltered search, which the usage advertises', async () => {
        const { error } = await invoke(['schema', 'search', '--dir', dir, 'reset password'], false);

        // It gets past the argument checks and on to building an embedder,
        // which this fixture names something no registry can construct. That
        // it got that far is the proof the phrase was taken as a query.
        expect(String(error)).not.toContain('no query given');
        expect(String(error)).toContain('stub');
    });

    it('refuses a search with filters but nothing asked', async () => {
        const err = await fails(['schema', 'search', '--dir', dir, '--direction', 'input']);
        expect(err.code).toBe(EXIT.usage);
        expect(err.message).toContain('no query given');
    });

    it('refuses a format it cannot write', async () => {
        const err = await fails([
            'schema',
            'search',
            '--dir',
            dir,
            '--all',
            'x',
            '--format',
            'pdf',
        ]);
        expect(err.code).toBe(EXIT.usage);
        expect(err.hint).toContain('mermaid-flowchart');
    });

    it('refuses --query that is not JSON, quoting the parser', async () => {
        const err = await fails(['schema', 'search', '--dir', dir, '--query', '{oops']);
        expect(err.message).toContain('--query is not JSON');
    });

    it('refuses a query field nobody defined', async () => {
        const err = await fails([
            'schema',
            'search',
            '--dir',
            dir,
            '--query',
            '{"output_propertys":["a"]}',
        ]);
        expect(err.message).toContain('unknown query field "output_propertys"');
    });

    it('refuses --interactive without a terminal', async () => {
        const err = await fails(['schema', 'search', '--dir', dir, '--interactive']);
        expect(err.code).toBe(EXIT.usage);
        expect(err.message).toContain('needs a terminal');
    });

    it('refuses an embedder the index was not built with', async () => {
        const err = await fails([
            'schema',
            'search',
            '--dir',
            dir,
            '--all',
            'x',
            '--embedding',
            'openai:text-embedding-3-small',
        ]);
        expect(err.code).toBe(EXIT.invalid);
        expect(err.message).toContain('built with stub:bag-of-words');
    });
});

describe('show', () => {
    it('needs an id', async () => {
        expect((await fails(['schema', 'show', '--dir', dir])).code).toBe(EXIT.usage);
    });

    it('says which ids it could not find, and what one looks like', async () => {
        const err = await fails(['schema', 'show', '--dir', dir, 'Type:Nope']);
        expect(err.code).toBe(EXIT.failed);
        expect(err.hint).toContain('Type:User');
    });

    it('prints a named node with no search in between', async () => {
        const { out } = await run(['schema', 'show', '--dir', dir, 'Type:ResetPasswordPayload']);
        expect(out).toContain('ResetPasswordPayload');
        expect(out).toContain('password');
    });

    it('hydrates one to TypeScript on demand', async () => {
        const { out } = await run(['schema', 'show', '--dir', dir, 'Type:Cat', '--format', 'ts']);
        expect(out).toContain("petType: 'cat';");
    });
});

describe('the query contract', () => {
    it('accepts every field it documents', () => {
        const query = parseQuery({
            all: ['a'],
            methods: ['b'],
            types: ['c'],
            input_types: ['d'],
            output_types: ['e'],
            properties: ['f'],
            input_properties: ['g'],
            output_properties: ['h'],
            exclude_ids: ['i'],
            exclude_methods: ['j'],
            exclude_types: ['k'],
            exclude_properties: ['l'],
            direction: 'input',
            method_type: 'read_write',
            limit: 3,
            max_hops: 2,
            max_nodes: 10,
        });
        expect(query.direction).toBe('input');
        expect(query.limit).toBe(3);
    });

    it('refuses the wrong shape rather than coercing it', () => {
        expect(() => parseQuery(['a'])).toThrow(QueryError);
        expect(() => parseQuery({ all: 'a' })).toThrow(/array of strings/);
        expect(() => parseQuery({ limit: 0 })).toThrow(/at least 1/);
        expect(() => parseQuery({ direction: 'sideways' })).toThrow(/input, output, any/);
    });

    it('tells a filter-only query from one that asks something', () => {
        expect(isEmpty(parseQuery({ direction: 'input', exclude_ids: ['x'] }))).toBe(true);
        expect(isEmpty(parseQuery({ output_properties: ['x'] }))).toBe(false);
    });
});
