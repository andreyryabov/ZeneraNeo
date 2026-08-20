import type { Skill, SkillProvider } from '../skills.ts';
import { FileSkillProvider, type FileSkillProviderOptions } from './file.ts';
import { StaticSkillProvider } from './static.ts';

// ---------------------------------------------------------------------------
// Skill provider factory
// ---------------------------------------------------------------------------

export interface StaticSkillProviderSpec {
    kind: 'static';
    id?: string;
    skills: Skill[];
}

export interface FileSkillProviderSpec extends FileSkillProviderOptions {
    kind: 'file';
}

/** Grows a member per source (`http`, `git`, …). */
export type SkillProviderSpec = StaticSkillProviderSpec | FileSkillProviderSpec;

/** Shorthand: `file:./skills`. The static provider needs its skills inline. */
export type SkillProviderRef = SkillProviderSpec | string;

export function createSkillProvider(ref: SkillProviderRef): SkillProvider {
    const spec = typeof ref === 'string' ? parseRef(ref) : ref;
    switch (spec.kind) {
        case 'static':
            return new StaticSkillProvider(spec.skills, spec.id);
        case 'file':
            return new FileSkillProvider(spec);
        default:
            throw new TypeError(
                `unknown skill provider kind: ${(spec as SkillProviderSpec).kind as string}`,
            );
    }
}

function parseRef(ref: string): SkillProviderSpec {
    const colon = ref.indexOf(':');
    const scheme = colon < 0 ? ref : ref.slice(0, colon);
    const rest = colon < 0 ? '' : ref.slice(colon + 1);
    if (scheme === 'file') {
        if (!rest) {
            throw new TypeError(`missing directory in "${ref}" (expected file:<dir>)`);
        }
        return { kind: 'file', dir: rest };
    }
    throw new TypeError(`unknown skill provider ref: "${ref}"`);
}
