import { platform } from 'node:os';
import { runProcess, SandboxError, type ProcResult } from 'zenera-neo';
import { CliError, confirm, dim, EXIT, isInteractive, note } from './term.ts';

// ---------------------------------------------------------------------------
// The pre-flight lifecycle manager
//
// Podman is native on Linux and a background virtual machine everywhere else,
// which means "is the container engine ready" is four questions, not one: is
// the binary installed, does the machine exist, is it running, and is the
// image on disk. Asked late, each of them surfaces as a different opaque
// failure in the middle of a turn the user is already paying for.
//
// So they are asked first, in order, and every one of them that can be fixed
// without a decision is fixed without asking. Installing a package manager's
// worth of software is the one thing that *is* a decision, so it is the one
// thing that prompts — and in a pipeline, where nobody can answer, it fails
// with the exact command to run instead of hanging.
// ---------------------------------------------------------------------------

export interface PodmanOptions {
    /** the image the project needs on disk before the first run */
    image?: string;
    /** machine size, when one has to be created */
    cpus?: number;
    /** MiB */
    memory?: number;
    engine?: string;
    /** never prompt; `--yes`, `--json`, or no terminal */
    yes?: boolean;
    /** so the tests can watch the sequence without a container engine */
    exec?: typeof runProcess;
}

const DEFAULT_MACHINE_CPUS = 2;
const DEFAULT_MACHINE_MEMORY = 2048;
/** Starting a virtual machine and pulling an image are both slow on purpose. */
const SLOW_MS = 600_000;

interface Machine {
    Name: string;
    Running: boolean;
    Starting: boolean;
    Default?: boolean;
}

export interface PodmanStatus {
    engine: string;
    installed: boolean;
    version?: string;
    /** absent on Linux, where there is no machine to have */
    machine?: { name: string; running: boolean; starting: boolean };
    /** whether `podman info` answered */
    ready: boolean;
    image?: string;
    imagePresent?: boolean;
}

// One process asks once. Several agents starting containers in the same run
// must not each decide to boot a virtual machine.
const settled = new Map<string, Promise<void>>();

export async function ensurePodmanReady(opts: PodmanOptions = {}): Promise<void> {
    const key = `${opts.engine ?? 'podman'}::${opts.image ?? ''}`;
    const pending = settled.get(key);
    if (pending) {
        return pending;
    }
    const attempt = preflight(opts).catch((err: unknown) => {
        // A failure is not a settled answer: the user may well go and install
        // the thing we just complained about and try again in the same TUI.
        settled.delete(key);
        throw err;
    });
    settled.set(key, attempt);
    return attempt;
}

