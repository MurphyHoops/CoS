# CoS Next P3.3.1 — native experience & execution-readiness plan

Date: 2026-10-09. Source of truth: `CoS-Next-P3-Auth`, branch `next/v4/p3-native-trust`. **Local candidate only; do not claim that an autonomous Goal Loop exists.** Classic source remains available as a compatibility reference, not the active product.

## Product goal

The user should be able to operate Next as a normal native application: (1) find a project, (2) create a Goal, (3) break it into a plan, (4) see trustworthy progress and waiting/recovery states, (5) deliberately complete a step or change goal phase, (6) safely continue allowed operations through model throttling without losing receipts, and (7) allow model/browser follow-ups only when their own authorization gates are met. Progress indicators are facts about the **local plan ledger** and not proof that the assistant has completed the underlying work.

## This slice: shipped into local isolated candidate

1. **Top orientation:** visible 48px native header above the real ChatGPT WebContentsView; distinguish Core handshake from tool publication/entitlement; show the Goal shortcut `Cmd+Shift+G`. Header is an inert, sandboxed, JavaScript-disabled renderer, not an injected ChatGPT page script.
2. **Project sidebar:** matched typography, compact cards, consistent access and connection states, clear project/Goal counts and discovery guidance. Strict CSP; no links, networking, renderer IPC or dynamic scripts.
3. **Goal workbench:** distinct overview counters (total, active, waiting/attention, completed), prominent create flow, separate model-rate-limit panel, priority-ordered active Goal cards, humane status labels, visual plan progress, optional detail editor, collapsed terminal history, readable feedback. It retains the original local-only form origins and revision checks, with no new provider/browser privileges.
4. **Fast manual plan progress:** `advance` uses a bounded exact native form and verifies **task ID + task revision + plan revision + step index + active phase**. The selected step must be the sole explicit `in_progress` step; it is marked completed and the next pending step (if any) becomes in progress. No model execution, shell, project write, webpage send or task completion is implied. The existing per-plan stale revision and fsync durability still apply. Duplicate/stale clicks fail closed.
5. **Native shortcut:** separate first-class `目标` macOS menu and `Cmd+Shift+G`; the older menu names remain for compatibility. The Goal editor opens at 1040×820 and responds to narrower widths. All visual changes preserve JavaScript OFF, no preload, no network and strict native form interception.

## Verified / limits

- Native package can create Goal through real UI, save initial steps, click a real step-advance button via Chromium input, and read changed local plan snapshot: `WEB_FIRST_OFFLINE_GOAL_STEP_ADVANCE_PASS` (synthetic project in temporary root only).
- Packaged Web-First path also tests real visible window, local MCP receipt, project lookup/read/replace and one-off offline browser continuation fixture. This does **not** confer a real ChatGPT chat identity or a real provider send receipt.
- Rate-limit state is displayed as a separately qualified local observation. Model limit 429 and history-list 429 are distinct. Clearing a local cooldown is **not** evidence of provider quota readiness.
- Normal user app / authenticated partition, old CoS credentials, native grants and task journal are not modified during isolated build/test. Active app should only be switched when its in-flight messages/drafts and Core ownership are accounted for.

## P3.4 execution architecture (next core milestone, not yet implemented)

**A. Trusted task and capability intent.** A native per-Goal execution policy names registered project ID, permitted operation category, exact paths and bounded budget. Never infer execute or write authorization from a Goal's free-text description or from an unverified conversation ID. Background `git status`, preapproved tests and bounded CI polling may run under explicit, persisted native authorization; unapproved shell commands, edits and pushes remain HOLD.

**B. Durable model-independent local queue.** Store `operation_id`, exact parameters and digest, task ID/revision, scoped authorization receipt, enqueue and start journal positions, timeout, output hash, exit receipt and side-effect class. Atomic writes/0600/no symlink/fsync. Resume only proven read-only repeatable operations; an unknown-impact mutation must transition to `REVIEW` instead of replay. Restart reconcile operations against real process/session state and nonces. Enforce one executor per project/task and bounded time, disk, CPU and output.

**C. Provider wait state.** Distinguish `MODEL_COOLDOWN`, `HISTORY_LIST_DEGRADED`, `NETWORK_OFFLINE`, `AUTH_REQUIRED`, `KEYCHAIN_PENDING`, `NATIVE_REVIEW`, `RECEIPT_UNCERTAIN`. While the model is throttled, only already authorized local work and status/CI checks proceed. Do not invent provider remaining quota. After cooldown, require fresh model readiness plus task/plan/source/lease reconciliation.

**D. Web follow-up loop gate.** No silent `send` or timer-based prompt retry. Require exact conversation binding, own chat turn, current visible composer, unambiguous provider turn completion, durable outbox receipt, per-task user opt-in with turn/time ceilings and immediate Stop. A sent-but-unacknowledged web turn becomes `UNCERTAIN` after process loss, not a replay candidate. Document the platform's model turns as chargeable to its usage limits.

**E. Goal/Loop closeout.** A successful local command is an operation receipt, not Goal completion. Verify tests/assertions/artifacts and require native review for terminal success. Expose a clear timeline in the Goal workbench, including evidence, blocked reasons, next action and remaining authorized budget. Reuse Classic `exec_command`/`session_wait`/multi-agent patterns only after mapping their authority to current Web-First grants.

## Acceptance before advertising unattended Goal/Loop

- Real local policy enqueue/run/restart and rate-limit injection, with **no duplicate side effects**.
- Test exit receipt, task/plan revision fencing, failed permission, changed project inode/root and corrupt journal fail-closed cases.
- Provider 429, login interruption, Core disconnect, process crash, reload, user Stop, stale conversation and uncertain web-send recovery, all tested with authenticated real account where appropriate.
- Cross-platform macOS/Windows/Linux packaging and accessibility (keyboard, zoom, high contrast). Current local candidate is macOS ARM64 only.

**Shipping rule:** Keep `deployment=HOLD` for autonomous loops until all gates are proved; do not mistake fixture test results or pretty UI for live authorization.

## 2026-10-09 local acceptance receipt

- `npm run verify:ci`: **exit 0** — 5,119 ordinary tests passed, 131 skipped, plus 2 standalone MCP shutdown tests passed; no test failures. Typechecking, public-history privacy and package notices checks passed within the command.
- Fresh macOS ARM64 package `release-next/webfirst-p3-ui-r4/mac-arm64/CoS Next Web-First Preview.app`: verified Bundle ID, executable architecture, package contents and native Tunnel resource. `WEB_FIRST_P1_PACKAGE_GATE=PASS`.
- Isolated bundled Electron offline smoke: `WEB_FIRST_OFFLINE_MAIN_WINDOW_VISIBLE_PASS`, `WEB_FIRST_OFFLINE_NATIVE_TOPBAR_PASS`, `WEB_FIRST_OFFLINE_NATIVE_GOAL_FORM_PASS`, `WEB_FIRST_OFFLINE_GOAL_STEP_ADVANCE_PASS`, `WEB_FIRST_OFFLINE_DURABLE_TASK_RPC_PASS` and `WEB_FIRST_OFFLINE_BROWSER_CONTINUATION_PASS`.
- The previously running process remains the original `webfirst-p3-goal-workbench` build and is **not replaced** mid-chat. The new package is a side-by-side **local candidate**, not a verified live ChatGPT account run or production release. No GitHub push authorized for this slice.
