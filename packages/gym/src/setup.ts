import {
    credentialError,
    ensureHome,
    envNames,
    home,
    invalidError,
    KeyStore,
    paths,
    PROVIDERS,
    readJson,
    writeJson,
    type Provider,
} from '@zenera/cli/lib';
import { createModel, type Model } from '@zenera/neo';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Box } from './box.ts';
import { Cache, type CacheOptions } from './cache.ts';
import { Catalog } from './catalog.ts';
import { Router } from './router.ts';
import { loadSpecs, SpecError } from './spec.ts';
import { statePath, WorldStore } from './store.ts';
import { NO_STORY, openStory, type Story } from './story.ts';
import { World, type WorldEvent } from './synth.ts';
import { Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// Assembly
//
// The order here is the whole point and it is the same order `zen run` uses:
// credentials before anything that needs one, then the documents, then the
// story, and the world last because its file is named after the story — so the
// failure a user sees is the first thing that was actually wrong rather than
// whatever happened to be checked first.
// ---------------------------------------------------------------------------

/**
 * The model each provider gets when none is named — the same picks `zen meta`
 * recommends (`RECOMMENDED` in `packages/cli/src/meta/model.ts`). Every ref names its
 * provider: the shorthand reads the first segment as a *provider name*, so a
 * bare `gemini-3.8-flash` would be asked of OpenAI.
 *
 * Gym's agents call tools, and OpenAI's reasoning models take tools only over
 * the Responses API, so that is the one named.
 */
const DEFAULT_MODEL: Record<Provider, string> = {
    openai: 'openai/responses:gpt-5.6-sol',
    anthropic: 'anthropic:claude-opus-5',
    google: 'google:gemini-3.8-flash',
    vertex: 'vertex:gemini-3.8-flash',
    openrouter: 'openrouter:anthropic/claude-opus-5',
};

// ---------------------------------------------------------------------------
// Which model, and why that one
//
// The same chain `zen meta` uses: a flag beats the environment, the environment
// beats what was stored, and with none of them set it is whatever the keys on
// hand can buy. Which model writes generators is a choice about a tool on this
// machine and not about a document, so it is stored beside the keyring rather
// than anywhere near a specification.
// ---------------------------------------------------------------------------

/** The variable a shell or a CI job names it with — a zen ref. */
export const MODEL_ENV = 'ZENERA_GYM_MODEL';

export type ModelSource = 'flag' | 'env' | 'store' | 'default';

export const SOURCE_LABELS: Record<ModelSource, string> = {
    flag: '--model',
    env: MODEL_ENV,
    store: 'zen gym model',
    default: 'recommended',
};

export interface ModelChoice {
    ref: string;
    from: ModelSource;
}

export interface GymFile {
    version: 1;
    model?: string;
}

const EMPTY: GymFile = { version: 1 };

const settingsPath = (): string => join(home(), 'gym.json');

export const readSettings = (): Promise<GymFile> => readJson<GymFile>(settingsPath(), EMPTY);

export function writeSettings(file: GymFile): void {
    ensureHome();
    writeJson(settingsPath(), file);
}

/** What `open` would run, and where it came from, so a command can say so too. */
export async function chooseModel(
    flag: string | undefined,
    keys: KeyStore,
): Promise<ModelChoice | undefined> {
    const chain: readonly [ModelSource, string | undefined][] = [
        ['flag', flag],
        ['env', process.env[MODEL_ENV]],
        ['store', (await readSettings()).model],
        ['default', defaultRef(keys)],
    ];
    for (const [from, ref] of chain) {
        const named = ref?.trim();
        if (named) {
            return { ref: named, from };
        }
    }
    return undefined;
}

export interface SetupOptions {
    specs: readonly string[];
    cwd: string;
    /** where handlers, worlds and reports live */
    cache?: string;
    model?: string;
    /** the story of the world: documents, or a `zen rag docs` index */
    story?: string;
    /** the world's SQLite file; derived from the story when unset */
    state?: string;
    /** start from an empty world */
    reset?: boolean;
    attempts?: number;
    /** how many generators may be written at once */
    concurrency?: number;
    rebuild?: boolean;
    ephemeral?: boolean;
    timeout?: number;
    events?: Pick<CacheOptions, 'onStart' | 'onAttempt' | 'onReady' | 'onFail'>;
    onWorld?: (event: WorldEvent) => void;
}

export interface Setup {
    router: Router;
    checks: Checks;
    cache: Cache;
    box: Box;
    model: Model;
    choice: ModelChoice;
    catalog: Catalog;
    story: Story;
    world: World;
    /** the world's SQLite file */
    state: string;
    root: string;
    close(): Promise<void>;
}

export async function open(opts: SetupOptions): Promise<Setup> {
    if (opts.specs.length === 0) {
        throw invalidError('no specification given', 'name one or more openapi/swagger files');
    }

    // Real environment variables win, exactly as they do for `zen`.
    ensureHome();
    const keys = await KeyStore.open();
    keys.materialize();
    const choice = await chooseModel(opts.model, keys);
    if (!choice) {
        throw credentialError(
            'no credentials for any provider',
            'add one with: zen key add openai',
        );
    }
    const model = createModel(choice.ref);

    const root = resolve(opts.cwd, opts.cache ?? paths.gym());
    mkdirSync(root, { recursive: true, mode: 0o700 });

    const files = opts.specs.map((s) => resolve(opts.cwd, s));
    const operations = await loadSpecs(files);
    if (operations.length === 0) {
        throw invalidError('the specification declares no operations');
    }
    const router = new Router(operations);
    const checks = new Checks();
    const catalog = await Catalog.open(files);

    const story = opts.story ? await openStory(opts.story, opts.cwd) : NO_STORY;
    const state = statePath({
        root,
        state: opts.state ? resolve(opts.cwd, opts.state) : undefined,
        storyDigest: story.digest || undefined,
    });
    const store = new WorldStore(state);
    if (opts.reset) {
        store.reset();
    }
    const world = new World({
        model,
        story,
        catalog,
        store,
        reportDir: join(root, 'reports'),
        onMade: opts.onWorld,
    });
    const box = new Box({
        root,
        db: store.path,
        timeout: opts.timeout,
        synthesize: world.synthesize,
    });
    const cache = new Cache({
        box,
        checks,
        model,
        catalog,
        world,
        operations,
        attempts: opts.attempts,
        concurrency: opts.concurrency,
        rebuild: opts.rebuild,
        ephemeral: opts.ephemeral,
        ...opts.events,
    });

    return {
        router,
        checks,
        cache,
        box,
        model,
        choice,
        catalog,
        story,
        world,
        state,
        root,
        close: async () => {
            await box.dispose();
            world.close();
            store.close();
            story.close();
        },
    };
}

/**
 * Presence, not liveness. `zen init` probes because it is writing a project
 * that has to work later; this is about to make a call anyway, and the call
 * itself is a better test than a round trip that costs the same.
 */
function defaultRef(keys: KeyStore): string | undefined {
    const provider =
        PROVIDERS.find((p) => envNames(p).some((name) => process.env[name])) ??
        PROVIDERS.find((p) => keys.active(p) !== undefined);
    return provider ? DEFAULT_MODEL[provider] : undefined;
}

export { SpecError };
