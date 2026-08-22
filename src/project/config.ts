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
 * A model is either the shorthand string `createModel` already parses
 * (`gpt-4o`, `openai/responses:o3`) or a key into `ProjectOptions.models`.
 * Which one it is cannot be decided here — the loader resolves aliases first
 * and falls through to the shorthand — so the schema only asks for a non-empty
 * string.
 */
const modelRef = z.string().min(1);

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
        /** fallback for agents that do not pin their own */
        model: modelRef.optional(),
        /** one directory, or several merged into one catalog */
        skills: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
        agents: z.array(agent).min(1),
    })
    .strict();

export type ProjectConfig = z.infer<typeof projectSchema>;
export type AgentConfig = ProjectConfig['agents'][number];

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
