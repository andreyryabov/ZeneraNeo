import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_IMAGE, runProcess, type Runner } from 'zenera-neo';

// ---------------------------------------------------------------------------
// The image
//
// The generators are Python, and Python that has to invent a plausible name out
// of `random.choice` writes output that looks like test data because it is. So
// the container gets real libraries.
//
// They cannot be installed into the *running* box. `containerName()` in
// zenera-neo hashes the image and the network, so "start online, install, then
// switch to `network: none`" resolves to two different containers and the
// install goes with the first one. Baking them into an image instead is one
// build, cached by podman's own layers, and leaves the serving container
// offline — which is the property that matters, because the code it runs was
// written by a model.
// ---------------------------------------------------------------------------

/**
 * Lower bounds rather than exact pins: the tag is a function of this list, so
 * an edit here yields a new image and a new container either way, and pinning a
 * patch release would only mean a rebuild every time one is published.
 */
export const REQUIREMENTS = [
    'Faker>=37',
    'exrex>=0.11',
    'jsonschema>=4.23',
    'python-dateutil>=2.9',
] as const;

/** What the generator may import. Quoted verbatim in the prompt. */
export const AVAILABLE = ['faker', 'exrex', 'jsonschema', 'dateutil'] as const;

export const BASE_IMAGE = DEFAULT_SANDBOX_IMAGE;

export function imageTag(base = BASE_IMAGE): string {
    const digest = createHash('sha256')
        .update(JSON.stringify([base, [...REQUIREMENTS].sort()]))
        .digest('hex')
        .slice(0, 12);
    return `localhost/zenera-faker:${digest}`;
}

function containerfile(base: string): string {
    return [
        `FROM ${base}`,
        `RUN pip install --no-cache-dir --disable-pip-version-check ${REQUIREMENTS.join(' ')}`,
        '',
    ].join('\n');
}

export interface ImageOptions {
    /** where the empty build context is created */
    root: string;
    base?: string;
    engine?: string;
    exec?: Runner;
    onBuild?: (tag: string) => void;
}

/**
 * The tag to run, built if it is not there yet. Returns without touching podman
 * when the image already exists, which is every start after the first.
 */
export async function ensureImage(opts: ImageOptions): Promise<string> {
    const base = opts.base ?? BASE_IMAGE;
    const tag = imageTag(base);
    const engine = opts.engine ?? 'podman';
    const run = opts.exec ?? runProcess;

    const exists = await run(engine, ['image', 'exists', tag], { timeoutMs: 60_000 });
    if (exists.code === 0) {
        return tag;
    }

    opts.onBuild?.(tag);
    // An empty directory, because the Containerfile arrives on stdin and there
    // is nothing to COPY: handing podman the working directory instead would
    // tar up whatever happened to be in it.
    const context = join(opts.root, 'build');
    mkdirSync(context, { recursive: true });

    const built = await run(engine, ['build', '--tag', tag, '--file', '-', context], {
        input: containerfile(base),
        timeoutMs: 900_000,
        maxBytes: 256 * 1024,
    });
    if (built.code !== 0) {
        throw new Error(
            `could not build ${tag}: ${(built.stderr.trim() || built.stdout.trim()).split('\n').slice(-3).join(' ')}`,
        );
    }
    return tag;
}
