# Generic Long-Run Runtime

CoS treats a development mission as durable local state and ChatGPT conversations as replaceable execution carriers. The kernel is intentionally project-agnostic: Lean, TypeScript, Python, research simulations, CI pipelines and other workflows use the same authority and recovery model.

## Kernel primitives

- **ExecutionEpoch** — the single mutation authority for one durable session. Rebind, stop and recovery advance or move that authority so stale executors cannot continue writing.
- **WorkObligation** — durable work debt that survives provider-turn completion, executor migration and application restart.
- **WaitContract** — a durable external condition monitored by the local supervisor instead of keeping a provider turn open.
- **ProgressCertificate** — evidence that the durable task actually advanced. Browser activity alone is not a certificate.
- **WaitProvider** — an adapter that observes one external wait kind. The scheduler never embeds project lifecycle rules.

Project workflows decide what to build, test and ship. The Core runtime only guarantees ownership, waiting, continuation, recovery and side-effect fencing.
## Waiting outside the provider turn

Use `session_wait` instead of polling an external condition inside ChatGPT.

Built-in providers:

- `github_run` — GitHub Actions run id plus owner/repository.
- `process` — a retained background `exec_command` session owned by the same durable session.
- `timer` — a local deadline.

Additional providers register a stable kind, an inspector and a semantic `provider_target`. Optional bounded `provider_data` belongs to the adapter; the scheduler core does not interpret it. Unknown providers fail closed.

A successful `action=arm` is a hard provider-turn boundary. CoS persists the WaitContract and WorkObligation before the source executor loses ordinary mutation authority.
## Host compatibility

Direct `session_wait` is preferred when ChatGPT exposes the tool natively. Some host surfaces expose only code mode (`exec`) even though the underlying MCP server advertises `session_wait`.

In that case code mode may call:

```js
await tools.session_wait({
  action: "arm",
  kind: "github_run",
  repository: "owner/repo",
  run_id: 123456
});
```

Successful arm is a **terminal yield**. The code-mode runtime immediately cuts remaining JavaScript, returns only the durable wait receipt, and refuses later nested admissions. Never place an arm call in `Promise.all` or beside an independent mutation. A refused arm does not cut the script.
## Continuation

The local supervisor observes each due WaitContract through its registered provider. Resolution changes the associated WorkObligation to owed and queues exactly one stable continuation.

Before acting, a resumed executor reconciles current files, Git state, processes, CI, receipts and workers. It must not repeat completed or ambiguous side effects.

Self-Healing and Long-Run are complementary:

- Long-Run handles expected external latency by ending the provider turn.
- Self-Healing handles an executor that should be working but becomes unresponsive.
- Executor migration carries ExecutionEpoch, active WaitContract and WorkObligation to the replacement conversation.

## Project policy boundary

Do not encode a project lifecycle such as “Lean proof → PR → ledger” in the Core runtime. Keep those rules in project instructions or future project-policy adapters. The durable kernel remains unchanged across repositories and languages.
## Invariants

1. One current ExecutionEpoch owns mutation authority.
2. Unknown or ambiguous mutations are never blindly replayed.
3. An armed wait cannot coexist with further source-turn mutations.
4. A WaitContract retry is idempotent by source turn plus stable semantic target.
5. A resolved wait queues at most one continuation identity.
6. Recovery or carrier migration cannot erase unresolved work debt.
7. Observations provide evidence; only durable kernel transitions grant or revoke authority.
8. Missing provider implementations fail closed instead of guessing completion.

Long-running tests should exercise restart, executor migration, duplicate callbacks, delayed external completion, provider errors and stale-source calls—not only isolated successful turns.
