import { existsSync } from 'node:fs';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { ensureHome } from '../home.ts';
import {
    ambient,
    ambientId,
    assertNotEmpty,
    describe,
    envNames,
    envOf,
    keyId,
    KeyStore,
    mask,
    OWNERS,
    parseRef,
    SHAPES,
    type Ambient,
    type KeyCheck,
    type KeyEntry,
    type KeyOwner,
    type Liveness,
} from '../keys.ts';
import { probe, probeAll } from '../liveness.ts';
import {
    ago,
    ask,
    askSecret,
    bold,
    confirm,
    credentialError,
    cyan,
    dim,
    green,
    isInteractive,
    json,
    note,
    progress,
    readStdin,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen key <ls|add|use|check|rm|show|env> [ref] [options]';

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MARK: Record<Liveness, string> = {
    live: green('live'),
    dead: red('dead'),
    unknown: dim('unknown'),
};

function state(entry: KeyEntry): string {
    return entry.check ? MARK[entry.check.state] : dim('unchecked');
}

/**
 * An ambient credential borrowed into the shape the rest of this file works
 * in. It is not in the store and never will be: `store.find` misses it, so
 * `store.record` drops its check and nothing is written to disk. That is the
 * intent — it can be listed and probed, not chosen or forgotten.
 */
function asEntry(cred: Ambient): KeyEntry {
    return {
        provider: cred.provider,
        name: cred.env ? `$${cred.env}` : 'adc',
        holds: cred.holds,
        value: cred.value,
        env: cred.env,
        addedAt: new Date().toISOString(),
    };
}

function rows(store: KeyStore, borrowed: readonly [Ambient, KeyEntry][]): string[] {
    const out: string[][] = [
        [bold(''), bold('KEY'), bold('VALUE'), bold('STATE'), bold('CHECKED')],
    ];
    for (const provider of OWNERS) {
        for (const entry of store.for(provider)) {
            const shadow = envNames(provider).find((name) => process.env[name]);
            out.push([
                store.isActive(entry) ? green('*') : ' ',
                keyId(entry),
                dim(describe(store, entry)),
                state(entry),
                dim(entry.check ? ago(entry.check.at) : '—') +
                    (shadow && store.isActive(entry) ? yellow(`  shadowed by $${shadow}`) : ''),
            ]);
        }
        for (const [cred, entry] of borrowed.filter(([c]) => c.provider === provider)) {
            out.push([
                dim('~'),
                dim(ambientId(cred)),
                dim(describe(store, entry)),
                state(entry),
                dim(cred.env ? 'from the environment' : 'from gcloud'),
            ]);
        }
    }
    return table(out);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

type Sub = (ctx: Context, args: readonly string[]) => Promise<void>;

/**
 * Checking is a network round trip per key, so it says which ones have come
 * back. Silence for ten seconds is indistinguishable from a hang.
 */
async function checkAll(
    ctx: Context,
    store: KeyStore,
    targets: readonly KeyEntry[],
): Promise<[KeyEntry, KeyCheck][]> {
    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`checking ${targets.length} key${targets.length === 1 ? '' : 's'} …`));
    try {
        return await probeAll(store, targets, (entry, done, total) =>
            bar?.update(dim(`checked ${keyId(entry)} … ${done}/${total}`)),
        );
    } finally {
        bar?.done();
    }
}

const ls: Sub = async (ctx, args) => {
    const { values } = parse<{ check?: boolean }>(args, { check: { type: 'boolean' } }, USAGE);
    const store = await KeyStore.open();
    const borrowed = ambient(store).map((cred) => [cred, asEntry(cred)] as [Ambient, KeyEntry]);

    if (values.check) {
        // Ambient credentials are checked alongside the stored ones and, unlike
        // them, forgotten again: there is nowhere to write the result, and a
        // variable that changes between runs would make a cached one a lie.
        const checks = await checkAll(ctx, store, [
            ...store.entries,
            ...borrowed.map(([, entry]) => entry),
        ]);
        for (const [entry, check] of checks) {
            store.record(entry, check);
            entry.check = check;
        }
        store.save();
    }

    if (ctx.json) {
        json({
            keys: store.entries.map((e) => ({
                ...e,
                value: e.holds === 'file' ? store.fileOf(e) : mask(e.value),
                active: store.isActive(e),
                env: envOf(e),
            })),
            ambient: borrowed.map(([cred, entry]) => ({
                provider: cred.provider,
                id: ambientId(cred),
                env: cred.env ?? null,
                holds: cred.holds,
                value: cred.holds === 'file' ? cred.value : mask(cred.value),
                check: entry.check,
            })),
        });
        return;
    }

    if (store.entries.length === 0 && borrowed.length === 0) {
        note('the keyring is empty');
        note(dim('add one: zen key add openai'));
        return;
    }
    writeAll(rows(store, borrowed));

    const missing = OWNERS.filter(
        (p) => !store.active(p) && !borrowed.some(([c]) => c.provider === p),
    );
    if (missing.length) {
        note('');
        note(dim(`no key for: ${missing.join(', ')}`));
    }
};

