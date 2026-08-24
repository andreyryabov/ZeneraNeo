import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelResponse } from '../src/model.ts';
import { loadProject, parseConfig, projectPath } from '../src/project/index.ts';
import { tool, zeroUsage } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
//
// Projects are written to a temp directory rather than committed, so each test
// can show the one file it is about instead of the reader having to hold a
// shared fixture tree in their head.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) {
        rmSync(r, { recursive: true, force: true });
    }
});

/** Writes a project tree; keys are paths relative to the root. */
function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'zn-project-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
        const path = join(root, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf8');
    }
    return root;
}

const MINIMAL = {
    'AGENTS.md': 'Be terse.',
    'agents.yaml': `
agents:
  - name: solo
    system: agents/prompts/solo.md
`,
    'agents/prompts/solo.md': 'You answer questions.',
};

const lookup = tool({
    name: 'lookup',
    description: 'Looks something up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
});

const quote = tool({
    name: 'quote',
    description: 'Quotes a price.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ eur: 42 }),
});

const SKILL = `---
name: pricing
description: How things are priced.
tools: [quote]
---
Quote with the tool.
`;

const STYLE = `---
name: style
description: How to write.
---
Be brief.
`;

// ---------------------------------------------------------------------------

describe('project layout', () => {
    it('assembles agents, prompts and the shared AGENTS.md', async () => {
        const p = await loadProject(project(MINIMAL));

        expect(p.registry.names()).toEqual(['solo']);
        const instructions = p.registry.get('solo').instructions as { path: string }[];
        expect(instructions.map((i) => i.path.split('/').pop())).toEqual(['AGENTS.md', 'solo.md']);
    });

    it('falls back to agents/prompts/<name>.md when `system` is absent', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: solo\n',
                'agents/prompts/solo.md': 'You answer questions.',
            }),
        );
        const instructions = p.registry.get('solo').instructions as { path: string }[];
        expect(instructions).toHaveLength(1);
        expect(instructions[0].path.endsWith('solo.md')).toBe(true);
    });

    it('shares one AGENTS.md object across every agent', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '  - name: other\n    system: agents/prompts/solo.md\n',
            }),
        );
        const a = (p.registry.get('solo').instructions as unknown[])[0];
        const b = (p.registry.get('other').instructions as unknown[])[0];
        // Same object, so the same bytes hash once and the report shows one
        // document feeding two prompts.
        expect(a).toBe(b);
    });

    it('resolves tool names against ProjectOptions.tools', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '    tools: [lookup]\n',
            }),
            { tools: [lookup] },
        );
        expect(p.registry.get('solo').tools.map((t) => t.name)).toEqual(['lookup']);
    });

    it('builds a skill catalog and binds it', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '    skills:\n      discovery: search\n      preload: [style]\n',
                'agents/skills/pricing/SKILL.md': SKILL,
                'agents/skills/style/SKILL.md': STYLE,
            }),
            { tools: [quote] },
        );

        expect(p.skillProviders.map((s) => s.id)).toEqual(['project']);
        expect(p.registry.get('solo').skills).toEqual({
            provider: 'project',
            discovery: 'search',
            allow: undefined,
            preload: ['style'],
            maxIndexEntries: undefined,
        });
        // The skill's tool resolved from the same registry the agents use.
        expect(p.skillProviders[0].tool('quote')?.name).toBe('quote');
    });
});

describe('entrypoint', () => {
    const two = (extra = '') => `${extra}agents:\n  - name: first\n  - name: second\n`;

    it('prefers an explicit top-level default', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': two('default: second\n'),
                'agents/prompts/first.md': 'a',
                'agents/prompts/second.md': 'b',
            }),
        );
        expect(p.entry).toBe('second');
    });

    it('then an agent that claims it', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: first\n  - name: second\n    default: true\n',
            }),
        );
        expect(p.entry).toBe('second');
    });

    it('then the first declared', async () => {
        const p = await loadProject(project({ 'agents.yaml': two() }));
        expect(p.entry).toBe('first');
    });

    it('rejects two claimants', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'agents:\n  - name: first\n    default: true\n' +
                        '  - name: second\n    default: true\n',
                }),
            ),
        ).rejects.toThrow(/more than one agent claims/);
    });

    it('rejects a default naming nobody', async () => {
        await expect(
            loadProject(project({ 'agents.yaml': two('default: third\n') })),
        ).rejects.toThrow(/unknown agent "third"/);
    });
});

