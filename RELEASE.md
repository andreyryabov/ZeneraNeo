# Releasing

Two packages are published from this repository:

| package                      | what it is        | installed as          |
| ---------------------------- | ----------------- | --------------------- |
| [`zenera-neo`](packages/neo) | the library       | a dependency          |
| [`zenera-cli`](packages/cli) | the `zen` command | `npm i -g zenera-cli` |

The repository root is `private: true` and is never published.

## The strategy in one paragraph

**Versions move in lockstep, a git tag is the release, and CI does the publishing.**
`zenera-cli` depends on `zenera-neo` by range, so the two versions are always identical:
one number, one tag, one release. `npm run release -- patch` writes the numbers and cuts
the tag; pushing the tag starts the `Release` workflow, which re-runs every check, proves
the tag matches the tree, and publishes the library first and the CLI second. Nothing
reaches npm from a laptop.

Two rules the tooling exists to enforce:

- **Order.** `zenera-neo` is published before `zenera-cli`, or the CLI ships asking for a
  library version that does not exist yet.
- **The dependency range.** When the version moves, `zenera-cli`'s `"zenera-neo": "^x.y.z"`
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

`npm run release -- patch`:

1. refuses to run on a dirty tree, or if the two packages are already out of lockstep,
   or if the tag already exists;
2. writes the new version into both `package.json` files and rewrites the CLI's
   `zenera-neo` range;
3. refreshes `package-lock.json`;
4. commits `release: vX.Y.Z` and annotates the tag `vX.Y.Z`.

Add `--dry-run` to see the numbers it would write and have it put the files back.
Add `--no-tag` to commit without tagging.

Pushing the tag is what publishes. Until then nothing has left the machine.

## What CI does

[.github/workflows/release.yml](.github/workflows/release.yml) runs on any `v*.*.*` tag
(and on `workflow_dispatch` with a tag name, to re-run a failed release):

1. `node scripts/release.mjs verify <tag>` — the tag must name the version in both
   packages, and the CLI's range must match it. A mismatched tag fails here, before
   anything is published.
2. `format:check`, `typecheck`, `vitest run --exclude '**/live-*'`.
   Live tests need real provider credentials and are excluded rather than skipped, so a
   missing key cannot pass as green.
3. `npm pack --dry-run` for both packages.
4. `npm publish -w packages/neo --access public --provenance`, then the same for
   `packages/cli`.
5. `gh release create <tag> --generate-notes`.

Both packages have a `prepack: tsc -b`, so a stale or missing `dist` cannot be published.
Both ship `dist` **and** `src`, so the `../src/*.ts` references inside the `.js.map` and
`.d.ts.map` files resolve inside the tarball.

## One-time setup

### Claiming the names

npm's trusted publishing is configured on an existing package, so the first ever publish
of each name is done by hand, from a clean checkout of the tag:

```bash
npm run release:check
npm publish -w packages/neo --access public
npm publish -w packages/cli --access public
```

### Authenticating CI

Pick one:

- **Trusted publishing (preferred, no secret to leak).** On npmjs.com, for each package:
  _Settings → Trusted publisher → GitHub Actions_, repository `andreyryabov/ZeneraNeo`,
  workflow `release.yml`, environment `npm`. Then delete the two `NODE_AUTH_TOKEN` blocks
  from the workflow — the OIDC token in `id-token: write` replaces them.
- **A granular access token.** Create one with write access to both packages and store it
  as the `NPM_TOKEN` secret of a repository environment named `npm`. Adding a required
  reviewer to that environment means a tag push cannot publish unattended.

Either way, keep the `npm i -g npm@latest` step: trusted publishing and `--provenance`
need npm >= 11.5.1, and `--provenance` needs `id-token: write` plus the `repository` field
that both `package.json` files already carry.

## Publishing by hand

Only when CI cannot ([release:publish](package.json) is the same two commands):

```bash
npm run release:check
npm run release:publish
```

- A bare `npm publish` at the root fails — the root is private. Always name a workspace.
- Keep the order: `packages/neo`, then `packages/cli`.
- In the VS Code terminal sandbox `npm pack`/`npm publish` fail with `EPERM` on
  `~/.npm/_cacache/tmp`. Add `--cache "$TMPDIR/npm-cache"`, or run in a normal terminal.

## Fixing a bad release

npm packages are immutable — a published version is never replaced.

- **The workflow failed before publishing:** fix, then re-run the workflow from the
  Actions tab with the same tag. Nothing was published, the tag is still good.
- **`zenera-neo` published but `zenera-cli` failed:** re-run the workflow with the same
  tag. The library publish will fail as already-published; instead publish just the CLI
  (`npm publish -w packages/cli --access public`) or use a temporary workflow run.
- **A broken version is live:** cut the next patch. `npm deprecate zenera-neo@x.y.z <reason>`
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
- [ ] `git push --follow-tags`
- [ ] the `Release` workflow is green and both versions appear on npmjs.com
- [ ] `npm i -g zenera-cli@latest && zn --version` from outside the repo
