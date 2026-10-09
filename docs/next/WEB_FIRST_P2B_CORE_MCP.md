# Web-First P2b — native read-only Core MCP and imported Tunnel

## Exact product contract

- AI is ChatGPT's **official website inside Electron**. The tool transport uses
  registered ChatGPT Core MCP, not Chrome or browser DOM scraping.
- No Codex CLI, API-billed inference, local Qwen or automated model turn.
  Ordinary ChatGPT web usage remains subject to account limits.
- Local project bookmarks are not implicit agent grants.

## Implementation

1. `WebFirstReadAuthority` checks a registered native-selected project ID,
   canonical project root, bounded (32 KiB) regular UTF-8 file type, path
   segments, actual symlinks (denied), and inode/dev identity **again after**
   the user-facing dialog and after opening with `O_NOFOLLOW`. A project
   directory listing is capped at 120 entries; project discovery returns only
   approved name/ID, not an absolute host path.
2. `createWebFirstCoreMcp` implements actual MCP `tools/list`/`tools/call` for
   `runtime_health`, `identity_diagnostics`, `project_list`, `project_ls`,
   `project_read`; NO `exec_command`, file writes, shell, mission start or
   persistent autoapproval. `identity_verified=false` and
   `mission_authorized=false` regardless of caller `_meta`.
3. `createWebFirstCoreLoopback` binds exclusively to 127.0.0.1 with a random
   per-process URL route, rejects cross-site browser Origin and invalid Host,
   limits request payloads to 64 KiB. The endpoint is never provided to the
   ChatGPT site's JavaScript, sidebar, preload or renderer.
4. From the **native `本地项目` menu**, user approval enables the local MCP;
   subsequent exact file/list requests each display a separate native approval.
   The local service is deliberately labelled `LOCAL_ONLY`, not connected.
5. A **second native approval** can adopt the existing Next-owned OpenAI Core
   Tunnel configuration/Keychain **without copying tokens**, but only when
   no other Next/legacy Tunnel owner exists. The tunnel client is staged from
   a local previously packaged Next and shipped inside the standalone preview
   (`Contents/Resources/tunnel/tunnel-client`); it does not require an installed
   original CoS or external Chrome. Tunnel state requires an actual recent
   successful control-plane poll, not local readiness. Shutdown uses
   `stopWithProof()`; uncertain shutdown retains HOLD, never declares success.
6. The existing encrypted Next credentials are accessed via a **read-only,
non-rotating** decrypt helper so the source ciphertext is never resealed by
Web-First. Access occurs **only** after an
   explicit native operator confirmation. No token/Tunnel ID/password is
   copied to Web-First's profile, printed, or added to Git. Full project
   access does NOT follow from Tunnel connection or reported ChatGPT metadata.

## Read-only QA — no user project and no ChatGPT messages

- 19 focused tests for native host, OAuth, project registry, identity-denial,
  actual MCP tools, forged caller rejection, symlink/path traversal, browser
  Origin rejection and Tunnel config validation.
- Packaged macOS ARM64 test uses a disposable local user profile and a
  disposable project `fixture.txt` only; sends real HTTP `tools/call` and
  confirms `WEBFIRST_LOCAL_MCP_READ_OK` after isolated fixture approval.
- Five successful packaged markers: `WEB_FIRST_OFFLINE_PROJECT_RESTORED`,
  `WEB_FIRST_OFFLINE_LOCAL_MCP_PASS`,
  `WEB_FIRST_OFFLINE_PROJECT_MENU_PASS`,
  `WEB_FIRST_OFFLINE_PROJECT_UI_PASS`, `WEB_FIRST_OFFLINE_INPUT_PASS`.
- Bundled main uses `scripts/build-next-webfirst-runtime.mjs`, which includes
  the local MCP SDK and its dependencies in `app.asar` rather than leaving
  `require('@modelcontextprotocol/server')` dangling at runtime.
- Build the independent native tunnel locally before packaging:

