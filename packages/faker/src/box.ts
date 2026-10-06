import {
    SANDBOX_MOUNT,
    SandboxError,
    SandboxPool,
    pidAlive,
    runProcess,
    type ExecResult,
    type Runner,
    type Sandbox,
} from '@zenera/neo';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Where generators run
//
// One container for the whole process, offline, with the faker's own directory
// bind-mounted at /workspace. That single mount is what makes the file contract
// work in both directions: the host writes `input.json` and reads
// `output.json`, the generator sees the same two paths from inside, and neither
// side has to serialise anything through a pipe.
//
// Nothing the model wrote ever reaches an argument on this side. The generator
// is invoked by a script built here out of paths derived here, and the script
// itself travels on stdin — the same rule the sandbox tools follow.
// ---------------------------------------------------------------------------

export const GENERATORS = 'generators';
const IO = 'io';
const ENTRY = 'gen.py';

/** Every faker container's name starts with this; `cache clear` relies on it. */
export const CONTAINER_PREFIX = 'zn-faker-';
/** `zn-faker-<pid>-<digest>`; a name without the pid predates per-process containers. */
const OWNED_BY = /^zn-faker-(\d+)-[0-9a-f]+$/;

/** Pause before the one retry of an engine failure, long enough for a concurrent rm to finish. */
const ENGINE_RETRY_MS = 300;

export interface BoxOptions {
    /** host directory mounted at /workspace; holds generators/ and io/ */
    root: string;
    image: string;
    /** seconds one generator may take */
    timeout?: number;
    engine?: string;
    exec?: Runner;
    /** the process the container belongs to; defaults to this one */
    owner?: number;
}

/**
 * The container engine could not run the generator at all. Nothing is known
 * about the generator from this, so it must never be fed back to a model as a
 * fault in the code: rewriting a working file cannot bring a container back.
 */
export class SandboxUnavailable extends Error {
    readonly hint: string;
    readonly container: string;
    readonly stderr?: string;

    constructor(message: string, opts: { hint: string; container: string; stderr?: string }) {
        super(message);
        this.name = 'SandboxUnavailable';
        this.hint = opts.hint;
        this.container = opts.container;
        this.stderr = opts.stderr;
    }
}

export interface Outcome {
    ok: boolean;
    /** parsed `output.json`, when the run produced one */
    value?: unknown;
    /** what went wrong, in the words the build loop feeds back to the model */
    fault?: string;
    stderr?: string;
    durationMs: number;
}

export class Box {
    readonly root: string;
    readonly #pool: SandboxPool;
    readonly #timeout: number;
    readonly #engine: string;
    readonly #exec: Runner;
    readonly #owner: number;

