# P3.4-B: safe multi-Worker restoration (native, 2026-10-09)

Status: **LOCAL TESTED / LIVE AI WORKER EXECUTION HOLD**. Active repository: `CoS-Next-P3-Auth`, branch `next/v4/p3-native-trust`. This builds on P3.4-A `1bc2320`, not the obsolete Classic-Next local branch. The original independent preview was gracefully terminated after the operator explicitly authorized it; the existing Web-First profile's `waiting` Goal was preserved.

## Terminology / actual capability

**Local diagnostic Workers (operational):** An ACTIVE Goal can request one grouped native approval for 2, 3 or 4 bounded, independent, read-only jobs, each with its own UUID, nonce, start/exit receipt, SHA-256 result and state. The fixed slot order is:

1. original directory device/inode validation (`root-check`);
2. tracked Git working tree status (`git-status`);
3. Git HEAD verification (`git-head`);
4. count of tracked Git paths (`git-tracked`).

The three Git checks spawn independently with no shell, no remote program or untrusted argument, only `/usr/bin/git` with fixed flags under the registered project root, bounded timeout and output. A team uses asynchronous dispatch of each slot and waits for individual evidence. The root check uses the native main process and is not a separate OS worker process; **the number denotes concurrent, independently receipted diagnostic slots, not a number of LLM sessions**. A non-Git project yields a failed Git check, not a falsely successful team. There are no writes, commits or repository mutations.

**AI Agent Worker assignments (persisted, NOT running):** The Goal workbench can add/remove up to four role assignments (`planner`, `builder`, `tester`, `auditor`). Each assignment has a unique worker ID, group ID, Goal ID/revision, plan revision, project ID, state `waiting-auth|review|cancelled` and timestamp. All are `waiting-auth` until a separate future trusted ChatGPT identity, per-worker conversation binding, quota and turn-receipt system is accepted. Model messages are NEVER started from these records, even if the profile carries old CoS credentials. No credential import or browser copy took place.

## User-facing operation

Open **目标 → 打开 Goal / 计划工作台** (`⌘⇧G`). Under an ACTIVE Goal:

- In **本地 Worker 并行数（不是 AI Agent）**, choose 2, 3 or 4 and click **启动只读 Worker 预检**. Confirm the native macOS approval dialog once, which describes the exact bounded scope. The latest per-slot local receipts display below the Goal. No one can override a blocked/finished Goal or supply arbitrary shell parameters.
- In **配置 AI Worker 角色（只登记，不发送消息）**, select 1–4 and click **＋ 添加 AI Worker 分工**. Existing roles are not duplicated. Use **移除** beside an individual assignment to cancel that slot. Pausing or cancelling the Goal cancels all waiting-auth assignments. Changes to Goal or plan revision move stale slots to **review** and do not silently inherit permission.

The Goal itself is never marked completed because a worker check returned 0 or a role was registered. Previous task records, workspaces and ChatGPT authentication partition remain separate from this workflow.

## Durable controls and restart guarantees

Local diagnostics use the existing `web-first-local-jobs.json` receipt ledger, with `O_NOFOLLOW`, 0600 permissions, 64-record bound, atomic fsync update, nonce fencing, project device/inode and task/plan revision checks. The group is admitted atomically after the native approval. Running/queued slots at process restart become `review`, not automatic replay; a paused/cancelled Goal stops its own active children. At most one newly approved diagnostic team per Goal can be queued/running at once, so parallel slots cannot compete with another team for that Goal.

AI assignments use their own owner-private, fsynced `web-first-ai-worker-roster.json` (64 historical records). Ledger corruption fails closed for the AI assignment UI, without destroying Goal or plan editing. On startup, assignments with changed Goal/plan revision become review-needed. The roster has no method that can send provider turns or claim AI completion.

## Local validation

- Unit tests: exact native protocol, duplicate/oversize/invalid worker counts, separate receipt UUIDs, 4-slot real Git status/HEAD/tracked-count with zero model access, team contention/denial and crash recovery, AI role uniqueness and capacity, stale plan transitions, individual removal, cancellation and hostile ledger rejection.
- Electron macOS ARM64 native package verification, plus real Chromium pointer clicks in a disposable profile: create Goal, advance plan, approve fixed local check, click 2-slot team, add AI Worker and remove it. Markers: `WEB_FIRST_OFFLINE_TWO_WORKER_TEAM_PASS`, `WEB_FIRST_OFFLINE_AI_WORKER_ASSIGNMENT_PASS`, `WEB_FIRST_OFFLINE_AI_WORKER_REMOVE_PASS`. No real chat transmission is attempted.
- The user’s previous Web-First preview was explicitly stopped. Final new app may be launched with the existing Web-First profile only after package/regression gates are clean.

## Next critical milestone: REAL AI agents, not pretending local Workers are AI

1. Per-Agent **MissionLease** and exact parent Goal/plan revision with delegated bounded scope; fork a non-mutating worker first and prove its result is attributable to that worker, not another conversation.
2. Trusted **conversation identity and send/receive receipts**, and one-shot model admission per worker. No reuse of opaque old cookies, credential migration or hidden HTML scripting. Preserve the old Mission Kernel Worker state transitions `QUEUED → CLAIMED → FINISHED/DELIVERY_UNKNOWN`, with verifier receipts.
3. Per-worker context/budget, 429 cooldown, 2–4 process/chat slot limits, safe Stop and abnormal-retirement accounting. A sent-but-unacknowledged turn cannot be replayed automatically.
4. Worktree isolation for write-capable agents, deterministic merge/review protocol, conflict detection and one authorized integration authority. **No two write agents to one working tree**.
5. Real provider loss/reload/identity swap, simultaneous worker claims, stale revision and recovery experiments; CI and cross-platform gates before claiming production multi-Agent support.

This slice is **P3.4-B worker slots and AI role registry**, not old CoS production multi-Agent parity. Autonomous AI Loop remains HOLD.

## Final acceptance receipt

- `npm run verify:ci` completed with **exit 0**: 5,139 ordinary tests passed, 131 skipped and 0 failed, plus 2 independent MCP shutdown tests passed. Static typechecking, privacy and notices checks are part of that run.
- Built macOS ARM64 candidate `release-next/webfirst-p34b-worker-final/mac-arm64/CoS Next Web-First Preview.app` passed bundle verification and the disposable-profile native Electron run with `WEB_FIRST_OFFLINE_TWO_WORKER_TEAM_PASS`, `WEB_FIRST_OFFLINE_AI_WORKER_ASSIGNMENT_PASS`, `WEB_FIRST_OFFLINE_AI_WORKER_REMOVE_PASS`, `WEB_FIRST_OFFLINE_LOCAL_JOB_APPROVED_EXECUTED_PASS` and existing durable/continuity markers. No live provider turn was created.
- UI also supports **移除** on each AI Worker slot, with exact worker UUID and Goal revision fencing. Capacity counts waiting-auth roles, while stale review records are still displayed for audit.
