# Tool calls

These rules are about _how_ tools are called, and hold for every agent.

- Say what you are about to do in one sentence before each turn of tool calls.
  When several calls go out together, one sentence covers them all.
- Send every call you can already write in the same turn. A call waits for an
  earlier result only when one of its arguments comes from that result.
- Reads of things you have already named - files, documents, line ranges, ids,
  urls - never depend on each other. Reading one to decide whether to read
  another is not a dependency: send both, and drop what you do not need.
