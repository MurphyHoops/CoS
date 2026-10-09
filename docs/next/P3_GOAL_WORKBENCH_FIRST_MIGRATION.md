# P3.3 Native Goal and Plan Workbench (2026-10-09)

## Scope and why

Classic CoS users could create goals, update plans and run a long-lived Goal/Loop. The Web-First P3 preview initially shipped only a local task state ledger and a one-shot, separately approved ChatGPT website continuation. It was impossible for ordinary users to *create and edit goals and plans in the app* without knowing MCP tool names. P3.3 restores a **native goal and plan UI**, not the unattended executor.

## User workflow

Open **本地项目 → Goal / 计划工作台（创建、编辑、恢复）**. This opens a dedicated 850×760 native window, separate from the authenticated ChatGPT WebContentsView. The user can:

- Choose a registered local project and enter a goal as free text (max 2,000 chars).
- Supply up to 12 plain-text plan lines. Prefix each with `[ ]` pending, `[>]` in progress, or `[x]` completed, with an optional ` :: details` suffix. At most one in-progress step is permitted.
- Create a durable goal **directly from the user's own form submission** without asking for a redundant native permission dialog. It does not launch Codex CLI, send a ChatGPT prompt, execute code, read project contents or start a Loop.
- Edit plan steps later in the same window. The plan's revision prevents a stale form from overwriting changes made by another model conversation or native window.
- Pause an ACTIVE task, explicitly resume a PAUSED, WAITING, RECOVERY-HOLD or REVIEW task, request native reviewed completion, or cancel after native confirmation. Terminal tasks cannot be reopened or have their plan overwritten.
- See the local model limit's *paused / requires review / no local hold* status; historical list 429 is displayed separately from model usage. The presence of a local clear status does **not** prove the provider's actual remaining quota.

The dark project sidebar also displays a compact Goal count, active count and waiting/recovery-hold count, with guidance to the native workbench. The existing **P3 持久任务与恢复** menu remains available.

## Core MCP parity

Two new **server-registered but not yet ChatGPT-platform-approved** tools:

- `task_plan_status(task_id)` — fetch the plan snapshot only for an existing durable task, no file or model actions.
- `task_plan_update(task_id,expected_revision,nonce,explanation,plan)` — replace the entire bounded plan after an explicit native confirmation. A repeated nonce with identical contents returns the same revision; a stale revision, conflicting nonce, invalid plan or terminal task is rejected.

The plan schema preserves Classic `update_plan` step/status/details semantics while binding records to P3's canonical **task ID and registered project ID**. It is not the old implicit conversation-bound plan; `identity_verified=false` remains authoritative. The MCP tool catalogue is now **14 locally registered names**, but tool publication/approval in ChatGPT is a distinct gate; the previous 12 tools are unchanged.

## Security model

The Goal editor is its own `BrowserWindow` with sandbox, context isolation, web security, **JavaScript disabled**, no Node integration or preload, no network requests, no OAuth session access, and a `default-src 'none'` CSP. Native GET forms use a private `cos-next-goal://native/` destination: `will-navigate` blocks all navigation before it can leave the local window, and the main process only recognizes a small, bounded enum of form actions. User text is HTML-escaped, action names and task IDs/revisions are parsed and checked, and all project IDs are revalidated against registered native projects. Source files, persistent read grants and project write approvals are unchanged.

Plan snapshots are 0600, fsync'd, atomically replaced, capped at 360 KiB and 64 goals; the ledger rejects symlinks, corrupt data, unexpected record fields, duplicate task IDs and stale revisions. A task that was durably created but whose initial plan write failed is **not deleted**: it remains visible for recovery, rather than silently discarding a possibly completed action.

## Verification

- 3 plan-ledger tests: persist/reopen, idempotent nonce, stale revision, 1 ACTIVE step, terminal-goal immutability and unsafe ledger mode/symlink rejection.
- 3 form/HTML tests: bounded action parser, status syntax and escaped project/goal text.
- Local MCP HTTP integration verifies plan update denied without native approval, accepted with approval, exact revision and readback.
- Native lifecycle test covers pause→restart storage→explicit resume; checkpoints are blocked while paused.
- **Packaged Electron ARM64 native fixture** uses CDP mouse events and `Input.insertText` against the **JavaScript-disabled native form**, clicks the real Create button, intercepts the local form navigation, and reloads the task+plan snapshot from disk. Marker: `WEB_FIRST_OFFLINE_NATIVE_GOAL_FORM_PASS`. The actual user-facing ChatGPT page is not accessed and no model request is sent.

## Not yet done / next execution lane

This milestone is **P3 plan/governance restoration**, not parity with Classic `Goal/Long-Run` execution. The site’s model quota remains provider-enforced. During limits, durable task/plan/status/recording can continue without a model, but coding actions still require the separately scoped Core execution tools. Those `exec_command`, `write_stdin`, `session_wait` and `agents` surfaces are present in Classic but are **not ported to Web-First**. Do not automatically continue ChatGPT messages until exact chat identity, authoritative provider turn completion, and persisted outbox replay fencing pass real-site fault injection. Native plan acceptance itself never grants permission to run arbitrary shell commands or write user files.

**Deployment:** The current running Web-First window is preserved until an explicit safe switch. The isolated ARM64 goal-workbench candidate must pass complete regression and package gates before release; no GitHub push unless requested.
