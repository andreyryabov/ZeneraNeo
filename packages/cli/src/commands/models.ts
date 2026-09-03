// ---------------------------------------------------------------------------
// zen models
//
// What this machine *can* use, as opposed to whether one particular project
// works. `zen check` answers the second question — it resolves a project,
// audits its credentials and asks every model it declares one real question.
// This command answers the first, and needs no project at all.
//
// The split matters most when something breaks. `zen check` says "this
// embedder was refused"; `zen models pick --embedding` says "use this one
// instead", and prints a ref on stdout that can be pasted straight back into
// agents.yaml — or read by an agent doing the pasting.
// ---------------------------------------------------------------------------

import { createEmbedder, createModel, ModelRegistry } from '@zenera/neo';

import { parse } from '../args.ts';
import {
    loadCatalog,
    loadCatalogs,
    matches,
    PREFERRED,
    type Catalog,
    type CatalogEntry,
    type Filters,
    type Role,
} from '../catalog.ts';
import type { Command, Context } from '../command.ts';
import { ensureHome } from '../home.ts';
import { envNames, form, isProvider, KeyStore, PROVIDERS, type Provider } from '../keys.ts';
import { probeModel, type ModelProbe, type ModelTarget } from '../liveness.ts';
import {
    ago,
    bold,
    credentialError,
    cyan,
    dim,
    green,
    json,
    note,
    progress,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen models <providers|ls|search|show|test|pick> [ref] [options]';

type Sub = (ctx: Context, args: readonly string[]) => Promise<void>;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface Credentialed {
    store: KeyStore;
    /** providers whose variable was already set in the real environment */
    fromEnv: Set<Provider>;
    /** providers this machine can actually reach, environment first */
    usable: Provider[];
}

/**
 * The keyring is materialised here, and only here.
 *
 * The frame does not do it, so every command that needs a credential asks for
 * one itself. Forgetting looks exactly like a missing key, which is the most
 * expensive kind of bug this file could have.
 */
async function credentials(): Promise<Credentialed> {
    ensureHome();
    const store = await KeyStore.open();
    // Asked before materialising, because materialising is what erases the
    // difference between "the environment had it" and "the keyring supplied it".
    const fromEnv = new Set(PROVIDERS.filter((p) => envNames(p).some((n) => process.env[n])));
    store.materialize();
    const usable = [
        ...PROVIDERS.filter((p) => fromEnv.has(p)),
        ...PROVIDERS.filter((p) => !fromEnv.has(p) && Boolean(store.active(p))),
    ];
    return { store, fromEnv, usable };
}

function source(where: Credentialed, provider: Provider): string {
    if (where.fromEnv.has(provider)) {
        return 'environment';
    }
    return where.store.active(provider) ? 'keyring' : '';
}

/** The providers a subcommand should touch, given an optional `--provider`. */
function scope(where: Credentialed, only: string | undefined): Provider[] {
    if (!only) {
        if (where.usable.length === 0) {
            throw credentialError(
                'no provider on this machine has a credential',
                'try: zen key add openai',
            );
        }
        return where.usable;
    }
    if (!isProvider(only)) {
        throw usageError(`unknown provider "${only}"`, `known: ${PROVIDERS.join(', ')}`);
    }
    return [only];
}

interface RoleFlags {
    chat?: boolean;
    embedding?: boolean;
    embeddings?: boolean;
    images?: boolean;
    audio?: boolean;
}

const ROLE_OPTIONS = {
    chat: { type: 'boolean' },
    // Both spellings, because half the flags in this CLI read as a filter over
    // a set and half as a choice of one, and nobody should have to remember
    // which this is.
    embedding: { type: 'boolean' },
    embeddings: { type: 'boolean' },
    images: { type: 'boolean' },
    audio: { type: 'boolean' },
} as const;

function rolesFrom(values: RoleFlags): Role[] {
    const roles: Role[] = [];
    if (values.chat) {
        roles.push('chat');
    }
    if (values.embedding || values.embeddings) {
        roles.push('embedding');
    }
    if (values.images) {
        roles.push('image');
    }
    if (values.audio) {
        roles.push('audio');
    }
    return roles;
}

const num = (value: string | undefined, what: string): number | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw usageError(`${what} must be a number, got "${value}"`);
    }
    return n;
};

const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

const tokens = (n: number | undefined): string => {
    if (n === undefined) {
        return '';
    }
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
};

