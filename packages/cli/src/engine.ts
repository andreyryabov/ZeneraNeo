import {
    AgentRunner,
    FilePayloadStore,
    SANDBOX_MOUNT,
    SKILLS_MOUNT,
    Workspace,
    assertState,
    buildRunReport,
    exaTools,
    lastText,
    loadProject,
    memoryDir,
    readProjectConfig,
    renderReportHtml,
    sandboxTools,
    turns,
    workspaceTools,
    type AgentEvent,
    type AgentProject,
    type AgentState,
    type Input,
    type RunResult,
} from '@zenera/neo';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditModels, describeIssue } from './audit.ts';
import { loadProjectEnv } from './env.ts';
import { readJson, writeJson } from './home.ts';
import { KeyStore, assertUsable } from './keys.ts';
import { projectMounts, type Project } from './projects.ts';
import { buildSandbox, preflight, teardown, usesSandbox, type SandboxSetup } from './sandbox.ts';
import {
    acquire,
    createRun,
    readSessionMeta,
    writeRunMeta,
    writeSessionMeta,
    type Held,
    type RunPaths,
    type SessionPaths,
} from './session.ts';
import { CliError, EXIT, invalidError, warn } from './term.ts';

// ---------------------------------------------------------------------------
// The engine
//
// Everything `zen run` does that is not presentation. The TUI and the one-shot
// path call exactly this, in the same order, which is what makes the TUI a view
// rather than a mode: nothing is recorded only when someone is watching.
// ---------------------------------------------------------------------------

export interface EngineOptions {
    project: Project;
    session: SessionPaths;
    readOnly?: boolean;
    /** default model override — `--model` */
    model?: string;
    /** sandbox image override — `--image` */
    image?: string;
    /** another directory to remember into — `--memory` */
    memoryDir?: string;
    /** recall only: nothing is written and several runs may share one graph */
    memoryReadOnly?: boolean;
    /** whether credentials reach the sandbox — `--no-keys` sets this false */
    keys?: boolean;
    /** answer the sandbox's install question without asking — `--yes` */
    yes?: boolean;
    /**
     * Hold back the warnings about the project rather than the run. A batch
     * opens one project a hundred times, and a hundred copies of the same
     * complaint is a worse report than one.
     */
    quiet?: boolean;
}

export interface Engine {
    project: AgentProject;
    runner: AgentRunner;
    name: string;
    workspace: string;
    /** where the workspace appears inside the container */
    workspaceMount: string;
    /** whether the agent was denied every writing tool */
    readOnly: boolean;
    session: SessionPaths;
    /** the graph this session remembers into, when any agent has one */
    memory?: string;
    /** the session's accumulated state, when it has one */
    state?: AgentState;
    /** the containers this session may start; present whether or not it does */
    sandbox: SandboxSetup;
    lock: Held;
    close(): Promise<void>;
}

/**
 * Wires the library to a session directory. Every store is file-backed and
 * rooted inside `.data/`, so a session is self-contained: copy the directory
 * and the whole conversation, its memory and its blobs travel with it.
 */
