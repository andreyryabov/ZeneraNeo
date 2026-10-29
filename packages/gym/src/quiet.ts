// LanceDB logs through env_logger, read once when its native module first
// loads, and at its default level it narrates routine work — "No existing
// dataset … it will be created" on every index gym builds. This runs before
// anything imports it; an explicit setting in the environment still wins.
process.env.LANCEDB_LOG ??= 'error';

export {};
