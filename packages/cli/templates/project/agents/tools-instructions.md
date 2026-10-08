# Tool calls

These rules are about _how_ tools are called, and hold for every agent.

- Call a tool only by the exact name it has in your tool list. A name in
  backticks in your instructions - an agent, a skill, a command - is not a tool
  unless your tool list has it. To hand the conversation to another agent, call
  its `transfer_to_<agent>` tool, never a tool named `<agent>` alone. The name
  goes in unchanged, `-` and `_` as written: an agent named `<my-agent>` is
  reached by `transfer_to_<my-agent>`, not `transfer_to_<my_agent>`. If your
  list has no `transfer_to_` tool, you cannot hand off.
- Say what you are about to do in one sentence before each turn of tool calls.
  When several calls go out together, one sentence covers them all.
- Send every call you can already write in the same turn. A call waits for an
  earlier result only when one of its arguments comes from that result.
- Reads of things you have already named - files, documents, line ranges, ids,
  urls - never depend on each other. Reading one to decide whether to read
  another is not a dependency: send both, and drop what you do not need.
