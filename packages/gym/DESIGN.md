# @zenera/gym - Design

Status: draft
Scope: `packages/gym`

## 1. What it is

A mock HTTP server for one or more OpenAPI/Swagger documents, backed by a
**stateful world** that can follow a **story**. Two agents do the writing:

- the **handler agent** writes one TypeScript handler per operation: the API's
  _mechanics_ (which collection, which filter, what a write changes, how it pages);
- the **world agent** writes the _content_ those handlers read: records that
  agree with the story and with everything already in the world.

Handlers are cached per operation shape and run in a worker thread. Content
lives in a SQLite file that several `zen gym` processes can share.

The split is the whole design: because a handler holds no content, one cached
handler serves every story. Change the story and the world changes; the code
does not.

## 2. Components

```
                         zen gym serve mail.yaml --story world.md
                                          │
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ command.ts    flags → setup → listen; build / cache / model subcommands      │
 └──────────────────────────────────────┬───────────────────────────────────────┘
                                        ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ setup.ts      assembles everything below, in dependency order                │
 └──┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────┘
    │          │          │          │          │          │          │
    ▼          ▼          ▼          ▼          ▼          ▼          ▼
 spec.ts   catalog.ts  story.ts   store.ts   synth.ts   box.ts    cache.ts
 router.ts (rag graph, (--story)  (SQLite    (World:    (worker   (handler
 validate  TS types,              world)     world      runner)   store +
 .ts       validators)                       agent)               builder)
    │          │          │          │          │          │          │
    └──────────┴──────────┴────┬─────┴──────────┴──────────┴──────────┘
                               ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ server.ts     node:http: route → check → ensure handler → run → validate     │
 │               → page backstop → answer; regeneration on handler faults       │
 └──────────────────────────────────────────────────────────────────────────────┘
```

How they depend on each other at run time:

```
   HTTP request
        │
        ▼
   ┌─────────┐ match  ┌──────────┐
   │ server  │───────▶│ router   │
   │         │ check  ┌──────────┐
   │         │───────▶│ validate │ (Ajv, request + response)
   │         │        └──────────┘
   │         │ ensure ┌──────────┐ build  ┌──────────────┐ tools ┌──────────┐
   │         │───────▶│ cache    │───────▶│ generate     │──────▶│ catalog  │
   │         │        └──────────┘        │ (handler     │       │ store    │
   │         │                            │  agent)      │──┐    └──────────┘
   │         │                            └──────────────┘  │ test_handler
   │         │ run    ┌──────────┐                          │ (probes, judge)
   │         │───────▶│ box      │◀─────────────────────────┘
   │         │        └────┬─────┘
   └─────────┘             │ postMessage
                           ▼
                    ┌──────────────┐  ctx.db  ┌──────────────┐
                    │ worker.ts    │─────────▶│ world.sqlite │◀──┐
                    │ + runtime.ts │          └──────────────┘   │ save_records
                    │ (handler.ts) │ ctx.ensure / lookup         │
                    └──────┬───────┘ (record missing)            │
                           │ 'synthesize' message                │
                           ▼                                     │
                    ┌──────────────┐  story tools  ┌─────────┐   │
                    │ synth.ts     │──────────────▶│ story   │   │
                    │ (world agent)│───────────────┴─────────┴───┘
                    └──────────────┘
```

## 3. File map

