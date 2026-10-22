# make patch — bump every package, push the tag, wait until npm serves the new version.

SHELL := /bin/bash

.PHONY: patch

# Waits on the last package in publish order: once it is on npm, all of them are.
patch:
	npm run release:check
	npm run release -- patch
	@set -e; \
	tag=$$(git describe --tags --exact-match HEAD); version=$${tag#v}; \
	git push origin HEAD "refs/tags/$$tag"; \
	last=$$(node scripts/release.mjs workspaces --paths | tail -1); \
	name=$$(node -p "require('./$$last/package.json').name"); \
	start=$$SECONDS; \
	until npm view "$$name@$$version" version --prefer-online >/dev/null 2>&1; do \
		elapsed=$$((SECONDS - start)); \
		if [ $$elapsed -ge 1200 ]; then echo "gave up after 20m - check the Release workflow on GitHub"; exit 1; fi; \
		echo "waiting for $$name@$$version on npm ($${elapsed}s)..."; \
		sleep 15; \
	done; \
	echo "released $$tag"
