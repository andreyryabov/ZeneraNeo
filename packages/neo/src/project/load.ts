import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Agent, AgentRegistry, type ForkOptions } from '../agent.ts';
import type { Embedder } from '../embedding.ts';
import { RunStream } from '../events.ts';
import type { MemoryStore } from '../memory.ts';
import type { Model } from '../model.ts';
import {
    ModelRegistry,
    type EmbeddingRef,
    type ModelRef,
    type ProviderSpec,
} from '../models/factory.ts';
import type { PayloadStore } from '../payload.ts';
import { promptFile, type PromptPart } from '../prompt.ts';
import { AgentRunner, type RunOptions, type RunnerOptions } from '../runner.ts';
import { FileSkillProvider, type SkillDir } from '../skill-providers/file.ts';
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
 * INSTRUCTIONS.md               house rules, prepended to every agent
 * agents.yaml                   who exists, what they may reach for
 * agents/prompts/<role>.md      one agent's own instructions
 * agents/skills/<name>/SKILL.md
 * assets/                       reference material, mounted read-only at /assets
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
    /** the same, for `embeddings:` — host last, for the same reason */
    embeddings?: Record<string, EmbeddingRef>;
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
    /**
     * Where the host has mounted the skill catalog for the agent to reach —
     * `/skills` from the CLI, which bind-mounts it into the container.
     *
     * Set it and a loaded skill carries the path of its own folder, so one that
     * ships a script can say where the script is. Left unset, a skill is text
     * and nothing claims otherwise: a promise of a directory that is not there
     * is worse than no directory.
     */
    skillsAt?: string;
}

