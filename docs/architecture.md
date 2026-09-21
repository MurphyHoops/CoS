# CoS 3.x architecture

CoS 3.x is a **durable local runtime for long-running AI work**.

The architectural break from the 2.x line is simple:

> **The mission is durable. The executor is replaceable.**

A ChatGPT conversation is one execution carrier for the work. It is not the identity of the work itself. The durable authority lives locally in CoS: session/mission state, work obligations, execution epochs, tool receipts, process custody, worker state, recovery transactions, external waits, queued user input and completion evidence.

This document is the canonical architecture overview for CoS 3.x. `AGENTS.md` turns these principles into implementation rules.

## 1. System model

The runtime is split into five layers:

1. **Mission layer** — what the user asked to accomplish and what obligations remain.
2. **Execution layer** — the currently authorized Prime/worker conversations that may act.
3. **Evidence layer** — tool receipts, browser observations, process state, Git/filesystem state and provider turn signals.
4. **Recovery layer** — bounded same-executor repair, executor migration, restart reconciliation and stale-owner fencing.
5. **Supervision layer** — local timers, external waits, worker lifecycle and exactly-once continuation delivery.

The browser, tunnel, ChatGPT conversation and model turn are execution resources. They can disappear or be replaced without redefining the mission.

## 2. Identity hierarchy

CoS uses different identities for different facts. They must never be collapsed into one another.

| Identity | Owns |
| --- | --- |
| Local session / mission | The durable unit of work, project association, history, obligations and current executor binding |
| Execution epoch | One interval in which a specific executor set may mutate mission-owned state |
| ChatGPT conversation | A provider-side execution carrier; replaceable |
| Turn | One provider generation attempt within a conversation |
| MCP request | One tool-call transport request |
| Tool/process receipt | Evidence that a local action was accepted, progressed or completed |
| Worker run/family | Prime-owned worker coordination state |
| External wait | A locally supervised condition that can outlive any provider turn |

A new conversation does **not** create a new mission. A new turn does **not** create a new mission. A browser reload does **not** create a new mission. Those events may create or refresh execution leases only.

## 3. Durable mission authority

A mission consists of durable facts such as:

- the user's current objective and constraints;
- project/workspace identity;
- pending work obligations;
- completed and ambiguous side effects;
- current execution epoch;
- Prime and worker roles;
- queued corrections or follow-up instructions;
- open external waits;
- active recovery or replacement transaction;
- completion evidence and terminal state.

Mission state is written before CoS relies on it for later recovery. Ephemeral UI projections may be rebuilt from durable state; durable state must never be reconstructed from a convenient UI guess when exact evidence exists.

## 4. Work obligations

Long-running work is represented as obligations, not as a stream of repeated "continue" prompts.

An obligation answers four questions:

- **What remains?**
- **Who currently has authority to act?**
- **What evidence proves progress?**
- **What condition closes the obligation?**

The local runtime may continue a mission only while a live obligation exists. No component may invent new work merely because a timer fired, a chat reopened or a previous turn was quiet.

This is the central defense against runaway continuation loops.

## 5. Execution epochs and stale-owner fencing

Every mutating execution belongs to an execution epoch.

When ownership moves from conversation A to conversation B:

1. CoS durably records the replacement transaction.
2. A is fenced from new mission mutations.
3. B is attached to the same mission.
4. CoS reconciles receipts/processes/files/Git/worker state.
5. Only then is B allowed to continue unresolved work.
6. A late result from A may be recorded as evidence, but it cannot silently regain authority.

The same rule applies to Prime replacement, worker replacement, Compact & Resume and Self-Healing.

## 6. Evidence before inference

CoS prefers exact evidence in this order:

1. durable local receipts/state;
2. exact request/conversation correlation;
3. current browser/Fiber turn evidence;
4. process/Git/filesystem inspection;
5. bounded conservative inference.

Silence is not success. Visible prose is not necessarily a final turn. A lost tool response is not proof that the side effect did not happen. A new chat is not proof that old work should be repeated.

When a mutating outcome is ambiguous, recovery must inspect durable/local state before deciding whether to retry.

## 7. Provider turns are short-lived execution leases

A provider turn should do active reasoning and tool work while useful. It should not be kept alive merely to poll a slow external condition.

For long waits, the executor arms a durable local wait with `session_wait` and yields. CoS then owns the waiting clock and condition. When the condition resolves, CoS materializes one continuation for the same mission.

This separates:

- **thinking time** — model-owned;
- **tool/process time** — local execution-owned;
- **external waiting time** — local supervisor-owned.

## 8. Generic Long-Run Runtime

The Long-Run Runtime is the common substrate for multi-hour work. It is not a special mode tied to one provider feature.