/** Freshness of a listing, said the way a person would ask about it. */
function freshness(cat: Catalog): string {
    if (cat.origin === 'curated') {
        return yellow('built-in list');
    }
    if (cat.origin === 'stale') {
        return yellow(`stale, ${ago(cat.fetchedAt)}`);
    }
    return cat.origin === 'live' ? green('fetched now') : dim(`cached ${ago(cat.fetchedAt)}`);
}

const roleMark = (row: CatalogEntry): string => row.roles.join('+');

function row(entry: CatalogEntry): string[] {
    return [
        cyan(entry.ref),
        dim(roleMark(entry)),
        dim(tokens(entry.contextLength)),
        dim(entry.pricing?.free ? 'free' : ''),
        dim(entry.name ?? ''),
    ];
}

/**
 * Says how a listing was obtained whenever it was not the vendor's own word —
 * on stderr, because it is narration about the answer rather than the answer.
 */
function explain(cats: readonly Catalog[]): void {
    for (const cat of cats) {
        if (cat.problem) {
            note(
                `${yellow(cat.provider)} could not be listed: ${cat.problem.detail ?? 'no reason given'} ` +
                    dim(`(showing the ${cat.origin} list)`),
            );
            if (cat.problem.fix) {
                note(dim(`  ${cat.problem.fix}`));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

/**
 * The overview, and deliberately an offline one: five listing round trips is
 * the wrong price for the question "what have I got set up". `ls` fetches.
 */
const providers: Sub = async (ctx, args) => {
    const { values } = parse<{ refresh?: boolean }>(
        args,
        { refresh: { type: 'boolean' } },
        'zen models providers [--refresh]',
    );
    const where = await credentials();
    const cats = await loadCatalogs(PROVIDERS, {
        offline: !values.refresh,
        refresh: values.refresh,
    });
    const by = new Map(cats.map((c) => [c.provider, c]));

    if (ctx.json) {
        json(
            PROVIDERS.map((p) => ({
                provider: p,
                credential: source(where, p) || null,
                env: form(p).env,
                models: by.get(p)?.entries.length ?? 0,
                origin: by.get(p)?.origin,
                fetchedAt: by.get(p)?.fetchedAt,
            })),
        );
        return;
    }

    writeAll(
        table(
            PROVIDERS.map((p) => {
                const cat = by.get(p)!;
                const cred = source(where, p);
                const counted = `${cat.entries.length} model${cat.entries.length === 1 ? '' : 's'}`;
                return [
                    cred ? cyan(p) : dim(p),
                    cred ? green(cred) : red('no credential'),
                    cred ? dim(counted) : dim(''),
                    cred ? freshness(cat) : dim(`zen key add ${p}`),
                ];
            }),
        ),
    );
    note('');
    note(dim('zen models ls <provider>   what one of them serves'));
    note(dim('zen models pick --chat     the first one that answers'));
};

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const ls: Sub = async (ctx, args) => {
    const { values, positionals } = parse<
        RoleFlags & { refresh?: boolean; limit?: string; all?: boolean }
    >(
        args,
        {
            ...ROLE_OPTIONS,
            refresh: { type: 'boolean' },
            limit: { type: 'string' },
            all: { type: 'boolean' },
        },
        'zen models ls [provider] [--chat] [--embeddings] [--refresh] [--limit N] [--all]',
    );
    const where = await credentials();
    const targets = scope(where, positionals[0]);
    const roles = rolesFrom(values);
    const limit = values.all ? Infinity : (num(values.limit, '--limit') ?? 40);

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`listing ${targets.join(', ')} …`));
    const cats = await loadCatalogs(targets, { refresh: values.refresh });
    bar?.done();

    const all = cats
        .flatMap((c) => c.entries)
        .filter((e) => matches(e, '', { roles }))
        .sort((a, b) => a.ref.localeCompare(b.ref));

    if (ctx.json) {
        json({
            models: all,
            sources: cats.map(({ provider, origin, fetchedAt }) => ({
                provider,
                origin,
                fetchedAt,
            })),
        });
        return;
    }
    explain(cats);
    if (all.length === 0) {
        note(dim('nothing matched — try: zen models ls --refresh'));
        return;
    }
    writeAll(table(all.slice(0, limit).map(row)));
    if (all.length > limit) {
        note(dim(`${all.length - limit} more — narrow with \`zen models search\`, or pass --all`));
    }
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const search: Sub = async (ctx, args) => {
    type Values = RoleFlags & {
        provider?: string;
        tools?: boolean;
        vision?: boolean;
        free?: boolean;
        'min-context'?: string;
        limit?: string;
        refresh?: boolean;
    };
    const { values, positionals } = parse<Values>(
        args,
        {
            ...ROLE_OPTIONS,
            provider: { type: 'string' },
            tools: { type: 'boolean' },
            vision: { type: 'boolean' },
            free: { type: 'boolean' },
            'min-context': { type: 'string' },
            limit: { type: 'string' },
            refresh: { type: 'boolean' },
        },
        'zen models search <query> [--provider p] [--embeddings] [--tools] [--vision] [--free] [--min-context N] [--limit N]',
    );
    const query = positionals.join(' ').trim();
    const where = await credentials();
    const targets = scope(where, values.provider);
    const limit = num(values.limit, '--limit') ?? 20;

    const filters: Filters = {
        roles: rolesFrom(values),
        tools: values.tools,
        vision: values.vision,
        free: values.free,
        minContext: num(values['min-context'], '--min-context'),
    };

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`searching ${targets.join(', ')} …`));
    const cats = await loadCatalogs(targets, { refresh: values.refresh });
    bar?.done();

    const hits = cats
        .flatMap((c) => c.entries)
        .filter((e) => matches(e, query, filters))
        // Cheapest first when price is known: search is usually the step before
        // picking one, and the free ones are what most people are looking for.
        .sort(
            (a, b) =>
                Number(b.pricing?.free ?? false) - Number(a.pricing?.free ?? false) ||
                a.ref.localeCompare(b.ref),
        );

    if (ctx.json) {
        json({ query, matched: hits.length, models: hits.slice(0, limit) });
        return;
    }
    explain(cats);
    if (hits.length === 0) {
        note(dim(`nothing matched "${query}" — try fewer words, or --refresh`));
        return;
    }
    writeAll(table(hits.slice(0, limit).map(row)));
    if (hits.length > limit) {
        note(dim(`${hits.length - limit} more — raise --limit, or add a word`));
    }
    note(dim('zen models test <ref>   ask one of them whether it answers'));
};

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * Splits a ref without building anything. `ModelRegistry.parse` is the same
 * splitter the runtime uses, so a ref that reads here reads there — and a typo
 * is a usage error rather than a credential one.
 */
function split(ref: string): { provider: Provider; id: string } {
    const registry = new ModelRegistry();
    let spec: { provider?: string; model: string };
    try {
        spec = registry.parse(ref);
    } catch (err) {
        throw usageError(
            err instanceof Error ? err.message.split('\n')[0]! : `bad reference "${ref}"`,
            'expected provider:model — see: zen models ls',
        );
    }
    const provider = spec.provider ?? registry.defaultProvider;
    if (!isProvider(provider)) {
        throw usageError(
            `"${provider}" is not a provider this command knows`,
            `known: ${PROVIDERS.join(', ')}`,
        );
    }
    return { provider, id: spec.model };
}

const show: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ refresh?: boolean }>(
        args,
        { refresh: { type: 'boolean' } },
        'zen models show <provider:model> [--refresh]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which model?', 'see: zen models ls');
    }
    const { provider, id } = split(ref);
    const cat = await loadCatalog(provider, { refresh: values.refresh });
    const found = cat.entries.find((e) => e.id === id);

    if (ctx.json) {
        json(found ?? { ref: `${provider}:${id}`, provider, id, known: false });
        return;
    }
    explain([cat]);
    if (!found) {
        note(`${yellow('not listed')} ${provider} does not advertise ${bold(id)}`);
        note(dim(`it may still work — try: zen models test ${provider}:${id}`));
        note(dim(`or look: zen models search ${id} --provider ${provider}`));
        return;
    }
    const rows: string[][] = [
        [dim('ref'), cyan(found.ref)],
        [dim('roles'), found.roles.join(', ')],
    ];
    const add = (label: string, value: string | undefined): void => {
        if (value) {
            rows.push([dim(label), value]);
        }
    };
    add('name', found.name);
    add(
        'context',
        found.contextLength ? `${found.contextLength.toLocaleString()} tokens` : undefined,
    );
    add(
        'max output',
        found.maxOutputTokens ? `${found.maxOutputTokens.toLocaleString()} tokens` : undefined,
    );
    add('dimensions', found.dimensions ? String(found.dimensions) : undefined);
    add('input', found.modalities?.input?.join(', '));
    add('output', found.modalities?.output?.join(', '));
    add(
        'supports',
        Object.entries(found.supports ?? {})
            .filter(([, on]) => on)
            .map(([k]) => k)
            .join(', '),
    );
    add(
        'pricing',
        found.pricing?.free
            ? 'free'
            : found.pricing?.prompt
              ? `$${found.pricing.prompt}/token in, $${found.pricing.completion ?? '?'}/token out`
              : undefined,
    );
    add('released', found.created);
    add('source', found.source === 'live' ? `${provider}, ${freshness(cat)}` : 'built-in list');
    writeAll(table(rows));
    if (found.description) {
        note('');
        note(dim(found.description));
    }
};

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