export async function open(opts: EngineOptions): Promise<Engine> {
    // Before the keyring, so the project's own file wins over the machine's
    // keys, and before the load, so `${VAR}` in agents.yaml can name anything
    // in it. The real environment still beats both.
    const env = loadProjectEnv(opts.project.dir);

    const keys = await KeyStore.open();
    keys.materialize();
    assertUsable(keys);

    // Said before the load, because the load stops at the first model it cannot
    // build: one SDK's words about one model, when the useful answer is which
    // of the project's models are reachable and which are not.
    for (const issue of auditModels(opts.project.dir, keys)) {
        if (!opts.quiet) {
            warn(describeIssue(issue));
        }
    }

    const meta = await readSessionMeta(opts.session);
    const workspace = resolve(meta.workspace);

    const payloads = new FilePayloadStore({ dir: opts.session.blobs, id: 'file' });

    // The config is read before the project is loaded because the sandbox is
    // configured by it and the tools have to exist before selectors can be
    // resolved against them. They are always registered, whether or not anyone
    // selects them: a project that names `sandbox:*` against an empty tool list
    // fails to load with "unknown tool", which would be a lie.
    let sandbox: SandboxSetup;
    let project: AgentProject;
    let files: Workspace;
    let memory: string | undefined;
    try {
        const { root, config } = readProjectConfig(opts.project.dir);
        // Naming a directory declares the graph, but it cannot bind anyone to
        // it — so say when the run is pointed at a memory no agent will touch.
        if (opts.memoryDir && !opts.quiet && !config.agents.some((a) => a.memory)) {
            warn('--memory names a directory no agent uses — none has `memory: true`');
        }
        memory = memoryDir(root, config, opts.memoryDir);
        // Assets and the skill catalog are mounted for both, under one name.
        const mounts = projectMounts(root, config, opts.memoryDir);
        sandbox = buildSandbox({
            config,
            root,
            session: opts.session,
            workspace,
            readOnly: opts.readOnly,
            image: opts.image,
            keys: opts.keys,
            env: env?.names,
            mounts,
        });
        const workspaceOptions = {
            root: workspace,
            readOnly: opts.readOnly,
            mount: sandbox.spec.workdir ?? SANDBOX_MOUNT,
            mounts,
        };
        // The same view the file tools have, so a path the agent just wrote
        // resolves the same way when it asks memory to keep a copy.
        files = new Workspace(workspaceOptions);
        project = await loadProject(opts.project.dir, {
            tools: [
                // Both groups are pointed at one directory, so both are told the
                // one name for it: whatever `run_command` prints a path as,
                // `read_file` accepts.
                ...workspaceTools(workspaceOptions),
                ...sandboxTools(sandbox.pool),
                // Registered whether or not a key exists: the credential is
                // read when a tool is called, so a project that names `exa:*`
                // loads on a machine that cannot yet search, and says so on the
                // turn that tried.
                ...exaTools(),
            ],
            skillsAt: SKILLS_MOUNT,
            memoryDir: opts.memoryDir,
            memoryReadOnly: opts.memoryReadOnly,
            payloads,
            resolveFile: (path: string) => files.within(path),
        });
    } catch (err) {
        throw invalidError(
            err instanceof Error ? err.message : String(err),
            `while loading ${opts.project.dir}`,
        );
    }

    // Asked here rather than at the first `run_command`, so a host with no
    // container engine costs an error instead of a round trip. Nothing is
    // started: the container itself waits until something actually runs.
    if (usesSandbox(project)) {
        await preflight(sandbox, opts.yes);
    }

    // `recordRequests` is what makes the report show the exact bytes sent
    // rather than a reconstruction. It costs state size, and a CLI run is
    // written to disk once and inspected by a human — exactly the case the
    // library leaves it off for by default.
    //
    // `--model` becomes the runner's fallback rather than an alias, so it
    // overrides the config's `model:` without touching agents that pinned one.
    const runner = project.runner({
        recordRequests: true,
        model: opts.model ? project.models.model(opts.model) : undefined,
    });

    const state = await loadState(opts.session);
    const lock = acquire(opts.session);

    return {
        project,
        runner,
        name: opts.project.name,
        workspace,
        workspaceMount: sandbox.spec.workdir ?? SANDBOX_MOUNT,
        readOnly: Boolean(opts.readOnly),
        session: opts.session,
        memory,
        state,
        sandbox,
        lock,
        close: async () => {
            await teardown(sandbox.pool);
            project.close();
            lock.release();
        },
    };
}

