import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    credentialError,
    ensureHome,
    ensurePodmanReady,
    invalidError,
    KeyStore,
    paths,
    PROVIDERS,
    SHAPES,
    type Provider,
} from 'zenera-cli/lib';
import { createModel, type Model } from 'zenera-neo';
import { Box } from './box.ts';
import { Cache, type CacheOptions } from './cache.ts';
import { ensureImage } from './image.ts';
import { Router } from './router.ts';
import { loadSpecs, SpecError } from './spec.ts';
import { Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// Assembly
//
// The order here is the whole point and it is the same order `zen run` uses:
// credentials before anything that needs one, the container engine before the
// image, the image before the box, and the documents last — so the failure a
// user sees is the first thing that was actually wrong rather than whatever
// happened to be checked first.
// ---------------------------------------------------------------------------

/**
 * The model each provider gets when none is named. Every ref names its
 * provider: the shorthand reads the first segment as a *provider name*, so a
 * bare `gemini-3.5-flash` would be asked of OpenAI.
 */
const DEFAULT_MODEL: Record<Provider, string> = {
    openai: 'openai:gpt-5.4-mini',
    anthropic: 'anthropic:claude-sonnet-4-5',
    google: 'google:gemini-3.5-flash',
    vertex: 'vertex:gemini-3.5-flash',
    openrouter: 'openrouter:inclusionai/ling-3.0-flash-fin:free',
};

export interface SetupOptions {
    specs: readonly string[];
    cwd: string;
    /** where generators and the container's workspace live */
    cache?: string;
    model?: string;
    image?: string;
    attempts?: number;
    /** how many generators may be written at once */
    concurrency?: number;
    rebuild?: boolean;
    ephemeral?: boolean;
    timeout?: number;
    onImageBuild?: (tag: string) => void;
    events?: Pick<CacheOptions, 'onStart' | 'onAttempt' | 'onReady' | 'onFail'>;
}

export interface Setup {
    router: Router;
    checks: Checks;
    cache: Cache;
    box: Box;
    model: Model;
    image: string;
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
    const model = createModel(opts.model ?? defaultRef(keys));

    const root = resolve(opts.cwd, opts.cache ?? paths.faker());
    mkdirSync(root, { recursive: true, mode: 0o700 });

    // Podman is asked about before the image is built, so a machine without a
    // container engine says so instead of failing halfway through a build.
    await ensurePodmanReady({ image: opts.image, yes: true });
    const image = opts.image ?? (await ensureImage({ root, onBuild: opts.onImageBuild }));

    const operations = await loadSpecs(opts.specs.map((s) => resolve(opts.cwd, s)));
    if (operations.length === 0) {
        throw invalidError('the specification declares no operations');
    }
    const router = new Router(operations);
    const checks = new Checks();
    const box = new Box({ root, image, timeout: opts.timeout });
    await box.fresh();
    const cache = new Cache({
        box,
        checks,
        model,
        attempts: opts.attempts,
        concurrency: opts.concurrency,
        rebuild: opts.rebuild,
        ephemeral: opts.ephemeral,
        ...opts.events,
    });

    return { router, checks, cache, box, model, image, root, close: () => box.dispose() };
}

/**
 * Presence, not liveness. `zen init` probes because it is writing a project
 * that has to work later; this is about to make a call anyway, and the call
 * itself is a better test than a round trip that costs the same.
 */
function defaultRef(keys: KeyStore): string {
    const provider =
        PROVIDERS.find((p) => process.env[SHAPES[p].env]) ??
        PROVIDERS.find((p) => keys.active(p) !== undefined);
    if (!provider) {
        throw credentialError(
            'no credentials for any provider',
            'add one with: zen key add openai',
        );
    }
    return DEFAULT_MODEL[provider];
}

export { SpecError };