/**
 * Which role to ask in. An explicit flag wins; then what the provider says the
 * model is for; then the id, which is the last resort and the only one that can
 * be wrong.
 */
async function roleOf(provider: Provider, id: string, forced: Role | undefined): Promise<Role> {
    if (forced) {
        return forced;
    }
    // Offline: this is one lookup on the way to a real call, and it must not
    // add a listing round trip to every `test`.
    const cat = await loadCatalog(provider, { offline: true });
    const known = cat.entries.find((e) => e.id === id);
    if (known?.roles.includes('embedding') && !known.roles.includes('chat')) {
        return 'embedding';
    }
    if (known?.roles.includes('chat')) {
        return 'chat';
    }
    return /embed/.test(id) ? 'embedding' : 'chat';
}

function target(ref: string, provider: Provider, id: string, role: Role): ModelTarget {
    if (role === 'embedding') {
        return { ref, kind: 'embedding', embedder: createEmbedder({ provider, model: id }) };
    }
    if (role !== 'chat') {
        throw usageError(
            `${ref} is ${role}-only, and there is no way to ask it a question from here`,
            'zen models test only exercises chat and embedding models',
        );
    }
    // 16 tokens is enough for "ok" and not enough to matter. Anthropic requires
    // a cap at all, so this is not merely thrift.
    return { ref, kind: 'model', model: createModel({ provider, model: id, maxTokens: 16 }) };
}