const PROMPTS_DIR = 'agents/prompts';
const SKILLS_DIR = 'agents/skills';
/** Reference material, by convention, when `assets:` says nothing. */
const ASSETS_DIR = 'assets';
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];
// Deliberately not `AGENTS.md`: every coding assistant now reads that name out
// of an open folder, and `zen open` opens exactly this directory. The house
// rules here address *this project's* agents, not the editor's.
const HOUSE_RULES = 'INSTRUCTIONS.md';

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
    // Resolved here rather than where it is mounted, so an `assets:` naming a
    // directory that is not there fails at load like every other bad path.
    const assets = assetsDir(root, config);

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
            fork: forkFor(spec),
        });
    }

    validate(config, registry, providers, catalogs, models);

    const embedders = embedderResolver(config, opts, models);
    // The default is resolved here rather than on first use, so a broken
    // `embedding:` fails at load like a broken `model:` does.
    embedders(config.embedding, 'embedding');

    return new AgentProject<TCtx>({
        root,
        source,
        config,
        entry: entrypoint(config),
        registry,
        skillProviders: providers,
        assets,
        models,
        embedders,
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
    assets: string | undefined;
    models: ModelRegistry;
    embedders: (ref: string | undefined, where: string) => Embedder | undefined;
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
    /** reference material to mount read-only, if the project has any */
    readonly assets: string | undefined;
    /** the providers this project declared, and the clients behind them */
    readonly models: ModelRegistry;
    readonly #embedders: (ref: string | undefined, where: string) => Embedder | undefined;
    readonly #options: ProjectOptions<TCtx>;
    #runner?: AgentRunner<TCtx>;

    constructor(parts: ProjectParts<TCtx>) {
        this.root = parts.root;
        this.source = parts.source;
        this.config = parts.config;
        this.entry = parts.entry;
        this.registry = parts.registry;
        this.skillProviders = parts.skillProviders;
        this.assets = parts.assets;
        this.models = parts.models;
        this.#embedders = parts.embedders;
        this.#options = parts.options;
    }

    get agents(): readonly Agent<TCtx>[] {
        return [...this.registry.agents.values()];
    }

    /**
     * A declared vectoriser, memoized. Named or not: with no argument this is
     * the project's `embedding:`, and `undefined` when it declares none.
     */
    embedder(name?: string): Embedder | undefined {
        const ref = name ?? this.config.embedding;
        return this.#embedders(ref, name ? `embeddings.${name}` : 'embedding');
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
 * `INSTRUCTIONS.md` first, the agent's own file second — shared context before
 * the specific job, and the stable half of the prompt in front where a cache
 * can reuse it.
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

/**
 * `embeddings:` values, resolved the same way `model:` values are — through the
 * alias tables, memoized, and with the offending key named when a ref will not
 * resolve.
 */
function embedderResolver<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
    models: ModelRegistry,
): (ref: string | undefined, where: string) => Embedder | undefined {
    const cache = new Map<string, Embedder>();
    return (ref, where) => {
        if (!ref) {
            return undefined;
        }
        const cached = cache.get(ref);
        if (cached) {
            return cached;
        }
        const resolved = opts.embeddings?.[ref] ?? config.embeddings?.[ref] ?? ref;
        try {
            // `routing` is widened to plain strings by the schema on purpose
            // (see config.ts); the request is the authority on rejecting one.
            const embedder = models.embedder(resolved as EmbeddingRef);
            cache.set(ref, embedder);
            return embedder;
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

/**
 * `true` and `{}` both mean "opt in, no limits", because the kernel offers the
 * tool on the binding's presence alone. `false` folds back to absent, so a
 * project can write the "no" it was going to write anyway without that being a
 * different state from omitting the key.
 */
function forkFor(spec: AgentConfig): ForkOptions | undefined {
    if (!spec.fork) {
        return undefined;
    }
    return spec.fork === true ? {} : spec.fork;
}

function skillProviders<TCtx>(
    root: string,
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
): SkillProvider[] {
    const declared = skillDirs(root, config);
    if (!declared.length) {
        return [];
    }
    // One provider over several directories rather than several providers: a
    // binding names exactly one, and "which folder is this skill in?" is not a
    // question an agent author should have to answer.
    return [
        new FileSkillProvider({
            id: 'project',
            dir: opts.skillsAt ? skillMounts(declared, opts.skillsAt) : declared,
            tools: opts.tools,
        }),
    ];
}

/**
 * Where each skill directory appears in the agent's namespace.
 *
 * One catalog is the whole of `/skills`, which is what a project normally has.
 * Several cannot all be it, so each takes its own last segment underneath — and
 * two directories ending in the same name would mean one hid the other, which
 * is a load error rather than a catalog that silently went missing.
 */
export function skillMounts(dirs: readonly string[], at: string): SkillDir[] {
    if (dirs.length === 1) {
        return [{ path: dirs[0], at }];
    }
    const taken = new Map<string, string>();
    return dirs.map((dir) => {
        const name = basename(dir);
        const clash = taken.get(name);
        if (clash) {
            throw new Error(`skills: ${dir} and ${clash} would both be mounted at ${at}/${name}`);
        }
        taken.set(name, dir);
        return { path: dir, at: `${at}/${name}` };
    });
}

/**
 * The directories the skill catalog is built from, resolved. `skills:` if it is
 * there, otherwise the conventional folder if it exists, otherwise none — a
 * project without skills is a project, not an error.
 */
export function skillDirs(root: string, config: ProjectConfig): string[] {
    const declared = config.skills
        ? Array.isArray(config.skills)
            ? config.skills
            : [config.skills]
        : existsSync(join(root, SKILLS_DIR))
          ? [SKILLS_DIR]
          : [];
    return declared.map((d, i) => projectDir(root, d, `skills[${i}]`));
}

/**
 * The project's reference material, resolved, or undefined if it has none.
 *
 * Convention first — `assets/` next to `agents.yaml` is enough, and a project
 * that only wants somewhere to put a handbook writes no config at all. The key
 * exists for the project that keeps its material elsewhere in the tree; a key
 * naming a directory that is not there is a mistake in the file and fails at
 * load, where the conventional folder merely being absent does not.
 */
export function assetsDir(root: string, config: ProjectConfig): string | undefined {
    if (config.assets) {
        return projectDir(root, config.assets, 'assets');
    }
    const at = join(root, ASSETS_DIR);
    return existsSync(at) && statSync(at).isDirectory() ? at : undefined;
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

    for (const [alias, spec] of Object.entries(config.embeddings ?? {})) {
        const named = typeof spec === 'string' ? undefined : spec.provider;
        if (named && !models.has(named)) {
            throw new Error(
                `embeddings.${alias}.provider: unknown provider "${named}" ` +
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

        // Unlike a hand-off, naming yourself is the common case here — one role
        // fanned out over ten regions — so only unknown names are an error.
        for (const target of registry.get(spec.name).fork?.agents ?? []) {
            if (!registry.find(target)) {
                throw new Error(
                    `agents.${spec.name}.fork.agents: unknown agent "${target}" ` +
                        `(known: ${registry.names().join(', ')})`,
                );
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
