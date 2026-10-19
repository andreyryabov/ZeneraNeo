# 02 - API Integration

A worked example: find a meeting request in a mock mailbox, check mock calendar
availability, propose a time, then - only after the user confirms - call the
calendar and mail APIs to create an event and send a confirmation.

This example demonstrates two integrations described by OpenAPI specs in
[`examples/mock-apis/specs`](../../mock-apis/specs): the project uses those
specs to understand the API contracts, and `zen faker` serves them as mock
HTTP APIs. The generated project contains the integration code that calls the
mock endpoints.

**Why Faker?** Real mail and calendar services need accounts, credentials and
send real messages. `zen faker` stands in for them: it serves the same API
contracts locally, so you can build and test the integrations - request shapes,
error handling, confirmation before writes - without touching real data or
sending anything.

Everything in this folder is the intent and instructions - the generated
project is built from [SPECIFICATION.md](SPECIFICATION.md).

## Before you start

- Node.js 24+, then `npm i -g @zenera/cli @zenera/faker`
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
that Faker will serve:

```sh
mkdir -p mock-apis/specs
for f in calendar mail; do
  curl -fsSL -o "mock-apis/specs/$f.yaml" \
    "https://raw.githubusercontent.com/andreyryabov/ZeneraNeo/main/examples/mock-apis/specs/$f.yaml"
done
```

The folder should now look like this:

```
api-integration/
└── mock-apis/
    └── specs/
        ├── calendar.yaml
        └── mail.yaml
```

Then run the Faker server from `@zenera/faker`, also from the root of
`api-integration`:

```sh
zen faker serve \
  mock-apis/specs/calendar.yaml \
  mock-apis/specs/mail.yaml \
  --host 0.0.0.0 \
  --port 8787 \
  --requests-dir .tmp/faker-requests
```

Faker serves both specs from one mock server. The first request to an operation
may take a little longer while Faker writes and validates that operation's
response generator; later calls use its cache. Keep this command running while
you try the project.

This command stays running in that terminal. To check it from your host, open
`http://localhost:8787/` in a browser, or check
`http://localhost:8787/__faker/health`. The root page lists the mock API
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

Faker generates deterministic, schema-valid response bodies; it does not
provide a stateful calendar or mailbox. A generated event is not guaranteed to
appear in a later calendar search, and a generated send response does not mean
an email was delivered. The coordinator must describe these as mock API
responses, not real bookings, availability, or delivery.

That makes this a safe example for learning the API shapes, composing
integrations, handling errors, and enforcing confirmation before writes. Use a
stateful test service or a real integration environment to test persistence
and end-to-end side effects.

## See also

- [API integration guide](../../../docs/integrations.md)
- [Project creation guide](../../../docs/projects.md)
- [Mock API package](../../../packages/faker/README.md)