It supplies:

- durable obligations;
- execution epochs;
- progress certification;
- external wait ownership;
- recovery/replacement fencing;
- continuation deduplication;
- terminal semantics.

Goal, Loop, Compact & Resume, Self-Healing, Prime/worker coordination and background process recovery all project onto this substrate.

## 9. Goal and Loop

Goal and Loop are **mission drivers**, not mission identity.

- **Goal** asks whether the requested finish line has been reached and may stop when no further work is owed.
- **Loop** keeps producing additional in-scope work until the user disables it or the mission reaches a terminal boundary.

Neither mode may manufacture authority outside the current mission. Their decisions must consume the same durable evidence and obligations as the rest of the runtime.

## 10. Compact & Resume

Compact & Resume is planned executor replacement caused by context pressure.

It does not "move a task to a new task." It replaces the provider conversation while preserving:

- session/mission identity;
- project/workspace;
- obligations;
- worker family;
- process custody;
- queued user input;
- recovery/continuation provenance.

The replacement uses a durable transaction and the same stale-owner fences as emergency recovery.

## 11. Self-Healing

Self-Healing handles an executor that becomes unusable.

The sequence is bounded:

1. detect a failure using provider/browser/local evidence;
2. attempt one bounded same-executor repair where appropriate;
3. if still unusable, claim the session replacement transaction;
4. open one replacement executor;
5. attach it to the same mission and role;
6. reconcile actual local state;
7. continue only unresolved obligations;
8. retire the source executor's mutation authority.

Self-Healing never treats missing tool history as permission to replay a mutation.

## 12. Prime and workers

Prime and workers are execution roles inside one durable mission.

Prime owns delegation intent. Workers own assigned sub-obligations. Worker chats are reusable execution carriers, not permanent identities.

A worker may sleep, revive or be replaced without losing its durable assignment history. Worker reports are persisted before live delivery so Prime can recover them after transport or tab failure.

Workers must not create a second independent mission for work that belongs to their Prime.

## 13. External waits

`session_wait` moves waiting authority from the provider turn to CoS.

A wait records:

- mission/session identity;
- execution epoch;
- condition description;
- supervision source;
- timeout/cancellation semantics;
- continuation deduplication identity.

A successful arm ends the source turn's right to keep mutating that obligation. The continuation is delivered exactly once when the local supervisor has evidence that the wait resolved.

## 14. Tool and process custody

Tool calls and background processes are owned by durable execution context, not by whichever chat happens to be visible later.

For mutating operations:

- admission is explicit;
- completion is recorded;
- publication/acknowledgement is distinct from execution;
- lost publication does not imply lost execution;
- recovery reads existing receipts/process state before retrying.

Background process output may be delivered after conversation replacement when durable custody proves it belongs to the same mission.

## 15. User control

User intent outranks automation.

Explicit user actions such as Stop, cancellation, changed objective, permission removal or project reassignment are durable control-plane events. Recovery must not reinterpret them as transient failures.

Queued corrections remain attached to the mission even if the current executor is replaced.

## 16. Permissions and safety

Durability does not expand authority.

Filesystem roots, read-only mode, command permissions, browser/desktop permissions and plugin permissions remain capability boundaries. Recovery can restore a mission only within the permissions that are currently enabled.

Provider restrictions are not retry conditions. CoS must not switch accounts, chats, connectors or tools to evade a provider safety or usage decision.

## 17. Repository authority

The canonical repository is **`MurphyHoops/CoS`**.

CoS 3.x is maintained directly in this repository. Historical and external repositories may be inspected as references, but external code is treated like any other third-party proposal:

1. identify the concrete problem or useful change;
2. audit it against current CoS invariants;
3. port only the required behavior;
4. write/update CoS-native tests;
5. validate in this repository;
6. commit the result as CoS work.

There is no synchronization or merge lane from another repository in the CoS 3.x development model.

## 18. Canonical documentation

Current behavior is defined by:

- `docs/architecture.md` — architecture and identity model;
- `AGENTS.md` — implementation invariants and code ownership map;
- `docs/tool-surface.md` — model-facing tool contracts;
- `docs/long-run-runtime.md` — long-run state machine and waits;
- `docs/setup.md` — user setup and runtime operation;
- `SECURITY.md` — permission and threat model.

Older 2.x release notes, worklogs and audits are historical evidence only. They may explain why code exists, but they do not override the documents above.

## 19. Acknowledgement

CoS 3.x began from the open-source **Chat On Steroids** project created by [@totec448-spec](https://github.com/totec448-spec). We are grateful for that foundation and for the earlier community work that made this independent runtime possible.

See `CONTRIBUTORS.md` and the repository license/notices for attribution details.