describe('validation', () => {
    it('names the yaml path in a schema error', () => {
        expect(() =>
            parseConfig(
                'agents:\n  - name: solo\n    skills:\n      discovery: auto\n',
                'agents.yaml',
            ),
        ).toThrow(/agents\[0\]\.skills\.discovery/);
    });

    it('rejects an unknown key rather than ignoring it', () => {
        expect(() =>
            parseConfig('agents:\n  - name: solo\n    colour: blue\n', 'agents.yaml'),
        ).toThrow(/agents\[0\] — Unrecognized key: "colour"/);
    });

    it('rejects a malformed name', () => {
        expect(() => parseConfig('agents:\n  - name: Solo Agent\n', 'agents.yaml')).toThrow(
            /lower-case words/,
        );
    });

    it('rejects a hand-off to nobody', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    handoffs: [ghost]\n' }),
            ),
        ).rejects.toThrow(/unknown agent "ghost"/);
    });

    it('rejects a hand-off to self', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    handoffs: [solo]\n' }),
            ),
        ).rejects.toThrow(/cannot hand off to itself/);
    });

    it('rejects an unregistered tool name', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    tools: [missing]\n' }),
            ),
        ).rejects.toThrow(/unknown tool "missing"/);
    });

    it('rejects a preload naming a skill the catalog does not have', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    skills:\n      preload: [ghost]\n',
                    'agents/skills/style/SKILL.md': STYLE,
                }),
            ),
        ).rejects.toThrow(/skills\.preload: unknown skill "ghost"/);
    });

    it('rejects a preload the allow list would hide', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'agents:\n  - name: solo\n    skills:\n' +
                        '      allow: [pricing]\n      preload: [style]\n',
                    'agents/skills/pricing/SKILL.md': SKILL,
                    'agents/skills/style/SKILL.md': STYLE,
                }),
                { tools: [quote] },
            ),
        ).rejects.toThrow(/"style" is not in `allow`/);
    });

    it('rejects skills without a catalog to bind to', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    skills:\n      discovery: index\n',
                }),
            ),
        ).rejects.toThrow(/no skill provider/);
    });

    it('reports a missing configuration file', async () => {
        await expect(loadProject(project({ 'AGENTS.md': 'x' }))).rejects.toThrow(
            /no project configuration/,
        );
    });
});