/**
 * The secret never comes from argv. A command line is visible in `ps`, lands in
 * shell history and is captured by CI logs — three places a key must not be.
 * Piped stdin or an echo-off prompt are the only two ways in.
 */
const add: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{
        name?: string;
        'no-check'?: boolean;
        project?: string;
        location?: string;
    }>(
        args,
        {
            name: { type: 'string' },
            'no-check': { type: 'boolean' },
            project: { type: 'string' },
            location: { type: 'string' },
        },
        'zen key add <provider>[/name] [--name <name>] [--project <id>] [--location <region>] [--no-check]',
    );

    const ref = positionals[0];
    if (!ref) {
        throw usageError('which provider?', `one of: ${OWNERS.join(', ')}`);
    }
    const parsed = parseRef(ref);
    const provider = parsed.provider;
    const name = values.name ?? parsed.name ?? 'default';
    const shape = SHAPES[provider];

    if ((values.project || values.location) && provider !== 'vertex') {
        throw usageError(
            `--project and --location mean nothing to ${shape.label}`,
            'they configure a Vertex service account',
        );
    }

    ensureHome();
    const store = await KeyStore.open();

    if (store.find(provider, name) && isInteractive()) {
        if (!(await confirm(`Replace ${provider}/${name}?`))) {
            throw usageError('cancelled');
        }
    }

    const raw = (await readStdin()) ?? (await promptFor(shape));
    if (!raw) {
        throw usageError('no value given');
    }

    // A provider with one form can say up front that a path is wrong. One with
    // two cannot: a value that is not a path is not a mistake there, it is the
    // other kind of credential, and `add` decides which by looking.
    if (shape.forms.length === 1 && shape.forms[0].holds === 'file' && !existsSync(raw)) {
        throw usageError(`no such file: ${raw}`);
    }

    const entry = store.add(provider, name, raw, {
        project: values.project,
        location: values.location,
    });

    // Verified before it is trusted, but stored either way: a key that cannot
    // be checked right now — offline, behind a proxy — is not a key that is
    // wrong, and refusing to save it would make `zen key add` fail on a plane.
    if (!values['no-check']) {
        const bar = ctx.json ? undefined : progress();
        bar?.update(dim(`checking ${keyId(entry)} …`));
        const check = await probe(store, entry);
        bar?.done();
        store.record(entry, check);
        if (check.state === 'dead') {
            note(`${red('rejected')} ${check.detail ?? 'the provider refused this key'}`);
        }
    }
    store.save();

    if (ctx.json) {
        json({
            key: keyId(entry),
            env: envOf(entry),
            active: store.isActive(entry),
            check: entry.check,
        });
        return;
    }
    note(
        `${green('added')} ${bold(keyId(entry))} ${dim(describe(store, entry))} ` +
            `${dim(`→ $${envOf(entry)}`)} ${state(entry)}`,
    );
    if (process.env[envOf(entry)]) {
        note(yellow(`$${envOf(entry)} is set and will win over this`));
    }
    if (provider === 'vertex' && entry.holds === 'file' && !entry.project) {
        note(dim('no --project given; the project_id inside the file will be used'));
    }
};

/**
 * A provider with two forms cannot ask for one of them. It asks with the echo
 * off, because one of the two answers is a secret and there is no way to know
 * which is coming until it arrives.
 */
async function promptFor(shape: (typeof SHAPES)[KeyOwner]): Promise<string> {
    const [first, ...rest] = shape.forms;
    if (rest.length) {
        note(dim(`${shape.label} — ${first.where},`));
        for (const form of rest) {
            note(dim(`  or ${form.where}`));
        }
        return askSecret('Paste the key, or a path to the file:');
    }
    note(dim(`${shape.label} — ${first.where}`));
    return first.holds === 'file'
        ? ask('Path to the credentials file:')
        : askSecret('Paste the key (it will not be shown):');
}

const use: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key use <provider>/<name>');
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    const entry = store.use(provider, name);
    store.save();
    if (ctx.json) {
        json({ key: keyId(entry), env: envOf(entry) });
        return;
    }
    note(`${green('using')} ${bold(keyId(entry))} for ${SHAPES[provider].label}`);
};

const check: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key check [provider[/name]]');
    const store = await KeyStore.open();
    assertNotEmpty(store);

    const targets = positionals[0] ? select(store, positionals[0]) : store.entries;
    const checks = await checkAll(ctx, store, targets);
    for (const [entry, result] of checks) {
        store.record(entry, result);
    }
    store.save();

    if (ctx.json) {
        json(checks.map(([entry, result]) => ({ key: keyId(entry), ...result })));
        return;
    }
    writeAll(
        table(
            checks.map(([entry, result]) => [
                keyId(entry),
                MARK[result.state],
                dim(result.detail ?? ''),
            ]),
        ),
    );
    if (checks.some(([, r]) => r.state === 'dead')) {
        throw credentialError('at least one key was refused');
    }
};

