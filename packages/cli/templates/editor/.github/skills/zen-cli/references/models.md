# Models — `zen models`

```
zen models <providers|ls|search|show|test|pick> [ref] [options]
```

Alias: `model`.

Answers **what can I use**. `zen check` answers the other question — whether one
particular project works — and needs a project to do it. This one needs nothing
but a credential.

## Subcommands

| Command                     | What it does                                           |
| --------------------------- | ------------------------------------------------------ |
| `zen models`                | Providers, credential source, how many models, how old |
| `zen models <provider>`     | Short for `ls <provider>`                              |
| `zen models ls [provider]`  | Everything it serves                                   |
| `zen models search <query>` | Narrow it                                              |
| `zen models show <ref>`     | One model, every field the vendor gave                 |
| `zen models test <ref> …`   | One real minimal call per ref, and a verdict           |
| `zen models pick`           | The first ref that answers, printed on stdout          |

Filters, on `ls` and `search`: `--chat`, `--embeddings`, `--images`, `--audio`,
`--tools`, `--vision`, `--free`, `--min-context <n>`, `--provider <name>`,
`--limit <n>`, `--all`, `--refresh`.

`pick` requires `--chat` or `--embedding`, and takes `--provider` and `--limit`.

## Where the lists come from

The providers themselves, cached for a day in `~/.zenera/neo/catalog`. When a
provider cannot be asked, the last listing is used and reported as stale; only
if there was never one does a short built-in list stand in. Every row says which
it was — `--json` carries `source` per model and `origin` per provider.

`--refresh` bypasses the cache. It is the only thing that does.

`zen models` on its own does **not** go to the network. `ls` and `search` do.

## Testing a model

```
zen models test openai:gpt-4o-mini
zen models test vertex:gemini-embedding-001 --embedding
```

The role is taken from the flag, else from what the provider says the model is
for, else from the id. One minimal call: `ok` for a chat model, one short vector
for an embedder — the embedding's width is reported, which matters because a
model serving a different number of dimensions is not interchangeable with the
one an index was built on.

Four verdicts, and they want four different actions:

| Verdict     | Means                                        | Do                         |
| ----------- | -------------------------------------------- | -------------------------- |
| `answers`   | it works                                     | nothing                    |
| `refused`   | the credential was rejected                  | `zen key check <provider>` |
| `blocked`   | the credential was fine, the account said no | the `fix` printed under it |
| `no answer` | it could not be reached                      | try again                  |

Exit `0` when every ref answered, `4` when any did not, `2` for a ref that does
not parse.

## Recovering from a blocked model

This is what the command is for.

```
$ zen models test vertex:gemini-embedding-001
vertex:gemini-embedding-001  blocked  Vertex AI API has not been used in project my-proj …
vertex:gemini-embedding-001: gcloud services enable aiplatform.googleapis.com --project my-proj
error 1 of 1 did not answer
        find one that does: zen models pick --embedding
```

Two ways out. Run the `gcloud` line, or take a different model:

```
$ zen models pick --embedding
openai:text-embedding-3-small
```

`pick` tries a short ordered list one at a time and stops at the first that
works. Sequential on purpose — the goal is one working ref, not a survey. The
ref goes to **stdout alone and unstyled**, so it substitutes directly:

```sh
zen rag schema index --embedding "$(zen models pick --embedding)" ./specs/*.yaml
```

`zen models pick --embedding --json` gives `{ref, provider, model, role,
dimensions, ms, tried}` — `tried` lists every candidate and why it was passed
over, so a caller can see _why_ a provider was skipped rather than only that it
was.

When nothing answers, exit `4` and the table of everything tried.

## What it will not do

There is no `test --all`. A sweep across every model on the machine is a bill,
not a diagnostic — name the refs you care about, or use `pick`.

There is no ranking. The candidate order in `pick` is cheapest-and-fastest
first, which is about how quickly an answer arrives, not about which model is
better.
