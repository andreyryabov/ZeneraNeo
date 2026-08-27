import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { tool, type AnyTool, type JsonSchema } from '../types.ts';

// ---------------------------------------------------------------------------
// Sandbox tools
//
// A shell, and a boundary around it. The boundary is a container: the agent's
// commands run against an image the project chose, with one host directory
// bind-mounted at `/workspace` and nothing else of the machine in reach. That
// is the whole security story, and it is deliberately the *only* one — the
// command string is handed to `/bin/sh` verbatim, because escaping a shell
// language is a game nobody wins and the container is what makes losing it
// survivable.
//
// The host side is the opposite: every process is spawned with an argv array
// and `shell: false`, and the command text travels on **stdin** rather than in
// an argument, so there is no host shell to inject into and no argv length to
// overflow.
//
// Nothing here knows how to install a container engine or start a virtual
// machine. That is a host concern with a user attached to it, so it lives in
// whatever front end is driving this — the library only reports, clearly, that
// the engine did not answer.
// ---------------------------------------------------------------------------

/** Where the workspace appears inside the container. */
export const SANDBOX_MOUNT = '/workspace';
/** Where background jobs keep their logs. Inside the container, not the host. */
const JOBS = '/tmp/zenera-jobs';
/** One command's output is capped, so a `cat` of a log file cannot fill the context. */
const MAX_OUTPUT = 64 * 1024;
/** ...and a job's log is read in windows of this many lines. */
const MAX_LOG_LINES = 400;
const DEFAULT_IMAGE = 'docker.io/library/python:3.14-slim-bookworm';
/** The image a project gets when it does not name one. */
export const DEFAULT_SANDBOX_IMAGE = DEFAULT_IMAGE;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_PIDS = 1024;
/** How long a container gets to stop itself before it is killed. */
const STOP_GRACE_S = 2;

/** The family name config selects the whole set by: `tools: [sandbox:*]`. */
export const SANDBOX_GROUP = 'sandbox';

/**
 * Everything about a container that an author can state, and that two agents
 * can therefore disagree about. Two specs that are equal share a container;
 * two that differ get one each, because the identity of a container here *is*
 * its configuration.
 */
export interface SandboxSpec {
    /** the base image commands run in */
    image?: string;
    /** fractional cores, as podman's `--cpus` */
    cpus?: number;
    /** MiB, as podman's `--memory` */
    memory?: number;
    network?: SandboxNetwork;
    /** where the workspace is mounted, and the default cwd */
    workdir?: string;
    /** default seconds a single command may take */
    timeout?: number;
    /** uid, name, or `uid:gid`; unset means the image's own user */
    user?: string;
    /** keep the container between sessions rather than removing it */
    persist?: boolean;
    /** environment inside the container — resolved values, never a passthrough */
    env?: Record<string, string>;
}

export type SandboxNetwork = 'bridge' | 'none' | 'host';

export interface SandboxMount {
    /** absolute host path */
    host: string;
    /** absolute path inside the container */
    at: string;
    readOnly?: boolean;
}

export interface SandboxOptions extends SandboxSpec {
    /** host directory mounted at `workdir` */
    root: string;
    /**
     * Stable name for whatever owns this sandbox — a session id, typically.
     * It prefixes the container name, so a crashed process leaves something a
     * human can recognise rather than a hash.
     */
    key: string;
    /** refuse to mount the workspace writable */
    readOnly?: boolean;
    /** extra bind mounts; the host side must already exist */
    mounts?: readonly SandboxMount[];
    /** the container engine binary */
    engine?: string;
    /** how processes are spawned — the seam tests replace */
    exec?: Runner;
}

/**
 * Per-agent overrides on top of one base spec. An agent that overrides nothing
 * shares the base container; an agent that names a different image gets its
 * own, and two agents that name the *same* different image share that.
 */
export interface SandboxPoolOptions extends SandboxOptions {
    agents?: Record<string, SandboxSpec>;
}

/** A failure the caller can do something about — a missing engine, usually. */
export class SandboxError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'SandboxError';
        this.hint = hint;
    }
}

