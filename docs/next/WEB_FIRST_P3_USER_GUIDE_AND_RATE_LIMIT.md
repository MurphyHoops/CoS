# CoS Next Web-First P3 — User guide and limit-aware continuation

**Status (2026-10-09):** This is a Web-First native preview, **not** full Classic Goal/Loop parity. Its primary inference surface is the **official ChatGPT site inside Electron**, not an external Chrome tab/extension or Codex CLI. Website model use remains subject to the user's ChatGPT subscription and provider usage limits.

## How to use the current installed preview

1. Open the CoS Next window. The left dark sidebar shows locally registered project bookmarks; selecting a bookmark does **not** automatically grant an AI filesystem or terminal permission.
2. From native **本地项目 → 连接现有 ChatGPT Core Tunnel（需批准）**, connect the previously registered Core Tunnel. After native confirmation, use **查看登记与 Core MCP 状态** to inspect connectivity. ChatGPT's plugin tool registry is a **separate** approval/refresh gate.
3. Register the actual **source directory** through **添加项目目录（仅本地登记）**. The currently registered project may only be an empty testing directory and is not automatically the source repository.
4. In the P3.3 Goal candidate, use **本地项目 → Goal / 计划工作台（创建、编辑、恢复）** to create a goal, enter up to 12 plan steps, pause/resume, or save the complete plan with revision fencing. In a ChatGPT conversation, you may alternatively ask it to create a **durable local task** for the registered project. It will call Core `task_begin(project_id, goal)`, which needs native approval. `task_checkpoint`, `task_status`, and `task_wait` track progress without performing work or making model calls. Example goal: *Audit the repository, run its local tests, fix the failing cases, and request final review without overwriting uncommitted work.*
5. Open **本地项目 → P3 持久任务与恢复** to inspect the latest task, authorize resume from `waiting`/`recovery-hold`/`review`, confirm a reviewed completion, or cancel. A model's “done” assertion alone never completes a task.
6. The menu **在当前 ChatGPT 网页续接任务一次（需确认）** can type **one** explicitly approved follow-up into the exact current ChatGPT chat, with crash-safe delivery receipt and maximum five submissions per task and chat. It is not yet an unattended Loop. **开始/停止当前对话连续工作观察** only observes and checks safety; it never submits a message.
7. `project_list`, `project_ls`, `project_read`, `project_find` and `project_replace` are the current project Core tools. Persistent approvals are scoped to **read** operations only; `project_replace` requires each write's exact SHA-256 and separate native macOS confirmation. General terminals (`exec_command`, `write_stdin`), Classic multi-agent (`agents`), Classic implicit-chat `update_plan`, executable Goal/Long-Run and the multi-agent coordinator are **not fully migrated** into Web-First Core yet.

## What happens on a usage limit

**The following are three different failure modes, not one global “blocked” state:**

| Event | Meaning | Correct behavior |
| --- | --- | --- |
| ChatGPT `conversation-list` HTTP 429 | Chat/history list requests are being throttled | Mark **history degraded**; **do not** claim model generation capacity is depleted, delete chats, or aggressively retry the list |
| Other ChatGPT backend API HTTP 429 | Some provider API operation is limited; may or may not be model generation | Conservatively pause new optional website model-turn submissions, use bounded backoff; recheck before resuming |
| ChatGPT site says model messages/usage exhausted without a 429 | Consumer model usage limit (not always accessible to an HTTP status observer) | Native **本地项目 → 限流暂停与恢复（保留任务） → 模型限流：暂停 30 分钟** (new candidate build) |
| Core Tunnel offline but ChatGPT UI works | Local MCP transport failure, not necessarily model quota | Reconcile broker/process receipts and use bounded reconnect; do **not** duplicate the active Tunnel owner |

The new **rate-limit supervisor** writes only a 0600 local metadata state (no URLs, cookies, prompts or message text) and survives App restart. History-only 429 tracks a separate local degradation window, never globally blocking model work. Ambiguous API 429 starts a 2-minute exponential backoff up to 30 minutes. A manual observed model cap starts a 30-minute cooldown. Actual provider recovery **may occur earlier or later**; local backoff is not a published quota-reset schedule.

On expiry, the app reports **operator review**, not “quota restored.” The user verifies service availability on the official ChatGPT site, then explicitly confirms local recovery. This removes the local pause only; it does **not** send a queued prompt, reset task state or advance the Goal. The one-shot task continuation checks the rate-limit state both before and after its macOS confirmation prompt. Existing durable task checkpoints, safely authorized non-model local operations, project browsing and local build processes remain logically independent of model quota.

## Continuous-work contract to restore from Classic (not yet present)

**Goal is not the same as a durable task record.** The target end-to-end design is:

`Native goal + editable task plan → checked local operation queue → ChatGPT official page reasoning → exact chat/task/turn receipts → approved Core tools → checkpoint → provider-limit wait → resume/reconcile → final review.`

