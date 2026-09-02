import {
    DEFAULT_SANDBOX_IMAGE,
    SANDBOX_GROUP,
    SandboxPool,
    type AgentProject,
    type ProjectConfig,
    type SandboxConfig,
    type SandboxMount,
    type SandboxSpec,
} from '@zenera/neo';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveBuild, type ResolvedBuild } from './image.ts';
import { credentials } from './keys.ts';
import { ensurePodmanReady } from './podman.ts';
import type { SessionPaths } from './session.ts';
import { warn } from './term.ts';

// ---------------------------------------------------------------------------
// The sandbox, as this CLI wires it
//
// The library takes resolved values; the config states names and numbers. This
// is the layer between the two, and it owns the two decisions the library has
// no business making: which host variables are worth forwarding, and where the
// container's home directory lives.
//
// It lives in the session directory, which is the whole point. A session is
// already a self-contained thing — copy the directory and its conversation,
// memory and blobs travel with it — and a `pip install --user` that vanished
// on close would be the only part of a session that did not. So `$HOME` is a
// bind mount into `.data/sandbox/home`, and what the agent installs for itself
// is still there when the session is opened again. Everything *outside* the
// mounts is throwaway, which is what keeps a stale container from becoming a
// second, invisible configuration.
// ---------------------------------------------------------------------------

/** Where the persistent home lives, inside the container. */
const HOME = '/home/agent';

/** Where a credential *file* is mounted, inside the container. */
const KEY_MOUNT = '/run/zenera/keys';

/**
 * The credentials the run is using, in the form a container takes.
 *
 * Two shapes, two mechanisms. A secret is forwarded by *name* — podman reads
 * the value from its own environment, so nothing is written into an argv that
 * `ps` will show. A service-account file has to be present as a file, so the
 * one file is bind-mounted read-only and the variable is rewritten to where it
 * landed; mounting the directory it came from would drag in whatever else the
 * user keeps beside it.
 *
 * This is the part of the design that gives something away, and it should be
 * said plainly: the sandbox runs code the model wrote, and a key it can read
 * is a key it can send. `keys: false`, or `network: none`, is the answer for a
 * project where that is not an acceptable trade.
 */
function forwarded(): { secrets: string[]; env: Record<string, string>; mounts: SandboxMount[] } {
    const secrets: string[] = [];
    const env: Record<string, string> = {};
    const mounts: SandboxMount[] = [];
    for (const cred of credentials()) {
        if (cred.holds === 'file') {
            const at = `${KEY_MOUNT}/${basename(cred.value)}`;
            mounts.push({ host: cred.value, at, readOnly: true });
            env[cred.env] = at;
            continue;
        }
        secrets.push(cred.env);
    }
    // Not secrets, and useless without one: a service account says which
    // project it belongs to but never which region to call.
    for (const name of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']) {
        const value = process.env[name];
        if (value) {
            env[name] = value;
        }
    }
    return { secrets, env, mounts };
}

export interface SandboxSetup {
    pool: SandboxPool;
    /** the resolved base spec, for `zn sandbox status` and the image pre-warm */
    spec: SandboxSpec;
    image: string;
    /** the Dockerfile behind `image`, when it came from one */
    build?: ResolvedBuild;
    /** host side of the container's `$HOME`, created only if it is ever needed */
    home: string;
}

export interface SandboxInputs {
    config: ProjectConfig;
    session: SessionPaths;
    workspace: string;
    /** the project directory, which `build:` paths are relative to */
    root: string;
    readOnly?: boolean;
    /**
     * Trees to mount besides the workspace and the home — the project's assets
     * and its skill catalog. The same array goes to the file tools, so a path
     * a command prints is a path `read_file` accepts.
     */
    mounts?: readonly SandboxMount[];
    /** `--image` */
    image?: string;
    /** `--no-keys`: refuse to forward credentials, whatever the config says */
    keys?: boolean;
}

