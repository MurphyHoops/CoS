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
- New Next-only `exclusive-lifecycle.mjs` admission wrapper coordinates reservation, startup, stop and independently verified child termination. Mock lifecycle tests prove two owners cannot start concurrently and that stop failures or inconclusive child termination **retain the reservation**. This wrapper is not yet called from the product's actual `connection.ts` and `tunnel/index.ts`.

## Explicit Gate limitations

**WP08 LOCAL LOCK GATE only; full integration and production release remain BLOCKED.**

1. The lock/lifecycle wrapper **is not yet called by the live `startOpenAiTunnel()` lifecycle**. Introducing a lock without reliable child stop/health/ownership/rollback barriers would yield false confidence. Integrate after verifying the old `startTunnel().stop()` return value proves the child process is gone; current v3 stop returns void and may leave a surviving tunnel-client evidenced only by lease PID files.
2. The legacy CoS 3.1.16 binary does not acquire this new lock. **A Next-only lock cannot stop legacy↔Next races**. Until dual-version ownership is established, require explicit old-App shutdown check and a single-owner maintenance handoff; do not claim the full Tunnel-competition problem is solved.
3. Atomic directory locks prevent cooperating local processes from simultaneous claims. They **do not defend against an arbitrary malicious same-user process deleting or moving lock directories**, which requires a stronger OS trust boundary.
4. A crash between mkdir and metadata write conservatively leaves an orphan directory. An administrative recovery protocol with real PID/health/endpoint proof is required; never auto-delete ambiguous locks.
5. Actual ChatGPT G1b metadata has **not** reached a Next-owned live Tunnel; WP01 synthetic SDK results are not a live host test.
6. No transfer of credential plaintext from the old Electron `safeStorage` blob into a new app process was attempted.
7. The new app bundle ID, isolated Keychain namespace, project writer lock and autonomous model executor remain future gates.

## Next

1. Verify exact-head GitHub Actions across all supported OS, including new test jobs.
2. READ-ONLY security audit the race in release, loss of orphan evidence, path/permission semantics and multi-process failure injection.
3. Wire the implemented Next-only lifecycle adapter to a real **Next-owned** connection manager only after it can independently verify child termination (current legacy `.stop()` does not provide this proof). Add integration tests for true PID and health evidence, startup cancellation and recovery; do not modify the installed app.
4. Only after independent credential provisioning/old App shutdown/real host approval, test the actual existing Core connector one-owner handoff. Record a controlled rollback and two real ChatGPT conversation fingerprints.
