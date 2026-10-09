# P3.4-A — native-approved durable local diagnostic queue

Local development acceptance: 2026-10-09. Branch: `next/v4/p3-native-trust`.

## Exact implemented capability

Inside the existing Goal workbench, an **ACTIVE** Goal has two optional native-only diagnostic actions:

- **检查项目目录** (`root-check`): read-only revalidation that the registered absolute project directory still has its original device/inode identity and is not a symlink. The recorded digest includes the task ID and directory identity, not the directory name or contents.
- **检查 Git 状态** (`git-status`): exactly `/usr/bin/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain=v1 --untracked-files=no --no-renames` under that same project root. Spawn is shell-free with a fixed sanitized environment, 10-second timeout, 12-second hard kill guard, a 32 KiB output ceiling and explicit per-task stop. Only exit code, count of tracked changed entries and output hash are retained; no source text, filenames, stdout, cookies, ChatGPT messages or Git diff are persisted.

The user clicks a button and accepts one macOS native confirmation before the queue is allowed to write a durable `queued` receipt. Approval is for **only that exact operation on that exact Goal**, not an inherited permanent trust grant. No MCP tool and no ordinary ChatGPT message can enqueue/dispatch a local job. No untrusted shell command, arbitrary arguments or project file mutation exists in this slice. The queue is strictly independent from the provider inference path: an already-approved check can complete during a model quota cooldown; it never attempts model use or bypasses platform restrictions.

## Durable safety contract

Ledger: `web-first-local-jobs.json` in the Web-First app profile. Owner-only 0600, symlink excluded, O_NOFOLLOW, inode check, 160 KiB and 64-job caps; serialized operations and fsync of file+directory after atomic rename. Each record stores job UUID, nonce, Goal ID/revision, plan revision, project ID/device/inode, native approval timestamp, bounded kind, `queued|running|succeeded|failed|review`, start/end receipt, sanitized result and SHA256. Duplicate exact nonce has one identity; incompatible duplicate nonce is an error. Only one `queued` or `running` job per Goal at a time.

Dispatch revalidates the live Goal's ACTIVE phase, exact task and plan revision and project inode. A changed condition produces `review` before execution. On process restart, both queued (not dispatched) and running (unknown exit) jobs transition to `review`: neither is automatically replayed. The operator can make a **new, separately approved** diagnostic request after reviewing history. Pausing/cancelling a Goal cancels that Goal's currently active child, without stopping another project's child. Closing the app cancels active children; uncertain receipts are reconciled at next launch. No job receipt is permitted to change a Goal to `completed`.

The original task/plan ledgers, ChatGPT login partition, Classic CoS app, Core Tunnel/Keychain and model throttle supervisor are reused, not cleared or migrated. The app currently does not automatically install or replace the running user's live preview. Local isolated smoke fixtures use a disposable profile and waive native modal **only under the existing explicit offline fixture mode**.

## Verification and boundaries

- Unit tests cover native approval/denial, idempotent nonce, second in-flight job denial, model cooldown injection, real `/usr/bin/git` status, no source name/content persisted, stale plan or paused task, symlink and unsafe file protections, root inode swap, queued/running reboot hold and no duplicate launch.
- Packaged macOS ARM64 Electron offline fixture opens the real JS-disabled workbench, creates a Goal through native pointer input, completes a real plan step, clicks the `root-check` button and reloads the real fsynced diagnostic receipt; marker `WEB_FIRST_OFFLINE_LOCAL_JOB_APPROVED_EXECUTED_PASS`.
- The native package can be checked using `node scripts/verify-next-webfirst-package.mjs <absolute-app>` and run with `COS_NEXT_WEBFIRST_OFFLINE_SMOKE=1 <absolute-app>/Contents/MacOS/CoS Next Web-First Preview`. **This is not a live ChatGPT/production Goal/Loop test**.

**P3.4-A is foundation only:** Git status and directory verification are not the old Classic `exec_command`, `session_wait` or multi-agent. A bounded, authorized build/test catalog, durable operation scheduler, live 429/Stop/reboot fault injection, exact ChatGPT conversation identity, one-shot message receipt and per-task Model resume gates remain `HOLD`. Never represent local snapshot success as verified Goal completion or automatically replay a sent-but-unacknowledged web turn. Cross-platform `git` executable and process termination need separate validation before Windows/Linux promotion.

## Accepted local receipts (2026-10-09)

- `npm run verify:ci`: exit 0 — **5,128 ordinary tests passed, 131 skipped, 0 failed**, plus **2 additional MCP shutdown tests passed**. Includes typecheck, notice generation check, public-history privacy check and targeted queue tests.
- `release-next/webfirst-p34-final/mac-arm64/CoS Next Web-First Preview.app`: `WEB_FIRST_P1_PACKAGE_GATE=PASS`, matching ARM64 bundle identity and no legacy Chrome extension/Codex inference code in the Web-First bundle.
- Packaged isolated Electron smoke: `WEB_FIRST_OFFLINE_LOCAL_JOBS_HELD=0`, `WEB_FIRST_OFFLINE_MAIN_WINDOW_VISIBLE_PASS`, `WEB_FIRST_OFFLINE_NATIVE_GOAL_FORM_PASS`, `WEB_FIRST_OFFLINE_GOAL_STEP_ADVANCE_PASS`, `WEB_FIRST_OFFLINE_LOCAL_JOB_APPROVED_EXECUTED_PASS`, `WEB_FIRST_OFFLINE_DURABLE_TASK_RPC_PASS`, `WEB_FIRST_OFFLINE_BROWSER_CONTINUATION_PASS`. There were no unhandled promise rejection warnings in the final capture.
- Source changes are local only; existing authenticated preview and its registered original project/task data were not modified in this acceptance run.