function verdict(probe: ModelProbe): string {
    switch (probe.check.state) {
        case 'live':
            return `${green('answers')} ${dim(ms(probe.ms))}`;
        case 'blocked':
            return yellow('blocked');
        case 'dead':
            return red('refused');
        default:
            return dim('no answer');
    }
}

const test: Sub = async (ctx, args) => {
    const { values, positionals } = parse<RoleFlags>(
        args,
        ROLE_OPTIONS,
        'zen models test <provider:model> … [--chat|--embedding]',
    );
    if (positionals.length === 0) {
        throw usageError('which model?', 'see: zen models ls');
    }
    const forced = rolesFrom(values)[0];

    // Every ref is split before anything is built, so a typo in the third one
    // does not arrive after two billable calls.
    const parsed = positionals.map((ref) => ({ ref, ...split(ref) }));
    await credentials();

    const probes: ModelProbe[] = [];
    const bar = ctx.json ? undefined : progress();
    for (const { ref, provider, id } of parsed) {
        bar?.update(dim(`asking ${ref} …`));
        probes.push(
            await probeModel(target(ref, provider, id, await roleOf(provider, id, forced))),
        );
    }
    bar?.done();

    if (ctx.json) {
        json(probes);
    } else {
        writeAll(
            table(
                probes.map((p) => [
                    cyan(p.ref),
                    verdict(p),
                    dim(p.dimensions ? `${p.dimensions} dims` : ''),
                    dim(p.check.detail ?? ''),
                ]),
            ),
        );
        for (const p of probes) {
            if (p.check.fix) {
                note(dim(`${p.ref}: ${p.check.fix}`));
            }
        }
    }
    const failed = probes.filter((p) => p.check.state !== 'live');
    if (failed.length > 0) {
        // The suggestion follows what was actually asked, not what was flagged:
        // being told to `pick --chat` after an embedder was refused is how a
        // recovery path stops being one.
        const role = failed.every((p) => p.kind === 'embedding') ? '--embedding' : '--chat';
        throw credentialError(
            `${failed.length} of ${probes.length} did not answer`,
            `find one that does: zen models pick ${role}`,
        );
    }
};

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

/**
 * The recovery path, and the reason this command exists.
 *
 * Candidates are tried one at a time and the walk stops at the first that
 * answers. Sequential on purpose: the goal is *one* working ref, and firing
 * eight billable calls to find it is the wrong trade — especially for the
 * caller most likely to be running this, which is an agent that has just been
 * refused and is looking for somewhere else to go.
 */
