# Web-First P3/P4 continuity and Classic tool preservation (2026-10-09)

## Product source of truth

The live app is built from `CoS-Next-P3-Auth` (`next/v4/p3-native-trust`), **not**
the older `CoS-Next-WebFirst-P1` or `CoS-Next-WP03` worktrees. Preserve the
current app's authenticated ChatGPT partition, Core Tunnel/Keychain broker,
project registry, per-project native grants and P3 operation receipts. No Chrome
extension or Codex CLI inference belongs to the primary Web-First path.

The user owns all automated work: an initial project-task approval is required.
Read consent never promotes to file edits, terminal control or git pushes. The
current Core Tunnel still does not cryptographically prove an individual
ChatGPT conversation; caller-supplied conversation IDs are not authorization.

## Continuity contract

`task_begin(project_id, goal)` → macOS native confirmation → durable local task;
`task_checkpoint(task_id, revision, nonce, note)` → bounded, idempotent
reported-progress event; `task_wait(task_id, revision, nonce, minutes|null)` →
durable manual/timed wait; `task_status(task_id)` → compact status; and
`task_finish_request(task_id, revision, nonce, note)` → **review-requested**,
not verified completion. The user approves **resume**, **complete** or **cancel**
from the native `本地项目 → P3 持久任务与恢复` menu.

The JSON ledger is 0600, atomically written and fsync'd, size/record bounded,
validated on every read and project-root dev/inode fenced. In-flight ACTIVE
tasks become RECOVERY-HOLD at startup. Uncertain operations are not repeated,
and fake model completion claims cannot change a task to COMPLETED. Only
native operator approval does so. A failed/invalid ledger disables automation;
it must not silently reset tasks. No user-project source contents are stored
in task events by default. These are **local work state tools**, not an extra
model, inference API or an unattended browser executor.

## Web turn driver: next gates (not yet complete)

1. Opt-in page observer inside **Electron WebContentsView**, not an external
   Chrome tab/extension. Correlate exact `chatgpt.com/c/<id>` navigation with
   stable assistant-turn DOM/protocol evidence. Read neither cookies, storage,
   tokens nor hidden prompt state; fail closed on navigation/virtualization.
2. A native-owned outbox with exact message nonce, persisted decision and
   delivery receipt. Never submit the same generated follow-up twice if a crash
   occurs after the browser accepted it but before disk acknowledgement.
3. Bounded continuous-work mode requires explicit task grant, exact chat
   binding, user-set time/turn budget, provider settle evidence and a pause
   mechanism. Waits monitor external conditions locally; tool calls do not
   consume an additional model inference. Follow-up ChatGPT website turns do
   count against platform usage limits and must not be described as free.
4. Recover from crashed windows/Tunnel/keychain with the same task ID and
   no lost receipts, no silent reruns, and no false Goal completion claim.
5. Only after these gates, add delegated project write/patch and command
   execution with separate approvals, path controls, idempotency, and audited
   stdout/stderr. For non-verified chat principals, high-risk operations remain
   explicitly authorized and cannot inherit permanent read grants.

## Classic Core tool preservation

Source of truth: `src/main/mcp/surfaces.ts`, 14 Classic Core names. A tested
compatibility manifest in `core-parity.ts` tracks every one. The original
Classic implementation remains intact; *not* all tools are migrated to the
Web-First server yet. Availability is based on actual MCP `tools/list`, not
on the existence of old source code or what ChatGPT used to advertise.

| Classic tool | Web-First migration phase |
| --- | --- |
| runtime_health, identity_diagnostics | Already available |
| read, view_image, find | Native read / bounded browse planned |
| update_plan, project_runtime, session_wait | Task/diagnostic adaptation planned |
| apply_patch, exec_command, write_stdin | Needs separately verified mutation/terminal authority |
| agents, exec, session_finish | Optional or identity-sensitive, not yet migrated |

**New native Web-First tools:** `project_list`, `project_ls`, `project_read`,
`task_begin`, `task_status`, `task_checkpoint`, `task_wait`,
`task_finish_request` — plus the existing two diagnostics. MCP metadata
refresh in ChatGPT is needed to expose new tool names; local registration
alone does not publish them to an approved platform app.

## Local deletion record

After verifying version, `com.chatonsteroids.app` Bundle ID, non-symlink
root, inactivity and exact absolute parent, five abandoned `/Applications`
app bundles were permanently deleted: 3.1.0 (one), 3.1.1 (two), 3.1.2 (one),
3.1.4 (one); total 2,315,939,927 bytes of regular-file data before removal.
The active 3.1.16 app, the 3.1.15/3.1.16 backups, source worktrees, Next
builds, user project roots, session data and secrets were preserved. Any
unversioned dmg/zip archive was left unmodified because its contained app
version was not positively verified.