async function preflight(opts: PodmanOptions): Promise<void> {
    const engine = opts.engine ?? 'podman';
    const run = opts.exec ?? runProcess;
    const call = async (args: string[], timeoutMs = 60_000): Promise<ProcResult> => {
        try {
            return await run(engine, args, { timeoutMs });
        } catch (err) {
            if (err instanceof SandboxError) {
                return {
                    code: 127,
                    stdout: '',
                    stderr: err.message,
                    truncated: false,
                    timedOut: false,
                };
            }
            throw err;
        }
    };

    // 1. The binary.
    const version = await call([`--version`], 15_000);
    if (version.code !== 0) {
        await install(engine, opts, run);
    }

    // 2. The virtual machine, on the platforms that have one. Linux runs
    //    containers natively and has no machine to list, so asking would fail
    //    with a message about an unknown command rather than about anything
    //    true.
    if (platform() !== 'linux') {
        await machine(engine, call, opts, run);
    }

    // 3. The socket. Everything above can be true while the engine is wedged.
    const info = await call(['info'], 60_000);
    if (info.code !== 0) {
        throw sandboxError(
            `${engine} is installed but not responding`,
            first(info) || `try: ${engine} machine start`,
        );
    }

    // 4. The image, so the first command is not a five-minute pull that looks
    //    like a hung model.
    if (opts.image) {
        const present = await call(['image', 'exists', opts.image], 30_000);
        if (present.code !== 0) {
            note(dim(`pulling ${opts.image} — this happens once`));
            const pulled = await stream(engine, ['pull', opts.image], run);
            if (pulled.code !== 0) {
                throw sandboxError(
                    `could not pull ${opts.image}`,
                    first(pulled) || 'check the image name and your network',
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

async function install(engine: string, opts: PodmanOptions, run: typeof runProcess): Promise<void> {
    if (engine !== 'podman') {
        throw sandboxError(`${engine} is not installed`, `install ${engine} and try again`);
    }

    const how = instructions();
    if (platform() !== 'darwin' || opts.yes || !isInteractive()) {
        throw sandboxError('podman is not installed', how);
    }

    const brew = await run('brew', ['--version'], { timeoutMs: 15_000 }).catch(() => undefined);
    if (!brew || brew.code !== 0) {
        throw sandboxError('podman is not installed', how);
    }
    if (!(await confirm('Podman is not installed. Install it with Homebrew now?', true))) {
        throw sandboxError('podman is not installed', how);
    }

    note(dim('installing podman — this takes a few minutes'));
    const done = await stream('brew', ['install', 'podman'], run);
    if (done.code !== 0) {
        throw sandboxError('could not install podman', first(done) || how);
    }
}

function instructions(): string {
    switch (platform()) {
        case 'darwin':
            return 'install it with: brew install podman';
        case 'win32':
            return 'install it with: winget install RedHat.Podman';
        default:
            return 'install it with your package manager, e.g. apt install podman';
    }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

async function machine(
    engine: string,
    call: (args: string[], timeoutMs?: number) => Promise<ProcResult>,
    opts: PodmanOptions,
    run: typeof runProcess,
): Promise<void> {
    const listed = await call(['machine', 'list', '--format', 'json'], 30_000);
    if (listed.code !== 0) {
        throw sandboxError(`${engine} machine list failed`, first(listed));
    }
    const machines = parseMachines(listed.stdout);

    if (machines.length === 0) {
        const cpus = String(opts.cpus ?? DEFAULT_MACHINE_CPUS);
        const memory = String(opts.memory ?? DEFAULT_MACHINE_MEMORY);
        note(dim(`initialising the podman machine (${cpus} cpus, ${memory} MiB) — once per host`));
        const created = await stream(
            engine,
            ['machine', 'init', '--cpus', cpus, '--memory', memory],
            run,
        );
        if (created.code !== 0) {
            throw sandboxError('could not create the podman machine', first(created));
        }
    }

    const chosen = machines.find((m) => m.Default) ?? machines[0];
    if (machines.length > 0 && chosen?.Running) {
        return;
    }

    // A machine that is already starting is not a machine to start again;
    // `machine start` on one mid-boot is an error, not a no-op.
    const args = ['machine', 'start'];
    if (chosen && !chosen.Starting) {
        args.push(chosen.Name);
    }
    note(dim('starting the podman machine'));
    const started = await stream(engine, args, run, SLOW_MS);
    if (started.code !== 0 && !/already running/i.test(started.stderr)) {
        throw sandboxError('could not start the podman machine', first(started));
    }
}

function parseMachines(stdout: string): Machine[] {
    const text = stdout.trim();
    if (!text) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as Machine[]) : [];
    } catch {
        // A podman that answers `--format json` with something else is a podman
        // we cannot reason about; treating it as "no machines" would try to
        // create a second one.
        throw sandboxError('could not read `podman machine list --format json`');
    }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** What `zn sandbox status` prints. Changes nothing, and never throws. */
export async function podmanStatus(opts: PodmanOptions = {}): Promise<PodmanStatus> {
    const engine = opts.engine ?? 'podman';
    const run = opts.exec ?? runProcess;
    const call = (args: string[]): Promise<ProcResult | undefined> =>
        run(engine, args, { timeoutMs: 30_000 }).catch(() => undefined);

    const version = await call(['--version']);
    if (!version || version.code !== 0) {
        return { engine, installed: false, ready: false };
    }

    const status: PodmanStatus = {
        engine,
        installed: true,
        version: version.stdout.trim().split(' ').at(-1),
        ready: false,
    };

    if (platform() !== 'linux') {
        const listed = await call(['machine', 'list', '--format', 'json']);
        const machines = listed?.code === 0 ? safeMachines(listed.stdout) : [];
        const chosen = machines.find((m) => m.Default) ?? machines[0];
        if (chosen) {
            status.machine = {
                name: chosen.Name,
                running: Boolean(chosen.Running),
                starting: Boolean(chosen.Starting),
            };
        }
    }

    const info = await call(['info']);
    status.ready = info?.code === 0;

    if (opts.image) {
        status.image = opts.image;
        const exists = status.ready ? await call(['image', 'exists', opts.image]) : undefined;
        status.imagePresent = exists?.code === 0;
    }
    return status;
}

function safeMachines(stdout: string): Machine[] {
    try {
        return parseMachines(stdout);
    } catch {
        return [];
    }
}

export interface OwnedContainer {
    name: string;
    /** podman's own word: `running`, `exited`, `created`, `paused` */
    state: string;
}

/**
 * Containers this CLI created, whatever session they belong to, and whether
 * each is up. `--all` is the point: with `persist: true` a session leaves a
 * *stopped* container behind, and a listing that only showed running ones
 * would say nothing is there while the disk says otherwise.
 */
export async function ownedContainers(
    engine = 'podman',
    exec = runProcess,
): Promise<OwnedContainer[]> {
    const res = await exec(
        engine,
        ['ps', '--all', '--filter', 'label=zenera=1', '--format', '{{.Names}}\t{{.State}}'],
        { timeoutMs: 30_000 },
    ).catch(() => undefined);
    if (!res || res.code !== 0) {
        return [];
    }
    return res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, state] = line.split('\t');
            return { name, state: state?.trim() || 'unknown' };
        });
}

export async function removeContainers(
    names: readonly string[],
    engine = 'podman',
    exec = runProcess,
): Promise<void> {
    if (names.length === 0) {
        return;
    }
    await exec(engine, ['rm', '--force', '--volumes', ...names], { timeoutMs: 120_000 });
}

// ---------------------------------------------------------------------------

/**
 * Long steps print as they go. A five-minute pull with no output is
 * indistinguishable from a hang, and the one thing worse than waiting is not
 * knowing whether you are waiting.
 */
async function stream(
    bin: string,
    args: string[],
    run: typeof runProcess,
    timeoutMs = SLOW_MS,
): Promise<ProcResult> {
    const res = await run(bin, args, { timeoutMs });
    for (const line of res.stderr.split('\n').slice(-3)) {
        if (line.trim()) {
            note(dim(`  ${line.trim()}`));
        }
    }
    return res;
}

function first(res: ProcResult): string {
    return (res.stderr.trim() || res.stdout.trim()).split('\n')[0] ?? '';
}

function sandboxError(message: string, hint?: string): CliError {
    return new CliError(message, EXIT.sandbox, hint);
}