async function loadState(session: SessionPaths): Promise<AgentState | undefined> {
    if (!existsSync(session.state)) {
        return undefined;
    }
    const json = await readJson<unknown>(session.state, undefined);
    try {
        return assertState(json);
    } catch {
        throw invalidError(
            `${session.state} is not a usable run state`,
            'start a fresh session with --new',
        );
    }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface Mount {
    /** the directory on this machine */
    host: string;
    /** where it appears to the agent */
    at: string;
    readOnly: boolean;
}

/** Every tree the agent can see, the workspace first. */
export function mounts(engine: Engine): Mount[] {
    return [
        { host: engine.workspace, at: engine.workspaceMount, readOnly: engine.readOnly },
        ...engine.sandbox.mounts.map((m) => ({
            host: m.host,
            at: m.at,
            readOnly: Boolean(m.readOnly),
        })),
    ];
}

export interface RunOutcome {
    run: RunPaths;
    result: RunResult<string>;
    text: string;
    durationMs: number;
    /** where the report landed, when one could be rendered */
    report?: string;
}

/**
 * What one finished run looks like to a program: `zen run --json` prints it,
 * and a batch writes one beside every item. The same function on purpose — a
 * batch whose items were shaped differently would make every consumer of a
 * single run a special case.
 */
export function envelope(engine: Engine, outcome: RunOutcome): Record<string, unknown> {
    return {
        session: { id: engine.session.id, dir: engine.session.dir },
        run: {
            id: outcome.run.id,
            dir: outcome.run.dir,
            input: outcome.run.input,
            output: outcome.run.output,
            state: outcome.run.state,
            meta: outcome.run.meta,
            ...(outcome.report ? { report: outcome.report } : {}),
        },
        mounts: mounts(engine),
        agent: outcome.result.agent,
        stopReason: outcome.result.stopReason,
        durationMs: outcome.durationMs,
        usage: outcome.result.usage,
        output: outcome.text,
    };
}

/**
 * One turn. The session's state decides whether this starts a run or continues
 * one — which is the whole of what `resume` used to be, and why it is not a
 * command.
 */
export async function run(
    engine: Engine,
    input: Input,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
): Promise<RunOutcome> {
    const startedAt = new Date();
    const stream = engine.state
        ? engine.runner.send<string>(engine.state, input, { signal })
        : engine.runner.run<string>(engine.project.entry, input, { signal });

    if (onEvent) {
        for await (const event of stream) {
            onEvent(event);
        }
    }
    const result = await stream.final();
    const durationMs = Date.now() - startedAt.getTime();

    engine.state = result.state;
    const outcome = await record(engine, input, result, startedAt, durationMs);
    if (result.stopReason === 'failed') {
        throw new CliError(
            result.state.error ?? 'the run failed',
            EXIT.failed,
            `report: ${outcome.run.report}`,
        );
    }
    return outcome;
}

/**
 * Everything a finished turn leaves behind. The session state is written first:
 * if the report fails to render, the conversation is still resumable, which is
 * the ordering that loses least.
 */
async function record(
    engine: Engine,
    input: Input,
    result: RunResult<string>,
    startedAt: Date,
    durationMs: number,
): Promise<RunOutcome> {
    const { session } = engine;
    writeJson(session.state, result.state, 0o644);

    const meta = await readSessionMeta(session);
    meta.lastRunAt = new Date().toISOString();
    meta.title ??= title(input);
    writeSessionMeta(session, meta);

    const run = createRun(session);
    const text = await lastText(result.state, engine.runner.services.payloads);

    await writeFile(run.input, `${asText(input)}\n`, 'utf8');
    await writeFile(run.output, `${text}\n`, 'utf8');
    writeJson(run.state, result.state, 0o644);

    let report: string | undefined;
    try {
        const built = await buildRunReport(result.state, engine.runner.services.payloads, {
            title: `${engine.name} · ${run.id}`,
            architecture: await engine.runner.describe(),
            memory: engine.runner.services.memory?.store,
        });
        await writeFile(run.report, renderReportHtml(built), 'utf8');
        report = run.report;
    } catch {
        // A report is a convenience. Losing it must not lose the run.
    }

    writeRunMeta(run, {
        version: 1,
        id: run.id,
        session: session.id,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs,
        agent: result.agent,
        stopReason: result.stopReason,
        turns: turns(result.state),
        usage: result.usage,
        workspace: engine.workspace,
        memory: engine.memory,
        error: result.state.error,
    });

    return { run, result, text, durationMs, report };
}

function asText(input: Input): string {
    if (typeof input === 'string') {
        return input;
    }
    return input
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            if ('text' in part && typeof part.text === 'string') {
                return part.text;
            }
            // A media shorthand is a single key; naming it is more useful in a
            // transcript than printing the url or the base64 behind it.
            return `[${Object.keys(part)[0] ?? 'part'}]`;
        })
        .join('\n');
}

/** A session's label in a picker: the first thing that was ever asked of it. */
function title(input: Input): string {
    const text = asText(input).replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
