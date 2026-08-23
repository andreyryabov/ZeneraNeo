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
        kind: z.enum(['openai', 'google', 'vertex', 'anthropic', 'openai-compatible']).optional(),
        /** vertex only: the GCP project and region the endpoint is addressed by */
        project: z.string().min(1).optional(),
        location: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), z.string()).optional(),
        timeoutMs: z.number().positive().optional(),
        maxRetries: z.int().nonnegative().optional(),
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
        /** one directory, or several merged into one catalog */
        skills: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
        agents: z.array(agent).min(1),
    })
    .strict();

export type ProjectConfig = z.infer<typeof projectSchema>;
export type AgentConfig = ProjectConfig['agents'][number];
export type ProviderConfig = z.infer<typeof provider>;
export type ModelConfig = z.infer<typeof modelSpec>;

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
