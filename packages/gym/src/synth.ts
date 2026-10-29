import { tool, type AnyTool, type Model } from '@zenera/neo';
import type { SynthesizeHook } from './box.ts';
import type { Catalog } from './catalog.ts';
import type { GeneratorInput } from './envelope.ts';
import { runAgent } from './agents.ts';
import { sample } from './fake.ts';
import { ACCOUNTS, matches, OWNER, populatedKey, type SynthesisRequest } from './runtime.ts';
import { WorldStore } from './store.ts';
import type { Story } from './story.ts';

// ---------------------------------------------------------------------------
// The world agent
//
// Handlers know where content lives; this is where it comes from. A handler
// that finds the world empty — no messages yet, no event with that id — asks
// for records, and an agent writes them: reading the story, reading what the
// world already holds so the same people keep the same addresses across APIs,
// and saving records that are checked against the schema before anything can
// read them. What it saves is permanent, so the second request sees the first
// request's world.
//
// Judging a handler asks for content too, and gets `fake.ts` instead: a probe
// is about mechanics, and an agent call per probe would make every build slow
// and every build cost.
// ---------------------------------------------------------------------------

/**
 * Accounts are the one collection no document declares: who `me` is, and who
 * everyone else is, shared by every API in the world. So their shape is ours.
 */
const ACCOUNT_SCHEMA = {
    type: 'object',
    required: ['id', 'email', 'displayName'],
    properties: {
        id: {
            type: 'string',
            description: `"${OWNER}" for the account the API is called as; otherwise the email`,
        },
        email: { type: 'string', format: 'email' },
        displayName: { type: 'string' },
        timeZone: { type: 'string', description: 'IANA zone, e.g. Europe/Berlin' },
    },
};

const ACCOUNT_DECLARATION = `interface Account {
    /** "${OWNER}" for the account the API is called as; otherwise the email */
    id: string;
    email: string;
    displayName: string;
    /** IANA zone, e.g. Europe/Berlin */
    timeZone?: string;
}`;

const MAX_RECORDS = 50;
const DEFAULT_COUNT = 5;
const MAX_TOOL_CALLS = 14;
/** What one read of a collection may put into the prompt. */
const READ_CHARS = 24_000;

export interface WorldEvent {
    collection: string;
    made: number;
    /** the agent did not deliver and sampled records stood in */
    fallback?: string;
    report?: string;
    durationMs: number;
}

export interface WorldOptions {
    model: Model;
    story: Story;
    catalog: Catalog;
    /** the live world */
    store: WorldStore;
    reportDir?: string;
    onMade?: (event: WorldEvent) => void;
}

export class World {
    readonly store: WorldStore;
    readonly #opts: WorldOptions;
    readonly #stores = new Map<string, WorldStore>();
    readonly #locks = new Map<string, Promise<unknown>>();

    constructor(opts: WorldOptions) {
        this.#opts = opts;
        this.store = opts.store;
    }

