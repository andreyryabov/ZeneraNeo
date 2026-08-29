import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
    EXA_GROUP,
    FileSkillProvider,
    SANDBOX_MOUNT,
    exaTools,
    projectRegistry,
    readProjectConfig,
    sandboxTools,
    selectTools,
    workspaceTools,
    type AgentConfig,
    type AnyTool,
    type ModelRef,
    type ProjectConfig,
    type SkillSummary,
} from 'zenera-neo';
import { auditModels, credentialFor, type ModelIssue } from './audit.ts';
import { SHAPES, type KeyStore, type Service } from './keys.ts';

// ---------------------------------------------------------------------------
// The project check
//
// The loader already validates everything here — and stops at the first thing
// it does not like, with the offending key named. That is exactly right for a
// run: nothing should start on a project that will not hold together.
//
// It is exactly wrong for someone *fixing* the project. A first error is a
// keyhole: fix it, run again, find the next one, six times. So this walks the
// same ground and refuses to stop, collecting every finding it can reach, and
// says what it found rather than throwing it.
//
// Two consequences shape the whole module. Nothing here throws for a problem
// *in the project* — a throw would end the walk and cost the findings after it
// — so every check that could throw is wrapped and turned into a `Finding`.
// And nothing here needs a credential, a network or a container: a check that
// only works on a machine already set up is no use to the machine that is not.
// ---------------------------------------------------------------------------

/**
 * `error` — the project will not load, or will not run.
 * `warning` — it loads, and something about it is probably not what was meant.
 * `note` — worth knowing, wrong in no sense at all.
 */
export type Severity = 'error' | 'warning' | 'note';

export interface Finding {
    severity: Severity;
    /** stable identifier, e.g. `prompt.missing` — safe to match on */
    code: string;
    /** the config key or path this is about, e.g. `agents.triage.system` */
    where: string;
    message: string;
    /** what to do about it, naming a file or a command */
    fix?: string;
}

export interface FileCheck {
    /** relative to the project root */
    path: string;
    /** what the file is for, in words */
    role: string;
    kind: 'file' | 'directory';
    exists: boolean;
    /** the project does not load without it */
    required: boolean;
    bytes?: number;
    /** the config key that named it, when a key did rather than a convention */
    from?: string;
}

export interface AgentReport {
    name: string;
    /** the agent a bare `zen run` starts on */
    entry: boolean;
    description?: string;
    /** the model as written, before aliases are resolved */
    model?: string;
    /** where that value came from */
    modelSource: 'agent' | 'project' | 'none';
    /** prompt files, in the order they are concatenated */
    instructions: string[];
    /** `tools:` as written */
    toolSelectors: string[];
    /** what those selectors resolve to */
    tools: string[];
    handoffs: string[];
    skills?: {
        provider: string;
        discovery: string;
        allow?: string[];
        preload?: string[];
    };
    fork?: { agents?: string[]; maxBranches?: number };
    /** true when the agent overrides the project's container */
    ownSandbox: boolean;
}

export interface SkillReport {
    name: string;
    description: string;
    /** the SKILL.md, relative to the project root */
    path: string;
    tools?: string[];
    /** other files in the skill folder, which the agent gets as resources */
    resources?: string[];
    /** agents whose binding can see it */
    usedBy: string[];
}

export interface ModelReport {
    /** the alias it is declared under, or the reference itself */
    name: string;
    /** the provider it resolves to */
    provider?: string;
    kind?: string;
    /** the variable that would carry the credential */
    env?: string;
    credential: 'present' | 'missing' | 'rejected' | 'unknown';
    detail?: string;
    /** agents that would use it */
    usedBy: string[];
}

export interface Report {
    /** no errors — the project loads */
    ok: boolean;
    project: {
        name: string | null;
        root: string;
        /** whether the registry knows this path, i.e. whether `zen list` shows it */
        registered: boolean;
        /** the config file that wins, relative to the root */
        config: string | null;
        /** other config files present, which the loader will ignore */
        shadowed: string[];
        version: number | null;
        entry: string | null;
    };
    files: FileCheck[];
    agents: AgentReport[];
    skills: {
        /** the directories the catalog is built from */
        dirs: string[];
        entries: SkillReport[];
    };
    providers: string[];
    models: ModelReport[];
    sandbox: { image: string | null; declared: boolean; used: boolean };
    findings: Finding[];
    counts: { errors: number; warnings: number; notes: number };
}