// ---------------------------------------------------------------------------
// Spawning
//
// Small on purpose. `execa` would do this and more, and this package's runtime
// dependencies are two — so it does this and nothing more.
// ---------------------------------------------------------------------------

export interface ProcOptions {
    /** written to stdin, which is then closed */
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** per stream */
    maxBytes?: number;
}

export interface ProcResult {
    code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
}

export type Runner = (
    bin: string,
    args: readonly string[],
    opts?: ProcOptions,
) => Promise<ProcResult>;

export const runProcess: Runner = (bin, args, opts = {}) =>
    new Promise<ProcResult>((settle, fail) => {
        const max = opts.maxBytes ?? MAX_OUTPUT;
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outSize = 0;
        let errSize = 0;
        let truncated = false;
        let timedOut = false;
        let done = false;

        const child = spawn(bin, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

        const keep = (into: Buffer[], size: number, chunk: Buffer): number => {
            const room = max - size;
            if (room <= 0) {
                truncated = true;
                return size;
            }
            if (chunk.length > room) {
                truncated = true;
                into.push(chunk.subarray(0, room));
                return max;
            }
            into.push(chunk);
            return size + chunk.length;
        };

        child.stdout.on('data', (c: Buffer) => (outSize = keep(out, outSize, c)));
        child.stderr.on('data', (c: Buffer) => (errSize = keep(err, errSize, c)));

        // SIGTERM first so a well-behaved process can flush; SIGKILL after, so
        // one that ignores it cannot hold the turn open forever.
        let hard: NodeJS.Timeout | undefined;
        const stop = (): void => {
            child.kill('SIGTERM');
            hard = setTimeout(() => child.kill('SIGKILL'), 2000);
            hard.unref();
        };

        const timer = opts.timeoutMs
            ? setTimeout(
                  () => {
                      timedOut = true;
                      stop();
                  },
                  Math.min(opts.timeoutMs, MAX_TIMEOUT_MS),
              )
            : undefined;

        const onAbort = (): void => stop();
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (fn: () => void): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            clearTimeout(hard);
            opts.signal?.removeEventListener('abort', onAbort);
            fn();
        };

        child.on('error', (e: NodeJS.ErrnoException) => {
            finish(() =>
                fail(
                    e.code === 'ENOENT'
                        ? new SandboxError(`${bin} is not installed, or not on PATH`)
                        : e,
                ),
            );
        });

        child.on('close', (code) => {
            finish(() =>
                settle({
                    code: code ?? (timedOut ? 124 : 1),
                    stdout: Buffer.concat(out).toString('utf8'),
                    stderr: Buffer.concat(err).toString('utf8'),
                    truncated,
                    timedOut,
                }),
            );
        });

        if (opts.input !== undefined) {
            child.stdin.on('error', () => {
                // A command that exits before reading its script closes the
                // pipe under us. That is the command's answer, not an error.
            });
            child.stdin.end(opts.input);
        } else {
            child.stdin.end();
        }
    });

// ---------------------------------------------------------------------------
// One container
// ---------------------------------------------------------------------------

interface Resolved extends Required<Omit<SandboxSpec, 'user'>> {
    user?: string;
    root: string;
    key: string;
    readOnly: boolean;
    mounts: readonly SandboxMount[];
    engine: string;
}

export interface ExecOptions {
    cwd?: string;
    /** seconds; the spec's default otherwise */
    timeout?: number;
    signal?: AbortSignal;
}

export interface ExecResult {
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated?: boolean;
    timed_out?: boolean;
    duration_ms: number;
}

interface Job {
    id: string;
    command: string;
    cwd: string;
    startedAt: number;
}

/**
 * The container, started when it is first needed and not before. A project
 * whose agents never shell out never pays for an image pull, and a session
 * that only ever asks a question never leaves anything behind.
 */
export class Sandbox {
    readonly name: string;
    readonly spec: Resolved;
    readonly #run: Runner;
    readonly #jobs = new Map<string, Job>();
    #ready?: Promise<void>;
    #created = false;

    constructor(opts: SandboxOptions) {
        this.spec = resolveSpec(opts);
        this.#run = opts.exec ?? runProcess;
        this.name = containerName(this.spec);
    }