| File                             | Role                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [command.ts](./src/command.ts)   | `zen gym serve / build / cache / model`; flags, narration                                                          |
| [setup.ts](./src/setup.ts)       | Credentials → model → documents → catalog → story → world → box → cache                                            |
| [spec.ts](./src/spec.ts)         | Documents → `Operation[]`, dereferenced and normalised; cache key per operation (`GENERATOR_RULES_VERSION`)        |
| [schema.ts](./src/schema.ts)     | OpenAPI 3.0 / Swagger 2 → JSON Schema 2020-12; property walking                                                    |
| [router.ts](./src/router.ts)     | Method + path (+ pinned query) → operation                                                                         |
| [validate.ts](./src/validate.ts) | Ajv checks for path, query, body and response                                                                      |
| [catalog.ts](./src/catalog.ts)   | The documents as `@zenera/rag` reads them: TypeScript declarations, named-type validators, request/response briefs |
| [story.ts](./src/story.ts)       | `--story`: inline brief or `list_docs` / `grep_docs` / `read_docs` tools; content digest                           |
| [store.ts](./src/store.ts)       | `WorldStore`: SQLite collections of JSON records, meta, snapshots; `statePath`                                     |
| [runtime.ts](./src/runtime.ts)   | The `ctx` a handler gets: `db`, `lookup`, `ensure`, `synthesize`, `owner`, `page`, `fail`, seeded randomness       |
| [worker.ts](./src/worker.ts)     | Worker-thread entry: imports a handler, builds `ctx`, relays synthesis requests                                    |
| [box.ts](./src/box.ts)           | Host side of the worker: run, timeouts that pause while an agent works, restart on hang, snapshot release          |
| [agents.ts](./src/agents.ts)     | Runs a `@zenera/neo` agent with a tool-call budget, early stop, HTML report                                        |
| [generate.ts](./src/generate.ts) | The handler agent: brief, tools, `test_handler`, the judge (probes, echo rule, page walk)                          |
| [prompt.ts](./src/prompt.ts)     | The handler contract (`SYSTEM`), per-operation brief, repair brief                                                 |
| [probe.ts](./src/probe.ts)       | Synthetic probe requests, the echo rule, page-walk helpers                                                         |
| [synth.ts](./src/synth.ts)       | `World`: the world agent, its tools, record validation, per-collection locking, sampled fallback                   |
| [fake.ts](./src/fake.ts)         | Schema sampler: valid content for judging and fallbacks                                                            |
| [cache.ts](./src/cache.ts)       | Handlers in the shared cache; one build per operation at a time; concurrency slots; build reports                  |
| [server.ts](./src/server.ts)     | The HTTP pipeline, regeneration, pagination backstop                                                               |
| [paging.ts](./src/paging.ts)     | Recognising paged operations; cutting looping tokens; `PaginationLimiter`                                          |
| [logger.ts](./src/logger.ts)     | Log lines, request dumps, build reports, regeneration limits                                                       |
| [page.ts](./src/page.ts)         | The `GET /` contents page with a Run form per operation                                                            |
| [envelope.ts](./src/envelope.ts) | `GeneratorInput`: the one request shape handlers, probes and the world agent share                                 |

## 4. One request

```
client          server.ts            cache.ts         box.ts / worker.ts       synth.ts
  │  GET /x/{id}     │                   │                    │                    │
  │─────────────────▶│ router.match      │                    │                    │
  │                  │ validate request  │                    │                    │
  │                  │ ── 400 on issues  │                    │                    │
  │                  │ ensure(operation)▶│ hit: copy source   │                    │
  │                  │                   │  into the box      │                    │
  │                  │                   │ miss: build (§5)   │                    │
  │                  │◀──────────────────│                    │                    │
  │                  │ run(key, input) ─────────────────────▶ │ import handler.ts  │
  │                  │                   │                    │ handle(req, ctx)   │
  │                  │                   │                    │  ctx.lookup miss ─▶│ world agent
  │                  │                   │  (handler clock    │                    │ writes records
  │                  │                   │   paused)          │◀── records ────────│ into the world
  │                  │◀─────────────────── outcome ───────────│                    │
  │                  │ ok + status   → answer as is (ctx.fail)                     │
  │                  │ agentFault    → 502, no regeneration                        │
  │                  │ fault/mismatch→ regenerate (§5, repair) and run again       │
  │                  │ ok            → validate response, page backstop            │
  │◀─────────────────│ 200 + body (or declared status, no body)                    │
```

