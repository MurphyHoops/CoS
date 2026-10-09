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
