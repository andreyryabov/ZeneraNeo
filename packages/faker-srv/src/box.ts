import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SANDBOX_MOUNT, SandboxPool, type Runner, type Sandbox } from 'zenera-neo';

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

export interface BoxOptions {
    /** host directory mounted at /workspace; holds generators/ and io/ */
    root: string;
    image: string;
    /** seconds one generator may take */
    timeout?: number;
    engine?: string;
    exec?: Runner;
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

    constructor(opts: BoxOptions) {
        this.root = opts.root;
        this.#timeout = opts.timeout ?? 30;
        mkdirSync(join(opts.root, GENERATORS), { recursive: true });
        mkdirSync(join(opts.root, IO), { recursive: true });

        this.#pool = new SandboxPool({
            root: opts.root,
            key: 'faker',
            image: opts.image,
            // The one line that keeps model-written code from calling home.
            network: 'none',
            workdir: SANDBOX_MOUNT,
            timeout: this.#timeout,
            // Stopped rather than removed between runs, so the image is not
            // re-resolved on every start.
            persist: true,
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

            const res = await this.sandbox.exec(script, { timeout: this.#timeout });
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
}

/** A path inside the container. Every segment is derived here, never given. */
function inside(...parts: string[]): string {
    return [SANDBOX_MOUNT, ...parts].join('/');
}