export interface ValidateOptions {
    /** the project directory */
    dir: string;
    /** the registered name, when there is one */
    name?: string;
    /**
     * Whether the registry knows this path. Passed in rather than looked up,
     * because nothing in this check may depend on `$HOME` being readable: the
     * machine that is not set up yet is the one that most needs the report.
     */
    registered?: boolean;
    /**
     * The keyring, materialised. Given, every model the project names is
     * checked for a credential; omitted, that section says `unknown` and no
     * finding is raised — a project is not invalid because this laptop cannot
     * pay for it.
     */
    keys?: KeyStore;
}

// Mirrors the loader's own constants (`packages/neo/src/project/load.ts`).
// Duplicated rather than exported, because a check that agreed with the loader
// by construction could not report that the two had diverged.
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];
const HOUSE_RULES = 'INSTRUCTIONS.md';
const PROMPTS_DIR = 'agents/prompts';
const SKILLS_DIR = 'agents/skills';

/** What `allow:` and `preload:` accept, so a skill outside it cannot be named. */
const REFERABLE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export async function validateProject(opts: ValidateOptions): Promise<Report> {
    const root = resolve(opts.dir);
    const findings: Finding[] = [];
    const files: FileCheck[] = [];
    const agents: AgentReport[] = [];
    const skills: SkillReport[] = [];
    const models: ModelReport[] = [];
    let skillDirs: string[] = [];
    let providers: string[] = [];
    let config: ProjectConfig | undefined;
    let configPath: string | null = null;
    let shadowed: string[] = [];
    let entry: string | null = null;
    let registered = opts.registered ?? false;
    let name = opts.name ?? null;

    const add = (f: Finding): void => {
        findings.push(f);
    };

    const record = (
        rel: string,
        role: string,
        kind: 'file' | 'directory',
        required: boolean,
        from?: string,
    ): boolean => {
        const path = join(root, rel);
        const stat = existsSync(path) ? statSync(path) : undefined;
        const exists = Boolean(stat) && (kind === 'file' ? stat!.isFile() : stat!.isDirectory());
        files.push({
            path: rel,
            role,
            kind,
            exists,
            required,
            ...(stat?.isFile() ? { bytes: stat.size } : {}),
            ...(from ? { from } : {}),
        });
        return exists;
    };

    const done = (): Report =>
        finish(root, name, registered, configPath, shadowed, {
            version: config?.version ?? null,
            entry,
            files,
            agents,
            skills,
            skillDirs,
            providers,
            models,
            sandbox: sandboxSummary(config, agents),
            findings,
        });

    // -----------------------------------------------------------------------
    // The directory itself
    // -----------------------------------------------------------------------

    if (!existsSync(root) || !statSync(root).isDirectory()) {
        add({
            severity: 'error',
            code: 'root.missing',
            where: root,
            message: 'not a directory, so there is no project here to check',
            fix: `create one: zen init ${root}`,
        });
        return done();
    }

    // A project is a directory the loader can read; being *listed* is a
    // separate question, and one the caller has already answered — the registry
    // lives in `$HOME`, which this check does not read.
    if (!registered) {
        add({
            severity: 'warning',
            code: 'project.unregistered',
            where: root,
            message:
                'this directory is not registered, so `zen open` and `zen list` will not ' +
                'find it by name (naming it by path, as now, works either way)',
            fix: `register it: zen init ${root} --force`,
        });
    }

    // -----------------------------------------------------------------------
    // agents.yaml: which one, and does it parse
    // -----------------------------------------------------------------------

    const found = CONFIG_NAMES.filter((n) => existsSync(join(root, n)));
    configPath = found[0] ?? null;
    shadowed = found.slice(1);
    for (const n of CONFIG_NAMES) {
        if (existsSync(join(root, n))) {
            record(
                n,
                n === configPath ? 'project configuration' : 'ignored: another config wins',
                'file',
                false,
            );
        }
    }
    if (!configPath) {
        record(CONFIG_NAMES[0], 'project configuration', 'file', true);
        add({
            severity: 'error',
            code: 'config.missing',
            where: root,
            message:
                'no project configuration — the loader looks for ' +
                `${CONFIG_NAMES.join(', ')} and found none of them`,
            fix: `scaffold one: zen init ${root} --force`,
        });
        return done();
    }
    if (shadowed.length) {
        add({
            severity: 'warning',
            code: 'config.shadowed',
            where: shadowed.join(', '),
            message:
                `more than one project configuration is present; the loader takes the ` +
                `first it finds (${configPath}) and never reads ${shadowed.join(', ')}`,
            fix: `delete the ones that are not in use, or merge them into ${configPath}`,
        });
    }

    try {
        config = readProjectConfig(root).config;
    } catch (err) {
        for (const f of parseFailure(err, configPath)) {
            add(f);
        }
        // The schema failed, so nothing below can be trusted to have the shape
        // it reads. The file inventory is still worth having: it is what says
        // whether the prompts a broken config points at are even there.
        inventory(root, record);
        return done();
    }

    // -----------------------------------------------------------------------
    // Files the config and the conventions name
    // -----------------------------------------------------------------------

    const hasHouseRules = record(
        HOUSE_RULES,
        'house rules — prepended to every agent prompt',
        'file',
        false,
    );
    if (!hasHouseRules) {
        add({
            severity: 'note',
            code: 'house-rules.missing',
            where: HOUSE_RULES,
            message:
                'no INSTRUCTIONS.md, which is allowed: every agent then runs on its own role ' +
                'prompt alone, with nothing shared between them',
        });
    } else if (empty(join(root, HOUSE_RULES))) {
        add({
            severity: 'warning',
            code: 'house-rules.empty',
            where: HOUSE_RULES,
            message: 'INSTRUCTIONS.md is empty, so it contributes nothing but a prompt section',
            fix: 'write the rules that hold regardless of which agent is answering, or delete it',
        });
    }

    // -----------------------------------------------------------------------
    // Agents
    // -----------------------------------------------------------------------

    const declaredNames = config.agents.map((a) => a.name);
    for (const [duplicate, times] of tally(declaredNames)) {
        if (times > 1) {
            add({
                severity: 'error',
                code: 'agent.duplicate',
                where: `agents.${duplicate}`,
                message: `declared ${times} times; a later entry silently replaces the earlier`,
                fix: 'give each agent its own name',
            });
        }
    }

    entry = entrypoint(config, add);

    // The tools a `zen run` would actually offer, so a selector is checked
    // against the real set rather than a list written down twice.
    const available = availableTools(root, config);

    for (const spec of config.agents) {
        agents.push(checkAgent(root, config, spec, entry, available, record, add));
    }

    // -----------------------------------------------------------------------
    // Skills
    // -----------------------------------------------------------------------

    const catalog = await checkSkills(root, config, available, record, add);
    skillDirs = catalog.dirs;
    skills.push(...catalog.entries);
    bindSkills(config, skills, catalog.names, add);

    // -----------------------------------------------------------------------
    // Models and credentials
    // -----------------------------------------------------------------------

    const resolved = checkModels(root, config, opts.keys, add);
    providers = resolved.providers;
    models.push(...resolved.models);

    checkServices(agents, available, opts.keys, add);

    return done();
}

