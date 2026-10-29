<div align="center"> 
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera Logo"
    width="20"
  />
  <div>Powered By Zenera</div>
</div>
<br>

<div align="center">
<img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-gym-with-media-queries.svg" alt="ZENERA GYM" width="738">

[![npm](https://img.shields.io/npm/v/@zenera/gym.svg)](https://www.npmjs.com/package/@zenera/gym)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [Use](#use) · [Commands](#commands) · [Credentials](#credentials) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/gym

**Simulated API environments for agent training and evaluation. Point Gym at
a Swagger/OpenAPI spec — and, if you like, a story about the world behind it —
and it serves the API: stateful, consistent across endpoints and processes, and
populated with content that follows the story.**

Gym currently provides the API simulation layer, not a training loop, task
scoring, or rewards.

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). It ships no
> binary of its own: installing it adds a `gym` **subcommand** to
> [`zen`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## What you get

- **A mock server from a spec** - point it at one or more swagger/OpenAPI
  documents and every operation answers.
- **A world, not random bodies** - every answer comes from a shared world of
  entities. `GET /messages` lists what `GET /messages/{id}` returns, a `POST`
  is visible to the next `GET`, and a `DELETE` deletes.
- **A story it follows** - hand it a document describing the people, the
  projects and what is going on, and the mailbox, the calendar and everything
  else read like that place.
- **Several APIs, one world** - mail on one port and calendar on another,
  started with the same story, share one world: the meeting in an email is the
  meeting on the calendar.
- **Code written once** - an agent writes a TypeScript handler per operation,
  judged before it is kept; after that a request is a function call, and the
  only tokens spent are on content the world does not have yet.
- **Lists that end** - paging is built in, judged, and cut at request time, so a
  client never loops forever.

## Install

Node.js 24+. Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/gym
zen key add openai          # the keyring `zen` already uses
```

No container engine is needed: handlers are TypeScript that Node runs as it is.
`zen --help` lists `gym` whether or not it is installed, and says what to run
if not.

## Use

```sh
zen gym serve api/openapi.yaml --port 8787
curl -s localhost:8787/users/12324
# { "user_id": 12324, "email": "brooke.hoffman@example.org", ... }
```

With a story, and two APIs in two processes sharing one world:

```sh
zen gym serve specs/mail.yaml     --story world.md --port 8787
zen gym serve specs/calendar.yaml --story world.md --port 8788
```

The story is a Markdown or text file, a folder of them, or a
[`zen rag docs`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)
index. A short story is given to the agent whole; a long one is read with
`list_docs`, `grep_docs` and `read_docs`, so it can be as large as a wiki.
[`examples/mock-apis/stories`](https://github.com/zenera-ai/ZeneraNeo/tree/main/examples/mock-apis/stories)
has one for the mail and calendar specs beside it.

Warm it up before a demo or a test run, so no request pays for writing a handler:

```sh
zen gym build api/openapi.yaml     # write every handler now and exit
zen gym cache ls                   # what has been written
zen gym cache clear                # throw it away
```

A path key with a query string on it — `/x/{id}?action=retry`, which some
vendors write when they need two `post`s under one path — is read for what
it means rather than taken verbatim: the path is the part before the `?`, and
each pair after it becomes a required query value that tells those operations
apart. Call one without it and the 404 says which queries the path answers to.

## How an answer is produced

Two agents, and a split between them that is the whole design.

**The handler agent writes mechanics.** The first time an operation is called,
an agent writes its **handler**: one TypeScript module, `export default async
function handle(req, ctx)`. It is briefed with the operation as TypeScript
types (via [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md),
so a 2,000-operation document costs no more than a small one), and it has
tools to look before it writes: the operations around this one, the handlers
already written for them, the collections the world already holds, and any type
it was not shown. That is what makes `getMessage` read the collection
`listMessages` filled, rather than inventing its own.

A handler owns which collection an operation reads, how the query filters it,
what a write changes and how the list pages — and never the content:

```ts
export default async function handle(req, ctx) {
    const all = await ctx.ensure('messages', { type: 'Message', hint: req.query.q });
    const q = (req.query.q ?? '').toLowerCase();
    const hits = all.filter((m) => `${m.subject} ${m.snippet}`.toLowerCase().includes(q));
    const page = ctx.page(hits, { token: req.query.pageToken, size: req.query.maxResults });
    return {
        messages: page.items.map(({ id, threadId }) => ({ id, threadId })),
        nextPageToken: page.nextToken ?? undefined,
        resultSizeEstimate: hits.length,
    };
}
```

**The world agent writes content.** When a handler finds the world short of
something — an inbox nobody has read yet, a message id nobody has seen —
`ctx.ensure` and `ctx.lookup` ask, and an agent writes the records: from the
story, consistent with everything already in the world, and validated against
the schema type before anything can read them. What it saves is permanent.
`me`, `primary` and the like resolve through `ctx.owner()`, the account the
story says the API belongs to, so the calendar `primary` and the owner's
address are one calendar.

Because content lives in the world and not in the code, one cached handler
serves every story: change the story and the world changes, the code does not.

**Nothing is kept until it is judged.** The agent cannot decide it is finished;
`test_handler` decides. It runs the module against probe requests in a
throwaway copy of the world — content there is sampled from the schema, not
written by an agent, so judging is fast and free — and checks every answer
against the response schema and the **echo rule** (where a path parameter shares
a name with a response property, the response carries the value asked for:
`GET /users/12324` answering about user 999 validates and is still wrong). The
first test that passes ends the build; a build that never passes leaves a
**report** in `<cache>/builds/` with every rejected version and why, and the
`501` the request gets links to it.

Every agent run, handler or world, also leaves an HTML report in
`<cache>/reports/`: each tool call, what it returned, and what it cost.

Handlers run in a worker thread with an empty environment. A handler that
throws or times out (`--timeout`, not counting time spent waiting on the world
agent) is repaired: the agent gets the failing request, the stack and earlier
requests that worked, up to `--regen-limit` times per URL. A failure of the
world agent is never treated as a fault in the handler.

## The world

One SQLite file, `<cache>/worlds/story-<digest>.sqlite` — named after what the
story says, so every process given the same story shares it without being told
to. `--state <file>` names one explicitly; without a story there is one default
world. `--reset` starts from empty.

The world is data, not cache: `zen gym cache clear` throws handlers away and
leaves worlds alone.

## Pages that end

A list endpoint is the one place a mock can hang a real client. Given
`?cursor=abc`, the honest-looking answer is a body that validates, echoes
nothing it shouldn't, and hands back `abc` again - so the client asks for the
same page forever.

Gym reads the document for this. Where an operation has a paging parameter
(`cursor`, `page`, `offset`, `page_token`, …) in query or request body and a
response property that carries the next one (`next`, `next_cursor`, `has_more`,
…), three things happen, all in the operation's own names:

- the handler is told to page with `ctx.page`, whose token always advances and
  is absent on the last page;
- the handler is **walked** before it is kept: Gym calls it with no cursor,
  follows the token it gets back, and rejects it if the token repeats, cycles,
  or never runs out;
- at request time, pagination is tracked and bounded: a token identical to the
  one just sent is **cut** (nulled or dropped), cycles are stopped, and streams
  are capped to random 1-10 pages, returning empty results if a client loops
  past the end.

`GET /__gym/routes` reports the shape that was recognised, per operation.

## Commands

```
zen gym serve <spec...>    Serve them. Handlers are written on demand.
zen gym build <spec...>    Write every handler now and exit.
zen gym cache ls | clear   What has been written, or throw it away.
zen gym model [ref]        Show or set the model it uses.
```

The model is looked for in this order: `--model`, `ZENERA_GYM_MODEL`, what
`zen gym model <provider>:<id>` stored, then the best one your keys can buy.
Both agents call tools, so it must be a model that can; OpenAI's reasoning
models take tools over the Responses API (`openai/responses:<id>`), which is
what the default names. The stored one lives beside the keyring in
`~/.zenera/neo/gym.json`; `zen gym model --clear` forgets it.

Useful options: `--story`, `--state`, `--reset`, `--port`, `--host`
(reachable only from this machine by default), `--model`, `--seed` (same
request, same randomness), `--rebuild`, `--attempts`, `--concurrency`,
`--timeout`, `--cache <dir>`, `--quiet`. `zen help gym` prints the full table.

`GET /` is a contents page: every operation the mock is serving, grouped by the
document it came from, with its parameters and the shape of its answer. Each
one has a **Run** button, which opens a form — a box per parameter, required
ones marked, a body prefilled with something the mock will accept — and shows
the status, the time and the answer. `GET /__gym/routes` is the same thing as
JSON; `GET /__gym/health` is a health check. A document that declares `/`
itself keeps it.

## Credentials

The keyring is `zen`'s, so there is nothing new to configure:

```sh
zen key add openai
zen key ls --check
```

Environment variables still win over the keyring, exactly as they do for `zen`.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | the runtime - agents, models, tools, skills, memory           |
| **`@zenera/gym`**                                                                          | `zen gym` - a mock API from an openapi/swagger document       |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` - indexing and search for documents and API schemas |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` - a live local viewer for a folder                 |

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
