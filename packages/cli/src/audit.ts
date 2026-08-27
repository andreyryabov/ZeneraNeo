import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    projectRegistry,
    readProjectConfig,
    type ModelRef,
    type ModelRequirement,
    type ProjectConfig,
} from 'zenera-neo';
import { SHAPES, isProvider, type KeyStore, type Provider } from './keys.ts';
import { bold, dim } from './term.ts';

// ---------------------------------------------------------------------------
// The credential audit
//
// A project names models; the keyring holds credentials; nothing checks that
// the two meet until a client is built — and by then the only thing that can be
// said is that *one* model failed, in the words of whichever SDK was asked.
//
// This walks the other way: read the config, resolve every model it declares,
// and say which of them nothing can reach. Run before the project is loaded, so
// the answer arrives whether the load then succeeds or not.
// ---------------------------------------------------------------------------

export interface ModelIssue {
    /** the model as the config names it: an alias, or the ref itself */
    name: string;
    /** the provider it resolves to */
    provider: string;
    /** the variable that would carry the credential */
    env: string;
    /** `missing` — nothing to authenticate with. `dead` — rejected when checked. */
    reason: 'missing' | 'dead';
    /** the provider's own words, when it was the one to say no */
    detail?: string;
    /** the keyring provider the fix names, when the kind is one of them */
    add?: Provider;
}

/**
 * Every model the project names, keyed by how one would refer to it.
 *
 * The `models:` table comes first so a declared alias keeps its own name in the
 * report; a `model:` that names one collapses onto it rather than appearing
 * twice, and a `model:` that names no alias is a shorthand standing for itself.
 */
function declared(config: ProjectConfig): Map<string, ModelRef> {
    // The schema widens `reasoningEffort` to `string` on purpose, which is the
    // one thing keeping a config's model spec from being a `ModelSpec`. The
    // loader hands the same cast to `models.model()` for the same reason.
    const found = new Map<string, ModelRef>(
        Object.entries(config.models ?? {}) as [string, ModelRef][],
    );
    const add = (ref: string | undefined): void => {
        if (ref && !found.has(ref)) {
            found.set(ref, ref);
        }
    };
    add(config.model);
    for (const agent of config.agents) {
        add(agent.model);
    }
    return found;
}

/**
 * `gcloud auth application-default login` writes here, and the GenAI SDK finds
 * it with no variable set — so without this check every developer using ADC
 * would be told their working Vertex setup is broken.
 */
function hasGcloudAdc(): boolean {
    const dir = process.env.CLOUDSDK_CONFIG ?? join(homedir(), '.config', 'gcloud');
    return existsSync(join(dir, 'application_default_credentials.json'));
}

/**
 * Whether a requirement is actually met, and under which variable.
 *
 * `satisfied` is the library's answer and it is about api keys, which is the
 * wrong question for Vertex: that kind is `keyOptional` because it
 * authenticates from a service-account file instead. So the file-shaped
 * credential is looked for where the keyring keeps it.
 */
function credential(need: ModelRequirement): { env: string; present: boolean } {
    const provider = isProvider(need.kind) ? need.kind : undefined;
    const shape = provider ? SHAPES[provider] : undefined;
    if (shape?.holds === 'file') {
        return { env: shape.env, present: Boolean(process.env[shape.env]) || hasGcloudAdc() };
    }
    return { env: need.apiKeyEnv, present: need.satisfied };
}

/**
 * Reports the models a run could not reach. Best effort by design: a config
 * that will not parse, or that names a provider that does not exist, is the
 * loader's to report — precisely, and with the offending key named. Guessing
 * at it here would only produce a worse version of the same message.
 *
 * Call *after* `KeyStore.materialize()`, so the keyring's keys are as visible
 * here as they will be to the library.
 */
export function auditModels(versionDir: string, store: KeyStore): ModelIssue[] {
    let config: ProjectConfig;
    try {
        config = readProjectConfig(versionDir).config;
    } catch {
        return [];
    }

    const registry = projectRegistry(config);
    const issues: ModelIssue[] = [];

    for (const [name, ref] of declared(config)) {
        let need: ModelRequirement;
        try {
            need = registry.requirement(ref);
        } catch {
            continue;
        }

        const { env, present } = credential(need);
        const provider = isProvider(need.kind) ? need.kind : undefined;

        if (!present) {
            issues.push({ name, provider: need.provider, env, reason: 'missing', add: provider });
            continue;
        }

        // A key that the provider itself rejected last time it was asked. Said
        // as a warning rather than an error because a key can be reinstated
        // between the check and the run, and a stale verdict must not be the
        // thing that stops a run from being attempted.
        const check = provider ? store.active(provider)?.check : undefined;
        if (check?.state === 'dead') {
            issues.push({
                name,
                provider: need.provider,
                env,
                reason: 'dead',
                detail: check.detail,
                add: provider,
            });
        }
    }

    return issues;
}

/**
 * One line, and the command that fixes it. A warning nobody can act on is
 * noise, so the fix is part of the sentence rather than something to go and
 * look up.
 */
export function describeIssue(issue: ModelIssue): string {
    const what = `${bold(issue.name)} (${issue.provider})`;
    if (issue.reason === 'missing') {
        const fix = issue.add ? `zen key add ${issue.add}` : `set ${issue.env}`;
        return `${what} has no credential — ${issue.env} is not set; ${dim(fix)}`;
    }
    const why = issue.detail ? `: ${issue.detail}` : '';
    const fix = `zen key check ${issue.add ?? ''}`.trim();
    return `${what} was rejected when last checked${why} — ${dim(fix)}`;
}
