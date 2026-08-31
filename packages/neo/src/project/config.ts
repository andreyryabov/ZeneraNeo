import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// agents.yaml
// ---------------------------------------------------------------------------

// Names reach the model as part of `transfer_to_<name>` and reach the file
// system as skill directory names, so they are restricted to a shape that is
// unambiguous in both.
const NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const name = z
    .string()
    .regex(NAME, 'must be lower-case words separated by "-" or "_", e.g. "order-triage"');

/**
 * A model reference is either the shorthand `ModelRegistry.parse` understands
 * (`gpt-4o`, `openai/responses:o3`, `openai-eu:o3`) or a key into the
 * project's `models:` map. Which one it is cannot be decided here — the loader
 * resolves aliases first and falls through to the shorthand — so the schema
 * only asks for a non-empty string.
 */
const modelRef = z.string().min(1);

/**
 * Credentials, shared by providers and by the one-off model that overrides
 * them. Values may embed `${VAR}` references; the substitution happens in the
 * registry, not here, so a config that is never used never demands a key.
 */
const credentials = {
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    baseURL: z.string().min(1).optional(),
    baseURLEnv: z.string().min(1).optional(),
};

/**
 * A named connection. Splitting this out of the model is what lets one project
 * hold two keys for the same vendor: the key is declared once, under a name,
 * and models point at the name.
 */
const provider = z
    .object({
        ...credentials,
        kind: z
            .enum(['openai', 'google', 'vertex', 'anthropic', 'openrouter', 'openai-compatible'])
            .optional(),
        /** vertex only: the GCP project and region the endpoint is addressed by */
        project: z.string().min(1).optional(),
        location: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), z.string()).optional(),
        timeoutMs: z.number().positive().optional(),
        maxRetries: z.int().nonnegative().optional(),
    })
    .strict();

/**
 * openrouter only: which upstream provider serves a request.
 *
 * Named `routing` because `provider:` in this file already means the
 * connection. `sort` and the provider names are plain strings for the same
 * reason `reasoningEffort` is — OpenRouter adds providers continuously, and a
 * config the API would accept should not fail to load here first.
 */
const routing = z
    .object({
        /** providers to try, in order */
        order: z.array(z.string().min(1)).min(1).optional(),
        /** restricts serving to these, rather than merely preferring them */
        only: z.array(z.string().min(1)).min(1).optional(),
        ignore: z.array(z.string().min(1)).min(1).optional(),
        /** `price`, `throughput`, `latency`, `exacto` */
        sort: z.string().min(1).optional(),
        /** may OpenRouter go beyond `order`; on by default */
        allowFallbacks: z.boolean().optional(),
        /** skip providers that would silently drop parameters they do not support */
        requireParameters: z.boolean().optional(),
        dataCollection: z.enum(['allow', 'deny']).optional(),
        quantizations: z.array(z.string().min(1)).min(1).optional(),
        /** zero-data-retention endpoints only */
        zdr: z.boolean().optional(),
    })
    .strict();

/**
 * `reasoningEffort` is a plain string rather than an enum on purpose: the
 * vendor's accepted set changes faster than this file would, and the request
 * that carries a bad value is the authority on rejecting it. An enum here would
 * mean a config that the API accepts failing to load.
 */
const modelSpec = z
    .object({
        ...credentials,
        /** a name from `providers:`, or a built-in kind */
        provider: z.string().min(1).optional(),
        api: z.enum(['chat', 'responses']).optional(),
        model: z.string().min(1),
        reasoningEffort: z.string().min(1).optional(),
        reasoningSummary: z.enum(['auto', 'concise', 'detailed']).optional(),
        store: z.boolean().optional(),
        /** anthropic only: the output cap its API requires, and the thinking budget */
        maxTokens: z.int().positive().optional(),
        thinkingBudgetTokens: z.int().positive().optional(),
        /** gemini only: 2.5 takes a token budget, 3 takes a level */
        thinkingBudget: z.int().optional(),
        thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
        includeThoughts: z.boolean().optional(),
        /** openrouter only: who serves the request, what to try when they cannot */
        routing: routing.optional(),
        fallbacks: z.array(z.string().min(1)).min(1).optional(),
        serviceTier: z.enum(['auto', 'default', 'fast', 'flex', 'priority', 'scale']).optional(),
    })
    .strict();

