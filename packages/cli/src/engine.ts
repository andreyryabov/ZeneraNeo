import {
    describeIssue,
    openEngine,
    runEngine,
    type Engine,
    type EngineOptions,
} from '@zenera/engine';
import { preflight } from './sandbox.ts';
import { bold, dim, warn } from './term.ts';
import { traceMermaid } from './trace.ts';

// ---------------------------------------------------------------------------
// `@zenera/engine` as the terminal hosts it: warnings in colour on stderr, a
// podman that can be installed on the spot, and a graph beside every run.
// ---------------------------------------------------------------------------

export {
    envelope,
    mounts,
    type Engine,
    type EngineOptions,
    type Mount,
    type RunOutcome,
} from '@zenera/engine';

export function open(opts: EngineOptions): Promise<Engine> {
    return openEngine({
        logger: { warn },
        onIssue: (issue) => warn(describeIssue(issue, { bold, dim })),
        preflight,
        graph: traceMermaid,
        ...opts,
    });
}

export const run = runEngine;