describe('model configuration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // Every provider in this suite is an OpenAI one; `ProviderClient` is a
    // union across three SDKs, so the assertions say which.
    const openai = (client: unknown): { apiKey?: string; baseURL?: string } =>
        client as { apiKey?: string; baseURL?: string };

    const YAML = `
providers:
  house:
    apiKey: \${ZN_HOUSE_KEY}
  house-eu:
    apiKey: \${ZN_EU_KEY}
    baseURL: https://eu.example/v1
models:
  fast: house:gpt-4o-mini
  local:
    provider: house-eu
    api: responses
    model: o3
provider: house
model: fast
agents:
  - name: solo
  - name: eu
    model: local
`;

    it('declares providers, resolves aliases, and shares one client per name', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }));

        expect(p.registry.get('solo').model?.id).toBe('gpt-4o-mini');
        expect(p.registry.get('eu').model?.id).toBe('o3');
        expect(openai(p.models.client('house')).apiKey).toBe('sk-house');
        expect(openai(p.models.client('house-eu')).apiKey).toBe('sk-eu');
        expect(openai(p.models.client('house-eu')).baseURL).toBe('https://eu.example/v1');
        expect(p.models.defaultProvider).toBe('house');
    });

    it('hands two agents naming one alias the same model object', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(
            project({ 'agents.yaml': `${YAML}  - name: twin\n    model: fast\n` }),
        );
        expect(p.registry.get('twin').model).toBe(p.registry.get('solo').model);
    });

    it('never touches a provider no agent reaches for', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_UNUSED_KEY', '');

        // `gemini` has no resolvable key, and loading does not care: nothing
        // points at it. A project may name a vendor this deployment lacks.
        const p = await loadProject(
            project({
                'agents.yaml':
                    'providers:\n  house:\n    apiKey: ${ZN_HOUSE_KEY}\n' +
                    '  gemini:\n    kind: google\n    apiKey: ${ZN_UNUSED_KEY}\n' +
                    'provider: house\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            }),
        );
        expect(p.registry.get('solo').model?.id).toBe('gpt-4o');
        expect(() => p.models.client('gemini')).toThrow('${ZN_UNUSED_KEY} is not set');
    });

    it('lets ProjectOptions override a declared provider', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }), {
            providers: { house: { apiKey: 'sk-from-host' } },
        });
        expect(openai(p.models.client('house')).apiKey).toBe('sk-from-host');
    });

    it('lets ProjectOptions.models win over the config alias', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }), {
            models: { fast: 'house:gpt-5-nano' },
        });
        expect(p.registry.get('solo').model?.id).toBe('gpt-5-nano');
    });

    it('names the agent whose model ref does not resolve', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    model: ghost:gpt-4o\n',
                }),
            ),
        ).rejects.toThrow(/agents\.solo\.model: unknown provider "ghost"/);
    });

    it('catches a bad provider name in an alias nothing uses', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'models:\n  spare:\n    provider: ghost\n    model: gpt-4o\n' +
                        'agents:\n  - name: solo\n',
                }),
            ),
        ).rejects.toThrow(/models\.spare\.provider: unknown provider "ghost"/);
    });

    it('rejects a default provider that is not declared', async () => {
        await expect(
            loadProject(project({ 'agents.yaml': 'provider: ghost\nagents:\n  - name: solo\n' })),
        ).rejects.toThrow(/default provider "ghost" is not declared/);
    });
});

describe('path safety', () => {
    it('refuses a reference that escapes the root', () => {
        expect(() => projectPath('/srv/app', '../../etc/passwd', 'agents.solo.system')).toThrow(
            /resolves outside the project root/,
        );
    });

    it('refuses an absolute reference outside the root', () => {
        expect(() => projectPath('/srv/app', '/etc/passwd', 'agents.solo.system')).toThrow(
            /resolves outside the project root/,
        );
    });

    it('allows a plain relative reference', () => {
        expect(projectPath('/srv/app', 'agents/prompts/solo.md', 'x')).toBe(
            '/srv/app/agents/prompts/solo.md',
        );
    });

    it('refuses a file:// url naming a host', () => {
        expect(() => projectPath('/srv/app', 'file://elsewhere/x.md', 'x')).toThrow(/names a host/);
    });

    it('stops a `system` reference from reading outside the project', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    system: ../../secrets.md\n',
                }),
            ),
        ).rejects.toThrow(/resolves outside the project root/);
    });
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

class Fixed implements Model {
    readonly id = 'fixed';
    calls = 0;

    generate(): Promise<ModelResponse> {
        this.calls++;
        return Promise.resolve({
            text: 'answered',
            toolCalls: [],
            stopReason: 'stop',
            usage: zeroUsage(),
        });
    }
}

describe('running a project', () => {
    it('runs the entry agent end to end', async () => {
        const p = await loadProject(project(MINIMAL));
        const res = await p.runner({ model: new Fixed(), stream: false }).run(p.entry, 'hello');

        expect(res.output).toBe('answered');
        expect(res.state.agentName).toBe('solo');
    });

    it('memoizes the shared runner but not an overridden one', async () => {
        const p = await loadProject(project(MINIMAL));
        expect(p.runner()).toBe(p.runner());
        expect(p.runner({ stream: false })).not.toBe(p.runner());
    });

    it('keeps two chats on one project independent', async () => {
        const p = await loadProject(project(MINIMAL));
        const runner = p.runner({ model: new Fixed(), stream: false });

        const [a, b] = await Promise.all([
            runner.run(p.entry, 'first').final(),
            runner.run(p.entry, 'second').final(),
        ]);

        expect(a.state.runId).not.toBe(b.state.runId);
        // Neither transcript picked up the other's input.
        expect(a.state.trajectory.length).toBe(b.state.trajectory.length);
    });
});
