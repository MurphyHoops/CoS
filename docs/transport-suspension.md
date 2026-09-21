# Provider Transport Suspension

CoS 3.1 treats provider/network availability as a control-plane condition that is **separate from executor health**.

> **A missing transport is a wait, not evidence that the executor failed.**

This distinction is required for durable missions. A provider conversation can be healthy but unreachable because the network, tunnel or startup path is temporarily unavailable.

## Authority

`src/main/connection.ts` remains the single authority for connector/tunnel status.

It projects that status into the lightweight provider-transport gate in:

```text
src/main/session/connectivity.ts
```

Consumers do not independently infer internet health from browser presence, wake sockets, silence or their own timeout.

The browser wake channel is local browser ↔ CoS reachability. It is **not** proof that the machine can reach the provider.

## Semantic phases

The transport gate collapses connection details into three phases:

| Phase | Connection states | Meaning |
| --- | --- | --- |
| `ready` | `connected` | Provider/browser automation may start external work. |
| `suspended` | `offline`, `starting-server`, `connecting-tunnel` | Transient transport wait. Do not spend failure budgets. |
| `blocked` | setup/auth/disconnected terminal states | External work is unavailable until configuration/user state changes. |

Detail changes inside one phase do not create a new outage generation. A suspended episode keeps one outage anchor until readiness returns.

## What suspension freezes

While provider transport is unavailable, CoS preserves durable debt but does not advance transport-dependent failure clocks.

This includes:

- Self-Healing silence escalation and replacement admission;
- browser command delivery deadlines;
- Stop delivery deadlines;
- worker bootstrap/revival browser deadlines;
- Goal browser recovery/pickup;
- Compact & Resume browser pickup;
- provider-side Long-Run continuation dispatch;
- browser startup for queued authored input.

Evidence timestamps are **not rewritten**. CoS shifts only timeout/deadline budgets or grants a fresh post-connect observation window where appropriate.

## What may continue locally

Transport suspension does not stop work that is genuinely local.

Examples:

- a background process already owned by CoS may keep running;
- a local timer may reach its deadline;
- durable state may be written and reconciled.

A local wait may therefore resolve while offline. Its resulting WorkObligation remains `owed` until provider transport is ready to dispatch the continuation.

External wait providers that require connectivity are not polled while suspended and do not consume their monitor-error budget.

## Reconnect transaction

When the connection authority returns to `ready`, the bridge performs one serialized reconciliation:

1. compute the completed suspension interval;
2. restore transport-dependent deadline budget without changing evidence chronology;
3. reconcile legacy unattempted recovery failures that are provably safe to resume;
4. restore soft-recovery observation grace;
5. re-arm retained command deadlines;
6. resume transport-parked Goal drafts;
7. resume the same pending Stop commands;
8. resume queued browser delivery and worker/browser command delivery;
9. run the ordinary stale-work/Long-Run pickup logic against current durable state.

No subsystem mints a parallel replacement merely because connectivity returned.

## Self-Healing rule

Offline time does not consume executor recovery budget.

A new Self-Healing episode cannot start while transport is unavailable. A hard recovery that already crossed an ambiguous provider boundary remains fail-closed.

Compatibility recovery for a 3.0-era dead state is intentionally narrow: only a `recovery_failed` episode whose destination send is still `not-attempted`, with no replacement conversation, may be returned to the same recovery episode after connectivity is restored. A `dispatched-unresolved` or `sent` transaction is never replayed from network recovery.

## Stop rule

User Stop is durable control intent.

The local automation fence is applied immediately. If provider transport is unavailable, the exact Stop command remains pending instead of becoming terminal failure. On reconnect CoS resumes that same command, with the same turn identity and command id, provided the turn is still current.

## Queued authored input

Accepted input is durable before browser startup.

Transient transport suspension has no fixed 65-second failure timeout. The input waits locally. If an older queued row already carries a browser-startup failure, reconnect automatically retries browser delivery for the same durable UUID; it does not enqueue a second user message.

## Long-Run and Goal ownership

There is only one owner of the next automatic provider transition.

If a session has active Long-Run work in `waiting`, `owed`, `dispatching` or `queued` state, Goal browser drafting/pickup is parked. Goal does not race a WaitContract continuation.

Transport suspension additionally parks both until the provider path is ready.

## Crash/restart

Durable mission state remains authoritative across app restart.

Restored browser commands are not expired merely because wall-clock time passed while provider transport is unavailable. Ambiguous send checkpoints keep their existing fail-closed semantics. Local evidence and durable command identity are reconciled before any external action resumes.

## Development invariant

A subsystem that needs provider/browser reachability must consume the provider-transport gate instead of adding its own offline timeout or connectivity inference.

Do not implement:

```text
timeout → assume executor died
```

when the same observation can be explained by unavailable transport.

See [architecture.md](architecture.md), [long-run-runtime.md](long-run-runtime.md) and [../AGENTS.md](../AGENTS.md).
