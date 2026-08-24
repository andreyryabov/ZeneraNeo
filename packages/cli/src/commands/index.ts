import type { Command } from '../command.ts';
import { fork } from './fork.ts';
import { go, shellInit } from './go.ts';
import { init } from './init.ts';
import { inspect } from './inspect.ts';
import { key } from './key.ts';
import { list } from './list.ts';
import { models } from './models.ts';
import { run } from './run.ts';
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
    go,
    fork,
    key,
    models,
    inspect,
    'shell-init': shellInit,
    version,
};

/** Names that are not listed in help but still work. */
export const ALIASES: Record<string, string> = {
    ls: 'list',
    new: 'init',
    keys: 'key',
    report: 'inspect',
};