## Native WebContents reply receipt: implemented P3b foundation

The opt-in `开始/停止当前 ChatGPT 回复记录` menu binds the capture window to
**one** `https://chatgpt.com/c/<conversation-uuid>` at a time. It never reads
cookies, Keychain, localStorage, provider network bodies or unrelated tabs.
The recorder reads only the **visible** assistant DOM (`innerText`) through
its own Electron WebContentsView and stores the result locally under a 0600,
append-only, fsync'd journal, with a 24 KiB per-message/4 MiB log limit. User
consent is required once to start; navigating to a different conversation
stops capture. `查看已接收的 ChatGPT 最新回复` displays the last local entry.

The native settle tracker needs a visible, non-generating assistant reply,
ready editor and at least 4.5 seconds of stable content over two observations.
A re-render of identical text is deduplicated. This is **stable browser
presentation evidence**, not a server-verified assistant turn boundary.
The recording defaults **OFF** on every process launch; a task start does
not implicitly enable it. It does not automatically post messages or infer
that a goal has been achieved from assistant prose.

Isolated packaged Electron smoke exercises actual WebContents input AND
visible assistant DOM capture/persistence (`WEB_FIRST_OFFLINE_ASSISTANT_RECEIVE_PASS`),
then task_begin → checkpoint → task_wait over the authentic local MCP socket
(`WEB_FIRST_OFFLINE_DURABLE_TASK_RPC_PASS`). These tests are synthetic fixtures;
no real ChatGPT turn or additional inference is spent. Real-site streaming,
virtualized/history DOM, interrupt/restart and cross-conversation behavior
remain explicit future acceptance gates before enabling any bounded autonomous
follow-up loop.

The default task model deliberately stays **user-and-tool-driven** in P3b;
next build must add durable exact-conversation outbox, post-send receipt,
fail-closed replay protection and opt-in turn/time budget before auto-followups.

## P3c — native one-shot web continuation with crash-safe delivery receipt

`WebFirstWebOutbox` stores a per-task/per-conversation explicit instruction,
operator-approved local nonce and delivery state in a 0600 fsync'd atomic
ledger. Its lifecycle is `queued → dispatching → delivered` on positive
visible DOM evidence, otherwise `uncertain`; restart downgrades both queued
and dispatching messages to **uncertain**, never replays either automatically.
Nonce collisions with changed arguments and corrupted/tampered journals fail
closed. A task can submit at most five explicit follow-ups per ChatGPT chat,
with no other automatic message submissions.

The native `本地项目 → 在当前 ChatGPT 网页续接任务一次（需确认）`
menu operates only on an already **ACTIVE** and user-approved task. The
operator chooses a task, sees the exact outgoing prompt and confirms once;
there is no browser-autopilot default. The recipient must be the exact live
`https://chatgpt.com/c/<conversation-uuid>` currently open in the app; an
existing draft, active generation or changed navigation refuses dispatch.
Electron's OWN WebContents debugger dispatches genuine pointer/keyboard/text
input directly into the official page's visible composer, without an external
Chrome instance/extension or backend model API. A new rendered user message
matching the exact proposed text is required for DELIVERED; otherwise the
status remains UNCERTAIN and CoS cannot automatically resend it. The local
request must be durably marked DISPATCHING before the first input event.

A **real packaged macOS ARM64 Electron offline browser fixture** has passed
`WEB_FIRST_OFFLINE_BROWSER_CONTINUATION_PASS`: a native click/type/Enter
created a user message in the fixture, and the exact outbox proof survived
fresh on-disk reload. The same smoke also passed native assistant reply
capture, task begin/checkpoint/wait, file reads, grant recovery and browser
input. No ChatGPT account, Codex CLI, Chrome extension or model usage was
involved. Actual ChatGPT **website** acceptance is still HOLD until user
opts in to a real one-shot message and we compare authoritative turn state.

### Remaining gates for uninterrupted Goal/Loop

A bounded automatic follow-up supervisor with verified current-chat ownership,
provider turn-settle evidence, task-specific opt-in, pause/stop, time/turn
budgets and per-message durable receipts is **not yet enabled**. The current
WebContents stable DOM observer is not strong enough to authorize automatic
continuations by itself, especially across chat switches, virtualized history
and provider changes. Old Classic multi-agent, exec/patch, project runtime,
session wait and goal-loop backends remain in their original modules and the
compatibility matrix; they have not yet been fully migrated into this new
Web-First server. Keep the independent Core/Plugins/Desktop tool boundaries.

