# CoS Next WP02 — MissionLease Foundation Checkpoint (2026-10-08)

**Branch:** `next/v4/wp02-mission-leases`
**Base:** `next/v4/wp01-mcp-identity` at `2fd93f4`
**Issue:** [#16](https://github.com/MurphyHoops/CoS/issues/16) · [Epic #13](https://github.com/MurphyHoops/CoS/issues/13)
**Status:** LOCAL-POLICY-GREEN / G2b REAL PRINCIPAL AND OPERATOR APPROVAL **BLOCK** / NOT DEPLOYED.

## Implemented

- `src/main/next/auth/mission-leases.ts`: isolated, non-MCP-exported MissionLease policy. A real authority adapter must authenticate caller principal **independently** of raw `openai/session`, `openai/subject` or tool arguments, and a real local administrator must approve each grant/revoke.
- `hostBindingKey()` securely domain-separates namespace, verified principal and opaque chat session with HMAC-SHA256 using a stable 32+-byte local secret. WP01 ephemeral diagnostics **cannot be reused** for durable bindings. OS-protected key provisioning is still required.
- Per-mission, per-project, per-host-binding, per-capability, epoch-checked leases with bounded TTL and explicitly approved grant/revoke.
- `DurableMissionLeaseStorage` uses the existing CoS atomic primary JSON ledger with a **Next-only ledger name**, and requires **Next-only userData** initialization. No production data was touched in tests. Existing v3.1.16 durable ledger cannot be used for this.
- Corrupt/inaccessible persisted state is **blocked**, not silently replaced with an empty ledger. Uncertain commit/write likewise enters blocked state. A well-formed restored ledger is `restart_locked` and requires new independent approval; old leases are denied even if a different mission is approved.
- Serial write queue, persist-before-grant-ack, immediate in-memory fence once revoke approval completes, and no implicit authority to the older execution epoch. Grant approvals carry server-side operation IDs with durable request fingerprints: exact approved retry returns the original lease; reused IDs with changed payload or superseded/restarted leases are denied.

## Verification

- Local Node/TypeScript `npm run typecheck`: **PASS**.
- `test/next/mission-leases.test.ts`, `mission-leases-durable.test.ts` and WP01 identity regression: **36 tests passed / 0 failed**.
- Durable tests use an isolated `os.tmpdir()` root; no live CoS credentials, projects, Tunnel, session store or app paths are written.
- Broad WP01 prior `npm run verify:ci`: **4873 passed / 129 skipped**, plus MCP shutdown **2 passed**; this is evidence for *WP01 baseline*, not a claim that the new WP02 code passed entire CI.
- Separate WP02 GitHub Actions check must pass on exact-head before considering PR merge.

## Explicit limitations / security gates

1. **G2b is not solved by these mocks.** Current `MissionLeaseAuthority.authenticate()` and `confirmApproval()` are abstract interfaces; the WP02 test fixture intentionally supplies a fake local gateway. Actual verified ChatGPT principal, user-granted approval, and stable key provisioner are **not yet implemented**.
2. `MissionLeaseRegistry` is not wired to the live `agents`, `session_wait` or `project_runtime` tools. No live Mission write permission is granted by this code.
3. Existing durable JSON is process-local serialized, **not a cross-process interlock**. A separate single-owner lock/lease for Next App and project writer must be implemented and validated before multiple instances could write concurrently. Old CoS is currently stopped, but the two versions must still never write the same project concurrently.
4. Restart posture is conservatively **fail closed**: persisted leases cannot grant a fresh process access until reapproved.
5. Grant/revoke operation-ID idempotency is implemented at the ledger level, but WP02 production gate remains blocked until real one-shot local approval receipt issuance and verification exist. External operations must recheck lease/epoch at the tool-dispatch boundary, including after asynchronous waits; a preflight `authorize` alone is not sufficient to guarantee Stop semantics.
6. Not a live Tunnel/client plugin test. A real ChatGPT connector observing official `_meta` remains **G1b PENDING**.
7. User’s existing ChatGPT plan limits still apply; no paid inference API was enabled or used.

## Next steps

- Make independent security audit pass, exact-head WP02 CI green.
- Implement OS-backed stable HMAC key provision in isolated Next identity store, verifiable authenticated actor provider and OS-level operator approval.
- Integrate permission checks as a new adapter on `mission` tools (not directly into old v3.1.16 Agent/Goal code).
- Add adversarial cross-chat and Stop/race integration tests. Only after gate proof, move to Worker, Project and long-run adapters.
