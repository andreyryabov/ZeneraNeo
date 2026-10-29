# 02 - API Integration

A worked example: find a meeting request in a mock mailbox, check mock calendar
availability, propose a time, then - only after the user confirms - call the
calendar and mail APIs to create an event and send a confirmation.

This example demonstrates two integrations described by OpenAPI specs in
[`examples/mock-apis/specs`](../../mock-apis/specs): the project uses those
specs to understand the API contracts, and `zen gym` serves them as mock
HTTP APIs. The generated project contains the integration code that calls the
mock endpoints.

**Why Gym?** Real mail and calendar services need accounts, credentials and
send real messages. `zen gym` stands in for them: it serves the same API
contracts locally, so you can build and test the integrations - request shapes,
error handling, confirmation before writes - without touching real data or
sending anything.

Everything in this folder is the intent and instructions - the generated
project is built from [SPECIFICATION.md](SPECIFICATION.md).

## Before you start

- Node.js 24+, then `npm i -g @zenera/cli @zenera/gym`
- Podman, which is what `zen run` runs the agent in
- An OpenAI key for the agent and the mock-response generators

## 1. Add a key and choose the meta-agent model

```sh
zen key add openai
zen meta model --pick
```

The meta agent turns the specification into the project. It runs on your own
key, separately from the model the generated project declares.

## 2. Create the project

In another terminal:

```sh
cd ~/your-work-dir
zen init api-integration
cd api-integration
```

## 3. Start both mock APIs

First, from the root of `api-integration`, download the two OpenAPI specs
that Gym will serve, and the story of the world behind them:

```sh
mkdir -p mock-apis/specs
for f in calendar mail; do
  curl -fsSL -o "mock-apis/specs/$f.yaml" \
    "https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/examples/mock-apis/specs/$f.yaml"
done
mkdir -p mock-apis/stories
curl -fsSL -o mock-apis/stories/northwind-launch.md \
  "https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/examples/mock-apis/stories/northwind-launch.md"
```

The folder should now look like this:

```
api-integration/
└── mock-apis/
    ├── specs/
    │   ├── calendar.yaml
    │   └── mail.yaml
    └── stories/
        └── northwind-launch.md
```

Then run the Gym server from `@zenera/gym`, also from the root of
`api-integration`:

```sh
zen gym serve \
  mock-apis/specs/calendar.yaml \
  mock-apis/specs/mail.yaml \
  --story mock-apis/stories/northwind-launch.md \
  --host 0.0.0.0 \
  --port 8787 \
  --requests-dir .tmp/gym-requests
```

Gym serves both specs from one mock server, over one world that follows the
story: Alex Rivera's mailbox and calendar in the week of a product launch. The
first request to an operation takes longer while Gym writes and checks that
operation's handler, and the first read of the inbox or a calendar takes longer
while Gym writes its content; later calls are immediate. Keep this command
running while you try the project.

This command stays running in that terminal. To check it from your host, open
`http://localhost:8787/` in a browser, or check
`http://localhost:8787/__gym/health`. The root page lists the mock API
operations and lets you try them.

There are two different addresses here:

- **From your host browser or terminal:** use `http://localhost:8787`.
- **From inside the project sandbox:** use
  `http://host.containers.internal:8787`. This special hostname points from a
  Podman container back to the host; it may not work in your host browser.

`--host 0.0.0.0` makes the mock server listen on interfaces the sandbox can
reach; it is a bind address, not the URL to open. Use this only on a trusted
network and stop the server when finished. The project defaults its API URLs
to the sandbox address above.

## 4. Replace SPECIFICATION.md

Replace the `SPECIFICATION.md` in `api-integration` with the contents of
[this example's SPECIFICATION.md](SPECIFICATION.md).

## 5. Generate and check the project

From the project folder, run:

```sh
zen meta run /spec-sync-project
```

It should generate the project agents and the small API integrations that call
the Mail and Calendar endpoints from the sandbox. The project specification
defines the API base URLs and the behaviors the integrations must follow.

Review any `SPECIFICATION-FEEDBACK.md` it creates, apply your answers with
`zen meta run /spec-apply-feedback`, and sync again. Then verify the project:

```sh
zen check
```

The mock server must still be running for API calls. `zen check` checks that
the project loads; it does not prove that either mock API is reachable.

## 6. Try the workflow

```sh
zen run api-integration
```

Run this from inside the `api-integration` project folder.

Try:

- “What emails do I have for today?”
- “Find a time tomorrow when I can meet with `type-here-any-attendee-from-answer-above`.”
- Answer the coordinator's questions about meeting duration and timezone.

The coordinator should summarize its proposal and ask for confirmation before
it creates an event or sends mail. To exercise the write calls, confirm the
proposed time and recipients in the same run.

## What this mock does - and does not - prove

Gym keeps a simulated world: the meeting request in the mailbox is the one the
story describes, free/busy reflects the calendar, and an event the coordinator
creates shows up in later searches and free/busy queries. It is still a
simulation - nobody receives the confirmation email and nothing is booked
anywhere real - so the coordinator must describe results as mock API responses,
not real bookings, availability, or delivery.

That makes this a safe example for learning the API shapes, composing
integrations, handling errors, and enforcing confirmation before writes. Start
`zen gym serve` with `--reset` to put the world back the way the story has it.
Use a real integration environment to test end-to-end side effects.

## See also

- [API integration guide](../../../docs/integrations.md)
- [Project creation guide](../../../docs/projects.md)
- [Mock API package](../../../packages/gym/README.md)
