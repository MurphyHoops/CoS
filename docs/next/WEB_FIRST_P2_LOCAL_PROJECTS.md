# Web-First P2a — native local-project integration (2026-10-09)

## Product boundary

The user's real ChatGPT website is the assistant and conversation UI, hosted
inside an Electron WebContentsView. CoS provides an independent **native**
project/execution pane. A ChatGPT website tab is **never** handed the local
filesystem, project catalogue, terminal, Electron IPC, cookies or credentials.
The platform's official, authenticated Core MCP connection remains the only
future bridge for ChatGPT tool calls; it must first pass its actual published
schema, transport identity and permission tests.

No Codex CLI/model API, local model or Chrome browser/extension is involved.
The app does not auto-send chat prompts, and does not pretend ChatGPT web use is
unmetered. The user's confirmation that the last user message was sent from
this embedded page upgrades P1's authenticated website and manual turn gate
from provisional to **user-observed PASS**.

## P2a completed implementation

- `src/main/next/web-first/project-registry.ts`: explicit native directory
  bookmarks, unique UUIDs, `realpath`, directory verification, deterministic
  duplicate handling, serialized edits, 0600 atomic writes under *this Web-First
  profile only*. Read validates owner, file type, permissions, schema, limits,
  duplicate IDs and canonical absolute paths. Corruption/links fail closed; no
  silent reset, file reads within the project, git scans, commands or upload.
- `src/main/next/web-first/project-sidebar.ts`: escaped, CSP-locked **static**
  local project labels and status. It has no JavaScript, preload, IPC, ChatGPT
  cookie access, external links or permissions. The sidecar uses its own
  separate WebContentsView to the left of the real ChatGPT content view.
- `src/main/next/web-first/native-host.ts`: macOS native `本地项目` menu allows
  choosing a folder via Electron system dialog, asks for a separate visible
  confirmation, then registers only that directory. User can view project count,
  inspect Core connection posture and toggle the side pane with Cmd+Shift+P.
  Core always shows `尚未连接／未授权` until the real trusted P2b gate exists.
- `src/main/next/web-first/web-first-main.ts`: packaged **offline smoke** creates
  a synthetic project only inside disposable /tmp userData and proves the
  project ledger survives a second registry load and is returned to the native
  sidebar. Test input is sent **only** to an offline HTML fixture, never
  ChatGPT. Marker labels: `WEB_FIRST_OFFLINE_PROJECT_RESTORED`,
  `WEB_FIRST_OFFLINE_PROJECT_UI_PASS`, `WEB_FIRST_OFFLINE_INPUT_PASS`.

## Real P2b / P2c gates not yet passed

1. **Actual Core plugin publishing:** This conversation advertises only
   `runtime_health` / `identity_diagnostics`; real invocation returned
   `Tool not found` (2026-10-09). Therefore there is **no authenticated
   ChatGPT-to-local project tool call yet**. The sidecar is not a substitute.
2. **Registered user-owned roots:** project selection conveys NO remote
   permission. P2b must create separate, reviewable read grants for exact
   canonical project roots and verified host/session principals. The webpage
   cannot mint or renew them.
3. **Tool invocation:** expose bounded read/list/search through actual MCP
   `tools/list`, perform a *read-only* test with a user-approved normal website
   turn, record exact invocation and receipt. No automatic model invocation.
4. **Mutations / Computer Use:** different explicit permission; no implicit
   promotion of a read grant into shell/write; idempotency fences; audit.
5. **Goal / Agent:** only after remote attribution and durable task-contract
   validation; false Mission completion stays blocked.

## Local smoke / delivery

- User's active Web-First process is not replaced while they are communicating
  through it. New package can be tested with its `COS_NEXT_WEBFIRST_OFFLINE_SMOKE`
  temp-only profile and switched *after* user-controlled chat pause.
- Build and package as in `WEB_FIRST_P1_GATE.md`; the standalone bundle remains
  under `release-next/webfirst-p2-projects/...`, and in contrast to old CoS
  includes **no** Chrome Companion or Codex runtime assets.
- Real-project directory registration is **not** exercised on the user's
  workspace by tests; only synthetic scratch directories are used.

## Final local validation

- `npm run verify:ci`: **5,056 regular Vitest tests passed**, 130 skipped,
  plus **2 independent MCP shutdown tests passed**, 0 failures.
- Native Electron 44.3.0 macOS ARM64 standalone app built locally without
  external Electron download, Chrome Companion or Codex CLI assets.
- Package gate PASS: correct isolated bundle ID/ARM64 binary/entrypoint and
  absence of classic, Chrome extension and Codex assets.
- **Real packaged offline test PASS**, exit 0:
  `WEB_FIRST_OFFLINE_PROJECT_RESTORED`,
  `WEB_FIRST_OFFLINE_PROJECT_MENU_PASS`,
  `WEB_FIRST_OFFLINE_PROJECT_UI_PASS`,
  `WEB_FIRST_OFFLINE_INPUT_PASS`, `WEB_FIRST_OFFLINE_VIEW_READY`.
- Current user-authenticated Web-First app remains running unchanged because
  this conversation is taking place in that same window. Do not automatically
  terminate its ChatGPT session during code verification. After the user pauses,
  the updated `release-next/webfirst-p2-final/` app can be opened while the old
  preview has exited cleanly, reusing the established Web-First login partition.
