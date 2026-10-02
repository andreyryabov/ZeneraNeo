// ---------------------------------------------------------------------------
// The meta layer's one door into the rest of the CLI
//
// Everything under `src/meta/` imports the runtime through this file and no
// other, so the layer can leave for a package of its own by turning this into
// a dependency. `test/meta-boundary.test.ts` holds the line.
// ---------------------------------------------------------------------------

export { invokedAs } from '../args.ts';
export { paths, readJson, writeJson } from '../home.ts';
export { envOf, type KeyEntry, type KeyStore, type Provider } from '../keys.ts';
export { PROVIDER_NAMES, splitRef } from '../modelref.ts';
export { duration } from '../narrate.ts';
export { copyTree, MEMORY_RULES, TEMPLATES } from '../scaffold.ts';
export {
    credentialError,
    cut,
    cyan,
    dim,
    note,
    pad,
    plain,
    red,
    styled,
    usageError,
    write,
    yellow,
} from '../term.ts';
export { formatInline, formatMarkdown } from '../tui/markdown.ts';
export { boxWidth } from '../tui/wrap.ts';
