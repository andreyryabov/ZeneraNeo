import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, AgentRegistry } from '../agent.ts';
import { RunStream } from '../events.ts';
import type { MemoryStore } from '../memory.ts';
import type { Model } from '../model.ts';
import { ModelRegistry, type ModelRef, type ProviderSpec } from '../models/factory.ts';
import type { PayloadStore } from '../payload.ts';
import { promptFile, type PromptPart } from '../prompt.ts';
import { AgentRunner, type RunOptions, type RunnerOptions } from '../runner.ts';
import { FileSkillProvider } from '../skill-providers/file.ts';
import type { SkillBinding, SkillProvider, SkillSummary } from '../skills.ts';
import { selectTools, type AnyTool, type Input } from '../types.ts';
import { parseConfig, type AgentConfig, type ProjectConfig } from './config.ts';
import { projectDir, projectFile, projectRoot } from './refs.ts';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * A folder is an agentic system:
 *
 * ```
 * AGENTS.md                     house rules, prepended to every agent
 * agents.yaml                   who exists, what they may reach for
 * agents/prompts/<role>.md      one agent's own instructions
 * agents/skills/<name>/SKILL.md
 * ```
 *
 * The loader turns that into the objects an author would otherwise write by
 * hand — it introduces no runtime concept of its own. Everything below is
 * assembly, which is the point: a project is a *serialisation* of a registry,
 * not a second way to run agents.
 */

export interface ProjectOptions<TCtx = unknown> {
    /**
     * Tool implementations, keyed by name. Config can name a tool; it cannot
     * contain one, so this is the seam where code re-enters a declarative
     * system. Both `agents[].tools` and a skill's `tools:` frontmatter resolve
     * against it.
     */
    tools?: AnyTool<TCtx>[];
    /**
     * Credentials for the names the config declares — or names it does not, so
     * a deployment can add a provider the repository never mentions. Merged
     * over `providers:`, host last, which is how ops repoints a key without a
     * commit.
     */
    providers?: Record<string, ProviderSpec>;
    /**
     * Aliases for `model:` values, so a project can say `model: fast` and the
     * host decides what fast means this week. Merged over the config's
     * `models:` map; a name in neither falls through to the shorthand.
     */
    models?: Record<string, ModelRef>;
    /**
     * A registry to populate and use instead of a fresh one. Share it across
     * projects and they share clients; pre-load it with a stub provider and the
     * project never reaches the network.
     */
    registry?: ModelRegistry;
    memory?: MemoryStore[];
    payloads?: PayloadStore;
    /** extra providers merged with the ones the project declares */
    skills?: SkillProvider[];
}

const PROMPTS_DIR = 'agents/prompts';
const SKILLS_DIR = 'agents/skills';
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];
const HOUSE_RULES = 'AGENTS.md';

/** A project's declaration, before anything is assembled from it. */
export interface ProjectSource {
    root: string;
    /** the config file that was read */
    source: string;
    config: ProjectConfig;
}

/**
 * Finds and validates `agents.yaml`, and stops there. Loading a project builds
 * its model clients, which needs credentials — so anything that wants to *look*
 * at what a project declares, credentials included, has to be able to read it
 * without that.
 */
export function readProjectConfig(dir: string): ProjectSource {
    const root = projectRoot(dir);
    const source = findConfig(root);
    return { root, source, config: parseConfig(readFileSync(source, 'utf8'), source) };
}

/**
 * Reads a project into memory. Every file it will ever need is read here, so a
 * broken path, an unknown tool or a hand-off to nobody fails at startup with
 * the offending key named — not on some later turn, in production, as a model
 * error nobody can act on.
 */
