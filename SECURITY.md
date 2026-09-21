# CoS 3.x security model

## Reporting a vulnerability

Do not open a public issue for a security vulnerability. Use GitHub private vulnerability reporting for **MurphyHoops/CoS**.

Include the smallest useful reproduction, CoS version, OS/architecture and the affected capability. Redact usernames, paths, conversation text, account/workspace identifiers, connector URLs, tunnel tokens and credentials. Rotate any credential that was exposed.

## Security model

CoS is a local capability boundary plus a durable orchestration runtime.

The most important distinction is:

> **Recovery may restore work continuity; it may not expand authority.**

### Capability boundaries

- File tools are restricted to folders the user approved.
- Read-only mode removes effective file writes, commands and mutating browser/desktop actions.
- `exec_command` runs with the privileges of the logged-in OS user. Approved roots choose its starting workspace; they are not an OS sandbox.
- Browser/desktop capabilities can act outside one project folder when explicitly enabled and should be treated as powerful.
- MCP services bind locally; public reachability exists only through the configured tunnel.
- Credentials stored by CoS use Electron `safeStorage` where supported.

### Durable authority boundaries

A mission can outlive one provider conversation, but only the current execution epoch may mutate mission-owned state.

When an executor is replaced:
- the source executor is fenced;
- the replacement attaches to the same mission;
- local/Git/process/tool evidence is reconciled;
- only unresolved obligations continue.

Late results from an old executor may be recorded as evidence but cannot silently restore its authority.

### Mutation ambiguity

Transport failure is not evidence that a mutation failed.

If a tool response is lost after dispatch, CoS must inspect receipts, process state, files, Git or the target system before retrying. Blind replay is a security and correctness bug.

### Long external waits

A long wait should be handed to the local supervisor. After `session_wait` arms a wait, the source turn loses the right to keep mutating that obligation. This prevents one provider turn and the local supervisor from racing the same task.

### User control

Explicit Stop, cancellation, permission removal and changed objectives are durable control-plane events. Recovery must not reinterpret them as failures to work around.

### Provider rules

Provider restrictions are not recovery targets. Do not switch accounts, chats, connectors or tools to evade safety decisions, usage limits or account restrictions.

CoS is independent software and is not affiliated with or endorsed by OpenAI.

## Stored data

Session recording can contain detailed conversation and tool activity. It is local application data and is not automatically encrypted as a whole. Anyone with access to the OS account may be able to read it.

Do not place secrets in logs or public issue reports.

## Expected limitations

- Release binaries may be unsigned/unnotarized as stated in the release notes.
- On Linux, if unprivileged user namespaces are unavailable, the AppImage may use the documented `--no-sandbox` fallback. Prefer the DEB if you do not want that fallback.
- Approved-root checks are application controls, not a VM/kernel sandbox.
- Command and browser/desktop control capabilities are intentionally powerful.

## Scope

In scope:
- CoS desktop app;
- Core/Desktop MCP surfaces;
- durable session/mission runtime;
- Long-Run/Self-Healing/continuation logic;
- local browser bridge and companion extension;
- packaged first-party helpers.

Third-party providers, Electron/Chromium, tunnel binaries and external services should also be reported to their respective maintainers where appropriate.