    /** Whether anything was actually started — `dispose` is free when not. */
    get started(): boolean {
        return this.#created;
    }

    /**
     * Idempotent, and single-flight: several tool calls in one batch all await
     * the same start rather than racing to create the same container.
     */
    start(): Promise<void> {
        this.#ready ??= this.#bring().catch((err: unknown) => {
            // A failed start must not be remembered as a start, or every later
            // call in the session inherits a failure it could have retried.
            this.#ready = undefined;
            throw err;
        });
        return this.#ready;
    }

    async #bring(): Promise<void> {
        const status = await this.#podman([
            'container',
            'inspect',
            this.name,
            '--format',
            '{{.State.Status}}',
        ]);
        if (status.code === 0) {
            const state = status.stdout.trim();
            if (state !== 'running') {
                await this.#must(['start', this.name], `could not start container ${this.name}`);
            }
            this.#created = true;
            return;
        }
        await this.#must(this.#createArgs(), `could not create container ${this.name}`);
        this.#created = true;
    }

    #createArgs(): string[] {
        const s = this.spec;
        const args = ['run', '--detach', '--name', this.name];

        args.push('--label', 'zenera=1', '--label', `zenera.key=${s.key}`);
        args.push('--volume', mount({ host: s.root, at: s.workdir, readOnly: s.readOnly }));
        for (const m of s.mounts) {
            args.push('--volume', mount(m));
        }
        args.push('--workdir', s.workdir);
        args.push('--network', s.network);
        if (s.cpus > 0) {
            args.push('--cpus', String(s.cpus));
        }
        if (s.memory > 0) {
            args.push('--memory', `${s.memory}m`);
        }
        args.push('--pids-limit', String(DEFAULT_PIDS));

        // `no-new-privileges` costs nothing here and closes setuid escalation.
        // Capabilities are deliberately *not* dropped wholesale: installing a
        // package is the ordinary use of this tool, and `--cap-drop=ALL` breaks
        // every package manager there is. The container is the boundary.
        args.push('--security-opt', 'no-new-privileges');

        // Background jobs orphan processes; without an init they accumulate as
        // zombies until the pids limit stops the sandbox dead.
        args.push('--init');
        args.push('--restart', 'no');

        if (s.user) {
            args.push('--user', s.user);
        }
        for (const [k, v] of Object.entries(s.env)) {
            args.push('--env', `${k}=${v}`);
        }
        args.push(s.image, 'sleep', 'infinity');
        return args;
    }

    /**
     * Runs one command and waits for it. The script goes down stdin, so no part
     * of it is ever parsed by a shell on this side of the container.
     */
    async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const timeoutMs = this.#timeout(opts.timeout);
        const startedAt = Date.now();

        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', '--workdir', cwd, this.name, '/bin/sh', '-s'],
            { input: command, timeoutMs, signal: opts.signal },
        );

        return {
            exit_code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated || undefined,
            timed_out: res.timedOut || undefined,
            duration_ms: Date.now() - startedAt,
        };
    }

    /**
     * Starts a command and returns. The wrapper writes the log and the exit
     * code to files the container owns, which is what makes the job readable
     * after the `exec` that started it has long returned.
     */
    async startJob(command: string, opts: ExecOptions = {}): Promise<Job> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const id = jobId();

        // The command reaches the container as a *file*, written by `cat` from
        // stdin. Interpolating it into the launcher script would put user text
        // back into a shell parse, which is the one thing this design avoids.
        const body = await this.#run(
            this.spec.engine,
            [
                'exec',
                '--interactive',
                this.name,
                '/bin/sh',
                '-c',
                `mkdir -p ${JOBS} && cat > ${JOBS}/${id}.sh`,
            ],
            { input: command, timeoutMs: 30_000 },
        );
        if (body.code !== 0) {
            throw new SandboxError(`could not write the job: ${message(body)}`);
        }

        // One logical line, because a newline would end the group command and
        // leave the redirection and the `&` on a statement of their own — the
        // job would then run in the foreground of this `exec`, with its output
        // going to the caller instead of the log.
        //
        // `setsid` puts the job in a session of its own so that stopping it can
        // signal a process group rather than one process; a shell without job
        // control leaves background jobs in its own group, and signalling that
        // would take down the `exec` shell with them. It is not required: where
        // it is missing the job still runs, and stopping falls back to the
        // single pid. The leader writes its own pid, since with `setsid` the
        // launching shell's `$!` is no longer the process to signal.
        const inner =
            `echo $$ > ${JOBS}/${id}.pid; ` +
            `/bin/sh ${JOBS}/${id}.sh; echo $? > ${JOBS}/${id}.exit`;
        const launch = [
            `cd ${quote(cwd)}`,
            `S=; command -v setsid > /dev/null 2>&1 && S=setsid`,
            `$S /bin/sh -c ${quote(inner)} > ${JOBS}/${id}.log 2>&1 < /dev/null &`,
            // The pid file is written by the child, so the launcher waits for
            // it: a read or a stop arriving immediately after must not find
            // the job missing.
            `i=0; while [ ! -s ${JOBS}/${id}.pid ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done`,
        ].join('\n');

        const started = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: launch, timeoutMs: 30_000 },
        );
        if (started.code !== 0) {
            throw new SandboxError(`could not start the job: ${message(started)}`);
        }

        const job: Job = { id, command, cwd, startedAt: Date.now() };
        this.#jobs.set(id, job);
        return job;
    }

    /** A window of a job's log, plus whether it is still going. */
    async readJob(id: string, from = 1): Promise<unknown> {
        const job = this.#jobs.get(id);
        if (!job) {
            return { error: `no such job: ${id}`, hint: 'ids come from run_command_background' };
        }
        await this.start();
        const first = Math.max(1, Math.trunc(from));
        const script = [
            `cd ${JOBS} || exit 0`,
            `printf 'lines=%s\\n' "$(wc -l < ${id}.log 2>/dev/null || echo 0)"`,
            `if [ -f ${id}.exit ]; then printf 'exit=%s\\n' "$(cat ${id}.exit)"; fi`,
            `printf -- '---\\n'`,
            `tail -n +${first} ${id}.log 2>/dev/null | head -n ${MAX_LOG_LINES}`,
        ].join('\n');

        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: script, timeoutMs: 30_000 },
        );
        const [head, ...rest] = res.stdout.split('\n---\n');
        const meta = Object.fromEntries(
            head
                .split('\n')
                .filter(Boolean)
                .map((l) => l.split('=', 2) as [string, string]),
        );
        const output = rest.join('\n---\n');
        const lines = Number(meta.lines ?? 0);
        const shown = output ? output.replace(/\n$/, '').split('\n').length : 0;

        return {
            job_id: id,
            command: job.command,
            running: meta.exit === undefined,
            exit_code: meta.exit === undefined ? undefined : Number(meta.exit),
            duration_ms: Date.now() - job.startedAt,
            start_line: first,
            end_line: first + shown - 1,
            lines,
            truncated: first + shown - 1 < lines || undefined,
            output,
        };
    }

    /** Signals a job's whole process group, so its children go too. */
    async stopJob(id: string): Promise<unknown> {
        if (!this.#jobs.has(id)) {
            return { error: `no such job: ${id}`, hint: 'ids come from run_command_background' };
        }
        await this.start();
        const script = [
            `pid=$(cat ${JOBS}/${id}.pid 2>/dev/null)`,
            `[ -n "$pid" ] || { echo "already gone"; exit 0; }`,
            `kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
            `sleep 1`,
            `kill -KILL -"$pid" 2>/dev/null || true`,
            `echo stopped`,
        ].join('\n');
        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: script, timeoutMs: 30_000 },
        );
        this.#jobs.delete(id);
        return { job_id: id, stopped: res.code === 0 };
    }

    /**
     * Stops a persisted container and removes an ephemeral one. Stopping
     * rather than removing is what makes `persist` mean anything: a stopped
     * container costs disk, a running one costs the machine's whole budget.
     */
    async dispose(): Promise<void> {
        if (!this.#created) {
            return;
        }
        this.#created = false;
        this.#ready = undefined;
        await this.#podman(
            this.spec.persist
                ? ['stop', '--time', String(STOP_GRACE_S), this.name]
                : ['rm', '--force', '--volumes', this.name],
        ).catch(() => undefined);
    }

    /**
     * A path inside the container, contained to the working directory. Purely
     * lexical, and correctly so: this is the container's path space, not this
     * machine's, and there is nothing here to resolve a symlink against.
     */
    inside(path?: string): string {
        const base = this.spec.workdir;
        if (!path) {
            return base;
        }
        if (path.includes('\0')) {
            throw new SandboxError('path contains a null byte');
        }
        const at = posix.resolve(base, path);
        if (at !== base && !at.startsWith(`${base}/`)) {
            throw new SandboxError(`outside ${base}: ${path}`, `paths are relative to ${base}`);
        }
        return at;
    }

    #timeout(seconds?: number): number {
        const wanted = seconds && seconds > 0 ? seconds * 1000 : this.spec.timeout * 1000;
        return Math.min(wanted || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }

    #podman(args: readonly string[]): Promise<ProcResult> {
        return this.#run(this.spec.engine, args, { timeoutMs: 120_000 });
    }

    async #must(args: readonly string[], what: string): Promise<ProcResult> {
        const res = await this.#podman(args);
        if (res.code !== 0) {
            throw new SandboxError(`${what}: ${message(res)}`);
        }
        return res;
    }
}

function mount(m: SandboxMount): string {
    return `${m.host}:${m.at}${m.readOnly ? ':ro' : ''}`;
}

function message(res: ProcResult): string {
    return (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).split('\n')[0];
}

/** Only ever applied to paths this module derived, never to a model's text. */
function quote(s: string): string {
    return `'${s.replaceAll("'", `'\\''`)}'`;
}

function jobId(): string {
    return `job-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 6)}`;
}

function resolveSpec(opts: SandboxOptions): Resolved {
    const workdir = opts.workdir ?? SANDBOX_MOUNT;
    if (!posix.isAbsolute(workdir)) {
        throw new SandboxError(`sandbox workdir must be absolute: ${workdir}`);
    }
    return {
        root: opts.root,
        key: opts.key,
        image: opts.image ?? DEFAULT_IMAGE,
        cpus: opts.cpus ?? 0,
        memory: opts.memory ?? 0,
        network: opts.network ?? 'bridge',
        workdir,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS / 1000,
        user: opts.user,
        persist: opts.persist ?? false,
        env: opts.env ?? {},
        readOnly: opts.readOnly ?? false,
        mounts: opts.mounts ?? [],
        engine: opts.engine ?? 'podman',
    };
}

/**
 * The container's name is a function of its configuration. Change the image
 * and a new container appears rather than an old one quietly persisting with
 * the wrong rootfs — which is the failure mode `persist` would otherwise have.
 */
function containerName(spec: Resolved): string {
    const digest = createHash('sha256')
        .update(
            JSON.stringify([
                spec.root,
                spec.image,
                spec.cpus,
                spec.memory,
                spec.network,
                spec.workdir,
                spec.user ?? null,
                spec.readOnly,
                spec.mounts,
                Object.entries(spec.env).sort(),
            ]),
        )
        .digest('hex')
        .slice(0, 10);
    const key = spec.key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    return `zn-${key || 'session'}-${digest}`;
}

// ---------------------------------------------------------------------------
// One container per configuration
//
// Agents share a sandbox by default, and that is usually what an author means:
// they already share the workspace, and a hand-off is supposed to be
// continuous — whatever the first agent installed should still be there when
// the second one takes over.
//
// It stops being what they mean the moment two agents need different images.
// So the tool object stays single — one name, one schema, one prompt-cache
// prefix — and picks its container from `tc.agent` at call time. Two agents
// that resolve to the same spec still share one container, because the name is
// derived from the spec rather than from who asked.
// ---------------------------------------------------------------------------

export class SandboxPool {
    readonly #base: SandboxOptions;
    readonly #agents: Record<string, SandboxSpec>;
    readonly #boxes = new Map<string, Sandbox>();

    constructor(opts: SandboxPoolOptions) {
        const { agents, ...base } = opts;
        this.#base = base;
        this.#agents = agents ?? {};
    }

    for(agent?: string): Sandbox {
        const override = agent ? this.#agents[agent] : undefined;
        const box = new Sandbox(override ? { ...this.#base, ...override } : this.#base);
        const existing = this.#boxes.get(box.name);
        if (existing) {
            return existing;
        }
        this.#boxes.set(box.name, box);
        return box;
    }

    /** The containers that were actually started, for a status line. */
    get running(): readonly Sandbox[] {
        return [...this.#boxes.values()].filter((b) => b.started);
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.#boxes.values()].map((b) => b.dispose()));
    }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function sandboxTools<TCtx = unknown>(
    opts: SandboxPoolOptions | SandboxPool,
): AnyTool<TCtx>[] {
    const pool = opts instanceof SandboxPool ? opts : new SandboxPool(opts);

    const where: JsonSchema = {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command. Runs under /bin/sh inside the container.',
            },
            cwd: {
                type: 'string',
                description: `Directory to run in, relative to ${SANDBOX_MOUNT}.`,
            },
        },
        required: ['command'],
        additionalProperties: false,
    };

    const runCommand = tool<{ command: string; cwd?: string; timeout?: number }, TCtx>({
        name: 'run_command',
        group: SANDBOX_GROUP,
        description:
            'Runs a shell command in a Linux container and waits for it to finish. The ' +
            `workspace is mounted at ${SANDBOX_MOUNT} and is the working directory, so files you ` +
            'read and write here are the same files the workspace tools see. Everything ' +
            'else is throwaway. Use this for builds, tests, and package installs; use ' +
            'run_command_background for anything that does not end on its own, such as a ' +
            'server or a watcher.',
        parameters: {
            ...where,
            properties: {
                ...where.properties,
                timeout: { type: 'integer', description: 'Seconds to allow before killing it.' },
            },
        },
        execute: (args, tc) =>
            guard(() =>
                pool.for(tc.agent.name).exec(args.command, {
                    cwd: args.cwd,
                    timeout: args.timeout,
                    signal: tc.signal,
                }),
            ),
    });

    const runBackground = tool<{ command: string; cwd?: string }, TCtx>({
        name: 'run_command_background',
        group: SANDBOX_GROUP,
        description:
            'Starts a long-running command and returns immediately with a job id. Output ' +
            'is collected to a log you read with read_command_output; stop it with ' +
            'stop_command. Use this for servers, watchers, and anything you want to keep ' +
            'running while you do something else.',
        parameters: where,
        execute: (args, tc) =>
            guard(async () => {
                const job = await pool.for(tc.agent.name).startJob(args.command, { cwd: args.cwd });
                return {
                    job_id: job.id,
                    started: true,
                    hint: 'read_command_output shows what it has printed so far',
                };
            }),
    });

    const readOutput = tool<{ job_id: string; start_line?: number }, TCtx>({
        name: 'read_command_output',
        group: SANDBOX_GROUP,
        description:
            "Reads a background job's output and says whether it is still running. Pass " +
            'start_line to continue from where the last read ended, which is `end_line + 1`.',
        parameters: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'From run_command_background.' },
                start_line: { type: 'integer', description: 'First log line to return, 1-based.' },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args, tc) =>
            guard(() => pool.for(tc.agent.name).readJob(args.job_id, args.start_line)),
    });

    const stop = tool<{ job_id: string }, TCtx>({
        name: 'stop_command',
        group: SANDBOX_GROUP,
        description: 'Stops a background job and everything it started.',
        parameters: {
            type: 'object',
            properties: { job_id: { type: 'string', description: 'From run_command_background.' } },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args, tc) => guard(() => pool.for(tc.agent.name).stopJob(args.job_id)),
    });

    return [runCommand, runBackground, readOutput, stop];
}

/**
 * A missing engine and a path outside the workspace are things the model can
 * be told about; anything else is a bug and should reach the runner as one.
 */
async function guard(fn: () => Promise<unknown>): Promise<unknown> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof SandboxError) {
            return { error: err.message, hint: err.hint };
        }
        throw err;
    }
}