export async function loadProject<TCtx = unknown>(
    dir: string,
    opts: ProjectOptions<TCtx> = {},
): Promise<AgentProject<TCtx>> {
    const { root, source, config } = readProjectConfig(dir);

    // Read once and share the object: every agent's prompt then reports the
    // same path and the same content hash, so the report says "one document,
    // five prompts" instead of showing five identical blobs.
    const houseRules = readHouseRules(root);

    const providers = [...skillProviders(root, config, opts), ...(opts.skills ?? [])];
    const catalogs = await indexOf(providers);
    const models = projectRegistry(config, opts);

    const registry = new AgentRegistry<TCtx>();
    const resolve = modelResolver(config, opts, models);
    for (const spec of config.agents) {
        registry.agent({
            name: spec.name,
            description: spec.description,
            instructions: instructionsFor(root, spec, houseRules),
            model: resolve(spec.model ?? config.model, `agents.${spec.name}.model`),
            tools: toolsFor(spec, opts.tools ?? []),
            handoffs: spec.handoffs,
            skills: bindingFor(spec, providers),
        });
    }

    validate(config, registry, providers, catalogs, models);

    return new AgentProject<TCtx>({
        root,
        source,
        config,
        entry: entrypoint(config),
        registry,
        skillProviders: providers,
        models,
        options: opts,
    });
}

interface ProjectParts<TCtx> {
    root: string;
    source: string;
    config: ProjectConfig;
    entry: string;
    registry: AgentRegistry<TCtx>;
    skillProviders: SkillProvider[];
    models: ModelRegistry;
    options: ProjectOptions<TCtx>;
}

/**
 * A loaded project: immutable, and therefore shareable.
 *
 * Load once per process and let every chat use the same instance. Nothing
 * per-conversation lives here — a conversation *is* its `AgentState`, and the
 * caller's data reaches tools through `RunOptions.context`. Two chats holding
 * this object cannot observe each other.
 *
 * There is a second, quieter payoff. Because tool schemas no longer change as
 * skills activate, every chat on a shared project sends a byte-identical
 * `[tool schemas][system prompt]` prefix. That is a provider cache hit *across*
 * conversations, not merely within one.
 */
export class AgentProject<TCtx = unknown> {
    readonly root: string;
    /** the config file that was read, for error messages and reloads */
    readonly source: string;
    readonly config: ProjectConfig;
    /** agent the project starts with */
    readonly entry: string;
    readonly registry: AgentRegistry<TCtx>;
    readonly skillProviders: readonly SkillProvider[];
    /** the providers this project declared, and the clients behind them */
    readonly models: ModelRegistry;
    readonly #options: ProjectOptions<TCtx>;
    #runner?: AgentRunner<TCtx>;

    constructor(parts: ProjectParts<TCtx>) {
        this.root = parts.root;
        this.source = parts.source;
        this.config = parts.config;
        this.entry = parts.entry;
        this.registry = parts.registry;
        this.skillProviders = parts.skillProviders;
        this.models = parts.models;
        this.#options = parts.options;
    }

    get agents(): readonly Agent<TCtx>[] {
        return [...this.registry.agents.values()];
    }

