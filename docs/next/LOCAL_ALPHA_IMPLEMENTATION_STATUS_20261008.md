# CoS Next — local alpha implementation and release gates (2026-10-08)

**Status: LOCAL ALPHA / NOT PRODUCTION / NO CLOUD PROMOTION AUTHORIZED.**
Worktree branch: `next/v4/wp03-mission-runtime`, based on previous WP01/WP02/WP08 local-only changes. The existing CoS 3.1.16 app, its persisted state and its registered Tunnel identifiers remain outside this app.

## Implemented and locally exercised

- **Independent Electron application:** `com.chatonsteroids.next`; independent userData, single-writer lock, default offline model, loopback-only MCP diagnostics. No import of legacy CoS startup/extension/bridge. Mac arm64 ad-hoc development bundle launches and exits with `COS_NEXT_SMOKE=PASS` and asserts no remote connector/inference was started.
- **Native administration:** local approval tickets (opaque object identity, short TTL, single-use, scoped operation/mission), registering a canonical project root, browsing projects/Missions with new operator consent, and provisioning Mission with an explicit machine-verification completion contract.
- **Mission ledger:** authoritative epoch, revision, project root inode/device binding, durable effect admission, deduplication, Stop/Pause fences, process-tree cancellation notice, durable UNKNOWN_EFFECT/DELIVERY_UNKNOWN reconciliation, independently checked completion predicates.
- **Agent lane:** Worker queue/claim/report in one ledger, durable claim/final receipt fences, optional plan-backed Codex app-server JSONL adapter tested with an offline fake model, multi-agent concurrency budget, no model turn replay after ambiguous exit.
- **External wait:** locally attested CI/process event state, independently verified success vs failure, durable CONTINUATION_OWED separate from any model ACK, one-time resume receipt after a locally observed model turn, bounded polling with retry limits and hard deadlines. GitHub Actions adapter pins the repository, run ID, optional SHA and canonical run URL. Its opt-in real read-only test checked an already completed run without triggering a workflow.
- **Exact command permissions:** native executor approves *program + complete argv + timeout + Mission + invocationId* as one frozen request, not just a general interpreter binary. Real child-process success/failure/timeout/Stop/Pause and no-repeat tests use temporary directories.

## Facts that prohibit a production-ready claim

1. **G1b real ChatGPT metadata still unproven:** the live ChatGPT host has not demonstrated its session identifiers through the new MCP entrypoint. Synthetic metadata is correlation-only and cannot grant permission.
2. **G2b principal verification incomplete:** no production OAuth or trusted host identity adapter exists yet. New App intentionally publishes only `runtime_health` and `identity_diagnostics`; Agent, shell and Mission mutations remain inaccessible from ChatGPT.
3. **Autonomous model remains opt-in/unverified:** the machine lacked a local Codex executable at development time. Offline fake JSONL tests do **not** prove entitlement, account OAuth, real Codex model turns, quota behavior, or thread recovery. Do not auto-fallback to separately billed API.
4. **No extensionless autonomous ChatGPT-Web turns:** generic MCP cannot prove it can send a fresh model turn into an existing webpage conversation. In mode A, continuation stays OWED until the host/user runs a new turn. Only explicitly authorized plan-backed local model (mode B) might eventually execute in background.
5. **Independent Tunnel handover is not enabled:** previous Core/Desktop/Plugins identifiers have incumbent owners. The Next app must not contend for a Tunnel ID or silently replace the old app. Approval and an intentional cutover/rollback plan are required.
6. **Release gates remain:** real identity + OAuth end-to-end, native permissions UX and denial, actual Codex app-server, multi-agent sustained crash/Stop/quota testing, clean Windows/Linux packaging and macOS signing/notarization strategy. Current bundle uses ad-hoc signing only.

## Acceptance workflow

1. Run all local tests and `npm run verify:ci` in a checkout with physical `node_modules`, record exact pass/fail/skip counts.
2. Run `electron-vite build --config electron.vite.next.config.ts`; build isolated macOS preview using `electron-builder.next.yml` and run `COS_NEXT_LOCAL_SMOKE=1` against that actual bundle.
3. Check that neither legacy app nor Tunnel was started, confirm bundle ID, installed app integrity, no extension payload, clean git diff, no secrets and no use of old userData.
4. **Do not push or release** if real G1b/G2b, account-plan entitlement, cross-platform distribution and full behavior gates remain unresolved. Commit completed local artifacts only; preserve HOLD status and the old runtime.

There is no external billing, no quota circumvention and no automatic replacement of the original app in this local alpha.