```
node scripts/stage-next-webfirst-tunnel.mjs "/path/to/existing/Chat On Steroids Next.app"
node scripts/build-next-webfirst-runtime.mjs
npx electron-builder --config electron-builder.next-webfirst.yml --mac --arm64 --dir \
  --config.directories.output=release-next/webfirst-p2b-native-bundled \
  --config.electronDist="$PWD/node_modules/electron/dist"
node scripts/verify-next-webfirst-package.mjs \
 "$PWD/release-next/webfirst-p2b-native-bundled/mac-arm64/CoS Next Web-First Preview.app"
```

## Not yet certified (do not overclaim)

- A successful local MCP test does **not** establish remote ChatGPT plugin
  tool discovery or a verified user/conversation principal. The existing
  platform `Chat_on_steriods_Core` plugin previously returned `Tool not found`
  for its two advertised diagnostics. It may require an authorized plugin
  reconnect/schema refresh before newly published project_* tools appear.
- No credential ingestion or live Tunnel connection has been auto-initiated
  during testing; native opt-in is mandatory.
- No project other than a disposable `/tmp` fixture has been read through
  these MCP tools. User-approved live `project_read` and a same-conversation
  ChatGPT response remain **P2c HOLD**.
- Goal/Agent/write/shell/Computer Use remain separate future permission gates.

## Current human acceptance steps (no automatic model turn)

Open the new Web-First P2b preview (only after the previous preview exits):

1. In macOS menu **本地项目 → 添加项目目录**, choose one harmless test
   directory and approve *register bookmark only*. There is no automatic
   project read or upload.
2. **本地项目 → 启用本机只读 MCP（需批准）**, approve the local-only socket.
   A subsequent **查看登记与 Core MCP 状态** should report local-only, NOT remote.
3. **本地项目 → 连接现有 ChatGPT Core Tunnel（需批准）**, approve using the
   previously configured Next OS-encrypted Tunnel. The app will block if a
   different Next/CoS Tunnel owner exists, and will HOLD if Keychain cannot
   decrypt the stored key, network poll does not complete, or shutdown is
   unverified. No credentials are printed or copied.
4. In the embedded ChatGPT website, independently verify that the
   `Chat on steriods Core` plugin actually advertises **project_list/project_ls/
   project_read**. If its published tool registry still reports `Tool not
   found`, **do not treat MCP control-plane connect as remote tool success**.
   A platform-side plugin refresh may require manual reconnection. Do not
   bypass OAuth, invent endpoints or fabricate a tool result.
5. Only with a verified registered tool and an explicitly approved normal
   ChatGPT message, attempt a one-time `project_list` call to a disposable
   local project, approve exactly that call, and inspect its actual result.
   No shell or write calls are currently exposed.

## Final P2b local gate

- 6 focused Web-First suites / **19 focused tests** passed.
- `npm run verify:ci` pass: 225 regular test files with **5,065 tests
  passed**, 130 skipped, and 1 separate MCP shutdown suite with **2 passed**.
  No failed tests.
- Final code adds OAuth-protected-resource discovery metadata and
  pre/post native approval directory inode checks; these changes are covered
  by focused tests including real loopback HTTP.
- The packed app also contains a locally staged, **ARM64** version of the
  existing Next Tunnel binary and all MCP SDK modules in `app.asar`. This is
  not a Chrome extension or Codex CLI dependency.
- The currently running P2b Web-First preview uses the existing authenticated
  ChatGPT site profile with a sidebar and native MCP actions. The Core plugin
  currently reports `Tunnel-client has not been seen for 300 seconds`, which
  is expected BEFORE the user opts into Core Tunnel from the native menu.
- The live imported Tunnel and ChatGPT platform tool registry are **not**
  certified by synthetic tests. Actual Core adoption remains native user
  opt-in and must pass a recent OpenAI poll plus a real `project_list` request.
- No Github push, no secret values logged, and no user-project data used in QA.


