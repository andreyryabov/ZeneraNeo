import { projectSchema } from '@zenera/neo';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { scaffold } from '../src/scaffold.ts';

// ---------------------------------------------------------------------------
// The editor's schema for agents.yaml
//
// `templates/editor/.vscode/agents.schema.json` is written by hand, because the
// value of it is the prose: zod holds none — the descriptions in `config.ts` are
// JSDoc — and `agents[].memory` is a `z.preprocess`, whose `memory: true`
// shorthand no converter keeps. What a hand-written file cannot do is notice a
// key being added to `projectSchema`, so that is what these tests are: the two
// are compared key for key and enum for enum, and a schema that has fallen
// behind the runtime fails here rather than in somebody's editor, silently.
//
// `io: 'output'` is what reads through the `memory:` preprocess — the transform
// is on the input side, so the input view of it is unrepresentable and the
// output view is the binding itself. Nothing here looks at which keys are
// required, which is the only thing the choice otherwise decides.
// ---------------------------------------------------------------------------

const SCHEMA = fileURLToPath(
    new URL('../templates/editor/.vscode/agents.schema.json', import.meta.url),
);
const SETTINGS = fileURLToPath(
    new URL('../templates/editor/.vscode/settings.json', import.meta.url),
);

type Node = Record<string, unknown>;

function read(path: string): Node {
    return JSON.parse(readFileSync(path, 'utf8')) as Node;
}

/** Follows a local `$ref`, whether the schema keeps its definitions under `$defs` or `definitions`. */
function deref(node: unknown, root: Node): Node | undefined {
    if (!node || typeof node !== 'object') {
        return undefined;
    }
    const ref = (node as Node).$ref;
    if (typeof ref !== 'string') {
        return node as Node;
    }
    if (!ref.startsWith('#/')) {
        throw new Error(`only local refs are resolvable here: ${ref}`);
    }
    let found: unknown = root;
    for (const segment of ref.slice(2).split('/')) {
        found = (found as Node | undefined)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (found === undefined) {
        throw new Error(`unresolvable ref: ${ref}`);
    }
    return deref(found, root);
}

interface Shape {
    /** every property path, as `agents[].skills.discovery` */
    paths: Set<string>;
    /** the enum members at each path that has any */
    enums: Map<string, string>;
}

/**
 * Every property name reachable from the root, by path. Union branches collapse
 * onto the path that holds them — `models.<name>` is one key whether the value
 * is a string or the object form — so the two schemas are comparable without
 * either having to arrange its unions the way the other does.
 */
function shapeOf(root: Node): Shape {
    const paths = new Set<string>();
    const enums = new Map<string, string>();

    const walk = (schema: unknown, path: string, depth: number): void => {
        if (depth > 20) {
            throw new Error(`schema nests deeper than 20 at ${path} — is it recursive?`);
        }
        const node = deref(schema, root);
        if (!node) {
            return;
        }
        if (Array.isArray(node.enum)) {
            enums.set(path, [...(node.enum as string[])].sort().join(' | '));
        }
        for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
            for (const branch of (node[key] as unknown[]) ?? []) {
                walk(branch, path, depth + 1);
            }
        }
        for (const [key, value] of Object.entries((node.properties as Node) ?? {})) {
            const child = path ? `${path}.${key}` : key;
            paths.add(child);
            walk(value, child, depth + 1);
        }
        if (node.additionalProperties && typeof node.additionalProperties === 'object') {
            walk(node.additionalProperties, `${path}.<name>`, depth + 1);
        }
        if (node.items) {
            walk(node.items, `${path}[]`, depth + 1);
        }
    };

    walk(root, '', 0);
    return { paths, enums };
}

describe('the agents.yaml schema the editor is given', () => {
    const shipped = read(SCHEMA);
    const runtime = z.toJSONSchema(projectSchema, { io: 'output' }) as Node;

    it('describes every key the runtime accepts, and no others', () => {
        const ours = shapeOf(shipped).paths;
        const theirs = shapeOf(runtime).paths;

        // A walker that reached nothing would agree with anything.
        expect(theirs.size).toBeGreaterThan(50);

        // Reported as two lists rather than as a set comparison: what a failure
        // has to say is which key was added to config.ts and never documented.
        expect({
            missing: [...theirs].filter((p) => !ours.has(p)).sort(),
            invented: [...ours].filter((p) => !theirs.has(p)).sort(),
        }).toEqual({ missing: [], invented: [] });
    });

    it('offers the same choices as the runtime wherever it constrains one', () => {
        const ours = shapeOf(shipped).enums;
        const theirs = shapeOf(runtime).enums;

        // Only the paths the runtime constrains: a `default:` this file adds for
        // the editor's benefit is not a disagreement, a wrong member list is.
        const wrong = [...theirs].filter(([path, members]) => ours.get(path) !== members);
        expect(
            Object.fromEntries(wrong.map(([p, m]) => [p, { runtime: m, schema: ours.get(p) }])),
        ).toEqual({});
    });

    it('resolves every reference it makes', () => {
        const refs: string[] = [];
        const collect = (node: unknown): void => {
            if (!node || typeof node !== 'object') {
                return;
            }
            for (const [key, value] of Object.entries(node as Node)) {
                if (key === '$ref' && typeof value === 'string') {
                    refs.push(value);
                }
                collect(value);
            }
        };
        collect(shipped);

        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
            expect(() => deref({ $ref: ref }, shipped), ref).not.toThrow();
        }
    });

    /**
     * The schema is inert without the association, and the association is inert
     * without the extension — so all three travel together, and the four names
     * are the ones the loader looks for.
     */
    it('is bound to the four names a project may keep its config under', () => {
        const settings = read(SETTINGS) as { 'yaml.schemas': Record<string, string[]> };

        expect(settings['yaml.schemas']).toEqual({
            './.vscode/agents.schema.json': [
                'agents.yaml',
                'agents.yml',
                'agents/agents.yaml',
                'agents/agents.yml',
            ],
        });
    });

    it('lands in a scaffolded project, with the extension that reads it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-schema-'));
        afterAll(() => rmSync(dir, { recursive: true, force: true }));
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });

        expect(written.editor).toContain(join('.vscode', 'agents.schema.json'));
        expect(written.editor).toContain(join('.vscode', 'extensions.json'));
        // Ours, not the project's: it describes this version of the format.
        expect(written.files).not.toContain(join('.vscode', 'agents.schema.json'));
        expect(read(join(dir, '.vscode', 'agents.schema.json'))).toEqual(shipped);
    });
});
