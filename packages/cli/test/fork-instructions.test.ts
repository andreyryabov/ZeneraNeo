import { FORK_TOOL, frontmatter, toList } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.ts';
import { validateProject, type Finding } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The fork house rules
//
// `agents/fork-instructions.md` is the only place forking is explained to a
// model. It used to be a template literal in `packages/neo`, where renaming the
// tool broke the build; now it is prose in a file, and nothing but this notices
// when the two drift apart.
//
// It is also the first document delivered by condition rather than to everyone,
// so the frontmatter that does the delivering is checked here too: a typo there
// is a document that silently reaches nobody.
// ---------------------------------------------------------------------------

const TEMPLATE = fileURLToPath(
    new URL('../templates/project/agents/fork-instructions.md', import.meta.url),
);

const rules = readFileSync(TEMPLATE, 'utf8');

describe('the condition that delivers the fork house rules', () => {
    it('requires the capability the document is about, and nothing else', () => {
        const { data } = frontmatter(rules);
        expect(toList(data.requires)).toEqual(['fork']);
    });

    it('names the real tool, so a rename does not leave the prose behind', () => {
        expect(rules).toContain(`\`${FORK_TOOL}\``);
    });

    // The condition is a property of the project tree. A copy carried anywhere
    // else keeps the prose and loses the gate, so the prose states it as well.
    it('is restated in the opening section, for a copy that has lost it', () => {
        const opening = rules.slice(0, rules.indexOf('Forking runs work'));
        expect(opening).toContain(FORK_TOOL);
    });
});

describe('the copy a scaffold leaves behind', () => {
    const dirs: string[] = [];

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A scaffolded project whose entry agent can fork. */
    function forking(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });
        const config = join(dir, 'agents.yaml');
        writeFileSync(
            config,
            readFileSync(config, 'utf8').replace('memory: true', 'memory: true\n      fork: true'),
        );
        return dir;
    }

    it('is byte-identical to the template', () => {
        const dir = forking('zen-fork-rules-');
        expect(readFileSync(join(dir, 'agents', 'fork-instructions.md'), 'utf8')).toBe(rules);
    });

    // Nothing else notices the loss: the project still loads and the tool is
    // still granted, so the check has to be the thing that fails the build.
    it('is what stops `zen check` failing on an uninstructed fork', async () => {
        const dir = forking('zen-fork-check-');

        const uninstructed = async (): Promise<Finding | undefined> => {
            const report = await validateProject({ dir });
            return report.findings.find((f) => f.code === 'fork.uninstructed');
        };

        expect(await uninstructed()).toBeUndefined();

        rmSync(join(dir, 'agents', 'fork-instructions.md'));
        expect((await uninstructed())?.severity).toBe('error');

        writeFileSync(join(dir, 'agents', 'fork-instructions.md'), '');
        expect((await uninstructed())?.severity).toBe('error');
    });

    it('reaches the prompt of an agent that forks, and no other', async () => {
        const dir = forking('zen-fork-reach-');
        const report = await validateProject({ dir });
        const forker = report.agents.find((a) => a.name === 'default');
        expect(forker?.instructions).toContain('agents/fork-instructions.md');

        // Ours is copied into every project, so a project that never forks
        // carries an inert copy — which is not a finding.
        const plain = mkdtempSync(join(tmpdir(), 'zen-fork-plain-'));
        dirs.push(plain);
        scaffold({ dir: plain, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });
        const quiet = await validateProject({ dir: plain });
        expect(quiet.agents[0]?.instructions).not.toContain('agents/fork-instructions.md');
        expect(quiet.findings.some((f) => f.code === 'rules.unreached')).toBe(false);
    });
});