const pick: Sub = async (ctx, args) => {
    const { values } = parse<RoleFlags & { provider?: string; limit?: string }>(
        args,
        { ...ROLE_OPTIONS, provider: { type: 'string' }, limit: { type: 'string' } },
        'zen models pick --chat|--embedding [--provider p] [--limit N]',
    );
    const roles = rolesFrom(values);
    if (roles.length !== 1 || (roles[0] !== 'chat' && roles[0] !== 'embedding')) {
        throw usageError('which kind of model?', 'pass --chat or --embedding');
    }
    const role = roles[0];

    const where = await credentials();
    const targets = scope(where, values.provider);
    const cap = num(values.limit, '--limit') ?? 8;
    const candidates = targets
        .flatMap((p) => PREFERRED[p][role].map((id) => ({ provider: p, id, ref: `${p}:${id}` })))
        .slice(0, cap);

    if (candidates.length === 0) {
        throw credentialError(
            `no ${role} model is known for ${targets.join(', ')}`,
            'try: zen models pick --provider openai',
        );
    }

    const tried: ModelProbe[] = [];
    const bar = ctx.json ? undefined : progress();
    for (const candidate of candidates) {
        bar?.update(dim(`trying ${candidate.ref} …`));
        const probe = await probeModel(
            target(candidate.ref, candidate.provider, candidate.id, role),
        );
        tried.push(probe);
        if (probe.check.state !== 'live') {
            continue;
        }
        bar?.done();
        if (ctx.json) {
            json({
                ref: probe.ref,
                provider: candidate.provider,
                model: candidate.id,
                role,
                ...(probe.dimensions ? { dimensions: probe.dimensions } : {}),
                ms: probe.ms,
                tried: tried.map(({ ref, check }) => ({ ref, ...check })),
            });
            return;
        }
        for (const t of tried.slice(0, -1)) {
            note(`${dim(t.ref)} ${verdict(t)} ${dim(t.check.detail ?? '')}`);
        }
        note(`${green('works')} ${bold(probe.ref)} ${dim(ms(probe.ms))}`);
        // stdout, alone and unstyled, so `$(zen models pick --embedding)` is
        // the ref and nothing else.
        write(probe.ref);
        return;
    }
    bar?.done();

    if (ctx.json) {
        json({ ref: null, role, tried: tried.map(({ ref, check }) => ({ ref, ...check })) });
    } else {
        writeAll(
            table(
                tried.map((t) => [
                    dim(t.ref),
                    verdict(t),
                    dim(t.check.fix ?? t.check.detail ?? ''),
                ]),
            ),
        );
    }
    throw credentialError(
        `no ${role} model answered on this machine`,
        'add a credential: zen key add openai',
    );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUBS: Record<string, Sub> = {
    providers,
    ls,
    list: ls,
    search: search,
    find: search,
    show: show,
    test,
    check: test,
    pick,
};

export const models: Command = {
    summary: 'What this machine can use: list, search, test and pick models.',
    usage: USAGE,
    details: [
        'Answers "what can I use", using the credentials already on this',
        'machine. `zen check` answers the other question — whether one',
        'particular project works — and needs a project to do it.',
        '',
        'Listings come from the providers themselves and are cached for a day',
        'in ~/.zenera/neo/catalog. When a provider cannot be asked, the last',
        'listing is used and said to be stale; only if there was never one does',
        'a short built-in list stand in.',
        '',
        '  zen models                       Providers, credentials and counts.',
        '  zen models <provider>            Short for `ls <provider>`.',
        '  zen models ls [provider]         Everything it serves.',
        '  zen models search <query>        Narrow it — --tools, --vision, --free.',
        '  zen models show <ref>            One model, in full.',
        '  zen models test <ref> …          Ask it one real question.',
        '  zen models pick --embedding      The first ref that answers, on stdout.',
    ],
    run: async (ctx) => {
        const [name, ...rest] = ctx.args;
        if (!name) {
            await providers(ctx, []);
            return;
        }
        const sub = SUBS[name];
        if (sub) {
            await sub(ctx, rest);
            return;
        }
        // `zen models openai` is the thing people type, and it means `ls`.
        // Safe because no provider is named after a subcommand.
        if (isProvider(name)) {
            await ls(ctx, ctx.args);
            return;
        }
        throw usageError(
            `unknown: zen models ${name}`,
            `try: ${cyan('providers, ls, search, show, test, pick')} — or a provider: ${dim(PROVIDERS.join(', '))}`,
        );
    },
};