## P2b.1 — Keychain identity migration without copying encrypted secrets

A real user attempt initially showed `EXISTING_NEXT_KEYCHAIN_UNAVAILABLE` and a
misleading `本地登记错误` in the sidebar. Read-only diagnosis established:

- Legacy CoS and old Next both still have `secrets.bin`, each mode 0600.
- `safeStorage.isAsyncEncryptionAvailable()` was true but the **Web-First**
  Electron identity failed to decrypt either encrypted store.
- The macOS Keychain contains separate services for `Chat On Steroids Next`
  and `CoS Next Web-First Preview`.
- A read-only, no-plaintext diagnostic with the SAME packaged Web-First app,
  but the **original Next product name set before app.whenReady**, decrypted
  both existing encrypted stores successfully and verified the preexisting
  OpenAI key. Neither store was rewritten, moved or logged.

Fix: `core-broker.ts` is a short-lived, separately launched **Electron** child
with legacy `Chat On Steroids Next` Keychain name, its **own disposable profile**
and stdin ownership tie to the Web-First host. `core-transport.ts` launches it
only after the native user consent. The broker itself decrypts the legacy key
via `peekSecretWithoutRotation` and starts the bundled Tunnel, then emits
ONLY `READY`, `CONNECTED`, `OFFLINE`, `FAILED`, `STOPPED_PROVEN` or
`STOPPED_UNVERIFIED` over stdout. **The decrypted key never crosses the IPC
or subprocess boundary, and is never copied to a new profile.** The original
Web-First ChatGPT login profile keeps its separate Keychain identity.

`project-sidebar.ts` now distinguishes `Core Tunnel 连接受阻 · 项目登记仍正常`
from a genuinely invalid project ledger. P2b's native project registry remains
unchanged, and previous user-selected roots are preserved.

### Real-network broker validation (explicit user-requested repair)

A packaged **ARM64** Web-First Broker was launched against an isolated,
**deny-all** local MCP fixture. It decrypted existing stored OpenAI credentials,
started `tunnel-client`, completed a real OpenAI control-plane poll, and
closed with verified owner shutdown: `READY → CONNECTED → STOPPED_PROVEN`.
No model message, Codex call, real user project read, credential transfer,
Chrome interaction or project mutation occurred. The real-network test is
opt-in-only: `COS_NEXT_REAL_TUNNEL_TEST=1` and exact `COS_NEXT_WEBFIRST_LIVE_APP`
are required; the default CI suite skips it. The test cleans up its mock
project, local server and owned client.

**Still HOLD:** whether the ChatGPT platform Core plugin has refreshed its
`tools/list` schema and can route `project_list` into this server. A control-
plane success does not prove platform tool publication or conversation identity.


### Keychain Broker hotfix, final gates

- `Web-First Preview` with its own Keychain name could not decrypt the user's
  two original 0600 stores. The same Electron bundle launched with **legacy
  Next name before ready** decrypted both, and detected preexisting OpenAI
  credentials without revealing values. Both encrypted blobs remained untouched.
- Separate native Broker conserves the existing ChatGPT partition, owns the
  tunnel client's life via stdin + `stopWithProof`, and returns only fixed
  state words. User-readable status disambiguates Core `HOLD` from an invalid
  project registry.
- Explicit opt-in **real OpenAI control-plane** test with a deny-all temporary
  local project fixture: `READY`, `CONNECTED`, `STOPPED_PROVEN` all observed.
  No model messages or real user file reads; no orphan test tunnel was kept.
- TypeScript and 20 focused Web-First tests passed (one real-network test
  skipped by default).
- `npm run verify:ci` after this change: 5,066 regular tests passed, 131 skipped
  (includes the optional real-network test), plus 2 MCP shutdown tests passed.
- New ARM64 bundle passed package inspection and real offline Electron MCP
  smoke. Running Web-First retained existing authenticated ChatGPT browser
  partition and post-login navigation state.
