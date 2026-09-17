# Specification

## Purpose

Answer questions about the Hugging Face Transformers documentation from an index of it, quoting the passage the answer came from.

## Models

- `openai:gpt-5.6-luna` — one model for the whole project.
- `openai:text-embedding-3-small` — the vectors, for the index and memory both.

## Setup

Download `https://raw.githubusercontent.com/andreyryabov/ZeneraNeo/main/examples/projects/common/markdown-documentation-transformers.zip`
into `.tmp/`, unzip it, create index and store in `assets/docs-db`. It skips when that index is
already built.

## Agents

`default` — the only agent.

- Hugging Face documentation assistant.
- The index is the only source. It lists the documents once before its first search, and never answers from its own recollection of the library.
- Anything outside the Hugging Face documentation — another library, the weather, a code review — is declined outright, with a line on what it does cover.
- Every answer names the document and the paragraph it came from.
- Recalls before answering, and commits what it found, so the same question is not searched twice.

## Knowledge

- `assets/docs-db` — the Transformers documentation, read-only at `/assets`.
- create and preload a skill that explain how to do search.

## Boundaries

- Access only to the documentation index via search commands; no workspace tools or general sandbox execution.
