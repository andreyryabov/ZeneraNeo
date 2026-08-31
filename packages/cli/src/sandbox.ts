import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_SANDBOX_IMAGE,
    SANDBOX_GROUP,
    SandboxPool,
    type AgentProject,
    type ProjectConfig,
    type SandboxConfig,
    type SandboxMount,
    type SandboxSpec,
} from '@zenera/core';
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

export interface SandboxSetup {
    pool: SandboxPool;
    /** the resolved base spec, for `zn sandbox status` and the image pre-warm */
    spec: SandboxSpec;
    image: string;
    /** host side of the container's `$HOME`, created only if it is ever needed */
    home: string;
}

export interface SandboxInputs {
    config: ProjectConfig;
    session: SessionPaths;
    workspace: string;
    readOnly?: boolean;
    /** `--image` */
    image?: string;
}

export function buildSandbox(opts: SandboxInputs): SandboxSetup {
    const base = { ...(opts.config.sandbox ?? {}), ...(opts.image ? { image: opts.image } : {}) };
    const home = join(opts.session.data, 'sandbox', 'home');

    const mounts: SandboxMount[] = [{ host: home, at: HOME }];
    const spec = toSpec(base, { HOME });

    const agents: Record<string, SandboxSpec> = {};
    for (const agent of opts.config.agents) {
        if (agent.sandbox) {
            agents[agent.name] = toSpec({ ...base, ...agent.sandbox }, { HOME });
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

    return { pool, spec, image: spec.image ?? DEFAULT_SANDBOX_IMAGE, home };
}

/**
 * Config names a variable; this reads it. A name that is not set on this host
 * is simply not forwarded — an empty string in the container is a different
 * thing from an absent one, and tools test for absence.
 */
function toSpec(config: SandboxConfig, extra: Record<string, string>): SandboxSpec {
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