    /** Given to the box: every request a handler makes for content lands here. */
    readonly synthesize: SynthesizeHook = (request, context) => {
        const req = normalizeRequest(request);
        const store = this.#storeFor(context.db);
        if (context.probe) {
            return Promise.resolve(this.#stub(store, req, context.input.seed));
        }
        // One agent per collection at a time: two requests that both found the
        // inbox empty must not both fill it.
        const key = `${context.db}\u0000${req.collection}`;
        const before = this.#locks.get(key) ?? Promise.resolve();
        const mine = before
            .catch(() => undefined)
            .then(() => this.#make(store, req, context.input));
        this.#locks.set(key, mine);
        void mine.finally(() => {
            if (this.#locks.get(key) === mine) {
                this.#locks.delete(key);
            }
        });
        return mine;
    };

    /** Forgets a world that was only borrowed, such as a judging snapshot. */
    release(db: string): void {
        const store = this.#stores.get(db);
        if (store && store !== this.store) {
            store.close();
        }
        this.#stores.delete(db);
    }

    close(): void {
        for (const db of [...this.#stores.keys()]) {
            this.release(db);
        }
    }

    // -----------------------------------------------------------------------

    #storeFor(db: string): WorldStore {
        if (db === this.store.path) {
            return this.store;
        }
        let store = this.#stores.get(db);
        if (!store) {
            store = new WorldStore(db);
            this.#stores.set(db, store);
        }
        return store;
    }

    async #make(
        store: WorldStore,
        req: Required<Pick<SynthesisRequest, 'collection' | 'idField'>> & SynthesisRequest,
        input: GeneratorInput,
    ): Promise<Record<string, unknown>[]> {
        const col = store.collection(req.collection);
        // Whoever held the lock may already have made what is wanted.
        if (req.ids?.length && req.ids.every((id) => col.has(id))) {
            return req.ids.map((id) => col.get(id)!);
        }
        const key = populatedKey(req.collection, req.where);
        if (!req.ids?.length && req.min !== undefined) {
            const have = col.all().filter((r) => matches(r, req.where));
            if (have.length >= req.min && (!req.populate || store.getMeta(key))) {
                return have;
            }
        }

        const started = Date.now();
        const saved = new Map<string, Record<string, unknown>>();
        const wanted = req.ids?.length ?? Math.min(req.count ?? DEFAULT_COUNT, MAX_RECORDS);
        const done = (): boolean =>
            req.ids?.length ? req.ids.every((id) => saved.has(String(id))) : saved.size >= wanted;

        let report: string | undefined;
        let failure: string | undefined;
        try {
            const run = await runAgent({
                model: this.#opts.model,
                name: 'world',
                label: req.collection,
                instructions: this.#instructions(),
                tools: [...this.#opts.story.tools, ...this.#tools(store, req, saved)],
                input: this.#brief(store, req, input, wanted),
                maxToolCalls: MAX_TOOL_CALLS,
                done,
                reportDir: this.#opts.reportDir,
            });
            report = run.report;
            if (!done()) {
                failure = `the world agent saved ${saved.size} of ${wanted} records`;
            }
        } catch (err) {
            failure = `the world agent failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        let made = [...saved.values()];
        if (!req.ids?.length) {
            store.setMeta(key, true);
        }
        if (failure) {
            // Better a plausible-shaped answer than a failed request: the rest
            // is sampled from the schema, and the narration says so.
            made = [
                ...made,
                ...this.#stub(
                    store,
                    { ...req, ids: missing(req, saved), count: wanted - saved.size },
                    input.seed,
                ),
            ];
        }
        this.#opts.onMade?.({
            collection: req.collection,
            made: made.length,
            fallback: failure,
            report,
            durationMs: Date.now() - started,
        });
        return made;
    }

    #stub(store: WorldStore, req: SynthesisRequest, seed: number): Record<string, unknown>[] {
        const idField = req.idField ?? 'id';
        if (!req.ids?.length) {
            store.setMeta(populatedKey(req.collection, req.where), true);
        }
        const schema = req.type
            ? this.#opts.catalog.types[req.type]
            : req.collection === ACCOUNTS
              ? ACCOUNT_SCHEMA
              : undefined;
        const n = req.ids?.length ?? Math.max(0, Math.min(req.count ?? 3, MAX_RECORDS));
        const col = store.collection(req.collection);
        const out: Record<string, unknown>[] = [];
        for (let i = 0; i < n; i++) {
            const made = schema ? sample(schema, this.#opts.catalog.types, seed * 31 + i + 1) : {};
            const record: Record<string, unknown> =
                typeof made === 'object' && made !== null && !Array.isArray(made)
                    ? (made as Record<string, unknown>)
                    : {};
            Object.assign(record, req.where ?? {});
            const want = req.ids?.[i];
            // A path segment is text; a schema that calls the id a number gets a number.
            record[idField] =
                want !== undefined
                    ? typeof record[idField] === 'number' && /^-?\d+$/.test(String(want))
                        ? Number(want)
                        : want
                    : (record[idField] ?? `${req.collection}-${seed}-${col.count() + i + 1}`);
            col.put(String(record[idField]), record);
            out.push(record);
        }
        return out;
    }

    #instructions(): string {
        return [
            'You populate the world behind a simulated API. A request handler needs records',
            'that do not exist yet; you write them and save them with save_records.',
            '',
            this.#opts.story.brief,
            '',
            'RULES',
            '- Agree with the story. Use its people, names, addresses, dates, projects and',
            '  themes. Where it is silent, invent what fits it.',
            '- Respect what the story says has NOT happened: a meeting it calls unscheduled',
            '  is not on any calendar, a reply it says was not sent is not in the mailbox.',
            '  Those are left for the user of the API to do.',
            '- Agree with the world. Look at what other collections already hold',
            '  (list_collections, read_collection) and reuse the same people, ids and',
            '  facts: the world is shared by several APIs and must read as one place.',
            '- Every record must satisfy the type you are given. Required fields always;',
            '  optional ones where they make the record more realistic.',
            '- Write content a person would recognise: real-sounding subjects, bodies,',
            '  titles, descriptions; consistent timestamps; ids in the format the schema',
            '  asks for.',
            '- Save everything in one save_records call when you can. If it reports',
            '  errors, fix those records and save them again. Do not save duplicates.',
            '- Stop as soon as the request is satisfied.',
        ].join('\n');
    }

    #brief(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
        input: GeneratorInput,
        wanted: number,
    ): string {
        const catalog = this.#opts.catalog;
        const typed = req.type && catalog.hasType(req.type);
        const lines = [
            `Make records for the collection \`${req.collection}\`, keyed by \`${req.idField}\`.`,
            req.ids?.length
                ? `They must have exactly these ${req.idField} values: ${JSON.stringify(req.ids)}.`
                : `Make ${wanted} new records.`,
        ];
        if (req.populate) {
            lines.push(
                'This is the first time anyone reads this collection: fill it as the story has it',
                'today — a realistic, varied population — not only what this one request asks for.',
                "Records already in it were written by the API's users; keep them and add around them.",
            );
        }
        if (req.where && Object.keys(req.where).length > 0) {
            lines.push(`Every record must carry these values: ${JSON.stringify(req.where)}.`);
        }
        if (req.hint) {
            lines.push(`What they are for: ${req.hint}`);
        }
        lines.push(
            '',
            `The request that needs them: ${input.method.toUpperCase()} ${input.path}`,
            `  path ${JSON.stringify(input.pathParams)}  query ${JSON.stringify(input.query)}` +
                (input.body !== undefined
                    ? `  body ${clip(JSON.stringify(input.body), 1500)}`
                    : ''),
            `Today is ${new Date().toISOString().slice(0, 10)}.`,
            '',
        );
        if (typed) {
            const { code, omitted } = catalog.declare([req.type!], 16_000);
            lines.push(`Each record is a \`${req.type}\`:`, code.trimEnd());
            if (omitted.length > 0) {
                lines.push(`(also referenced, ask describe_types: ${omitted.join(', ')})`);
            }
        } else if (req.collection === ACCOUNTS) {
            lines.push(
                'Each record is an account. The one with id "' +
                    OWNER +
                    '" is the person the API is',
                'called as — the owner of the mailbox, calendar and data in the story.',
                ACCOUNT_DECLARATION,
            );
        } else {
            lines.push(
                'No schema type was named: make records shaped like the response the request expects.',
            );
        }
        const world = store.collections();
        lines.push(
            '',
            'THE WORLD SO FAR',
            ...(world.length > 0
                ? world.map(
                      (c) => `- ${c.name}: ${c.count} records (e.g. ${c.sampleIds.join(', ')})`,
                  )
                : ['- (empty)']),
        );
        return lines.join('\n');
    }

    #tools(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
        saved: Map<string, Record<string, unknown>>,
    ): AnyTool[] {
        const catalog = this.#opts.catalog;
        const validate = req.type
            ? catalog.validator(req.type)
            : req.collection === ACCOUNTS
              ? catalog.compile(ACCOUNT_SCHEMA)
              : undefined;

        const list = tool<Record<string, never>>({
            name: 'list_collections',
            description: 'Every collection in the world, with how many records it holds.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => ({ collections: store.collections() }),
        });

        const read = tool<{ collection: string; limit?: number; where?: Record<string, unknown> }>({
            name: 'read_collection',
            description:
                'Records already in a collection, oldest first. Read related collections to ' +
                'reuse their people, ids and facts.',
            parameters: {
                type: 'object',
                properties: {
                    collection: { type: 'string' },
                    limit: { type: 'integer', description: 'Default 10.' },
                    where: { type: 'object', description: 'Only records with these values.' },
                },
                required: ['collection'],
                additionalProperties: false,
            },
            execute: ({ collection, limit, where }) => {
                const all = store
                    .collection(collection)
                    .all()
                    .filter((r) => matches(r, where));
                const records = all.slice(0, Math.min(limit ?? 10, 50));
                return {
                    total: all.length,
                    records: JSON.parse(clip(JSON.stringify(records), READ_CHARS, true)),
                };
            },
        });

        const describe = tool<{ names: string[] }>({
            name: 'describe_types',
            description: 'Schema types by name, as TypeScript, with everything they refer to.',
            parameters: {
                type: 'object',
                properties: { names: { type: 'array', items: { type: 'string' } } },
                required: ['names'],
                additionalProperties: false,
            },
            execute: ({ names }) => {
                const { code, omitted } = catalog.declare(names, 30_000);
                return code
                    ? { typescript: code, omitted }
                    : { error: `no such type: ${names.join(', ')}` };
            },
        });

        const save = tool<{ records: Record<string, unknown>[] }>({
            name: 'save_records',
            description:
                `Validates records and saves the valid ones to \`${req.collection}\`. ` +
                'Reports every invalid record with what is wrong, so it can be fixed and saved again.',
            parameters: {
                type: 'object',
                properties: {
                    records: { type: 'array', items: { type: 'object' } },
                },
                required: ['records'],
                additionalProperties: false,
            },
            execute: ({ records }) => {
                const col = store.collection(req.collection);
                const errors: { index: number; problems: string[] }[] = [];
                let ok = 0;
                (Array.isArray(records) ? records : []).forEach((record, index) => {
                    const problems = this.#problems(record, req, validate);
                    if (problems.length > 0) {
                        errors.push({ index, problems });
                        return;
                    }
                    const id = String(record[req.idField]);
                    col.put(id, record);
                    saved.set(id, record);
                    ok++;
                });
                const left = missing(req, saved);
                return {
                    saved: ok,
                    errors,
                    ...(left?.length ? { stillMissing: left } : {}),
                    ...(!req.ids?.length
                        ? { stillNeeded: Math.max(0, (req.count ?? DEFAULT_COUNT) - saved.size) }
                        : {}),
                };
            },
        });

        return [list, read, describe, save];
    }

    #problems(
        record: unknown,
        req: SynthesisRequest & { idField: string },
        validate: ReturnType<Catalog['validator']>,
    ): string[] {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) {
            return ['is not an object'];
        }
        const r = record as Record<string, unknown>;
        const out: string[] = [];
        const id = r[req.idField];
        if (typeof id !== 'string' && typeof id !== 'number') {
            out.push(`\`${req.idField}\` is missing`);
        } else if (req.ids?.length && !req.ids.some((want) => String(want) === String(id))) {
            out.push(`\`${req.idField}\` ${JSON.stringify(id)} is not one of the ids asked for`);
        }
        for (const [k, v] of Object.entries(req.where ?? {})) {
            if (String(r[k]) !== String(v)) {
                out.push(`\`${k}\` must be ${JSON.stringify(v)}`);
            }
        }
        if (validate && !validate(r)) {
            for (const e of validate.errors ?? []) {
                // An id the client asked for wins over the id format: it is the
                // name the record will be looked up by.
                if (req.ids?.length && e.instancePath === `/${req.idField}`) {
                    continue;
                }
                out.push(`${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
            }
        }
        return out;
    }
}

function normalizeRequest(
    request: SynthesisRequest,
): SynthesisRequest & { collection: string; idField: string } {
    if (!request || typeof request.collection !== 'string' || !request.collection.trim()) {
        throw new Error('synthesize needs a `collection` name');
    }
    return {
        ...request,
        collection: request.collection.trim(),
        idField: request.idField ?? 'id',
        ids: request.ids?.slice(0, MAX_RECORDS),
    };
}

function missing(
    req: SynthesisRequest,
    saved: Map<string, unknown>,
): (string | number)[] | undefined {
    return req.ids?.filter((id) => !saved.has(String(id)));
}

function clip(text: string, max: number, json = false): string {
    if (text.length <= max) {
        return text;
    }
    return json
        ? JSON.stringify({ truncated: true, preview: text.slice(0, max) })
        : `${text.slice(0, max)}…`;
}
