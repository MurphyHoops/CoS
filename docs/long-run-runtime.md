# Generic Long-Run Runtime

CoS 3.x treats long-running work as a durable local state machine, not as one provider conversation that must remain alive.

## Core principle

> **The mission is durable; the executor is replaceable.**

Long-Run Runtime supplies the common control plane used by Goal/Loop, external waits, process custody, Compact & Resume, Self-Healing and worker continuation.

## Durable primitives

### Mission/session

Owns project identity, history, obligations, current executor binding and terminal state.

### Work obligation

Represents work CoS still owes. It records why continuation exists and prevents recovery from inventing generic "continue" prompts.

### Execution epoch

Fences mutation authority. When ownership transfers to a replacement executor, stale executors cannot start new mission mutations.

### Progress evidence

Progress must come from durable or correlated evidence such as:
- accepted/completed tool calls;
- process state;
- Git/filesystem change;
- CI state transition;
- worker report;
- verified provider turn completion.

A page merely showing "working" is not enough to erase a recovery episode.

### Wait contract

Transfers a slow external condition from the provider turn to the local supervisor.

## `session_wait`

`session_wait` is the model-facing control primitive for durable external waits.

Supported actions include status/arm/cancel according to the current schema.

Built-in wait providers:

| Kind | Target |
| --- | --- |
| `github_run` | One exact GitHub Actions run |
| `process` | One background `exec_command` process owned by the same durable session |
| `timer` | One local deadline |

The provider registry is extensible, so reusable adapters can add external conditions without changing the scheduler core.

Providers explicitly declare whether observation requires connectivity. GitHub waits do; local process/timer waits do not. Custom/open-world providers default to connectivity-required unless they explicitly opt out.

## Terminal yield

Arming a wait is a control-flow boundary.

After the wait is durably armed, the source provider turn must not continue mutating that obligation.

CoS supports:
- direct `session_wait` invocation when the host exposes it;
- code-mode terminal yield when the host virtualizes the tool behind `exec`.

The semantics are the same: arm → cut remaining executor work → local supervisor owns the wait.

## Why provider-side polling is wrong

A loop such as:

```text
gh run view
sleep
gh run view
sleep
...
```

keeps browser/provider/MCP state live for no useful reasoning work and increases the chance of stale ownership, transport loss or context churn.

The correct pattern is:

```text
start external work
→ obtain exact target identity
→ arm durable wait
→ finish provider turn
→ local supervisor polls
→ resolve
→ enqueue one continuation
```

## Wait resolution

When a provider reports a terminal condition:

1. the wait result is persisted;
2. CoS materializes/updates the obligation;
3. a continuation is queued exactly once;
4. the authorized executor receives the continuation;
5. it reconciles real state before further mutation.

A successful wait does not imply the whole mission is complete.

## Process waits

A process wait may only name a process owned by the same durable session.

If a process is no longer retained after restart/crash, CoS reports that fact and the executor must inspect the filesystem/process/project state before deciding whether any command should be re-run.

## GitHub waits

A GitHub wait names an exact repository and run id.

The continuation must inspect the actual run result and current Git/PR state before merging, pushing or re-triggering anything.

## Timers

Timers are local scheduling primitives, not progress evidence. A timer expiration means only that its deadline arrived.

## Provider transport suspension

The Long-Run Runtime does not turn provider/network loss into a wait-provider error.

While provider transport is unavailable:

- connectivity-dependent providers are not inspected and their consecutive-error budget remains unchanged;
- local process/timer providers may continue to resolve;
- a resolved local wait may make its WorkObligation `owed`;
- provider continuation dispatch remains parked;
- Goal is not allowed to become a competing next-message owner for the same active Long-Run work.

When transport is ready again, the ordinary supervisor loop resumes from the same durable WaitContract/WorkObligation. It does not create a replacement wait or generic `continue` message.

See [transport-suspension.md](transport-suspension.md).

## Machine completion

A bound project may optionally supply machine completion predicates through `.cos/project.json`.

If `completion.auto_stop` is true and the evaluator returns `satisfied`, Long-Run may fulfill an obligation only while it is still in the eligible owed state. `unsatisfied`, `blocked` and `unconfigured` never manufacture completion.

For command-backed checks, the automatic completion attempt is durably claimed before the verifier
starts. That claim survives crash/rebind for the same obligation so ambiguous verifier execution is
not replayed automatically.

See [project-runtime.md](project-runtime.md).

## Recovery interaction

Recovery does not replace a specific wait result with a generic continuation.

If an executor dies while a wait is active, the wait remains mission-owned. A replacement executor inherits only the unresolved obligation after reconciliation.

## Exactly-once continuation

The runtime distinguishes:
- wait resolution;
- continuation creation;
- continuation dispatch;
- continuation acknowledgement.

These are separate durable phases so a crash between them does not duplicate work.

## User cancellation

User cancellation/Stop can revoke the obligation or automation authority. Recovery must preserve that revocation.

## Development invariant

Any new long-run mechanism should integrate through these primitives instead of adding a parallel timer/watcher/retry state machine.

See [architecture.md](architecture.md) and [../AGENTS.md](../AGENTS.md).
