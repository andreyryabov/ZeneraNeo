import { CliError, EXIT } from '@zenera/cli/lib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '../src/command.ts';
import { buildIndex } from '../src/schema/build.ts';
import { isEmpty, parseQuery, QueryError } from '../src/schema/query.ts';
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

    it('requires the subject, since a bare verb would have to guess one', async () => {
        const err = await fails(['stats', '--dir', dir]);
        expect(err.code).toBe(EXIT.usage);
        expect(err.message).toContain('unknown subject "stats"');
    });

    it('prints a subject’s own help, which --help never reaches', async () => {
        const { out } = await run(['help', 'schema']);
        expect(out).toContain('zen rag schema');
        expect(out).toContain('trace <pattern>');
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

describe('list', () => {
    it('needs to know what to list, and says what it can', async () => {
        expect((await fails(['schema', 'list', '--dir', dir])).code).toBe(EXIT.usage);
        const err = await fails(['schema', 'list', '--dir', dir, 'wat']);
        expect(err.code).toBe(EXIT.usage);
        expect(err.hint).toContain('methods');
    });

    it('prints every operation, without an embedder or a credential', async () => {
        const { out } = await run(['schema', 'list', 'methods', '--dir', dir]);
        expect(out).toContain('/pets');
        expect(out.trim().split('\n')).toHaveLength(4);
    });

    it('filters on a glob over the route', async () => {
        const { out } = await run(['schema', 'list', 'methods', '--dir', dir, '--path', '*/pets*']);
        expect(out).toContain('/pets');
        expect(out).not.toContain('/auth');
    });

    it('reads a bare --name as a substring, so a word finds something', async () => {
        const { out } = await run(['schema', 'list', 'types', '--dir', dir, '--name', 'Password']);
        expect(out).toContain('ResetPasswordPayload');
    });

    it('reads the filters as regexes when told to, stars and all', async () => {
        const pattern = '^/(pets|auth).*';
        const { out } = await run(['schema', 'list', 'methods', '--dir', dir, '--path', pattern]);
        // As a glob this matches nothing at all, which is the whole point of
        // the flag: the punctuation belongs to the regex, not to the glob.
        expect(out).not.toContain('/pets');
        expect(out).not.toContain('/auth');

        const { out: asRegex } = await run([
            'schema',
            'list',
            'methods',
            '--dir',
            dir,
            '--regex',
            '--path',
            pattern,
        ]);
        expect(asRegex).toContain('/pets');
        expect(asRegex).toContain('/auth/reset-password');
        // The alternation is a real one: what it leaves out stays out.
        expect(asRegex).not.toContain('/users/');
    });

    it('reaches a parameter through the route its operation sits on', async () => {
        const { out } = await run(
            ['schema', 'list', 'properties', '--dir', dir, '--path', '/pets*'],
            true,
        );
        const result = JSON.parse(out) as { rows: { id: string }[] };

        expect(result.rows.length).toBeGreaterThan(0);
        // A schema sits on no one route, so only parameters can come back.
        expect(result.rows.every((r) => r.id.includes('#'))).toBe(true);
    });

    it('names the document each row came from when asked', async () => {
        const { out } = await run(['schema', 'list', 'methods', '--dir', dir, '--show-source']);
        expect(out).toContain('[source: petstore]');
    });

    it('answers nothing without failing, because empty is an answer', async () => {
        const { out, err } = await invoke(
            ['schema', 'list', 'types', '--dir', dir, '--name', 'Nope'],
            false,
        );
        expect(err).toContain('0');
        expect(out.trim()).toBe('');
    });

    it('reports the true total even when it prints fewer', async () => {
        const { out } = await run(
            ['schema', 'list', 'properties', '--dir', dir, '--limit', '2'],
            true,
        );
        const result = JSON.parse(out) as { found: number; truncated: boolean; rows: unknown[] };

        expect(result.rows).toHaveLength(2);
        expect(result.truncated).toBe(true);
        // The count is of everything that matched, not of what survived the
        // limit — otherwise a capped answer would lie about the API.
        expect(result.found).toBeGreaterThan(2);
    });
});

describe('grep', () => {
    it('needs a pattern', async () => {
        expect((await fails(['schema', 'grep', '--dir', dir])).code).toBe(EXIT.usage);
    });

    it('finds every literal occurrence, whatever a ranking would rate them', async () => {
        const { out } = await run(['schema', 'grep', 'password', '--dir', dir], true);
        const result = JSON.parse(out) as { found: number; matches: { id: string }[] };
        const ids = result.matches.map((m) => m.id);

        expect(result.found).toBe(ids.length);
        expect(ids).toContain('Type:ResetPasswordPayload');
        expect(ids).toContain('Property:ResetPasswordPayload.password');
    });

    it('takes a regex when told to, and refuses a broken one', async () => {
        const { out } = await run(['schema', 'grep', 'pass(word|phrase)', '--dir', dir, '--regex']);
        expect(out).toContain('password');

        const err = await fails(['schema', 'grep', '(unclosed', '--dir', dir, '--regex']);
        expect(err.code).toBe(EXIT.usage);
        expect(err.message).toContain('invalid pattern');
    });

    it('narrows to a kind, and refuses one that is not a kind', async () => {
        const { out } = await run(['schema', 'grep', 'password', '--dir', dir, '--kind', 'type']);
        expect(out).toContain('Type:');
        expect(out).not.toContain('Property:');

        expect((await fails(['schema', 'grep', 'x', '--dir', dir, '--kind', 'wat'])).code).toBe(
            EXIT.usage,
        );
    });

    it('prints bare ids on demand, so the shell can pipe them into show', async () => {
        const { out } = await run(['schema', 'grep', 'password', '--dir', dir, '--ids-only']);
        const ids = out.trim().split('\n');

        expect(ids.length).toBeGreaterThan(0);
        expect(ids.every((id) => /^(Method|Type|Property):/.test(id))).toBe(true);
    });

    it('takes the same --name and --path constraints `list` takes', async () => {
        const { out } = await run([
            'schema',
            'grep',
            'password',
            '--dir',
            dir,
            '--name',
            'ResetPasswordPayload',
            '--ids-only',
        ]);
        expect(out.trim().split('\n')).toEqual(['Type:ResetPasswordPayload']);

        const { out: byRoute } = await run(
            ['schema', 'grep', 'pet', '--dir', dir, '--path', '/pets*', '--ids-only'],
            false,
        );
        const ids = byRoute.trim().split('\n').filter(Boolean);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.some((id) => id.startsWith('Type:'))).toBe(false);
    });

    it('names the document a match came from when asked', async () => {
        const { out } = await run(['schema', 'grep', 'password', '--dir', dir, '--show-source']);
        expect(out).toContain('[source: petstore]');
    });

    it('exits clean on no match, since absence is the answer it was asked for', async () => {
        const { out, error } = await invoke(['schema', 'grep', 'passwrd', '--dir', dir], false);
        expect(error).toBeUndefined();
        expect(out.trim()).toBe('');
    });
});

describe('trace', () => {
    it('needs something to trace', async () => {
        expect((await fails(['schema', 'trace', '--dir', dir])).code).toBe(EXIT.usage);
    });

    it('walks a nested field up to the call that carries it', async () => {
        const { out } = await run(['schema', 'trace', 'city', '--dir', dir]);

        // Three lookups by hand: the field is on Address, Address is held by
        // PublicUserProfile.address, and only PublicUserProfile is returned.
        expect(out).toContain('Property:Address.city');
        expect(out).toContain('GET /users/{userId}');
        expect(out).toContain('PublicUserProfile.address → Address.city');
    });

    it('reads a node id as that node, and a word as a pattern', async () => {
        const { out } = await run(['schema', 'trace', 'Type:Cat', '--dir', dir], true);
        const result = JSON.parse(out) as { found: number; traces: { id: string }[] };

        expect(result.found).toBe(1);
        expect(result.traces[0]!.id).toBe('Type:Cat');
    });

    it('says which side of the call each operation is on', async () => {
        const { out } = await run(
            ['schema', 'trace', 'Property:ResetPasswordPayload.password', '--dir', dir],
            true,
        );
        const result = JSON.parse(out) as {
            traces: { routes: { path: string; direction: string }[] }[];
        };

        expect(result.traces[0]!.routes).toEqual([
            expect.objectContaining({ path: '/auth/reset-password', direction: 'input' }),
        ]);
    });

    it('keeps only the side that was asked for', async () => {
        const { out } = await run([
            'schema',
            'trace',
            'Property:Address.city',
            '--dir',
            dir,
            '--direction',
            'input',
        ]);
        // Nothing accepts an address. That is an answer, not a failure.
        expect(out).toContain('no operation reaches it');
    });

    it('gives bare operation ids to pipe into show', async () => {
        const { out } = await run(['schema', 'trace', 'meowVolume', '--dir', dir, '--ids-only']);
        expect(out.trim().split('\n')).toContain('Method:createPet');
    });

    it('says nothing is called that, rather than answering emptily', async () => {
        const { out, err } = await run(['schema', 'trace', 'mfa_secret', '--dir', dir]);
        expect(out.trim()).toBe('');
        expect(err).toContain('0 node(s)');
    });
});

describe('show', () => {
    it('needs an id', async () => {
        expect((await fails(['schema', 'show', '--dir', dir])).code).toBe(EXIT.usage);
    });

    it('names the document a node came from without being asked for --json', async () => {
        const plain = await run(['schema', 'show', '--dir', dir, 'Type:ResetPasswordPayload']);
        expect(plain.out).not.toContain('[source:');

        const { out } = await run([
            'schema',
            'show',
            '--dir',
            dir,
            'Type:ResetPasswordPayload',
            '--show-source',
        ]);
        expect(out).toContain('[source: petstore]');
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

    it('takes a type by name, so the caller need not know the id scheme', async () => {
        const { out } = await run([
            'schema',
            'show',
            '--dir',
            dir,
            '--type',
            'ResetPasswordPayload',
            '--format',
            'ts',
        ]);
        expect(out).toContain('export interface ResetPasswordPayload');
    });

    it('takes an operation by name', async () => {
        const { out } = await run(['schema', 'show', '--dir', dir, '--method', 'resetPassword']);
        expect(out).toContain('/auth/reset-password');
    });

    it('fails on a name it does not have, pointing at the way to find it', async () => {
        const err = await fails(['schema', 'show', '--dir', dir, '--method', 'resetPasswrd']);
        expect(err.code).toBe(EXIT.failed);
        expect(err.hint).toContain('zen rag schema list methods');
    });

    it('keeps to exactly what was named when asked to be exact', async () => {
        const { out } = await run(
            ['schema', 'show', '--dir', dir, '--type', 'ResetPasswordPayload', '--exact'],
            true,
        );
        const result = JSON.parse(out) as { ids: string[]; subgraphs: { nodes: unknown[] }[] };

        expect(result.ids).toEqual(['Type:ResetPasswordPayload']);
        // Without --exact the neighbours come too; with it, the answer is the
        // one node that was asked for.
        expect(result.subgraphs[0]!.nodes).toHaveLength(1);
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