- **P4a (native plan foundation achieved in P3.3):** The Goal workbench now creates, persists and edits task-bound plan metadata; MCP `task_plan_status`/`task_plan_update` require independent ChatGPT tool publication. Next add richer progress/history UI and proof-scoped conversation binding. Do not import Chrome extension or legacy implicit session identity.
- **P4b:** Port terminal, file patch, long-running child process, `session_wait`, project runtime profile, output receipts and user stop/pause commands. During model limits, deterministic queued steps (CI polling, pre-approved bounded commands, file integrity inspection) may continue safely **only if previously explicitly authorized**. They must not invent new AI judgments.
- **P4c:** Bound ChatGPT website automatic continuation by an exact verified conversation owner, provider turn completion evidence, persisted outbox, monotonic task revisions, and time/turn/usage budgets. Limit expiry must never blindly replay an uncertain prompt.
- **P4d:** Fault-inject App/browser/Tunnel restart, provider 429, website cap banner, history-list 429, slow responses and partial file operations; prohibit false “completed,” duplicate side effects and silent provider switching. Any optional independent inference provider requires explicit user approval and its own quota/account rules. There is **no** technique to override OpenAI's server-side usage limits.

The P3.3 preview's **running** binary may be older. A separate verified `webfirst-p3-goal-workbench` ARM64 candidate includes the rate-limit menu and Goal editor; local packaging does not constitute a live deployment. Never confuse a passing offline fixture with a live ChatGPT website generation-loop acceptance test.

## P3.3.1 workbench UI (2026-10-09)

Open the new 「目标」 menu or press ⌘⇧G to open the Goal workbench. The older local-project menu option remains. The dashboard separates active, waiting, completed, and archived goals. Edit plans in collapsed panels. The model cooldown panel is informational, not proof of provider entitlement.

In an ACTIVE Goal with an explicit `[>]` step, click 「✓ 完成当前步骤」 to mark it `[x]` and bring the next pending `[ ]` step into progress. This only changes the versioned native plan snapshot after exact task/plan revision checks. It does not run the plan, send a browser turn or complete the parent Goal. To change other steps, expand plan editing.

The native top toolbar and project sidebar now use one visual language; the ChatGPT web partition is untouched. See `P3_UI_PRODUCT_AND_LOCAL_EXECUTION_PLAN.md` for the P3.4 durable queue and recovery gates.

## P3.4-A: authorized local checks from Goal workbench

An ACTIVE Goal now shows **检查项目目录** and **检查 Git 状态**. These initiate a separate, explicitly confirmed native-only diagnostic operation, not an automatic model-generated action. Only the fixed project inode check or bounded Git status command is permitted. Each operation writes a durable local job receipt, exposed as the latest check status on the Goal card. Git counts tracked-file status entries only, not untracked files. No source names or stdout are written to the receipt.

Under ChatGPT model cooldown, approved local checks may still complete without additional inference. On restart, interrupted or undispatched jobs go to **待复核**, not a silent replay. Pausing/cancelling the Goal stops its running local check. If the separate diagnostic ledger is corrupt, the check buttons are unavailable but the Goal and plan editor remain usable. This is **not** arbitrary `exec_command`, a full Goal/Loop engine, or entitlement to send another ChatGPT prompt. See `P34_NATIVE_LOCAL_JOBS_FIRST_SLICE.md` for the audited boundary.

## P3.4-B native multiple Workers

Inside an ACTIVE Goal, select **2 / 3 / 4** under **本地 Worker 并行数**, then click **启动只读 Worker 预检**. One macOS approval admits that group of fixed, independent directory/Git inspection jobs; each produces a separate durable local receipt. A checked Git result may report failure when the project is not a Git repository; it is not a failed model turn.

Separately, **AI Worker 分工** lets you add/remove up to four planned roles (规划/开发/验证/审计). These are **registered only** and explicitly display `等待可信会话授权`; they do not send ChatGPT prompts. A stale plan moves an old role to review. Goal pause/cancel cancels waiting roles and stops active local checks. See `P34B_MULTIWORKER_NATIVE_FIRST.md` for precise safety and pending real AI-agent requirements.

## P3.4-C one-click local acceptance

Choose **本地项目 → 运行一键本机功能验收（只读）** to check current registered projects, Goal/plan/job/Worker ledger readability, grant storage, rate-limit state, website loading, the local Core MCP catalogue and broker handshake. Read the **通过 / 待完善 / 异常** breakdown, not only the PASS count. This view does not reveal stored secrets or inspect conversation text, issue a model turn, edit a project or change permission. The verification of ChatGPT-side tool publication and true multi-AI Worker execution remains HOLD until separately proved. Full evidence and failure boundaries are in `P34C_FULL_ACCEPTANCE_REVIEW_20261009.md`.