Requests to operations with no response body still run their handler, so a
`DELETE` actually deletes.

## 5. Writing a handler

```
cache.ensure(op) ── miss ──▶ generate.build(op)
                                 │
              brief: operation as TypeScript (catalog.describe),
                     candidate record types, paging rules,
                     related operations [built?], world collections
                                 │
                                 ▼
                ┌──────────────────────────────────┐
                │ handler agent  (agents.runAgent) │
                │ tools:                           │
                │   list_operations  read_handler  │
                │   list_collections read_collection│
                │   describe_types   test_handler  │
                └───────────────┬──────────────────┘
                                │ test_handler(source)
                                ▼
          box.write(key, source)
          world.snapshot ──▶ scratch/<key>-<n>.sqlite
          judge, all with { db: scratch, probe: true }:
            probes (probe.ts, path ids fitted to response patterns)
              → runs ok?  answered a body, not ctx.fail?
              → response schema (validate.ts)
              → echo rule (probe.ts)
            page walk if paged: token advances, never repeats, ends
          release + delete the scratch copy
                                │
            ┌───────────────────┴───────────────────┐
            ▼                                       ▼
        no problems                             problems
     run stops at once                 handed back as the tool result;
     source kept (cache.ts)            after --attempts failures:
                                       BuildFailed + builds/<…>.md
```

The agent cannot declare itself finished: the first passing test ends the run.
If it stops without passing, it is started again with its last version and the
last problems (twice at most). Repair after a live fault is the same build with
a repair brief: the current source, the failing request, the stack and earlier
successful requests.

Content during judging comes from [fake.ts](./src/fake.ts) instead of the world
agent, so judging costs no model calls and writes nothing real requests can
see.

## 6. Writing the world

```
handler (worker)                 box.ts (host)              synth.ts World
  ctx.ensure('messages',            │                           │
    { type, min, where, hint })     │                           │
  ── populated:<col>:<where> unset  │                           │
     or fewer than min ──▶ 'synthesize' ─▶ synthesize hook ────▶│
                                    │   (clock paused)          │ probe? → fake.ts sample
                                    │                           │ lock per (db, collection)
                                    │                           │ recheck: made meanwhile?
                                    │                           │
                                    │            ┌──────────────▼───────────────┐
                                    │            │ world agent                  │
                                    │            │ instructions: story brief +  │
                                    │            │   rules (agree with story,   │
                                    │            │   with the world, negatives) │
                                    │            │ brief: collection, type as   │
                                    │            │   TS, ids / count / where,   │
                                    │            │   the request, world so far  │
                                    │            │ tools: story tools,          │
                                    │            │   list_collections,          │
                                    │            │   read_collection,           │
                                    │            │   describe_types,            │
                                    │            │   save_records (validated)   │
                                    │            └──────────────┬───────────────┘
                                    │                           │ stops as soon as
                                    │                           │ the request is met
                                    │                           │ short? sampled stand-ins
                                    │◀────── records ───────────│ mark populated
   re-reads ctx.db ◀── 'synthesized'│                           │
```

- `ctx.lookup(col, id)` asks for exactly that id; `ctx.ensure` asks for a
  population. A collection that only holds what clients wrote is not
  _populated_: the first read still fills it as the story has it.
- `ctx.owner()` is `lookup('accounts', '@me')`. The `accounts` shape is gym's
  own (no document declares it). Handlers resolve `me`, `primary` and `self`
  through it, so `primary` and the owner's email are one calendar.
- `save_records` checks the id, the `where` pins and the named schema type, and
  reports every invalid record so the agent can fix it.

## 7. The worker

