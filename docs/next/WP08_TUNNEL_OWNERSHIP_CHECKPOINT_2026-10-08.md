# CoS Next WP08 — Tunnel Ownership Recovery and Gate Report

Date: 2026-10-08. Canonical task: [Issue #18](https://github.com/MurphyHoops/CoS/issues/18), [Epic #13](https://github.com/MurphyHoops/CoS/issues/13). Branch: `next/v4/wp08-tunnel-ownership`, parent: `b78ef40` (WP02).

## Reconciliation after conversation interrupted

- Prior in-flight source was found **only in this local worktree**, uncommitted: `src/main/next/tunnel/exclusive-owner.mjs`, `exclusive-owner.d.mts`, `test/next/fixtures/tunnel-owner-worker.mjs`, and `test/next/tunnel-exclusive-owner.test.ts`.
- No separate WP08 PR or remote branch initially existed; GitHub latest exact-head CI for WP01/WP02 was green. No overlapping edit or process remains active.
- Installed old `/Applications/Chat On Steroids.app` is 3.1.16. OS process check found **no running old CoS or tunnel-client**; no termination or secret extraction performed. Old userData/Keychain/Chrome extension untouched.
- Earlier user screenshot showed many Desktop Commander actions, but **a progress list is not durable proof of completed commits or working CI**. Only directly inspected files/commits/CI are counted.

## Implemented and tested locally

- `exclusive-owner.mjs`: hash-based tunnel-ID-only lock path, independent of Core/Desktop/Plugins label, using atomic OS directory creation (`mkdir`) across processes. Only accepts syntactically valid IDs, labels and absolute roots.
- Owner `nonce`, PID, label, timestamp recorded without raw Tunnel IDs, API keys, credentials, or raw session metadata.
- Another process holding the same ID blocks admission. A dead/unknown owner blocks until an explicitly reviewed reconciliation; automatic stealing or killing any process is forbidden.
- Owner verification checks recorded nonce/PID and directory inode before release; release first atomically renames the reserved directory to a nonce-specific retired location. The retired directory is checked again before removing it. Concurrent release callers share one promise and cannot remove the next owner's lock.
- True child-process tests verify contention, concurrent race, crash retention, stale lock, label independence, different IDs, tamper detection, single-flight release and successor safety. All tests use disposable `os.tmpdir()` directories and a fake Tunnel ID.
- CI workflow `.github/workflows/next-tunnel-ownership.yml` covers macOS, Windows and Linux runners, TypeScript check, privacy guard and these cross-process tests.
- `next-openai-transport.ts` now composes the **actual existing startTunnel() API** through the Next-only exclusive lifecycle wrapper, with two operator-supplied legacy-process checks before launching, default global lock-root enforcement, and forced `nextRejectOrphans` mode. The existing OpenAI tunnel handle now returns `stopWithProof()` for direct tracked-child process shutdown while retaining old `stop(): Promise<void>` behavior. The original installed 3.1.16 binary remains untouched.
- New Next-only `exclusive-lifecycle.mjs` admission wrapper coordinates reservation, startup, stop and independently verified child termination. Mock lifecycle tests prove two owners cannot start concurrently and that stop failures or inconclusive child termination **retain the reservation**. This wrapper is not yet called from the product's actual `connection.ts` and `tunnel/index.ts`.

## Explicit Gate limitations

**WP08 LOCAL LOCK GATE only; full integration and production release remain BLOCKED.**

1. `next-openai-transport.ts` can now invoke the *real* `startTunnel()` with the Next lock, but **no Next application entrypoint or production connection manager calls this new function yet**. The integration tests use a mocked launcher, and child-shutdown proof tests use the tracked child-process fixture. Introducing a lock without reliable child stop/health/ownership/rollback barriers would yield false confidence. Integrate after verifying the old `startTunnel().stop()` return value proves the child process is gone; current v3 stop returns void and may leave a surviving tunnel-client evidenced only by lease PID files.
2. The legacy CoS 3.1.16 binary does not acquire this new lock. **A Next-only lock cannot stop legacy↔Next races**. Until dual-version ownership is established, require explicit old-App shutdown check and a single-owner maintenance handoff; do not claim the full Tunnel-competition problem is solved.
3. Atomic directory locks prevent cooperating local processes from simultaneous claims. They **do not defend against an arbitrary malicious same-user process deleting or moving lock directories**, which requires a stronger OS trust boundary.
4. A crash between mkdir and metadata write conservatively leaves an orphan directory. An administrative recovery protocol with real PID/health/endpoint proof is required; never auto-delete ambiguous locks.
5. Actual ChatGPT G1b metadata has **not** reached a Next-owned live Tunnel; WP01 synthetic SDK results are not a live host test.
6. No transfer of credential plaintext from the old Electron `safeStorage` blob into a new app process was attempted.
7. The new app bundle ID, isolated Keychain namespace, project writer lock and autonomous model executor remain future gates.

## Next

1. Verify exact-head GitHub Actions across all supported OS, including new test jobs.
2. READ-ONLY security audit the race in release, loss of orphan evidence, path/permission semantics and multi-process failure injection.
3. Wire `startNextExistingOpenAiTunnel()` into a **separate Next-owned** connection manager only after trusted OS approval/credentials and real legacy-off verification. Harden child-tree PID/health evidence and implement recovery; do not modify the installed app.
4. Only after independent credential provisioning/old App shutdown/real host approval, test the actual existing Core connector one-owner handoff. Record a controlled rollback and two real ChatGPT conversation fingerprints.

## Post-recovery real API integration (2026-10-08, second implementation pass)

- `src/main/next/tunnel/next-openai-transport.ts` is an **opt-in Next-only executable entrypoint** composing the production `startTunnel(opts)` with the previously audited per-Tunnel-ID lock and lifecycle guard. Before spawning, it checks an independently supplied legacy-off predicate both outside and inside the claimed lock; production lock roots are fixed globally, and test-only custom roots are refused in production mode.
- `src/main/tunnel/index.ts` now exposes optional `TunnelHandle.stopWithProof(): Promise<boolean>` while preserving legacy `stop(): Promise<void>`. It tracks earlier failed retirements, the active child shutdown, and refuses a positive receipt after any unverified stop. This is **tracked child/process-tree termination evidence**, not yet a separate OS kernel-level attestation of all arbitrary descendants; release requires a stronger real-process audit before production adoption.
- `nextRejectOrphans` is a Next-only tunnel startup option: it blocks instead of automatically killing/reclaiming legacy PID or health-file evidence. Normal legacy behavior is unchanged.
- New tests cover the actual existing tunnel adapter under mocked process fixtures, Next transport composition, production lock-root refusal, two legacy-off checks, missing stop proof, failed stops and old publication files. Production Core Tunnel was **not** started and no legacy API secret was touched.
- Latest local full `npm run verify:ci` after real adapter changes: **4,925 tests passed / 129 skipped**, plus **2 MCP shutdown** tests, typecheck/privacy/notices passed. A later single root-guard negative test also passed in a focused **36/36** run. Latest GitHub exact-head CI must be re-run after commit.

**Do not promote to G1b PASS:** neither the live Next app nor an officially authenticated ChatGPT Core Tunnel is running this code. `NextTransportGuards.assertLegacyStopped()` still requires a real, independently implemented legacy-process/owner verification provider, and Next's OS-managed secret store is not configured. Existing 3.1.16 is deliberately stopped.