/**
 * A tool that needs a key of its own is invisible to the model audit, which
 * walks `models:` and finds nothing to say about `web_search`. The project is
 * still valid — the credential is read at call time and a missing one is a
 * failed turn, not a failed load — so this is a warning, and only when the
 * keyring was readable at all.
 */
function checkServices(
    agents: AgentReport[],
    available: AnyTool<unknown>[],
    keys: KeyStore | undefined,
    add: Add,
): void {
    if (!keys) {
        return;
    }
    const byService: Record<Service, Set<string>> = {
        exa: new Set(available.filter((t) => t.group === EXA_GROUP).map((t) => t.name)),
    };
    for (const [service, names] of Object.entries(byService) as [Service, Set<string>][]) {
        const users = agents.filter((a) => a.tools.some((t) => names.has(t)));
        if (users.length === 0) {
            continue;
        }
        const shape = SHAPES[service];
        if (process.env[shape.env] || keys.active(service)) {
            continue;
        }
        add({
            severity: 'warning',
            code: 'service.credential',
            where: users.map((a) => `agents.${a.name}`).join(', '),
            message:
                `uses the ${shape.label} tools, and nothing on this machine holds a ` +
                `${shape.label} key — those tools will refuse every call`,
            fix: `zen key add ${service}, or set $${shape.env}`,
        });
    }
}

// ---------------------------------------------------------------------------
// The config file
// ---------------------------------------------------------------------------

/**
 * Turns a loader failure back into findings.
 *
 * `parseConfig` already renders every schema issue, one indented line each —
 * so the message is a report that has been flattened into a string, and this
 * unflattens it. A yaml syntax error arrives as a single line instead, and
 * carries its own line and column, which is the one thing worth keeping.
 */
function parseFailure(err: unknown, where: string): Finding[] {
    const message = err instanceof Error ? err.message : String(err);
    const lines = message.split('\n');
    const issues = lines
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean);

    if (!issues.length) {
        return [
            {
                severity: 'error',
                code: 'config.unreadable',
                where,
                message: lines[0].replace(/^.*?: /, ''),
                fix: 'fix the syntax — nothing else can be checked until the file parses',
            },
        ];
    }

    return issues.map((issue) => {
        const [key, ...rest] = issue.split(' — ');
        return {
            severity: 'error' as const,
            code: 'config.invalid',
            where: `${where}: ${key}`,
            message: rest.join(' — ') || issue,
            fix: 'see docs/agents-yaml.md for the keys this file accepts',
        };
    });
}

