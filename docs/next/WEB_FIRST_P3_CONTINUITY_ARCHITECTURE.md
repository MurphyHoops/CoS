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
