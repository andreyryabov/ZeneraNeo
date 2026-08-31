# Releasing

Four packages are published from this repository:

| package                           | what it is                       | installed as             |
| --------------------------------- | -------------------------------- | ------------------------ |
| [`@zenera/core`](packages/neo)    | the library                      | a dependency             |
| [`@zenera/cli`](packages/cli)     | the `zen` command                | `npm i -g @zenera/cli`   |
| [`@zenera/faker`](packages/faker) | the `zen faker` subcommand       | `npm i -g @zenera/faker` |
| [`@zenera/rag`](packages/rag)     | the `zen rag` subcommand + tools | `npm i -g @zenera/rag`   |

The repository root is `private: true` and is never published.

Nothing lists those four by hand: [scripts/release.mjs](scripts/release.mjs) takes every
directory under `packages/` whose `package.json` is not `private`, and sorts them so a
package comes after the siblings it depends on. `node scripts/release.mjs workspaces`
prints that list as `-w` flags (`--paths` for bare directories), and the pack and publish
commands use it. To publish a new package, drop `"private": true` from it — and publish its
first version by hand, because CI's credential does not exist until the package does.

## The strategy in one paragraph

**Versions move in lockstep, a git tag is the release, and CI does the publishing.**
The packages depend on each other by range, so their versions are always identical:
one number, one tag, one release. `npm run release -- patch` writes the numbers and cuts
the tag; pushing the tag starts the `Release` workflow, which re-runs every check, proves
the tag matches the tree, and publishes each package after the siblings it depends on.
Nothing reaches npm from a laptop.

Two rules the tooling exists to enforce:

- **Order.** A package is published after everything it depends on: `@zenera/core`, then
  `@zenera/cli`, then the subcommand packages that depend on both. Out of order, a package
  ships asking for a sibling version that does not exist yet.
- **The dependency ranges.** When the version moves, every internal `"@zenera/*": "^x.y.z"`
  must move with it. `npm version --workspaces` does _not_ do this — it bumps each
  workspace and leaves every dependent pointing at the old version. That is the whole
  reason [scripts/release.mjs](scripts/release.mjs) exists.

## Cutting a release

```bash
git switch main && git pull
npm run release:check          # format, typecheck, offline tests, pack dry-run
npm run release -- patch       # minor | major | 1.4.0 are also accepted
git push --follow-tags
```

**One tag at a time.** `--follow-tags` pushes every unpushed tag, so bumping twice before
pushing starts two workflow runs at once; they race to write the same packument and the
registry answers `409 Failed to save packument`, leaving a release half published. The
workflow now has a `concurrency: release` group, but do not rely on it — push the tag you
meant to cut.

`npm run release -- patch`:

1. refuses to run on a dirty tree, or if the packages are already out of lockstep,
   or if the tag already exists;
2. writes the new version into every `package.json` and rewrites every internal
   `@zenera/*` range;
3. refreshes `package-lock.json`;
4. commits `release: vX.Y.Z` and annotates the tag `vX.Y.Z`.

Add `--dry-run` to see the numbers it would write and have it put the files back.
**`--dry-run` restores the package manifests with `git checkout --`, so uncommitted edits
to them are lost.** Add `--no-tag` to commit without tagging.

Pushing the tag is what publishes. Until then nothing has left the machine.

## What CI does

[.github/workflows/release.yml](.github/workflows/release.yml) runs on any `v*.*.*` tag
(and on `workflow_dispatch` with a tag name, to re-run a failed release):

1. `node scripts/release.mjs verify <tag>` — the tag must name the version in every
   package, and each internal `@zenera/*` range must match it. A mismatched tag fails
   here, before anything is published.
2. `format:check`, `typecheck`, `vitest run --exclude '**/live-*'`.
   Live tests need real provider credentials and are excluded rather than skipped, so a
   missing key cannot pass as green.
3. `npm pack --dry-run` for every package.
4. one `npm publish -w <dir> --access public` per package, in dependency order,
   **skipping any `name@version` the registry already has** — so re-running a partially
   failed release finishes it instead of dying on the first already-published package.
5. `gh release create <tag> --generate-notes`.

> **CI has no npm token.** `NPM_TOKEN` is unset; the workflow authenticates with npm
> **trusted publishing** (OIDC, `id-token: write` + npm >= 11.5.1), which also signs a
> provenance statement automatically — the repository is public, so npm accepts it.
>
> **A package npm has never seen has no trusted publisher, so its first version cannot be
> published by CI.** The run fails with `npm error code ENEEDAUTH … You need to authorize
this machine using npm login`, exactly where the new package's turn comes up. Publish
> that first version by hand (below), then add the trusted publisher on npmjs.com —
> _package → Settings → Trusted Publisher → GitHub Actions_, repository
> `andreyryabov/ZeneraNeo`, workflow `release.yml`, environment `npm` — and every later
> release goes through CI like the rest.

Every package has a `prepack: tsc -b`, so a stale or missing `dist` cannot be published.
None ships `src`, and the `.js.map` / `.d.ts.map` files are excluded with it — their
`../src/*.ts` references would not resolve inside the tarball. Maps are still emitted into
`dist` for local work; they are only kept out of the published files.

## Publishing by hand

When CI cannot ([release:publish](package.json) is the same command), and to bootstrap a
brand-new package:

```bash
npm login                                    # once per machine; 2FA prompts for an OTP
npm run release:check
npm run release:publish                      # or: npm publish -w packages/<new> --access public
```

- A bare `npm publish` at the root fails — the root is private. Always name a workspace.
- Publish in dependency order; `release.mjs workspaces` already emits it.
- The version must be the one the tag names, or the tree is no longer in lockstep.
- In the VS Code terminal sandbox `npm pack`/`npm publish` fail with `EPERM` on
  `~/.npm/_cacache/tmp`. Add `--cache "$TMPDIR/npm-cache"`, or run in a normal terminal.

## Fixing a bad release

npm packages are immutable — a published version is never replaced.

- **The workflow failed before publishing:** fix, then re-run the workflow from the
  Actions tab with the same tag. Nothing was published, the tag is still good.
- **Some packages published and a later one failed:** re-run the workflow with the same
  tag. The publish step skips what is already on the registry and publishes the rest.
  Dispatch it from `main` (the workflow file comes from the dispatch ref, the tree from
  the tag) so any fix to the workflow itself is the one that runs.
- **A broken version is live:** cut the next patch. `npm deprecate @zenera/core@x.y.z <reason>`
  steers people off it. Only reach for `npm unpublish` within 72 hours and when nothing
  depends on the version.

Never move a tag that CI has already consumed.

## Checklist

- [ ] `main` is green and pulled
- [ ] READMEs and [docs/](docs) match the code being shipped
- [ ] package READMEs use **absolute** GitHub URLs (relative links break on npmjs.com)
- [ ] breaking changes → `major`; new surface → `minor`; fixes → `patch`
- [ ] `npm run release:check` passes
- [ ] `npm run release -- <bump>`
- [ ] `git push --follow-tags` — exactly one new tag
- [ ] the `Release` workflow is green and every version appears on npmjs.com
- [ ] `npm i -g @zenera/cli@latest && zn --version` from outside the repo