- **Platform ChatGPT Core dispatch remains HOLD** until the user permits the
  native Core connection from the current live app and the platform reports
  a durable post-request poll and successful `project_list` tool call. One-shot
  broker network test is not proof of this final delivery gate.


## P2c platform tool snapshot gate — 2026-10-09

**Observed on the user's connected ChatGPT Core integration:** Both
`runtime_health` and `identity_diagnostics` now work live, with actual
`runtime=WEB_FIRST`, `identity_verified=false`, `mission_authorized=false`.
Therefore the round trip ChatGPT -> Core Tunnel -> local MCP -> ChatGPT is
**proven** for diagnostic tools. This is distinct from the unverified new
project tools: the invoking ChatGPT conversation advertises only the two
previously approved tools, not `project_list`, `project_ls`, `project_read`.

OpenAI's own MCP app management documentation describes a **frozen approved
snapshot** of tool names/inputs: adding handlers to a live server does not
automatically expose them in already-approved apps. Refresh/publish the app's
actions in an eligible workspace, or recreate the app in settings where
refresh is not supported, reviewing the tools and preserving the existing
Core connection. Do not claim an automatic plugin refresh occurred or that a
new conversation alone will refresh the published tool snapshot.

This Web-First build adds:

- `WEBFIRST_CORE_TOOLS` authoritative server-side allowlist (five
  read-only MCP tools), and a stable `server_toolset` version label.
- **Backward-compatible** `runtime_health` response additions:
  `server_tools`, `server_toolset` and
  `chatgpt_tool_registry='NOT_VERIFIED'` — never claims that the tools are
  actually available in a ChatGPT conversation.
- A native `本地项目 → 核对 MCP 工具清单（仅本地）` menu item that performs a
  real `tools/list` exchange with its own random-route loopback MCP service,
  validates exactly the five tool names, and displays **only** tool names and
  registration caveats, not the bearer URL or the user project contents.
- The native sidebar now explicitly separates a successful Core handshake
  from the pending ChatGPT tool list refresh and per-read native approval.

Platform app update is not executed here: the current ASDK Core app identity
is not editable via the available Plugin Creator interface. No plugin is
uninstalled or replaced; the user can review the ChatGPT app management UI
when the workspace/app-owner publishing control is available. **Do not try to
smuggle a project read into `runtime_health` or `identity_diagnostics`** merely
because they are currently advertised — that bypasses published tool
semantics and safe review.

The gate remains **P2c HOLD** until ChatGPT advertises `project_list` and
receives its real return after a separate user-confirmed macOS native approval.

### P2c catalogue-audit release check

- `readWebFirstLocalToolList` performs a real, bounded, loopback-only MCP
  `tools/list` request, requires the exact five read-only server tool names,
  and never leaks the local random-route bearer URL.
- `runtime_health` retains its existing diagnostic fields and now reports
  `server_tools`, `server_toolset=web-first-readonly-p2b-v1`, and
  `chatgpt_tool_registry=NOT_VERIFIED`. These describe the **local server only**.
- Local menu `本地项目 → 核对 MCP 工具清单（仅本地）` shows actual local MCP
  discovery and distinguishes it from the separately frozen ChatGPT app
  tool snapshot. The sidebar also reflects this distinction.
- Focused Web-First suite: 21 passed, 1 opt-in real-network test skipped.
- Complete `npm run verify:ci`: 225 regular files / **5,067 tests passed**,
  **131 skipped**, plus **2** separate MCP shutdown tests passed; **0 failed**.
- macOS ARM64 standalone preview packaged and executed against an isolated
  offline test profile: startup, project durability, native input, local MCP
  fixture read, tool/menu checks and shutdown all passed.
- **The running authenticated user's Web-First app and active Core Tunnel are
  intentionally left undisturbed.** An upgrade of diagnostic UI is not worth
  disconnecting a previously working control-plane session while platform
  action refresh remains pending.
