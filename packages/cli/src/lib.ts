// ---------------------------------------------------------------------------
// The library face of the CLI
//
// `zen` is a program, not a library, and everything in `src/` is written that
// way: it prints, it prompts, it carries process exit codes. But the keyring is
// a machine-level thing rather than a command-level one — where credentials
// live, how they are stored 0600, how they reach `process.env` before a run —
// and a second front end on this machine has to agree with `zen` about all
// three or the two disagree about which key is active.
//
// `Command` is here for the other direction: a sibling package implements it
// and `zen` loads it by name, so a new package is a subcommand rather than a
// new binary.
//
// So this file, and only this file, is what another package may import. It is
// deliberately a hand-written list rather than a `export *`: every name here is
// public API of a published package and is bound by its version, which is a
// reason to add to it slowly.
//
// One caveat travels with `term.ts`: `CliError` carries an exit code and the
// writers go to stdout/stderr. That vocabulary belongs to startup. A server
// must not let a `CliError` escape into a request handler.
// ---------------------------------------------------------------------------

export { extract, invokedAs, one, parse, split, type Parsed, type Split } from './args.ts';
export { printBanner, type BannerText } from './banner.ts';
export {
    CATALOG_TTL_MS,
    CURATED,
    fetchCatalog,
    loadCatalog,
    loadCatalogs,
    matches,
    PREFERRED,
    type Catalog,
    type CatalogEntry,
    type CatalogOptions,
    type Filters,
    type Role
} from './catalog.ts';
export type { Command, Context } from './command.ts';
export { assertPrivate, ensureDir, ensureHome, home, paths, readJson, writeJson } from './home.ts';
export {
    assertNotEmpty,
    assertOwner,
    assertUsable,
    describe,
    envNames,
    envOf,
    form,
    isOwner,
    isProvider,
    keyId,
    KeyStore,
    mask,
    OWNERS,
    parseRef,
    PROVIDERS,
    SERVICES,
    SHAPES,
    type CredentialForm,
    type KeyCheck,
    type KeyEntry,
    type KeyOwner,
    type Liveness,
    type Provider,
    type Service
} from './keys.ts';
export { probe, probeAll } from './liveness.ts';
export {
    engineDisk,
    ensurePodmanReady,
    ownedContainers,
    podmanStatus,
    removeContainers,
    type DiskLine,
    type EngineDisk,
    type OwnedContainer,
    type PodmanOptions,
    type PodmanStatus
} from './podman.ts';
export {
    ago,
    bold,
    CliError,
    count,
    credentialError,
    cyan,
    dim,
    EXIT,
    fail,
    green,
    invalidError,
    isInteractive,
    json,
    note,
    pad,
    red,
    table,
    usageError,
    warn,
    write,
    writeAll,
    yellow,
    type ExitCode
} from './term.ts';