/** The layout, whether or not a config named any of it. */
function inventory(root: string, record: Recorder): void {
    record(HOUSE_RULES, 'house rules — prepended to every agent prompt', 'file', false);
    record(PROMPTS_DIR, 'role prompts, one per agent, by convention', 'directory', false);
    record(SKILLS_DIR, 'skill catalog', 'directory', false);
}

type Recorder = (
    rel: string,
    role: string,
    kind: 'file' | 'directory',
    required: boolean,
    from?: string,
) => boolean;

type Add = (f: Finding) => void;

/** Replicates the loader's `entrypoint`, reporting instead of throwing. */
function entrypoint(config: ProjectConfig, add: Add): string | null {
    const names = config.agents.map((a) => a.name);
    if (config.default) {
        if (!names.includes(config.default)) {
            add({
                severity: 'error',
                code: 'entry.unknown',
                where: 'default',
                message: `unknown agent "${config.default}" (declared: ${names.join(', ')})`,
                fix: 'name one of the declared agents, or drop the key and let the first win',
            });
            return null;
        }
        return config.default;
    }
    const claimed = config.agents.filter((a) => a.default);
    if (claimed.length > 1) {
        add({
            severity: 'error',
            code: 'entry.ambiguous',
            where: 'agents[].default',
            message:
                `${claimed.map((a) => a.name).join(' and ')} both claim \`default: true\`, ` +
                'so which agent a bare `zen run` starts on is undecided',
            fix: 'leave it on one of them, or settle it with a top-level `default:`',
        });
        return null;
    }
    return claimed[0]?.name ?? names[0] ?? null;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function availableTools(root: string, config: ProjectConfig): AnyTool<unknown>[] {
    // Constructed, not started: a pool creates its container on the first
    // command, so naming one here costs nothing and needs no container engine.
    return [
        ...workspaceTools<unknown>({
            root,
            mount: config.sandbox?.workdir ?? SANDBOX_MOUNT,
        }),
        ...sandboxTools<unknown>({ root, key: 'check' }),
        ...exaTools<unknown>(),
    ];
}

function checkAgent(
    root: string,
    config: ProjectConfig,
    spec: AgentConfig,
    entry: string | null,
    available: AnyTool<unknown>[],
    record: Recorder,
    add: Add,
): AgentReport {
    const where = `agents.${spec.name}`;
    const instructions: string[] = [];

    if (existsSync(join(root, HOUSE_RULES))) {
        instructions.push(HOUSE_RULES);
    }

    // The role prompt: named by `system:`, or found by convention. A named one
    // that is not there is an error — the loader says so too. An absent
    // conventional one is not, because a project may keep everything it has to
    // say in INSTRUCTIONS.md.
    if (spec.system) {
        const rel = normalise(root, spec.system);
        const outside = rel === undefined;
        const exists = outside
            ? false
            : record(rel, `role prompt for agent "${spec.name}"`, 'file', true, `${where}.system`);
        if (outside) {
            add({
                severity: 'error',
                code: 'prompt.outside',
                where: `${where}.system`,
                message: `"${spec.system}" resolves outside the project root, which is refused`,
                fix: 'keep prompts inside the project so it stays portable',
            });
        } else if (!exists) {
            add({
                severity: 'error',
                code: 'prompt.missing',
                where: `${where}.system`,
                message: `no such file: ${rel} — the project will not load`,
                fix: `create ${rel}, or point \`system:\` at a file that exists`,
            });
        } else {
            instructions.push(rel);
            if (empty(join(root, rel))) {
                add({
                    severity: 'warning',
                    code: 'prompt.empty',
                    where: `${where}.system`,
                    message: `${rel} is empty, so this agent has no instructions of its own`,
                    fix: `write what this agent is for in ${rel}`,
                });
            }
        }
    } else {
        const rel = join(PROMPTS_DIR, `${spec.name}.md`);
        const exists = record(
            rel,
            `role prompt for agent "${spec.name}" (by convention)`,
            'file',
            false,
        );
        if (exists) {
            instructions.push(rel);
        }
    }

    if (instructions.length === 0) {
        add({
            severity: 'warning',
            code: 'agent.no-instructions',
            where,
            message:
                'this agent has no prompt at all — no INSTRUCTIONS.md and no role file — so ' +
                'it runs on the tool descriptions alone',
            fix: `write ${join(PROMPTS_DIR, `${spec.name}.md`)}, or name one with \`system:\``,
        });
    }

    // Tools
    const selectors = spec.tools ?? [];
    let tools: string[] = [];
    if (selectors.length) {
        let resolved = true;
        try {
            tools = selectTools(available, [...selectors], {
                where: `${where}.tools`,
                hint: 'this CLI provides the workspace and sandbox groups',
            }).map((t) => t.name);
        } catch (err) {
            resolved = false;
            add({
                severity: 'error',
                code: 'tools.unresolved',
                where: `${where}.tools`,
                message:
                    (err instanceof Error
                        ? err.message.replace(`${where}.tools: `, '')
                        : String(err)) + ' — `zen run` will refuse to load the project',
                fix:
                    'correct the name, or drop it. A tool this CLI does not ship can only ' +
                    'reach an agent from a TypeScript host, through ProjectOptions.tools',
            });
        }
        if (resolved && tools.length === 0) {
            add({
                severity: 'warning',
                code: 'tools.empty',
                where: `${where}.tools`,
                message: `${selectors.join(', ')} resolves to no tools at all`,
                fix: 'a selector that subtracts everything it added leaves nothing behind',
            });
        }
    } else {
        add({
            severity: 'note',
            code: 'tools.none',
            where,
            message:
                'no `tools:`, so this agent can only talk, hand off and use whatever a ' +
                'skill unlocks',
        });
    }

    // Hand-offs
    for (const target of spec.handoffs ?? []) {
        if (target === spec.name) {
            add({
                severity: 'error',
                code: 'handoff.self',
                where: `${where}.handoffs`,
                message: 'an agent cannot hand off to itself',
                fix: 'remove the entry',
            });
        } else if (!config.agents.some((a) => a.name === target)) {
            add({
                severity: 'error',
                code: 'handoff.unknown',
                where: `${where}.handoffs`,
                message:
                    `unknown agent "${target}" (declared: ` +
                    `${config.agents.map((a) => a.name).join(', ')})`,
                fix: `declare "${target}" under \`agents:\`, or correct the spelling`,
            });
        }
    }

    // Forks
    const fork = spec.fork === true ? {} : spec.fork === false ? undefined : spec.fork;
    for (const target of fork?.agents ?? []) {
        if (!config.agents.some((a) => a.name === target)) {
            add({
                severity: 'error',
                code: 'fork.unknown',
                where: `${where}.fork.agents`,
                message:
                    `unknown agent "${target}" (declared: ` +
                    `${config.agents.map((a) => a.name).join(', ')})`,
                fix: `declare "${target}" under \`agents:\`, or correct the spelling`,
            });
        }
    }

    if (!spec.description && (config.agents.length > 1 || (spec.handoffs ?? []).length)) {
        add({
            severity: 'warning',
            code: 'agent.no-description',
            where,
            message:
                'no `description:` — it is what a sibling agent’s `transfer_to_' +
                `${spec.name}` +
                '` tool tells the model, so without it a hand-off is a guess',
            fix: 'one line saying what this agent is for',
        });
    }

    const model = spec.model ?? config.model;

    return {
        name: spec.name,
        entry: spec.name === entry,
        ...(spec.description ? { description: spec.description } : {}),
        ...(model ? { model } : {}),
        modelSource: spec.model ? 'agent' : config.model ? 'project' : 'none',
        instructions,
        toolSelectors: [...selectors],
        tools,
        handoffs: [...(spec.handoffs ?? [])],
        ...(spec.skills
            ? {
                  skills: {
                      provider: spec.skills.provider ?? 'project',
                      discovery: spec.skills.discovery,
                      ...(spec.skills.allow ? { allow: [...spec.skills.allow] } : {}),
                      ...(spec.skills.preload ? { preload: [...spec.skills.preload] } : {}),
                  },
              }
            : {}),
        ...(fork ? { fork: { ...fork } } : {}),
        ownSandbox: Boolean(spec.sandbox),
    };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface Catalog {
    dirs: string[];
    entries: SkillReport[];
    names: Set<string>;
}

async function checkSkills(
    root: string,
    config: ProjectConfig,
    available: AnyTool<unknown>[],
    record: Recorder,
    add: Add,
): Promise<Catalog> {
    const declared = config.skills
        ? Array.isArray(config.skills)
            ? config.skills
            : [config.skills]
        : existsSync(join(root, SKILLS_DIR))
          ? [SKILLS_DIR]
          : [];

    const dirs: string[] = [];
    for (const [i, ref] of declared.entries()) {
        const rel = normalise(root, ref);
        if (rel === undefined) {
            add({
                severity: 'error',
                code: 'skills.outside',
                where: `skills[${i}]`,
                message: `"${ref}" resolves outside the project root, which is refused`,
                fix: 'keep the catalog inside the project',
            });
            continue;
        }
        const named = config.skills !== undefined;
        const exists = record(
            rel,
            'skill catalog',
            'directory',
            named,
            named ? `skills[${i}]` : undefined,
        );
        if (!exists) {
            add({
                severity: 'error',
                code: 'skills.missing',
                where: `skills[${i}]`,
                message: `no such directory: ${rel} — the project will not load`,
                fix: `create ${rel}, or drop the \`skills:\` key`,
            });
            continue;
        }
        dirs.push(rel);
    }

    if (!dirs.length) {
        return { dirs, entries: [], names: new Set() };
    }

    const provider = new FileSkillProvider({
        id: 'project',
        dir: dirs.map((d) => join(root, d)),
        tools: available,
    });

    let summaries: SkillSummary[] = [];
    try {
        summaries = await provider.list();
    } catch (err) {
        add({
            severity: 'error',
            code: 'skills.unreadable',
            where: dirs.join(', '),
            message: err instanceof Error ? err.message : String(err),
        });
        return { dirs, entries: [], names: new Set() };
    }

    const entries: SkillReport[] = [];
    for (const summary of summaries) {
        const report: SkillReport = {
            name: summary.name,
            description: summary.description,
            path: '',
            usedBy: [],
        };
        // Loading is what resolves the skill's own `tools:` frontmatter, and
        // an unknown name there fails the *run*, not the load — so it is worth
        // paying a read to find out here.
        try {
            const skill = await provider.load(summary.name);
            report.path = display(root, skill.file ?? '');
            const resources = Object.keys(skill.resources ?? {});
            if (resources.length) {
                report.resources = resources;
            }
            if (skill.tools?.length) {
                report.tools = skill.tools.map((t) => t.name);
            }
        } catch (err) {
            report.path = locate(root, dirs, summary.name) ?? '';
            add({
                severity: 'error',
                code: 'skill.unloadable',
                where: `skill "${summary.name}"`,
                message:
                    (err instanceof Error ? err.message : String(err)) +
                    ' — the skill is indexed, so the model can ask for it, and the turn ' +
                    'that does will fail',
                fix:
                    "correct the skill's `tools:` frontmatter, or provide the tool from a " +
                    'TypeScript host through ProjectOptions.tools',
            });
        }

        if (!REFERABLE.test(summary.name)) {
            add({
                severity: 'warning',
                code: 'skill.unreferable',
                where: `skill "${summary.name}"`,
                message:
                    `"${summary.name}" is not a name \`allow:\` or \`preload:\` accept — ` +
                    'those take lower-case words joined by "-" or "_", so this skill can be ' +
                    'discovered but never pinned',
                fix: `rename the file or folder, or set \`name:\` in its frontmatter`,
            });
        }
        if (!summary.description.trim()) {
            add({
                severity: 'warning',
                code: 'skill.no-description',
                where: `skill "${summary.name}"`,
                message:
                    'no description — the description is the whole of what the model sees ' +
                    'in the skill index, so an empty one means it is never chosen',
                fix: 'add `description:` to the frontmatter, or open the body with one line',
            });
        }
        entries.push(report);
    }

    for (const finding of ignored(root, dirs, new Set(summaries.map((s) => s.name)))) {
        add(finding);
    }

    return { dirs, entries, names: new Set(summaries.map((s) => s.name)) };
}

/**
 * Where a skill's markdown lives, for the report a failed `load` cannot fill
 * in. Best effort: a skill renamed by its frontmatter is not findable by name.
 */
function locate(root: string, dirs: string[], name: string): string | undefined {
    for (const dir of dirs) {
        for (const rel of [join(dir, name, 'SKILL.md'), join(dir, `${name}.md`)]) {
            if (existsSync(join(root, rel))) {
                return rel;
            }
        }
    }
    return undefined;
}

/** Directories in a catalog that hold no `SKILL.md`, and are therefore not skills. */ function ignored(
    root: string,
    dirs: string[],
    known: Set<string>,
): Finding[] {
    const out: Finding[] = [];
    for (const dir of dirs) {
        let items;
        try {
            items = readdirSync(join(root, dir), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const item of items) {
            if (!item.isDirectory() || known.has(item.name)) {
                continue;
            }
            if (existsSync(join(root, dir, item.name, 'SKILL.md'))) {
                // It has one; it is in the catalog under a frontmatter name.
                continue;
            }
            out.push({
                severity: 'warning',
                code: 'skill.no-skill-md',
                where: join(dir, item.name),
                message:
                    'a folder in the skill catalog with no SKILL.md is silently ignored, ' +
                    'so nothing in it will ever reach an agent',
                fix: `add ${join(dir, item.name, 'SKILL.md')}, or move the folder out of the catalog`,
            });
        }
    }
    return out;
}

/** `allow:` / `preload:` against the catalog that was actually read. */
function bindSkills(
    config: ProjectConfig,
    entries: SkillReport[],
    known: Set<string>,
    add: Add,
): void {
    const byName = new Map(entries.map((e) => [e.name, e]));
    const list = [...known].join(', ') || 'none';

    for (const spec of config.agents) {
        if (!spec.skills) {
            continue;
        }
        const where = `agents.${spec.name}.skills`;
        const provider = spec.skills.provider ?? 'project';
        if (provider !== 'project') {
            add({
                severity: 'error',
                code: 'skills.provider-unknown',
                where: `${where}.provider`,
                message:
                    `unknown provider "${provider}" — a project has one, called "project", ` +
                    'built from the `skills:` directories',
                fix: 'drop `provider:` and let it default',
            });
            continue;
        }
        // A contradiction inside the binding itself, so it is worth saying
        // whether or not there is a catalog to check the names against.
        for (const skill of spec.skills.preload ?? []) {
            if (spec.skills.allow && !spec.skills.allow.includes(skill)) {
                add({
                    severity: 'error',
                    code: 'skills.preload-not-allowed',
                    where: `${where}.preload`,
                    message:
                        `"${skill}" is preloaded but not in \`allow\`, so it would be ` +
                        'activated and then hidden from the index',
                    fix: `add "${skill}" to \`allow\`, or stop preloading it`,
                });
            }
        }
        if (!known.size) {
            add({
                severity: 'error',
                code: 'skills.no-catalog',
                where,
                message: 'this agent binds skills, but the project has no catalog to bind to',
                fix: 'add a top-level `skills:` directory, or create agents/skills/<name>/SKILL.md',
            });
            continue;
        }

        for (const [key, names] of [
            ['allow', spec.skills.allow],
            ['preload', spec.skills.preload],
        ] as const) {
            for (const skill of names ?? []) {
                if (!known.has(skill)) {
                    add({
                        severity: 'error',
                        code: `skills.${key}-unknown`,
                        where: `${where}.${key}`,
                        message: `unknown skill "${skill}" (the catalog has: ${list})`,
                        fix: 'the name is the frontmatter `name:`, or the folder name when it has none',
                    });
                }
            }
        }
        if (spec.skills.discovery === 'none' && !spec.skills.preload?.length) {
            add({
                severity: 'warning',
                code: 'skills.unreachable',
                where: `${where}.discovery`,
                message:
                    'discovery is `none` and nothing is preloaded, so this agent is bound ' +
                    'to a catalog it can never see into',
                fix: 'preload what it should always have, or use `index` or `search`',
            });
        }

        for (const skill of known) {
            if (!spec.skills.allow || spec.skills.allow.includes(skill)) {
                byName.get(skill)?.usedBy.push(spec.name);
            }
        }
    }

    for (const entry of entries) {
        if (entry.usedBy.length === 0) {
            add({
                severity: 'note',
                code: 'skill.unused',
                where: `skill "${entry.name}"`,
                message: 'no agent binds a catalog that includes it, so nothing can load it',
                fix: 'add `skills: {}` to an agent, or add it to that agent’s `allow:`',
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function checkModels(
    root: string,
    config: ProjectConfig,
    keys: KeyStore | undefined,
    add: Add,
): { providers: string[]; models: ModelReport[] } {
    let registry;
    try {
        registry = projectRegistry(config);
    } catch (err) {
        add({
            severity: 'error',
            code: 'provider.invalid',
            where: 'providers',
            message: err instanceof Error ? err.message : String(err),
            fix: 'see the `providers:` section of docs/agents-yaml.md',
        });
        return { providers: [], models: [] };
    }

    // Declared under an alias first, so an alias keeps its own name in the
    // report and a `model:` that names one collapses onto it. Mirrors the
    // credential audit, which is what the verdicts below are matched against.
    const declared = new Map<string, { ref: ModelRef; usedBy: string[] }>();
    for (const [alias, spec] of Object.entries(config.models ?? {})) {
        declared.set(alias, { ref: spec as ModelRef, usedBy: [] });
    }
    const use = (ref: string | undefined, by: string): void => {
        if (!ref) {
            return;
        }
        const known = declared.get(ref);
        if (known) {
            known.usedBy.push(by);
            return;
        }
        declared.set(ref, { ref, usedBy: [by] });
    };
    const inherited = config.agents.filter((a) => !a.model).map((a) => a.name);
    if (config.model && inherited.length) {
        for (const agent of inherited) {
            use(config.model, agent);
        }
    } else if (config.model) {
        use(config.model, '(project default)');
    }
    for (const agent of config.agents) {
        use(agent.model, agent.name);
    }

    if (!config.model && inherited.length) {
        add({
            severity: 'warning',
            code: 'model.none',
            where: 'model',
            message:
                `no project-wide \`model:\`, and ${inherited.join(', ')} pin none of their ` +
                'own — those agents cannot run without `zen run --model <ref>`',
            fix: 'set a top-level `model:`',
        });
    }

    // A verdict per model, from the same audit `zen run` prints as a warning.
    const issues = new Map<string, ModelIssue>();
    if (keys) {
        for (const issue of auditModels(root, keys)) {
            issues.set(issue.name, issue);
        }
    }

    const models: ModelReport[] = [];
    for (const [name, { ref, usedBy }] of declared) {
        const report: ModelReport = {
            name,
            credential: keys ? 'present' : 'unknown',
            usedBy,
        };
        try {
            const need = registry.requirement(ref);
            const held = credentialFor(need);
            report.provider = need.provider;
            report.kind = need.kind;
            report.env = held.env;
            if (keys) {
                report.credential = held.present ? 'present' : 'missing';
            }
        } catch (err) {
            add({
                severity: 'error',
                code: 'model.unresolvable',
                where: config.models?.[name]
                    ? `models.${name}`
                    : usedBy.length && usedBy[0] !== '(project default)'
                      ? `agents.${usedBy[0]}.model`
                      : 'model',
                message: err instanceof Error ? err.message : String(err),
                fix: 'a reference is `[provider[/api]:]model`; see docs/agents-yaml.md',
            });
            report.credential = 'unknown';
            models.push(report);
            continue;
        }

        const issue = issues.get(name);
        if (issue) {
            report.credential = issue.reason === 'missing' ? 'missing' : 'rejected';
            report.env = issue.env;
            if (issue.detail) {
                report.detail = issue.detail;
            }
            add({
                severity: 'warning',
                code: `credential.${issue.reason}`,
                where: `model "${name}" (${issue.provider})`,
                message:
                    issue.reason === 'missing'
                        ? `nothing to authenticate with — ${issue.env} is not set, and the ` +
                          'keyring holds no key for this provider'
                        : `the provider rejected this key when it was last checked${
                              issue.detail ? `: ${issue.detail}` : ''
                          }`,
                fix: issue.add ? `zen key add ${issue.add}` : `set ${issue.env} in the environment`,
            });
        }
        models.push(report);
    }

    return { providers: registry.names(), models };
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

function sandboxSummary(
    config: ProjectConfig | undefined,
    agents: AgentReport[],
): Report['sandbox'] {
    const used = agents.some((a) => a.tools.some((t) => SANDBOX_TOOLS.has(t)));
    return {
        image: config?.sandbox?.image ?? null,
        declared: Boolean(config?.sandbox) || agents.some((a) => a.ownSandbox),
        used,
    };
}

const SANDBOX_TOOLS = new Set([
    'run_command',
    'run_command_background',
    'read_command_output',
    'stop_command',
]);

/** A project-relative path, or undefined when the reference escapes the root. */
function normalise(root: string, ref: string): string | undefined {
    const path = resolve(root, ref.replace(/^file:\/\/\//, '/').replace(/^file:/, ''));
    const rel = relative(root, path);
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel;
}

function display(root: string, path: string): string {
    const rel = relative(root, path);
    return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

function empty(path: string): boolean {
    try {
        return statSync(path).size === 0;
    } catch {
        return false;
    }
}

function tally(values: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const v of values) {
        out.set(v, (out.get(v) ?? 0) + 1);
    }
    return out;
}

interface Assembly {
    version: number | null;
    entry: string | null;
    files: FileCheck[];
    agents: AgentReport[];
    skills: SkillReport[];
    skillDirs: string[];
    providers: string[];
    models: ModelReport[];
    sandbox: Report['sandbox'];
    findings: Finding[];
}

function finish(
    root: string,
    name: string | null,
    registered: boolean,
    config: string | null,
    shadowed: string[],
    parts: Assembly,
): Report {
    const counts = {
        errors: parts.findings.filter((f) => f.severity === 'error').length,
        warnings: parts.findings.filter((f) => f.severity === 'warning').length,
        notes: parts.findings.filter((f) => f.severity === 'note').length,
    };
    return {
        ok: counts.errors === 0,
        project: {
            name,
            root,
            registered,
            config,
            shadowed,
            version: parts.version,
            entry: parts.entry,
        },
        files: parts.files,
        agents: parts.agents,
        skills: { dirs: parts.skillDirs, entries: parts.skills },
        providers: parts.providers,
        models: parts.models,
        sandbox: parts.sandbox,
        findings: parts.findings,
        counts,
    };
}
