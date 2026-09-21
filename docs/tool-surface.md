# CoS 3.x model-facing tool surface

This document describes the current tool philosophy. Exact schemas live in the source declarations and may be permission-dependent.

## Design rule

The model-facing surface stays small. Rich composition belongs behind tools or inside bounded Code Mode, not in dozens of overlapping schemas.

Tool availability is derived from:
- enabled capabilities;
- exact caller/session identity;
- current execution authority;
- whether the chat is stale/superseded;
- whether a long-run boundary is active;
- whether multi-agent/session tools are enabled.

## Core surface

Common Core tools include:

- `read` — files, folders and supported images inside approved roots;
- `view_image` — image inspection where enabled;
- `find` — fallback search when command execution is unavailable;
- `apply_patch` — structured file mutation;
- `exec_command` — OS command/process execution;
- `write_stdin` — interact with an owned background process;
- `update_plan` — display/update executor plan state;
- `project_runtime` — inspect/check the current project's optional machine runtime contract without exposing executable argv in status;
- `session_wait` — arm/query/cancel durable external waits;
- `session_finish` — optional finish-hold boundary for supported execution modes;
- `agents` — Prime/worker coordination when multi-agent mode is enabled;
- `exec` — bounded JavaScript Code Mode composition when enabled.

The actual tool list is frozen/published by the active MCP endpoint. Do not infer a missing permission from a tool that is intentionally not exposed.

## Code Mode

Code Mode composes one surface's tools inside a bounded JavaScript runtime.

It is not a second authority layer. Nested calls still pass through the same identity, permission, execution-epoch and recovery fences.

### Terminal yield exception

`session_wait` may act as a terminal control-flow primitive inside Code Mode when the host does not expose the direct tool.

A successful arm must:
- persist the wait;
- terminate remaining Code Mode work;
- prevent later mutation in the same source turn;
- return control so the provider turn can end.

This preserves the same semantics as direct invocation.

## Core vs Desktop vs Plugins

### Core

Owns project files, commands, session/mission tools, plans and agents.

### Desktop

Owns screen/window observation and local user-interface actions when enabled.

### Plugins

Expose separately configured external MCP servers. Plugin tools do not inherit more local authority than the active CoS session.

## Identity and custody

A tool call is not admitted solely because a schema exists.

Mutation requires:
- proven caller identity where required;
- current mission/execution authority;
- enabled capability;
- non-superseded conversation;
- no conflicting long-run/recovery fence.

Background processes belong to the durable session that created them. A different chat cannot adopt one merely by knowing the process id.

## Error semantics

Tool errors should distinguish:
- permission disabled;
- identity unavailable;
- stale/superseded owner;
- different process/session owner;
- ambiguous external state;
- ordinary command/tool failure.

A refusal is not permission to create an alternate side effect.

## Approved roots

Approved roots are permission containers, often parents of one or more projects. Paths must name the complete path under the root; do not assume the approved root itself is the project root.

## Project runtime contract

A bound project may provide `.cos/project.json` with named direct-exec tasks and machine completion predicates. `project_runtime status` publishes only the safe declarative summary; executable argv remains local. `project_runtime check` evaluates the contract under the caller's current command/filesystem permissions.

See [project-runtime.md](project-runtime.md).

## Long-running external conditions

Use `session_wait` for CI/process/timer waits instead of keeping the provider turn alive with polling.

Provider/network unavailability is a separate local transport gate. It parks provider-dependent delivery and recovery rather than converting connectivity loss into executor failure.

See [long-run-runtime.md](long-run-runtime.md) and [transport-suspension.md](transport-suspension.md).

## Source authority

Exact declarations are in `src/main/mcp/`. This document explains the contract but does not override source schemas/tests.
