import { existsSync } from 'node:fs';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { ensureHome } from '../home.ts';
import {
    assertNotEmpty,
    describe,
    keyId,
    KeyStore,
    mask,
    parseRef,
    PROVIDERS,
    SHAPES,
    type KeyEntry,
    type Liveness,
    type Provider,
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
    readStdin,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zn key <ls|add|use|check|rm|show|env> [ref] [options]';

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

function rows(store: KeyStore): string[] {
    const out: string[][] = [
        [bold(''), bold('KEY'), bold('VALUE'), bold('STATE'), bold('CHECKED')],
    ];
    for (const provider of PROVIDERS) {
        for (const entry of store.for(provider)) {
            const shadowed = Boolean(process.env[SHAPES[provider].env]);
            out.push([
                store.isActive(entry) ? green('*') : ' ',
                keyId(entry),
                dim(describe(store, entry)),
                state(entry),
                dim(entry.check ? ago(entry.check.at) : '—') +
                    (shadowed && store.isActive(entry)
                        ? yellow(`  shadowed by $${SHAPES[provider].env}`)
                        : ''),
            ]);
        }
    }
    return table(out);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

type Sub = (ctx: Context, args: readonly string[]) => Promise<void>;

const ls: Sub = async (ctx, args) => {
    const { values } = parse<{ check?: boolean }>(args, { check: { type: 'boolean' } }, USAGE);
    const store = await KeyStore.open();

    if (values.check) {
        const checks = await probeAll(store, store.entries);
        for (const [entry, check] of checks) {
            store.record(entry, check);
        }
        store.save();
    }

    if (ctx.json) {
        json(
            store.entries.map((e) => ({
                ...e,
                value: e.holds === 'file' ? store.fileOf(e) : mask(e.value),
                active: store.isActive(e),
                env: SHAPES[e.provider].env,
            })),
        );
        return;
    }

    if (store.entries.length === 0) {
        note('the keyring is empty');
        note(dim('add one: zn key add openai'));
        return;
    }
    writeAll(rows(store));

    const missing = PROVIDERS.filter((p) => !store.active(p) && !process.env[SHAPES[p].env]);
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
    const { values, positionals } = parse<{ name?: string; 'no-check'?: boolean }>(
        args,
        { name: { type: 'string' }, 'no-check': { type: 'boolean' } },
        'zn key add <provider>[/name] [--name <name>] [--no-check]',
    );

    const ref = positionals[0];
    if (!ref) {
        throw usageError('which provider?', `one of: ${PROVIDERS.join(', ')}`);
    }
    const parsed = parseRef(ref);
    const provider = parsed.provider;
    const name = values.name ?? parsed.name ?? 'default';
    const shape = SHAPES[provider];

    ensureHome();
    const store = await KeyStore.open();

    if (store.find(provider, name) && isInteractive()) {
        if (!(await confirm(`Replace ${provider}/${name}?`))) {
            throw usageError('cancelled');
        }
    }

    const raw = (await readStdin()) ?? (await promptFor(shape.holds, shape.label, shape.where));
    if (!raw) {
        throw usageError('no value given');
    }
    if (shape.holds === 'file' && !existsSync(raw)) {
        throw usageError(`no such file: ${raw}`);
    }

    const entry = store.add(provider, name, raw);

    // Verified before it is trusted, but stored either way: a key that cannot
    // be checked right now — offline, behind a proxy — is not a key that is
    // wrong, and refusing to save it would make `zn key add` fail on a plane.
    if (!values['no-check']) {
        const check = await probe(store, entry);
        store.record(entry, check);
        if (check.state === 'dead') {
            note(`${red('rejected')} ${check.detail ?? 'the provider refused this key'}`);
        }
    }
    store.save();

    if (ctx.json) {
        json({
            key: keyId(entry),
            env: shape.env,
            active: store.isActive(entry),
            check: entry.check,
        });
        return;
    }
    note(`${green('added')} ${bold(keyId(entry))} ${dim(describe(store, entry))} ${state(entry)}`);
    if (process.env[shape.env]) {
        note(yellow(`$${shape.env} is set and will win over this`));
    }
};

async function promptFor(holds: 'secret' | 'file', label: string, where: string): Promise<string> {
    note(dim(`${label} — ${where}`));
    return holds === 'file'
        ? ask('Path to the credentials file:')
        : askSecret('Paste the key (it will not be shown):');
}

const use: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zn key use <provider>/<name>');
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zn key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    const entry = store.use(provider, name);
    store.save();
    if (ctx.json) {
        json({ key: keyId(entry), env: SHAPES[provider].env });
        return;
    }
    note(`${green('using')} ${bold(keyId(entry))} for ${SHAPES[provider].label}`);
};

const check: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zn key check [provider[/name]]');
    const store = await KeyStore.open();
    assertNotEmpty(store);

    const targets = positionals[0] ? select(store, positionals[0]) : store.entries;
    const checks = await probeAll(store, targets);
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
        throw usageError(`no key ${ref}`, 'see: zn key ls');
    }
    return [entry];
}

