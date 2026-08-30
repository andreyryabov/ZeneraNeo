import type { BannerText } from '../banner.ts';
import type { Command } from '../command.ts';
import { check } from './check.ts';
import { init } from './init.ts';
import { inspect } from './inspect.ts';
import { key } from './key.ts';
import { list } from './list.ts';
import { models } from './models.ts';
import { open } from './open.ts';
import { run } from './run.ts';
import { sandbox } from './sandbox.ts';
import { version } from './version.ts';

/**
 * Insertion order is the order help prints in, and it is deliberate: the four
 * a new user needs first, then the two about credentials and models, then the
 * two that are only ever run on purpose.
 */
export const COMMANDS: Record<string, Command> = {
    init,
    list,
    run,
    open,
    key,
    models,
    check,
    inspect,
    sandbox,
    version,
};

/** Names that are not listed in help but still work. */
export const ALIASES: Record<string, string> = {
    ls: 'list',
    new: 'init',
    keys: 'key',
    validate: 'check',
    doctor: 'check',
    report: 'inspect',
    edit: 'open',
    code: 'open',
    mock: 'faker',
};

// ---------------------------------------------------------------------------
// Commands living in another package
//
// A sibling package adds commands to `zen` rather than a binary of its own, so
// there is one thing to install and one name to remember. This table is what
// `zen` knows about them, and it is data: help is rendered from it without
// resolving anything and without importing anything, which is what keeps
// `zen list` from paying for a mock server's dependencies.
//
// It is a known list rather than a scan of `node_modules` on purpose. These
// packages are released in lockstep by one author, so discovery would buy
// nothing and cost a manifest format, an API version and a public contract.
// ---------------------------------------------------------------------------

export interface External {
    /** the package to import `<pkg>/command` from */
    readonly package: string;
    readonly summary: string;
    readonly usage: string;
    /** what to tell someone who has not got it */
    readonly install: string;
    /** printed instead of the `zen` banner, so the sub-brand shows through */
    readonly banner?: BannerText;
}

export const EXTERNAL: Record<string, External> = {
    faker: {
        package: 'zenera-faker',
        summary: 'A mock API from an openapi/swagger document.',
        usage: 'zen faker <serve|build|cache> [spec...]',
        install: 'npm i -g zenera-faker',
        banner: { head: 'Zenera', accent: 'Faker', subtitle: 'Mock API Server' },
    },
};