    /**
     * The shared runner, or a fresh one when a caller needs different wiring.
     *
     * Memoized without overrides because a runner holds only immutable
     * configuration; handing the same one to every chat is safe and saves
     * re-registering the agents.
     */
    runner(overrides?: RunnerOptions<TCtx>): AgentRunner<TCtx> {
        if (overrides) {
            return this.#build(overrides);
        }
        return (this.#runner ??= this.#build());
    }

    /** Starts a run on the entry agent with the shared runner. */
    run<T = string>(input?: Input, opts: RunOptions<T, TCtx> = {}): RunStream<T> {
        return this.runner().run<T>(this.entry, input, opts);
    }

    #build(overrides: RunnerOptions<TCtx> = {}): AgentRunner<TCtx> {
        const runner = new AgentRunner<TCtx>({
            payloads: this.#options.payloads,
            memory: this.#options.memory,
            skills: [...this.skillProviders],
            ...overrides,
        });
        runner.add(...this.agents);
        return runner;
    }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function findConfig(root: string): string {
    for (const name of CONFIG_NAMES) {
        const path = join(root, name);
        if (existsSync(path)) {
            return path;
        }
    }
    throw new Error(`no project configuration in ${root} (looked for ${CONFIG_NAMES.join(', ')})`);
}

function readHouseRules(root: string): PromptPart | undefined {
    const path = join(root, HOUSE_RULES);
    // Optional on purpose: a one-agent project whose whole prompt is its role
    // file should not need a second, empty document.
    return existsSync(path) ? promptFile(path, 'house_rules') : undefined;
}

/**
 * `AGENTS.md` first, the agent's own file second — shared context before the
 * specific job, and the stable half of the prompt in front where a cache can
 * reuse it.
 */
function instructionsFor(
    root: string,
    spec: AgentConfig,
    houseRules: PromptPart | undefined,
): PromptPart[] {
    const parts: PromptPart[] = [];
    if (houseRules) {
        parts.push(houseRules);
    }
    if (spec.system) {
        parts.push(
            promptFile(projectFile(root, spec.system, `agents.${spec.name}.system`), 'role'),
        );
    } else {
        const conventional = join(root, PROMPTS_DIR, `${spec.name}.md`);
        if (existsSync(conventional)) {
            parts.push(promptFile(conventional, 'role'));
        }
    }
    return parts;
}

/**
 * Assembles the project's providers. Declaring one contacts nothing and reads
 * no environment: a project may name a vendor a given deployment has no key
 * for, and only pay for it if an agent actually reaches for it.
 */
export function projectRegistry<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx> = {},
): ModelRegistry {
    const models = opts.registry ?? new ModelRegistry();
    for (const [name, spec] of Object.entries(config.providers ?? {})) {
        models.provider(name, spec);
    }
    // Host last: a deployment overrides the repository, never the other way.
    for (const [name, spec] of Object.entries(opts.providers ?? {})) {
        models.provider(name, spec);
    }
    if (config.provider) {
        models.setDefault(config.provider);
    }
    return models;
}

/**
 * `model:` values, resolved through the alias tables and memoized.
 *
 * Memoized because two agents naming `fast` should be two references to one
 * model over one client, not two of each — and because the error a bad ref
 * raises should be raised once, at the agent that wrote it.
 */
function modelResolver<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
    models: ModelRegistry,
): (ref: string | undefined, where: string) => Model | undefined {
    const cache = new Map<string, Model>();
    return (ref, where) => {
        if (!ref) {
            return undefined;
        }
        const cached = cache.get(ref);
        if (cached) {
            return cached;
        }
        const resolved = opts.models?.[ref] ?? config.models?.[ref] ?? ref;
        try {
            // `reasoningEffort` is widened to `string` by the schema on purpose
            // (see config.ts); the request is the authority on rejecting a bad
            // one, so this cast hands it over rather than guessing the vendor's
            // current set.
            const model = models.model(resolved as ModelRef);
            cache.set(ref, model);
            return model;
        } catch (e) {
            throw new Error(`${where}: ${(e as Error).message}`);
        }
    };
}

function toolsFor<TCtx>(spec: AgentConfig, available: AnyTool<TCtx>[]): AnyTool<TCtx>[] {
    if (!spec.tools?.length) {
        return [];
    }
    return selectTools(available, spec.tools, {
        where: `agents.${spec.name}.tools`,
        hint: 'pass it in ProjectOptions.tools',
    });
}

function bindingFor(spec: AgentConfig, providers: SkillProvider[]): SkillBinding | undefined {
    if (!spec.skills) {
        return undefined;
    }
    const provider = spec.skills.provider ?? providers[0]?.id;
    if (!provider) {
        throw new Error(
            `agents.${spec.name}.skills: no skill provider — add a top-level ` +
                `\`skills:\` directory or pass one in ProjectOptions.skills`,
        );
    }
    return {
        provider,
        discovery: spec.skills.discovery,
        allow: spec.skills.allow,
        preload: spec.skills.preload,
        maxIndexEntries: spec.skills.maxIndexEntries,
    };
}