```
 host thread (box.ts)                         worker thread (worker.ts)
 ───────────────────                          ─────────────────────────
 run ── { type: 'run', id, file, version,  ──▶ import(file?v=version)
          db, input }                          ctx = createContext(input, store, …)
 start timer (--timeout)                       await handle(input, ctx)
                                                 │ ctx.synthesize
 pause timer ◀── { type: 'synthesize',      ◀────┘
                   id, call, db, request }
 World.synthesize(...)
 resume timer ── { type: 'synthesized',     ──▶ resolve / reject
                   id, call, records|error }
 settle      ◀── { type: 'done', id, ok,    ◀── body | HttpError(status) | throw
                   value|status|fault }
 release(db) ── { type: 'close', db }       ──▶ close that SQLite handle

 timeout: settle the call as a fault, terminate the worker, fail what was in
 flight, start a new worker on the next run.
```

The worker gets an empty environment, so no credentials are in reach. It does
not get a network wall: handlers come from the model this process asked, and
are judged before they are kept.

[runtime.ts](./src/runtime.ts) and [store.ts](./src/store.ts) are loaded inside
the worker, so they import only `node:` built-ins and `randexp`, and use only
erasable TypeScript.

## 8. One world, several processes

```
 zen gym serve mail.yaml --story w.md        zen gym serve calendar.yaml --story w.md
          │ port 8787                                   │ port 8788
          ▼                                             ▼
   story digest = sha256(story content) ──── same ──── story digest
          │                                             │
          └────────────▶ <cache>/worlds/story-<digest>.sqlite ◀────┘
                         (WAL, busy_timeout, one connection per process,
                          one more per worker)
            table records(collection, id, data, updated_at)
            table meta(key, value)   populated:<collection>:<where>
```

`--state <file>` names the world explicitly; with no story there is one
`default.sqlite`; `--reset` empties it. World-agent runs are serialised per
collection within a process; two processes filling the same collection at the
same moment can both write.

## 9. On disk

```
~/.zenera/neo/
├── gym.json                         the stored model (zen gym model)
├── cache/gym-generator/<ab>/<sha>.json
│                                    handler source + meta, keyed by operation shape
└── gym/                             --cache (default)
    ├── generators/
    │   ├── package.json             {"type":"module"} for the handlers
    │   └── <key>/handler.ts         what the worker runs (a copy of the cache)
    ├── worlds/story-<digest>.sqlite the worlds (data, kept by cache clear)
    ├── scratch/                     judging snapshots, deleted after each test
    ├── reports/<time>-<agent>-<label>.html
    │                                every agent run (@zenera/neo report)
    ├── builds/<time>-build-….md     failed or retried builds, with every version
    └── requests/<time>-….md         request dumps (or --requests-dir)
```

## 10. Cache identity

`Operation.key` in [spec.ts](./src/spec.ts) hashes what a handler must
produce: method, path, operationId, parameters, request and response schemas,
paging shape and `GENERATOR_RULES_VERSION`. Not the story, and not the file the
document came from. Editing a spec yields a new key; changing the handler
contract (`prompt.ts`, `runtime.ts`) is a version bump. Nothing is ever
invalidated, because nothing is ever looked up under a stale key.

## 11. What happens when things fail

| What failed                                      | Answer                                      | Regenerates the handler?           |
| ------------------------------------------------ | ------------------------------------------- | ---------------------------------- |
| Request does not match the document              | 400 / 404 / 405                             | no                                 |
| Handler build never passed the judge             | 501 + build report link                     | no (remembered)                    |
| Model unreachable while building                 | 500                                         | no (retried next request)          |
| Handler threw, timed out, or answered off-schema | rebuilt with a repair brief, then run again | yes, up to `--regen-limit` per URL |
| Handler chose `ctx.fail(status)`                 | that status and body                        | no                                 |
| World agent failed inside a handler              | 502 `WORLD_AGENT_FAILED`                    | no                                 |
| World agent saved too few records                | sampled records fill in                     | no                                 |
| Worker could not start                           | 503                                         | no                                 |
| Client loops past the last page                  | token cut, items emptied                    | no                                 |