function select(store: KeyStore, ref: string): KeyEntry[] {
    const { provider, name } = parseRef(ref);
    if (!name) {
        return store.for(provider);
    }
    const entry = store.find(provider, name);
    if (!entry) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }
    return [entry];
}

const rm: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ yes?: boolean }>(
        args,
        { yes: { type: 'boolean' } },
        'zen key rm <provider>/<name> [--yes]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    if (!store.find(provider, name)) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }
    if (!values.yes && isInteractive() && !(await confirm(`Forget ${ref}?`))) {
        throw usageError('cancelled');
    }
    store.remove(provider, name);
    store.save();
    // The stored file is left behind on purpose: it was copied from somewhere,
    // and deleting a service-account key nobody asked us to delete is not the
    // CLI's call to make.
    if (ctx.json) {
        json({ removed: ref });
        return;
    }
    note(`${green('forgot')} ${ref}`);
};

/** The one deliberate way a secret leaves the store, and it has to be asked for. */
const show: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ reveal?: boolean }>(
        args,
        { reveal: { type: 'boolean' } },
        'zen key show <provider>[/name] [--reveal]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const store = await KeyStore.open();
    const entry = select(store, ref)[0];
    if (!entry) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }

    const value = values.reveal ? store.reveal(entry) : describe(store, entry);
    if (ctx.json) {
        json({
            key: keyId(entry),
            env: envOf(entry),
            value,
            revealed: Boolean(values.reveal),
        });
        return;
    }
    if (values.reveal) {
        // stdout, alone, unstyled — so `zen key show openai --reveal | pbcopy`
        // copies the key and nothing else.
        write(value);
        return;
    }
    writeAll(
        table([
            [dim('key'), keyId(entry)],
            [dim('env'), envOf(entry)],
            [dim('value'), value],
            ...(entry.project ? [[dim('project'), entry.project]] : []),
            ...(entry.location ? [[dim('location'), entry.location]] : []),
            [dim('state'), state(entry)],
            [dim('added'), ago(entry.addedAt)],
        ]),
    );
    note(dim('--reveal prints the secret itself'));
};

/**
 * `eval "$(zen key env)"` puts the active keys into a shell — for the tools that
 * are not `zen`. Real environment variables still win inside `zen` itself, so
 * this changes nothing about how a run resolves credentials.
 */
const env: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key env [provider …]');
    const store = await KeyStore.open();
    const only = positionals.length
        ? positionals.map((p) => parseRef(p).provider as KeyOwner)
        : undefined;
    // Ignore what is already exported: the point is to produce the exports.
    const vars: Record<string, string> = {};
    for (const provider of only ?? OWNERS) {
        const entry = store.active(provider);
        if (!entry) {
            continue;
        }
        vars[envOf(entry)] = store.reveal(entry);
        // A service account says which project it belongs to but not which
        // region to call, and a shell that has the file and not the region is
        // still a shell that cannot reach a model.
        if (entry.project) {
            vars.GOOGLE_CLOUD_PROJECT = entry.project;
        }
        if (entry.location) {
            vars.GOOGLE_CLOUD_LOCATION = entry.location;
        }
    }
    if (ctx.json) {
        json(vars);
        return;
    }
    for (const [name, value] of Object.entries(vars)) {
        write(`export ${name}=${shellQuote(value)}`);
    }
    if (Object.keys(vars).length === 0) {
        note(dim('nothing to export'));
    }
};

/** Single quotes, with the one escape single quotes cannot express. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUBS: Record<string, Sub> = { ls, list: ls, add, use, check, rm, remove: rm, show, env };

export const key: Command = {
    summary: 'The credential store: add, choose, verify and export API keys.',
    usage: USAGE,
    details: [
        'Keys live in ~/.zenera/neo/keys.json (0600) and are materialised into',
        'the environment before a run. A real environment variable always wins,',
        'and is listed as ~ so it is clear where a working provider comes from.',
        '',
        'Model providers: openai, anthropic, google, vertex, openrouter.',
        'Services the tools call: exa.',
        '',
        'Vertex takes either shape: a service-account JSON file, which wants',
        '--project and --location too, or an express-mode API key, which wants',
        'neither. Which one you gave is read off the value.',
        '',
        '  zen key ls [--check]              Everything stored, and its state.',
        '  zen key add <provider>[/name]     Read a key from stdin, or ask for it.',
        '  zen key use <provider>/<name>     Choose which one a run uses.',
        '  zen key check [provider[/name]]   Ask the provider whether it still works.',
        '  zen key rm <provider>/<name>      Forget one.',
        '  zen key show <ref> [--reveal]     Masked by default.',
        '  zen key env [provider …]          Shell exports, for other tools.',
    ],
    run: async (ctx) => {
        const [name, ...rest] = ctx.args;
        if (!name) {
            await ls(ctx, []);
            return;
        }
        const sub = SUBS[name];
        if (!sub) {
            throw usageError(
                `unknown: zen key ${name}`,
                `try: ${cyan(Object.keys(SUBS).slice(0, 7).join(', '))}`,
            );
        }
        await sub(ctx, rest);
    },
};
