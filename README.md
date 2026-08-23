# ZeneraNeo

An agent runtime for Node.js 24+ (ESM), and the command line over it.

## Packages

| Directory      | Published as | What it is                                             |
| -------------- | ------------ | ------------------------------------------------------ |
| `packages/neo` | `zenera-neo` | the library — `src/index.ts` is the public entry point |
| `packages/cli` | _private_    | `zenera`, a thin front end over it (a shell, for now)  |

The root package is `private` and is never published; it holds the workspace,
the shared toolchain and the demos.

```
packages/neo/src/     library source
packages/neo/test/    unit tests (*.test.ts)
packages/cli/src/     the `zenera` binary
examples/             runnable demos
docs/                 project layout and the agents.yaml reference
```

## Dependencies

The library depends on `yaml` and `zod` and nothing else. The three vendor SDKs
are **optional peer dependencies** — install the one you talk to:

```sh
npm i zenera-neo openai
npm i zenera-neo @anthropic-ai/sdk
npm i zenera-neo @google/genai
```

None of them is loaded until a client for that vendor is first built, so an
OpenAI-only application never pays for the other two.

## Scripts

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `npm run build`         | Build both packages (`tsc -b`, project references) |
| `npm run build:watch`   | Same, incrementally                                |
| `npm test`              | Run the unit tests once                            |
| `npm run test:watch`    | Run the unit tests in watch mode                   |
| `npm run test:coverage` | Run tests with a coverage report                   |
| `npm run typecheck`     | Build, then type-check tests and examples too      |
| `npm run cli -- --help` | Build and run the CLI                              |
| `npm run demo:all`      | Run every example (needs credentials in `.env`)    |

## Usage

```ts
import { loadProject } from 'zenera-neo';

const project = await loadProject('./my-agents');
```

See `examples/` for eight worked demos, from a single agent to a project loaded
entirely from a folder.
