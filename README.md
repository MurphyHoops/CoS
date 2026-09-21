# CoS

**Durable local runtime for long-running AI work.**

CoS keeps the mission local and durable while treating provider conversations as replaceable executors. It gives ChatGPT access to approved local files, terminals, browser/desktop capabilities and reusable workers, but the durable identity of the work lives in CoS rather than in one chat.

> **Core rule:** the mission is durable; the executor is replaceable.

CoS 3.x is maintained directly and independently in **MurphyHoops/CoS**.

## What CoS 3.x changes

Traditional chat automation tends to bind the task to one provider conversation. CoS 3.x separates them:

- **Mission/session** — durable objective, project, history, obligations and completion evidence.
- **Executor** — the currently authorized Prime or worker conversation.
- **Execution epoch** — the interval in which that executor may mutate mission-owned state.
- **Work obligation** — durable record of unfinished work.
- **External wait** — a condition supervised locally after the provider turn yields.
- **Recovery transaction** — bounded replacement of an unusable executor without replaying ambiguous mutations.

That separation enables multi-hour work without requiring one model turn to stay open for the entire job.

## Main capabilities

### Local work
- Read and edit approved project files.
- Run commands and keep background processes under durable custody.
- Optionally define a project-owned `.cos/project.json` contract for named verification tasks and machine completion predicates.
- Inspect tool results in the local timeline.
- Use browser/desktop capabilities when explicitly enabled.

### Durable long-running work
- Goal and Loop drive unfinished work through durable obligations.
- `session_wait` hands long external waits to the local supervisor.
- Provider/network outages become transport suspension rather than executor failure; durable debt resumes after connectivity reconciliation.
- Compact & Resume replaces a context-heavy conversation without changing the mission.
- Self-Healing can replace a stalled Prime or worker while preserving mission identity.
- Late/stale executors are fenced from new mutations after authority moves.

### Multi-agent work
- One Prime owns delegation intent.
- Workers own bounded sub-obligations and can sleep, revive or be replaced.
- Worker reports are persisted before live delivery so they survive transport/tab failures.

### Safe recovery
- A lost tool response does not prove the side effect failed.
- Ambiguous mutations are reconciled against local/Git/process state before retry.
- Explicit user Stop/cancellation outranks automation.
- Provider restrictions are terminal control events, not retry opportunities.

## Architecture

Read [docs/architecture.md](docs/architecture.md) first.

Canonical 3.x documentation:

- [Architecture](docs/architecture.md)
- [Setup and operation](docs/setup.md)
- [Model-facing tools](docs/tool-surface.md)
- [Long-Run Runtime](docs/long-run-runtime.md)
- [Project Runtime Profile](docs/project-runtime.md)
- [Provider Transport Suspension](docs/transport-suspension.md)
- [Security model](SECURITY.md)
- [Implementation invariants](AGENTS.md)
- [Documentation map](docs/README.md)

Older 2.x release notes, audits and worklogs are retained as historical evidence only. They do not define current behavior.

## Get started

1. Install the matching CoS app and companion extension.
2. In **Settings → Workspace**, approve the project folders CoS may access.
3. In **Settings → Setup**, connect the Core MCP app to ChatGPT Developer mode.
4. Load/reload the companion extension in Chrome/Edge.
5. Start a task from the CoS workspace.

For exact setup and recovery steps, see [docs/setup.md](docs/setup.md).

## Long waits

Do not keep a provider turn alive merely to poll CI or another slow condition.

The preferred pattern is:

```text
active executor
  → arm durable wait
  → provider turn ends
  → CoS supervises locally
  → condition resolves
  → exactly one continuation obligation
  → authorized executor resumes
```

See [docs/long-run-runtime.md](docs/long-run-runtime.md).

## Permissions and responsible use

CoS runs local tools with the permissions you explicitly enable. Durability and recovery do not expand those permissions.

- Approved filesystem roots limit file tools.
- Read-only mode removes effective mutation capabilities.
- Commands run with the normal privileges of your OS account.
- Browser/desktop control is powerful and must be enabled deliberately.
- Do not use CoS to evade provider safety decisions, usage limits or account restrictions.

CoS is independent software and is not affiliated with or endorsed by OpenAI. Provider model availability, usage limits and policies still apply.

See [SECURITY.md](SECURITY.md).

## Platform notes

Supported targets are Windows, macOS and Linux. The current macOS release target is **macOS 13 Ventura or newer**.

Release binaries are currently unsigned/unnotarized where documented. On Linux, when unprivileged user namespaces are disabled, the AppImage may require the documented `--no-sandbox` fallback; prefer the DEB if you do not want that fallback.

## Downloads

Releases: https://github.com/MurphyHoops/CoS/releases/latest

After updating:
- install the matching app build;
- reload the companion extension;
- refresh/reconnect the CoS custom app in ChatGPT when the tool schema changed.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Changes must preserve durable mission identity, execution authority, exactly-once continuation and mutation-reconciliation rules.

## Acknowledgement

CoS 3.x began from the open-source **Chat On Steroids** project created by [@totec448-spec](https://github.com/totec448-spec). Thank you for making that foundation available.

Historical contributors and third-party components remain credited through Git history, the archived 2.x documents, [CONTRIBUTORS.md](CONTRIBUTORS.md), [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
