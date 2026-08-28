# Configuration fixtures

A catalog of `agents.yaml` files, each covering one aspect of model
configuration and each annotated in place. They are loaded and asserted by
[../model-configs.test.ts](../model-configs.test.ts), so the comments cannot
drift from what the loader actually does.

Read them alongside [docs/agents-yaml.md](../../docs/agents-yaml.md), which is
the reference these are the worked examples of.

Committed rather than written to a temp directory, unlike the fixtures in
[../project.test.ts](../project.test.ts) — those are about the loader and are
clearest inline; these are about the configuration language and are meant to be
read.

## Valid

| Folder               | What it shows                                                               |
| -------------------- | --------------------------------------------------------------------------- |
| `shorthand`          | Every form of `[provider[/api]:]model`, including a colon-bearing id        |
| `named-models`       | The `models:` map, agent pinning, the top-level fallback, memoization       |
| `providers`          | Two keys for one vendor, a gateway, transport settings on the connection    |
| `vendors`            | One agent per protocol: openai chat + responses, Gemini API, Vertex, Claude |
| `openrouter`         | The gateway kind: filled-in defaults, prefixed ids, variants, routing       |
| `tuning`             | Every vendor knob the schema accepts, on the vendor it belongs to           |
| `env`                | `${VAR}`, `${VAR:-default}`, composition, and how late they are read        |
| `inline-credentials` | A one-off key on the model, opting out of the shared client                 |
| `default-provider`   | `provider:` repointing where a bare model id belongs                        |

## Invalid

Each of these fails at load, with the offending key named.

| Folder                     | Failure                                                   |
| -------------------------- | --------------------------------------------------------- |
| `unknown-provider`         | An agent names a provider nobody declared                 |
| `unused-alias-typo`        | A typo in a `models:` entry no agent uses — still caught  |
| `api-on-single-api-vendor` | `api:` on a vendor that speaks only one                   |
| `unknown-api`              | An API the openai protocol does not speak                 |
| `openrouter-responses`     | An api named in a _ref_, on a kind that has none          |
| `missing-model`            | A model entry with no `model:`                            |
| `unknown-kind`             | A vendor with no adapter                                  |
| `unknown-key`              | A strict-schema violation on a provider                   |
| `unknown-model-key`        | The same, inside the `models:` union, with a vaguer error |
| `missing-key`              | A provider whose credentials cannot be resolved when used |
| `bad-name`                 | A name that breaks the shared name pattern                |

## Environment

The fixtures reference `ZN_`-prefixed variables plus the conventional
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` and
`GOOGLE_CLOUD_PROJECT`. The test stubs all of them, so the suite behaves
identically with or without real credentials in `.env`.

Nothing here touches the network: building a client constructs an SDK object
and resolves credentials, and no request is ever made.