const rm: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ yes?: boolean }>(
        args,
        { yes: { type: 'boolean' } },
        'zn key rm <provider>/<name> [--yes]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zn key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    if (!store.find(provider, name)) {
        throw usageError(`no key ${ref}`, 'see: zn key ls');
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
        'zn key show <provider>[/name] [--reveal]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zn key ls');
    }
    const store = await KeyStore.open();
    const entry = select(store, ref)[0];
    if (!entry) {
        throw usageError(`no key ${ref}`, 'see: zn key ls');
    }

    const value = values.reveal ? store.reveal(entry) : describe(store, entry);
    if (ctx.json) {
        json({
            key: keyId(entry),
            env: SHAPES[entry.provider].env,
            value,
            revealed: Boolean(values.reveal),
        });
        return;
    }
    if (values.reveal) {
        // stdout, alone, unstyled — so `zn key show openai --reveal | pbcopy`
        // copies the key and nothing else.
        write(value);
        return;
    }
    writeAll(
        table([
            [dim('key'), keyId(entry)],
            [dim('env'), SHAPES[entry.provider].env],
            [dim('value'), value],
            [dim('state'), state(entry)],
            [dim('added'), ago(entry.addedAt)],
        ]),
    );
    note(dim('--reveal prints the secret itself'));
};

/**
 * `eval "$(zn key env)"` puts the active keys into a shell — for the tools that
 * are not `zn`. Real environment variables still win inside `zn` itself, so
 * this changes nothing about how a run resolves credentials.
 */
const env: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zn key env [provider …]');
    const store = await KeyStore.open();
    const only = positionals.length
        ? positionals.map((p) => parseRef(p).provider as Provider)
        : undefined;
    // Ignore what is already exported: the point is to produce the exports.
    const vars: Record<string, string> = {};
    for (const provider of only ?? PROVIDERS) {
        const entry = store.active(provider);
        if (entry) {
            vars[SHAPES[provider].env] = store.reveal(entry);
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
        'the environment before a run. A real environment variable always wins.',
        '',
        '  zn key ls [--check]              Everything stored, and its state.',
        '  zn key add <provider>[/name]     Read a key from stdin, or ask for it.',
        '  zn key use <provider>/<name>     Choose which one a run uses.',
        '  zn key check [provider[/name]]   Ask the provider whether it still works.',
        '  zn key rm <provider>/<name>      Forget one.',
        '  zn key show <ref> [--reveal]     Masked by default.',
        '  zn key env [provider …]          Shell exports, for other tools.',
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
                `unknown: zn key ${name}`,
                `try: ${cyan(Object.keys(SUBS).slice(0, 7).join(', '))}`,
            );
        }
        await sub(ctx, rest);
    },
};