    constructor(opts: BoxOptions) {
        this.root = opts.root;
        this.#timeout = opts.timeout ?? 30;
        this.#engine = opts.engine ?? 'podman';
        this.#exec = opts.exec ?? runProcess;
        this.#owner = opts.owner ?? process.pid;
        mkdirSync(join(opts.root, GENERATORS), { recursive: true });
        mkdirSync(join(opts.root, IO), { recursive: true });

        this.#pool = new SandboxPool({
            root: opts.root,
            // One container per process. The name is otherwise a pure function
            // of the configuration, so two servers on the same --cache shared
            // one container, and each start (`fresh`) or exit (`dispose`)
            // removed it from under the other: `exited 125, no such container`.
            key: `faker-${this.#owner}`,
            image: opts.image,
            // The one line that keeps model-written code from calling home.
            network: 'none',
            workdir: SANDBOX_MOUNT,
            timeout: this.#timeout,
            // Deliberately NOT persisted, unlike `zen`'s sandbox. A container's
            // name is a hash of its configuration, which includes the host
            // path but not the directory behind it — so a cache directory that
            // is deleted and recreated (`zen faker cache clear`, or any rm -rf)
            // gets a stopped container reattached whose bind mount still points
            // at the old inode. Everything written here is then invisible
            // inside, and every generator fails with "can't open file".
            // `zen` persists to keep `pip install`s; the libraries here are
            // baked into the image, so there is nothing to keep.
            persist: false,
            readOnly: false,
            // Deliberately empty: the keyring is in this process's environment
            // and none of it belongs in the container.
            env: {},
            engine: opts.engine,
            exec: opts.exec,
        });
    }

    get sandbox(): Sandbox {
        return this.#pool.for();
    }

    /**
     * Removes this process's container if a previous owner of the pid left one,
     * and every faker container whose owning process is gone. Belt to
     * `persist: false`'s braces: a hard kill never runs `dispose`, and the
     * leftover is exactly the stale-mount trap above. A container whose owner
     * is alive is another server's, and is never touched.
     */
    async fresh(): Promise<void> {
        const listed = await this.#exec(
            this.#engine,
            ['ps', '--all', '--filter', `name=^${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
            { timeoutMs: 60_000 },
        ).catch(() => undefined);
        const orphans = (listed?.code === 0 ? listed.stdout.split('\n') : [])
            .map((n) => n.trim())
            .filter((name) => {
                const pid = Number(OWNED_BY.exec(name)?.[1]);
                return Number.isInteger(pid) && pid !== this.#owner && !pidAlive(pid);
            });
        await this.#exec(
            this.#engine,
            ['rm', '--force', '--volumes', this.sandbox.name, ...orphans],
            { timeoutMs: 60_000 },
        ).catch(() => undefined);
    }

    /** Host path of a generator's source file. */
    sourceOf(key: string): string {
        return join(this.root, GENERATORS, key, ENTRY);
    }

    async write(key: string, source: string): Promise<void> {
        mkdirSync(join(this.root, GENERATORS, key), { recursive: true });
        await writeFile(this.sourceOf(key), source, 'utf8');
    }

    /**
     * One generator, one input, one output. The io directory is removed
     * afterwards whatever happened — a mock server left alone for a week must
     * not fill a disk with request envelopes.
     *
     * Throws `SandboxUnavailable` when the engine, not the generator, failed.
     */
    async run(key: string, input: unknown): Promise<Outcome> {
        const id = randomUUID();
        const dir = join(this.root, IO, id);
        mkdirSync(dir, { recursive: true });
        const started = Date.now();

        try {
            await writeFile(join(dir, 'input.json'), JSON.stringify(input), 'utf8');

            const script = [
                `exec python3 ${inside(GENERATORS, key, ENTRY)}`,
                inside(IO, id, 'input.json'),
                inside(IO, id, 'output.json'),
            ].join(' ');

            let res = await this.#exec1(script);
            if (engineFault(res)) {
                // `exec` already brought a vanished container back once; a
                // second fault is usually a concurrent rm still settling.
                await new Promise((settle) => setTimeout(settle, ENGINE_RETRY_MS));
                res = await this.#exec1(script);
            }
            const fault = engineFault(res);
            if (fault) {
                throw this.#unavailable(fault, res.stderr.trim() || res.stdout.trim());
            }
            const stderr = res.stderr.trim();

            if (res.timed_out) {
                return {
                    ok: false,
                    fault: `took longer than ${this.#timeout}s`,
                    stderr,
                    durationMs: Date.now() - started,
                };
            }
            if (res.exit_code !== 0) {
                return {
                    ok: false,
                    fault: `exited ${res.exit_code}`,
                    stderr: stderr || res.stdout.trim(),
                    durationMs: Date.now() - started,
                };
            }

            let text: string;
            try {
                text = await readFile(join(dir, 'output.json'), 'utf8');
            } catch {
                return {
                    ok: false,
                    fault: 'wrote no output file',
                    stderr,
                    durationMs: Date.now() - started,
                };
            }
            try {
                return {
                    ok: true,
                    value: JSON.parse(text),
                    stderr,
                    durationMs: Date.now() - started,
                };
            } catch (err) {
                return {
                    ok: false,
                    fault: `output.json is not JSON: ${err instanceof Error ? err.message : String(err)}`,
                    stderr,
                    durationMs: Date.now() - started,
                };
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    async dispose(): Promise<void> {
        await this.#pool.dispose();
    }

    async #exec1(script: string): Promise<ExecResult> {
        try {
            return await this.sandbox.exec(script, { timeout: this.#timeout });
        } catch (err) {
            if (err instanceof SandboxError) {
                throw new SandboxUnavailable(
                    `${this.#engine} could not run the generator: ${err.message}`,
                    {
                        hint:
                            err.hint ??
                            `check \`${this.#engine} ps -a --filter name=${CONTAINER_PREFIX}\``,
                        container: this.sandbox.name,
                    },
                );
            }
            throw err;
        }
    }

    #unavailable(fault: EngineFault, stderr: string): SandboxUnavailable {
        const name = this.sandbox.name;
        const first = stderr.split('\n')[0] ?? '';
        const hint =
            fault === 'missing-file'
                ? `the generator is on the host but not inside ${name}, so its bind mount is stale ` +
                  `(the --cache directory was deleted and recreated while the server ran). ` +
                  `Restart \`zen faker serve\`.`
                : fault === 'no-python'
                  ? `the image has no python3. Rebuild it: \`zen faker serve --rebuild …\`, or pass a working --image.`
                  : `${name} was removed or stopped while this server was using it, twice in a row. ` +
                    `Usual causes: \`zen sandbox clean\` or \`zen faker cache clear\` run meanwhile, ` +
                    `a ${this.#engine} machine restart, or an older \`zen faker\` (before per-process ` +
                    `containers) started on the same --cache. Check \`${this.#engine} ps -a --filter ` +
                    `name=${CONTAINER_PREFIX}\` and \`${this.#engine} machine list\`; the next request ` +
                    `recreates the container.`;
        return new SandboxUnavailable(
            `${this.#engine} could not run the generator in ${name} — ${first || fault} ` +
                `(an engine failure, not a fault in the generator; nothing was regenerated)`,
            { hint, container: name, stderr: stderr || undefined },
        );
    }
}

type EngineFault = 'engine' | 'missing-file' | 'no-python';

/**
 * A failure of the container rather than of the code in it. 125 is podman's
 * own exit code for "could not exec at all"; the other two are our command
 * line failing before a line of the generator ran.
 */
function engineFault(res: ExecResult): EngineFault | undefined {
    if (res.timed_out) {
        return undefined;
    }
    if (res.exit_code === 125) {
        return 'engine';
    }
    if (res.exit_code === 2 && /can't open file '\/workspace\/generators\//.test(res.stderr)) {
        return 'missing-file';
    }
    if (res.exit_code === 127 && /python3: (not found|No such file)/.test(res.stderr)) {
        return 'no-python';
    }
    return undefined;
}

/** A path inside the container. Every segment is derived here, never given. */
function inside(...parts: string[]): string {
    return [SANDBOX_MOUNT, ...parts].join('/');
}
