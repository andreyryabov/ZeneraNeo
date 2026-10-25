import { projectDir, projectFile, type SandboxConfig } from '@zenera/neo';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Building the sandbox image
//
// `image:` names something to pull; `build:` names a Dockerfile to build. The
// library never learns the difference — it is handed a resolved reference and
// runs it — because building is a host concern with a container engine
// attached to it, and that is the line this CLI exists on the other side of.
//
// The tag is a function of what goes into the image, and it has to be: the
// container's name in @zenera/neo hashes `spec.image`, so a tag that stayed put
// while the Dockerfile changed would leave a `persist: true` container running
// last week's filesystem, with nothing anywhere saying so. Hashing the context
// as well as the Dockerfile means an edit to either yields a new tag, a new
// container name, and a build — which is the only honest answer.
// ---------------------------------------------------------------------------

/** Not scoped: a `/` or an `@` is not a legal image tag. */
const TAG = 'localhost/zenera-sandbox';

/**
 * A build context is meant to be small — a Dockerfile and whatever it copies.
 * Hashing a directory someone pointed at their whole home folder would hang
 * before it was wrong, so it stops and says which key to narrow.
 */
const MAX_CONTEXT_FILES = 2_000;

export interface ResolvedBuild {
    /** the image reference to run, and to build under */
    tag: string;
    /** absolute path to the Dockerfile */
    dockerfile: string;
    /** absolute path to the build context */
    context: string;
}

/**
 * What the config's `build:` block means on this machine, or nothing if it has
 * none. Both paths are resolved against the project root and refused if they
 * escape it — a project is data someone else may have written.
 */
export function resolveBuild(root: string, config?: SandboxConfig): ResolvedBuild | undefined {
    if (!config?.build) {
        return undefined;
    }
    const dockerfile = projectFile(root, config.build.dockerfile, 'sandbox.build.dockerfile');
    const context = config.build.context
        ? projectDir(root, config.build.context, 'sandbox.build.context')
        : dirname(dockerfile);
    return { tag: `${TAG}:${digest(dockerfile, context)}`, dockerfile, context };
}

/**
 * The content address of a build: the Dockerfile, then every file the build can
 * see, by path and by content.
 *
 * `.dockerignore` is not read. The engine honours it and we do not, so an
 * ignored file that changes yields a new tag and a build that produces the same
 * image — wasteful, never wrong, and the alternative is reimplementing a match
 * syntax whose disagreements would be silent.
 */
function digest(dockerfile: string, context: string): string {
    const hash = createHash('sha256');
    hash.update(readFileSync(dockerfile));
    for (const rel of walk(context)) {
        // The separator is hashed as posix so the same tree tags the same on
        // any host.
        hash.update(`\0${rel.split(sep).join('/')}\0`);
        hash.update(readFileSync(join(context, rel)));
    }
    return hash.digest('hex').slice(0, 12);
}

/** Every file under `dir`, relative and sorted, so the digest is stable. */
function walk(dir: string): string[] {
    const found: string[] = [];
    const pending = [dir];
    while (pending.length > 0) {
        const at = pending.pop()!;
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) {
                pending.push(path);
            } else if (entry.isFile()) {
                found.push(relative(dir, path));
            }
        }
        if (found.length > MAX_CONTEXT_FILES) {
            throw new Error(
                `sandbox.build.context: ${dir} holds more than ${MAX_CONTEXT_FILES} files — ` +
                    'point `context:` at the directory the build actually copies from',
            );
        }
    }
    return found.sort();
}