/**
 * A vectoriser. Deliberately much smaller than `modelSpec`: an embedding call
 * has no conversation, no tools and no reasoning, so a connection, an id and a
 * width is all there is to say. `taskType` is absent because it describes the
 * *text*, not the model, and so belongs to the call.
 */
const embeddingSpec = z
    .object({
        ...credentials,
        /** a name from `providers:`, or a built-in kind */
        provider: z.string().min(1).optional(),
        model: z.string().min(1),
        /** truncate to this width, where the model supports it */
        dimensions: z.int().positive().optional(),
        /** gemini only: a document title the retrieval task type takes into account */
        title: z.string().min(1).optional(),
        /** gemini only: texts per request; every `gemini-embedding-*` model takes one */
        maxBatch: z.int().positive().optional(),
        /** openrouter only: who serves the request */
        routing: routing.optional(),
    })
    .strict();

const skillsBinding = z
    .object({
        /** provider id; defaults to the project's sole provider */
        provider: z.string().min(1).optional(),
        discovery: z.enum(['index', 'search', 'none']).default('index'),
        /** restricts the catalog this agent sees; absent means all of it */
        allow: z.array(name).optional(),
        /** activated before the first call of every turn this agent owns */
        preload: z.array(name).optional(),
        maxIndexEntries: z.int().positive().optional(),
    })
    .strict();

/**
 * Opt-in to parallel sub-agents. The kernel gates the `fork` tool on the
 * binding *existing*, not on what it holds, so `true` and `{}` say the same
 * thing and there is nothing here to default — an agent that does not mention
 * `fork:` is never offered the tool.
 *
 * Both limits are stated as errors rather than as values that get clamped
 * later: `maxBranches: 1` would make every call the model could write fail, and
 * `agents: []` reads as "no agents" while actually meaning "only itself".
 */
const forkBinding = z
    .object({
        /** agents a branch may run; absent means any registered agent */
        agents: z.array(name).min(1).optional(),
        /** a fork is never valid with one branch, so a cap below two is a contradiction */
        maxBranches: z.int().min(2).optional(),
    })
    .strict();

/**
 * The container command-line tools run in.
 *
 * Everything here is a *resource* decision — which image, how much of the
 * machine, whether the network is reachable — because those are the decisions
 * that differ between a laptop and CI and cannot be baked into an image.
 *
 * `env` names host variables to forward, and only names: values never appear
 * in the config, so a repository never carries one. Names that read like a
 * credential are refused outright. The CLI materialises the keyring into its
 * own environment before loading a project, so an unguarded passthrough would
 * hand every model key to whatever the agent decided to run.
 */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

const sandbox = z
    .object({
        /** the base image, e.g. `docker.io/library/python:3.13-slim` */
        image: z.string().min(1).optional(),
        /** fractional cores the container may use */
        cpus: z.number().positive().optional(),
        /** MiB the container may use */
        memory: z.int().positive().optional(),
        network: z.enum(['bridge', 'none', 'host']).optional(),
        /** where the workspace is mounted, and the default working directory */
        workdir: z.string().min(1).optional(),
        /** seconds one command may take before it is killed */
        timeout: z.int().positive().optional(),
        /** uid, name or `uid:gid`; unset means the image's own user */
        user: z.string().min(1).optional(),
        /** keep the container between sessions instead of removing it */
        persist: z.boolean().optional(),
        /** host variables to forward, by name */
        env: z.array(z.string().min(1)).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        for (const [i, name] of (value.env ?? []).entries()) {
            if (SECRETISH.test(name)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['env', i],
                    message:
                        `refusing to forward ${name} into the sandbox — it reads like a ` +
                        'credential, and the sandbox runs whatever the model writes',
                });
            }
        }
    });