function skillProviders<TCtx>(
    root: string,
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
): SkillProvider[] {
    const declared = config.skills
        ? Array.isArray(config.skills)
            ? config.skills
            : [config.skills]
        : existsSync(join(root, SKILLS_DIR))
          ? [SKILLS_DIR]
          : [];
    if (!declared.length) {
        return [];
    }
    // One provider over several directories rather than several providers: a
    // binding names exactly one, and "which folder is this skill in?" is not a
    // question an agent author should have to answer.
    return [
        new FileSkillProvider({
            id: 'project',
            dir: declared.map((d, i) => projectDir(root, d, `skills[${i}]`)),
            tools: opts.tools,
        }),
    ];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function indexOf(providers: SkillProvider[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const p of providers) {
        out.set(p.id, new Set((await p.list()).map((s: SkillSummary) => s.name)));
    }
    return out;
}

/**
 * Cross-references the config against what was actually loaded.
 *
 * The schema can only check shape. Whether `handoffs: [resolver]` names a real
 * agent, or `preload: [house_style]` a real skill, is knowable only once
 * everything is in memory — and getting it wrong is the failure that would
 * otherwise surface as a confused model halfway through a run.
 */
function validate<TCtx>(
    config: ProjectConfig,
    registry: AgentRegistry<TCtx>,
    providers: SkillProvider[],
    catalogs: Map<string, Set<string>>,
    models: ModelRegistry,
): void {
    const ids = new Set(providers.map((p) => p.id));

    // Provider *names* are checkable without credentials, so a typo in an entry
    // no agent happens to use is still caught — unlike the key it would need.
    for (const [alias, spec] of Object.entries(config.models ?? {})) {
        const named = typeof spec === 'string' ? undefined : spec.provider;
        if (named && !models.has(named)) {
            throw new Error(
                `models.${alias}.provider: unknown provider "${named}" ` +
                    `(known: ${models.names().join(', ')})`,
            );
        }
    }

    for (const spec of config.agents) {
        for (const target of spec.handoffs ?? []) {
            if (!registry.find(target)) {
                throw new Error(
                    `agents.${spec.name}.handoffs: unknown agent "${target}" ` +
                        `(known: ${registry.names().join(', ')})`,
                );
            }
            if (target === spec.name) {
                throw new Error(`agents.${spec.name}.handoffs: an agent cannot hand off to itself`);
            }
        }

        const binding = registry.get(spec.name).skills;
        if (!binding) {
            continue;
        }
        if (!ids.has(binding.provider)) {
            throw new Error(
                `agents.${spec.name}.skills.provider: unknown provider "${binding.provider}" ` +
                    `(known: ${[...ids].join(', ') || 'none'})`,
            );
        }
        const known = catalogs.get(binding.provider) ?? new Set<string>();
        for (const [key, names] of [
            ['allow', spec.skills?.allow],
            ['preload', spec.skills?.preload],
        ] as const) {
            for (const skill of names ?? []) {
                if (!known.has(skill)) {
                    throw new Error(
                        `agents.${spec.name}.skills.${key}: unknown skill "${skill}" ` +
                            `(catalog "${binding.provider}" has: ${[...known].join(', ') || 'none'})`,
                    );
                }
            }
        }
        // A skill that is preloaded but not allowed would be activated by the
        // runner and then hidden from the index — contradictory, and silent.
        for (const skill of spec.skills?.preload ?? []) {
            if (spec.skills?.allow && !spec.skills.allow.includes(skill)) {
                throw new Error(
                    `agents.${spec.name}.skills.preload: "${skill}" is not in \`allow\``,
                );
            }
        }
    }
}

/** Explicit `default:` wins, then an agent that claims it, then the first declared. */
function entrypoint(config: ProjectConfig): string {
    if (config.default) {
        const named = config.agents.find((a) => a.name === config.default);
        if (!named) {
            throw new Error(
                `default: unknown agent "${config.default}" ` +
                    `(declared: ${config.agents.map((a) => a.name).join(', ')})`,
            );
        }
        return named.name;
    }
    const claimed = config.agents.filter((a) => a.default);
    if (claimed.length > 1) {
        throw new Error(
            `more than one agent claims \`default: true\`: ${claimed.map((a) => a.name).join(', ')}`,
        );
    }
    return claimed[0]?.name ?? config.agents[0].name;
}