export function buildSandbox(opts: SandboxInputs): SandboxSetup {
    // An explicit --image is an answer, so there is nothing left to build.
    const build = opts.image ? undefined : resolveBuild(opts.root, opts.config.sandbox);
    const base = {
        ...(opts.config.sandbox ?? {}),
        ...((opts.image ?? build?.tag) ? { image: opts.image ?? build?.tag } : {}),
        ...(opts.keys === false ? { keys: false } : {}),
    };
    const home = join(opts.session.data, 'sandbox', 'home');

    const mounts: SandboxMount[] = [{ host: home, at: HOME }, ...(opts.mounts ?? [])];
    const keys = base.keys === false ? undefined : forwarded();
    if (keys) {
        mounts.push(...keys.mounts);
    }
    // Skills and assets are mounted read-only, and a python script run from a
    // read-only directory fails on writing its own `__pycache__` — a confusing
    // error about a file nobody asked for.
    const extra = { HOME, PYTHONDONTWRITEBYTECODE: '1', ...(keys?.env ?? {}) };
    const spec = toSpec(base, extra, keys?.secrets);

    const agents: Record<string, SandboxSpec> = {};
    for (const agent of opts.config.agents) {
        if (agent.sandbox) {
            const merged = merge(base, agent.sandbox);
            // An agent that opts out gets neither the variables nor the mount,
            // but the mount is on the pool and cannot be taken back per agent —
            // so the variable is what actually decides, and without it the file
            // sitting there is not a credential anything will look for.
            const own = merged.keys === false ? undefined : keys;
            agents[agent.name] = toSpec(
                merged,
                { HOME, PYTHONDONTWRITEBYTECODE: '1', ...(own?.env ?? {}) },
                own?.secrets,
            );
        }
    }

    const pool = new SandboxPool({
        ...spec,
        agents,
        root: opts.workspace,
        key: opts.session.id,
        readOnly: opts.readOnly,
        mounts,
    });

    return { pool, spec, image: spec.image ?? DEFAULT_SANDBOX_IMAGE, build, home };
}

/**
 * An agent's overrides on the project's block. `image` and `build` answer the
 * same question, so naming either one drops the other: a plain spread would
 * leave an agent's `image` sitting next to the project's `build`, and the
 * schema forbids exactly that combination when it is written down.
 */
function merge(base: SandboxConfig, agent: SandboxConfig): SandboxConfig {
    const merged = { ...base, ...agent };
    if (agent.image !== undefined) {
        delete merged.build;
    }
    if (agent.build !== undefined) {
        delete merged.image;
    }
    return merged;
}

/**
 * Config names a variable; this reads it. A name that is not set on this host
 * is simply not forwarded — an empty string in the container is a different
 * thing from an absent one, and tools test for absence.
 */
function toSpec(
    config: SandboxConfig,
    extra: Record<string, string>,
    secrets?: readonly string[],
): SandboxSpec {
    const env: Record<string, string> = { ...extra };
    for (const name of config.env ?? []) {
        const value = process.env[name];
        if (value !== undefined && value !== '') {
            env[name] = value;
        }
    }
    return {
        image: config.image,
        cpus: config.cpus,
        memory: config.memory,
        network: config.network,
        workdir: config.workdir,
        timeout: config.timeout,
        user: config.user,
        persist: config.persist,
        env,
        secrets,
    };
}

/**
 * Whether anything in this project can reach a shell.
 *
 * Read off the *resolved* tool lists rather than off the config's selectors,
 * because `sandbox:*`, `*` and a bare name all mean the same thing by the time
 * the loader is done, and only one of those three is greppable.
 */
export function usesSandbox(project: AgentProject): boolean {
    return project.agents.some((a) => a.tools.some((t) => t.group === SANDBOX_GROUP));
}

/**
 * Asked before the first turn rather than at the first tool call, so a missing
 * container engine costs nothing instead of costing a round trip and half a
 * plan. A project that never shells out never gets here at all.
 */
export async function preflight(setup: SandboxSetup, yes?: boolean): Promise<void> {
    mkdirSync(setup.home, { recursive: true });
    await ensurePodmanReady({
        image: setup.image,
        build: setup.build,
        cpus: setup.spec.cpus,
        memory: setup.spec.memory,
        yes,
    });
}

/** Best-effort teardown: losing a container must never lose a run. */
export async function teardown(pool: SandboxPool): Promise<void> {
    try {
        await pool.dispose();
    } catch (err) {
        warn(`could not clean up the sandbox: ${err instanceof Error ? err.message : String(err)}`);
    }
}