const agent = z
    .object({
        name,
        /** what a sibling agent's `transfer_to_` tool tells the model */
        description: z.string().optional(),
        /** path to a markdown file, relative to the project root */
        system: z.string().min(1).optional(),
        model: modelRef.optional(),
        /** names resolved against `ProjectOptions.tools`; code cannot live in yaml */
        tools: z.array(z.string().min(1)).optional(),
        /**
         * Plain agent names. Deliberately not objects: a hand-off carries no
         * configuration in this version, so there is nothing for an object form
         * to hold, and accepting one would mean accepting keys nothing honours.
         */
        handoffs: z.array(name).optional(),
        skills: skillsBinding.optional(),
        /** parallel sub-agents; `true` is the unrestricted form */
        fork: z.union([z.boolean(), forkBinding]).optional(),
        /**
         * Overrides on the project's sandbox. An agent that overrides nothing
         * shares the container with everyone else, which is what a hand-off
         * usually wants; an agent that names its own image gets its own.
         */
        sandbox: sandbox.optional(),
        /** entrypoint, when no top-level `default` is given */
        default: z.boolean().optional(),
    })
    .strict();

export const projectSchema = z
    .object({
        version: z.literal(1).default(1),
        /** entrypoint agent name; wins over any `default: true` */
        default: name.optional(),
        /** named connections; the built-in kinds work without being declared */
        providers: z.record(name, provider).optional(),
        /** the provider a bare model id belongs to */
        provider: name.optional(),
        /** named model configurations, referenced by `model:` anywhere below */
        models: z.record(name, z.union([modelRef, modelSpec])).optional(),
        /** fallback for agents that do not pin their own */
        model: modelRef.optional(),
        /**
         * Named vectorisers. Not a per-agent key: nothing in the runtime
         * consumes an embedder yet, and a key nothing honours is worse than a
         * key that is not there.
         */
        embeddings: z.record(name, z.union([modelRef, embeddingSpec])).optional(),
        /** the vectoriser `AgentProject.embedder()` hands back when asked for none */
        embedding: modelRef.optional(),
        /** one directory, or several merged into one catalog */
        skills: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
        /**
         * Reference material every agent can read and none can write, mounted
         * at /assets. One directory, project-wide: an agent that may only see
         * some of it is a different project, not a different key.
         */
        assets: z.string().min(1).optional(),
        /** the container `run_command` and friends execute in */
        sandbox: sandbox.optional(),
        agents: z.array(agent).min(1),
    })
    .strict();

export type ProjectConfig = z.infer<typeof projectSchema>;
export type AgentConfig = ProjectConfig['agents'][number];
export type ProviderConfig = z.infer<typeof provider>;
export type ModelConfig = z.infer<typeof modelSpec>;
export type EmbeddingConfig = z.infer<typeof embeddingSpec>;
export type SandboxConfig = z.infer<typeof sandbox>;

/**
 * Re-renders a zod failure as `agents.yaml: agents[1].skills.discovery — …`.
 *
 * The default message is a JSON blob with the path in a nested array, which
 * tells an author everything except the one thing they need: which line to fix.
 */
export function parseConfig(text: string, source: string): ProjectConfig {
    let raw: unknown;
    try {
        raw = parseYaml(text);
    } catch (e) {
        throw new Error(`${source}: ${(e as Error).message}`);
    }
    const result = projectSchema.safeParse(raw);
    if (!result.success) {
        const lines = result.error.issues.map((i) => {
            const path = i.path.length ? i.path.map(segment).join('').replace(/^\./, '') : '(root)';
            return `  ${path} — ${i.message}`;
        });
        throw new Error(`${source}: invalid project configuration\n${lines.join('\n')}`);
    }
    return result.data;
}

function segment(p: PropertyKey): string {
    return typeof p === 'number' ? `[${p}]` : `.${String(p)}`;
}