## P3d — dead Core Broker handle and bounded native reconnect

A later read-only live audit of the **previous running P3 preview** found its
Electron UI process alive but no active `tunnel-client` and a ChatGPT Core
`Tunnel-client has not been seen for 300 seconds` response. This does **not**
prove an invalid Keychain credential or an OpenAI authentication failure. It
shows the live Core delivery path was offline. The older native host retained
`coreTunnel` even when its broker child had exited, so subsequent menu
Connect calls could return early with an unusable handle, and Close could
fail on an unprovable stop receipt.

The repaired transport now exposes a truthful child-process `alive` flag. A
disappeared broker is reconciled before reconnect/disconnect. If an orphaned
`tunnel-client` or another Core owner is present, recovery fails **HOLD**;
never start a duplicate owner. If the broker is provably absent, the stale
handle can be retired without falsely claiming `stopWithProof` succeeded.

After one native approval to connect, the current app process also has a
bounded background recovery policy: no repeated approval dialogs, maximum
four attempts per incident, exponential retry backoff capped at 90 seconds,
reset only after five minutes of healthy connection. A live offline poll with
an existing broker **does not** trigger a second process: let the tunnel's
own network retry recover. Manual Disconnect or window Close cancels the
self-heal grant. It never launches a model inference or sends ChatGPT prompts.

Pure recovery decision tests cover revoked consent, broker already alive,
orphan owner, retry due time and exhaustion. Native bundled offline smoke
continues to pass all P3 tools, input and reply receipts. A real long-duration
OpenAI Broker crash/restore with platform tool receipts must still be tested
separately before claiming field-level auto-recovery validation. The running
older app is intentionally not hot-replaced while its web draft/session may
be in use. This fix is in the next independently packaged preview build.

## P3e scoped project text search

`project_find(project_id, relative_path, query)` is a new bounded, native-
approved literal search under a registered root. It lists filename matches
and bounded UTF-8 line snippets; it does not execute shell/regex or expose
user project paths. Hidden folders, `.env*`, credentials/private keys,
`node_modules`, linked paths and files larger than 32 KiB are skipped. Search
is bounded by depth 5, 360 scanned entries, 24 results and a 3-second
budget, with directory identity checks. It uses the existing per-project read
authorization (one approval or scoped persistent grant). A dedicated MCP test
proves sensitive files and symlink escapes are not returned. This is **not**
a full Classic `find` compatibility replacement; that original schema and
advanced search features remain tracked in the migration matrix.

ChatGPT's published tool snapshot must be refreshed to advertise this new
tool, independently of the native Core Tunnel connection. The running P3
instance is not hot-patched; the next preview package contains this change.

## P3f per-file bounded editing tool

`project_replace(project_id,relative_path,expected_sha256,old_text,new_text)`
provides a non-automatic, **single-file exact text substitution** under a
registered project. It only edits existing regular UTF-8 files of at most
32 KiB; old and replacement text inputs are limited to 4,000 characters.
The caller must provide the correct SHA-256 of the current full file and the
old span must occur **exactly once**. The target is revalidated after a
mandatory, default-deny macOS native write-approval dialog that shows the
requested path and before/after snippet. Filesystem writes are staged in the
same directory with O_EXCL, fsync'd and atomically renamed; the original
mode is preserved. Symlinks, directory escapes, hard links, sensitive paths
and changed source content are rejected. Only the SHA and byte count return
over MCP; project body content is not written into the operation receipt.

Permanent **read** grants do not grant any write authority. This does not
expose terminal commands, arbitrary patch application, file deletion, folder
creation or Git push. The original Classic `apply_patch` remains unmigrated,
tracked by the parity ledger. Real local MCP integration tests prove approval
denial, successful exact replacement, stale SHA refusal, duplicate span
refusal and sensitive/symlink rejection; packaged offline Electron smoke now
covers search and replacement against disposable fixture content only.

## P3g native Electron main-window visibility hardening

