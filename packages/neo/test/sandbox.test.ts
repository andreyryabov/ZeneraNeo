import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/project/config.ts';
import {
    MOUNT,
    Sandbox,
    SANDBOX_GROUP,
    SandboxPool,
    sandboxTools,
    type ProcOptions,
    type ProcResult,
    type Runner,
} from '../src/tools/sandbox.ts';
import { selectTools, type ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Nothing here starts a container. Every process goes through the injected
// runner, so what is under test is the *decision*: which arguments podman is
// handed, what reaches the shell, and what never does.
// ---------------------------------------------------------------------------

interface Call {
    bin: string;
    args: string[];
    opts?: ProcOptions;
}

interface Fake {
    run: Runner;
    calls: Call[];
    /** queued answers, matched in order; anything unanswered succeeds silently */
    reply(match: string, res: Partial<ProcResult>): void;
}

function fake(): Fake {
    const calls: Call[] = [];
    const replies: { match: string; res: Partial<ProcResult> }[] = [];

    const run: Runner = (bin, args, opts) => {
        calls.push({ bin, args: [...args], opts });
        const line = args.join(' ');
        const i = replies.findIndex((r) => line.includes(r.match));
        const res = i >= 0 ? replies.splice(i, 1)[0].res : {};
        return Promise.resolve({
            code: 0,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: false,
            ...res,
        });
    };

    return { run, calls, reply: (match, res) => void replies.push({ match, res }) };
}

/** The container does not exist yet, so `container inspect` has to fail. */
function fresh(): Fake {
    const f = fake();
    f.reply('container inspect', { code: 1, stderr: 'no such container' });
    return f;
}

function box(f: Fake, over: Record<string, unknown> = {}): Sandbox {
    return new Sandbox({ root: '/host/ws', key: '20260827-120000-abcd', exec: f.run, ...over });
}

const find = (f: Fake, verb: string): Call | undefined => f.calls.find((c) => c.args[0] === verb);

describe('starting a container', () => {
    it('mounts the workspace and nothing else of the host', async () => {
        const f = fresh();
        await box(f).start();

        const create = find(f, 'run');
        expect(create).toBeDefined();
        expect(create?.args).toContain('--detach');
        expect(create?.args).toContain(`/host/ws:${MOUNT}`);
        expect(create?.args.at(-3)).toBe('docker.io/library/debian:bookworm-slim');
        expect(create?.args.slice(-2)).toEqual(['sleep', 'infinity']);
    });

    it('passes cpus and memory through as podman limits', async () => {
        const f = fresh();
        await box(f, { cpus: 4, memory: 3072 }).start();

        const create = find(f, 'run');
        expect(create?.args).toContain('--cpus');
        expect(create?.args[create.args.indexOf('--cpus') + 1]).toBe('4');
        expect(create?.args[create.args.indexOf('--memory') + 1]).toBe('3072m');
    });

    it('omits limits that were never configured', async () => {
        const f = fresh();
        await box(f).start();
        expect(find(f, 'run')?.args).not.toContain('--cpus');
        expect(find(f, 'run')?.args).not.toContain('--memory');
    });

    it('hardens without breaking package managers', async () => {
        const f = fresh();
        await box(f).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('no-new-privileges');
        expect(args).toContain('--init');
        expect(args).toContain('--pids-limit');
        // Dropping every capability would break `apt install`, which is the
        // ordinary use of this tool. The container is the boundary.
        expect(args).not.toContain('--cap-drop=ALL');
        expect(args).not.toContain('--privileged');
    });

    it('mounts the workspace read-only when the run is', async () => {
        const f = fresh();
        await box(f, { readOnly: true }).start();
        expect(find(f, 'run')?.args).toContain(`/host/ws:${MOUNT}:ro`);
    });

    it('forwards only the environment it was given', async () => {
        const f = fresh();
        await box(f, { env: { HOME: '/home/agent', HTTPS_PROXY: 'http://p:3128' } }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('HOME=/home/agent');
        expect(args).toContain('HTTPS_PROXY=http://p:3128');
    });

    it('reuses a container that already exists, and starts a stopped one', async () => {
        const f = fake();
        f.reply('container inspect', { code: 0, stdout: 'exited\n' });
        await box(f).start();

        expect(find(f, 'run')).toBeUndefined();
        expect(find(f, 'start')).toBeDefined();
    });

    it('does nothing at all to one that is already running', async () => {
        const f = fake();
        f.reply('container inspect', { code: 0, stdout: 'running\n' });
        await box(f).start();

        expect(find(f, 'run')).toBeUndefined();
        expect(find(f, 'start')).toBeUndefined();
    });

    it('starts once, however many calls arrive together', async () => {
        const f = fresh();
        const b = box(f);
        await Promise.all([b.exec('a'), b.exec('b'), b.exec('c')]);
        expect(f.calls.filter((c) => c.args[0] === 'run')).toHaveLength(1);
    });

    it('does not remember a failed start', async () => {
        const f = fake();
        f.reply('container inspect', { code: 1 });
        f.reply('run', { code: 125, stderr: 'no such image' });
        const b = box(f);

        await expect(b.exec('ls')).rejects.toThrow(/no such image/);
        expect(b.started).toBe(false);
    });
});

describe('the container name', () => {
    it('is a function of the configuration, so a changed image is a new container', () => {
        const f = fake();
        const a = box(f).name;
        const same = box(f).name;
        const other = box(f, { image: 'docker.io/library/python:3.13-slim' }).name;

        expect(a).toBe(same);
        expect(a).not.toBe(other);
        expect(a.startsWith('zn-20260827-120000-abcd-')).toBe(true);
    });

    it('survives a key that is not a legal container name', () => {
        const f = fake();
        expect(box(f, { key: 'Session Name/../x' }).name).toMatch(/^zn-[a-z0-9-]+$/);
    });
});

describe('running a command', () => {
    it('sends the command down stdin, never as an argument', async () => {
        const f = fresh();
        await box(f).exec('rm -rf / # $(whoami) `id`');

        const exec = find(f, 'exec');
        expect(exec?.args).toContain('--interactive');
        expect(exec?.args.slice(-2)).toEqual(['/bin/sh', '-s']);
        expect(exec?.opts?.input).toBe('rm -rf / # $(whoami) `id`');
        // The point: no part of the model's text is ever in argv.
        expect(exec?.args.join(' ')).not.toContain('whoami');
    });

    it('runs in the workspace by default and in a subdirectory on request', async () => {
        const f = fresh();
        const b = box(f);
        await b.exec('ls');
        const first = find(f, 'exec');
        expect(first?.args[first.args.indexOf('--workdir') + 1]).toBe(MOUNT);

        await b.exec('ls', { cwd: 'packages/cli' });
        const last = f.calls.at(-1);
        expect(last?.args[last.args.indexOf('--workdir') + 1]).toBe(`${MOUNT}/packages/cli`);
    });

    it('refuses a working directory outside the workspace', () => {
        const b = box(fake());
        expect(() => b.inside('../../etc')).toThrow(/outside/);
        expect(() => b.inside('/etc')).toThrow(/outside/);
        expect(() => b.inside('a/../../..')).toThrow(/outside/);
        expect(() => b.inside('ok\u0000')).toThrow(/null byte/);
    });

    it('reports the exit code rather than throwing on one', async () => {
        const f = fresh();
        f.reply('/bin/sh -s', { code: 2, stderr: 'nope\n' });
        const res = await box(f).exec('false');

        expect(res.exit_code).toBe(2);
        expect(res.stderr).toBe('nope\n');
        expect(res.timed_out).toBeUndefined();
    });

    it('takes its default timeout from the spec and lets a call override it', async () => {
        const f = fresh();
        const b = box(f, { timeout: 5 });
        await b.exec('sleep 1');
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(5000);

        await b.exec('sleep 1', { timeout: 30 });
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(30_000);
    });

    it('caps a timeout nobody should be allowed to ask for', async () => {
        const f = fresh();
        await box(f).exec('sleep 1', { timeout: 999_999 });
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(3_600_000);
    });
});

describe('background jobs', () => {
    it('writes the command to a file rather than into the launcher', async () => {
        const f = fresh();
        const job = await box(f).startJob('npm run dev', { cwd: 'app' });

        expect(job.id).toMatch(/^job-[0-9a-f]{6}$/);

        const write = f.calls.find((c) => c.opts?.input === 'npm run dev');
        expect(write).toBeDefined();
        expect(write?.args.at(-1)).toContain(`cat > /tmp/zenera-jobs/${job.id}.sh`);

        const launch = f.calls.at(-1);
        expect(launch?.opts?.input).toContain(`/bin/sh /tmp/zenera-jobs/${job.id}.sh`);
        expect(launch?.opts?.input).toContain(`cd '${MOUNT}/app'`);
        expect(launch?.opts?.input).not.toContain('npm run dev');
    });

    it('reads the log back with the running flag and a resumable window', async () => {
        const f = fresh();
        const b = box(f);
        const job = await b.startJob('npm run dev');

        f.reply('/bin/sh -s', { stdout: 'lines=3\n---\nfirst\nsecond\nthird\n' });
        const running = (await b.readJob(job.id)) as Record<string, unknown>;

        expect(running.running).toBe(true);
        expect(running.exit_code).toBeUndefined();
        expect(running.output).toBe('first\nsecond\nthird\n');
        expect(running.start_line).toBe(1);
        expect(running.end_line).toBe(3);

        f.reply('/bin/sh -s', { stdout: 'lines=4\nexit=0\n---\nfourth\n' });
        const done = (await b.readJob(job.id, 4)) as Record<string, unknown>;
        expect(done.running).toBe(false);
        expect(done.exit_code).toBe(0);
        expect(done.start_line).toBe(4);
    });

    it('will not read or stop a job it never started', async () => {
        const f = fresh();
        const b = box(f);
        expect(await b.readJob('job-000000')).toMatchObject({ error: expect.any(String) });
        expect(await b.stopJob('job-000000')).toMatchObject({ error: expect.any(String) });
    });

    it('signals the whole process group', async () => {
        const f = fresh();
        const b = box(f);
        const job = await b.startJob('npm run dev');
        await b.stopJob(job.id);

        expect(f.calls.at(-1)?.opts?.input).toContain('kill -TERM -"$pid"');
    });
});

describe('disposal', () => {
    it('removes an ephemeral container', async () => {
        const f = fresh();
        const b = box(f);
        await b.start();
        await b.dispose();
        expect(find(f, 'rm')?.args).toContain(b.name);
    });

    it('only stops one that asked to persist', async () => {
        const f = fresh();
        const b = box(f, { persist: true });
        await b.start();
        await b.dispose();
        expect(find(f, 'rm')).toBeUndefined();
        expect(find(f, 'stop')?.args).toContain(b.name);
    });

    it('is free when nothing was ever started', async () => {
        const f = fake();
        await box(f).dispose();
        expect(f.calls).toHaveLength(0);
    });
});

describe('one container per configuration', () => {
    const pool = (agents: Record<string, Record<string, unknown>>): SandboxPool =>
        new SandboxPool({
            root: '/host/ws',
            key: 'session',
            exec: fake().run,
            image: 'base',
            agents,
        });

    it('shares one container between agents that agree', () => {
        const p = pool({});
        expect(p.for('alpha')).toBe(p.for('beta'));
    });

    it('gives an agent that names its own image its own container', () => {
        const p = pool({ analyst: { image: 'python' } });
        expect(p.for('analyst').name).not.toBe(p.for('writer').name);
    });

    it('still shares between two agents that made the same choice', () => {
        const p = pool({ a: { image: 'python' }, b: { image: 'python' } });
        expect(p.for('a')).toBe(p.for('b'));
    });
});

describe('the tools', () => {
    const tools = sandboxTools({ root: '/host/ws', key: 'session', exec: fake().run });

    it('are one selectable family', () => {
        expect(tools.map((t) => t.name)).toEqual([
            'run_command',
            'run_command_background',
            'read_command_output',
            'stop_command',
        ]);
        expect(tools.every((t) => t.group === SANDBOX_GROUP)).toBe(true);
        expect(
            selectTools(tools, ['sandbox:*', '-stop_command'], { where: 'test' }).map(
                (t) => t.name,
            ),
        ).toEqual(['run_command', 'run_command_background', 'read_command_output']);
    });

    /**
     * The container is chosen from `tc.agent` at call time rather than captured
     * when the tool was built, so one tool object — one schema, one cached
     * prompt prefix — still serves agents that need different images.
     */
    it('pick their container from the calling agent', async () => {
        const f = fresh();
        const pool = new SandboxPool({
            root: '/host/ws',
            key: 'session',
            exec: f.run,
            image: 'base',
            agents: { analyst: { image: 'python' } },
        });
        const [runCommand] = sandboxTools(pool);
        const tc = { agent: { name: 'analyst' } } as ToolContext;

        await runCommand.execute({ command: 'python -V' }, tc);
        expect(find(f, 'run')?.args).toContain('python');
    });

    it('turn a path escape into something the model can act on', async () => {
        const [runCommand] = sandboxTools({ root: '/host/ws', key: 's', exec: fake().run });
        const out = await runCommand.execute({ command: 'ls', cwd: '../../etc' }, {
            agent: { name: 'a' },
        } as ToolContext);
        expect(out).toMatchObject({ error: expect.stringContaining('outside') });
    });
});

describe('the sandbox block in agents.yaml', () => {
    const config = (body: string): unknown =>
        parseConfig(`version: 1\n${body}\nagents:\n  - name: a\n`, 'agents.yaml');

    it('takes the resource knobs', () => {
        expect(config('sandbox:\n  image: python:3.13\n  cpus: 2\n  memory: 4096')).toMatchObject({
            sandbox: { image: 'python:3.13', cpus: 2, memory: 4096 },
        });
    });

    it('refuses a key it does not honour', () => {
        expect(() => config('sandbox:\n  privileged: true')).toThrow(/privileged/);
    });

    /**
     * The CLI materialises its keyring into the environment before loading a
     * project, so an unguarded passthrough would hand every model key to
     * whatever the agent decided to run.
     */
    it('refuses to forward anything that reads like a credential', () => {
        expect(() => config('sandbox:\n  env: [OPENAI_API_KEY]')).toThrow(/credential/);
        expect(() => config('sandbox:\n  env: [GH_TOKEN]')).toThrow(/credential/);
        expect(config('sandbox:\n  env: [HTTPS_PROXY]')).toMatchObject({
            sandbox: { env: ['HTTPS_PROXY'] },
        });
    });

    it('lets one agent differ from the rest', () => {
        const parsed = parseConfig(
            'version: 1\nsandbox:\n  image: base\nagents:\n' +
                '  - name: a\n    sandbox:\n      image: python\n',
            'agents.yaml',
        );
        expect(parsed.agents[0].sandbox?.image).toBe('python');
    });
});