A separate read-only native UI audit after successful Core connectivity
found no accessible main window associated with the running Web-First owner,
even though the headless MCP/Broker/Tunnel were responding. The native
`BrowserWindow` had `show:false` and was only revealed in `ready-to-show`.
Because the actual ChatGPT site resides in child `WebContentsView`, this
platform event is not a reliable sole readiness signal. The host now reveals
the window exactly once either on `ready-to-show` or after a 2.5-second
fallback timer, while web content continues loading. The fallback does not
read cookies, modify messages or start a model turn. The bundled offline
Electron smoke explicitly asserts `host.window.isVisible()` and emits
`WEB_FIRST_OFFLINE_MAIN_WINDOW_VISIBLE_PASS`. Real macOS foreground and
logged-in website acceptance must still be checked after version switch.

## P3h consolidated native Core connection approval

The manual `连接现有 ChatGPT Core Tunnel` action previously prompted twice:
first for the local-only MCP listener and then for the existing OpenAI Core
Tunnel. This was redundant for one user-requested connect operation and
could lead to approval fatigue. The same native Core connection confirmation
now explicitly covers **both** the local MCP listener and the existing
Tunnel/Keychain broker. Direct `启用本机 Core MCP` remains its own separate
consent path. No project read, file mutation, shell operation or third-party
plugin permission is broadened by this change. Reentrant Connect clicks are
coalesced while the approval is pending; native Disconnect still stops and
revokes the process-local reconnect grant.

## P3i bounded continuity observer and safety gate

A new pure, unit-tested `continuity-gate.ts` assesses the next-turn boundary
against an exact user-approved task and ChatGPT conversation, a process-local
15-minute/3-turn observation lease, active task phase, durable outbox delivery
receipts, a new settled visible assistant message and checkpoint timing.
Expired grants, changed chats, waiting/review/recovery-hold tasks, any
UNCERTAIN outbox, exhausted turn budget, old replies or missing progress hold
rather than proceed. The type explicitly sets `autonomousNextTurnAllowed`
to `false` because DOM stability and the native task revision do not prove
provider-final turn state or which ChatGPT principal issued a tool call.

The operator can activate an in-memory, read-only observation session from
`本地项目 → 开始/停止当前对话连续工作观察（不自动发送）` and inspect the decision at
`本地项目 → 检查连续工作安全门禁`. This requires one native selection of an
ACTIVE task, binds exactly one ChatGPT conversation, automatically ends on
chat navigation, expiry or App exit, and does not store any credentials or
initiate a ChatGPT model turn. It does **not** grant write/exec permissions or
activate unattended autopilot. The existing **one-shot** continuation retains
its separate explicit native confirmation.

## P3j — white ChatGPT pane triage and fail-visible recovery (2026-10-09)

**User report:** Native project sidebar and Core Tunnel are operational, but
ChatGPT's `WebContentsView` occupies the remaining window with a solid white
area and no chat controls. This is **not** equivalent to Core MCP connectivity.
Mac-wide unauthenticated `curl` to `https://chatgpt.com/` returned HTTP 403,
but that result alone cannot establish the logged-in embedded Electron page's
actual HTTP status or prove an account/authentication problem.

**Repair:** A first-party `PageRecoveryGate` tracks sanitized *main-frame*
HTTP status codes, network navigation errors, renderer disappearance, and a
sustained truly empty DOM. It never reads page text, HTML, cookies, message
identifiers, account information, or auth redirect URLs. Electron now overlays
a separate sandboxed **no-JavaScript, no-network** error panel above the blank
ChatGPT pane, with a readable reason and explicit native reload instructions.
The overlay is torn down on legitimate navigation and on window close. A
persistently empty fully loaded ChatGPT document may be reloaded once per app
process **only if it has no composer, visible UI or interactive buttons**.
A nonresponsive renderer is surfaced for manual recovery, never auto-retried.

The native `ChatGPT 网页 → 安全重新加载网页（保留登录）` menu calls
`reloadIgnoringCache`; no cookies or project data are cleared. `检查网页健康状态`
now exposes only main-document HTTP status, recovery category, whether an
empty-page reload has already occurred, aggregate status-code totals and
non-content DOM input counts. Loading errors must not silently become a
successful `did-finish-load` health claim.

**Regression:** Pure tests cover login/loading/content guards, no repeated
reload, 403-only metadata, network errors, renderer loss and 3x nonresponsive
polling. Packaged ARM64 Electron offline smoke proves a **real native recovery
WebContentsView overlay is mounted at nonzero dimensions**, alongside all
previous main-window, MCP file, task, web send/receive, grant and receipt
checks. Full regular and MCP shutdown tests pass. This verifies the native
failure UI, but **not** real account-page restoration: perform a controlled
restart with the existing login partition and collect only opt-in sanitized
page/network diagnostics before declaring the user-facing blank screen fixed.
