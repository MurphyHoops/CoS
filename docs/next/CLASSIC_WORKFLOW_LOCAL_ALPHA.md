# CoS Next Classic-first recovery — local alpha

**Branch:** `next/v4/classic-workflow-first`
**Goal:** restore the proven CoS 3.1.x front-end and working session/Goal/project/settings workflows before upgrading the transport and autonomy architecture. The earlier local-only simplified dashboard is preserved on Git history (commit `73e18b0`) but **is no longer the primary Next UI**.

## Implementation

- Next keeps its own `com.chatonsteroids.next` app ID and the isolated `chat-on-steroids-next` macOS userData directory.
- The actual original CoS renderer (`src/renderer/index.html` + `main.ts`) and full typed preload (`src/preload/index.ts`) are used for the Next Classic build, not superficial HTML copied into a disconnected dashboard.
- The actual original main process (`src/main/index.ts`) is imported **after** the Next root is set, so the existing IPC controllers, settings save, local projects, conversation UI, composer, Goal/Loop, multi-agent controls and durable session machinery are available.
- Build-time changes to the HTML brand as **Chat On Steroids Next** occur only in the Next build. Original renderer assets, source and installed original app are unchanged.
- The Next app disables legacy **automatic connection** on startup to avoid competing for the copied old Tunnel IDs. Existing credentials/configuration are preserved; user must choose Connect explicitly.
- The Next app disables legacy auto-update polling/apply, which otherwise could overwrite the independent v4 alpha with a v3 release.
- Before importing the old process runtime, the Next entrypoint refuses to start when the real original CoS binary or old tunnel client is already running. Detection is based on process paths and has negative controls for Next's distinct name.
- The classic boot failures are surfaced in a native alert rather than becoming an inert Dock icon; errors do not print credentials.
- The legacy runtime requires the correct macOS ARM64 native PTY and Tree-sitter prebuilds. The Next `electron-builder.next.yml` explicitly packages the installed/pinned node_modules prebuild paths that were excluded from the generic cross-platform dependency tree.
- The new v4 Mission kernel implementation is **retained separately in the repository** for later guarded integration. The old UI's Goal/agents are not silently relabeled as having passed the new v4 G1b/G2b authorization gates.

## What was actually validated

- Local TypeScript / electron-vite build completed.
- The first real Classic package failed before UI because native bindings were absent. That was reproduced, traced and fixed (not hidden).
- Rebuilt `Chat On Steroids Next.app` then started **without** a legacy CoS process, logged `NEXT_CLASSIC_LEGACY_IMPORT_OK`, wrote its own app log and showed one actual native BrowserWindow containing the familiar new chat, conversations, settings, composer and connect controls.
- Tested the *original* and *Next* window construction paths separately; sandbox/context isolation/nodeIntegration restrictions remain enforced. Original process-owner and Next-negative-control tests passed.
- The existing macOS Keychain entry may prompt for permission to use `Chat On Steroids Next Safe Storage`. Only the user should type the Mac login password in the genuine system dialog. No password, credential plaintext, or cookie is transmitted to ChatGPT.
- The UI's existence **does not** yet prove a live ChatGPT webpage turn can be delivered or continued without a companion extension.

## Unresolved acceptance gates

1. **Real typed chat delivery:** verify a newly authored Next message reaches the selected backend, and the resulting conversation/Goal state survives restart. The original ChatGPT Web browser-continuation path relies on the installed browser companion for precise chat attribution; extension-free parity remains an open design goal, not a fact.
2. **Settings roundtrip:** after macOS Keychain permission is granted, verify the UI can edit, save and reload a reversible benign preference without modifying the original CoS data.
3. **Imported tunnel operation:** connect only from Next while old CoS is fully closed. Do not auto-attach the copied old Tunnel ID.
4. **Native dependency packaging on non-macOS hosts:** the macOS arm64 preview has the necessary local prebuilds; Windows/Linux require their own tested package payloads.
5. **G1b/G2b, authenticated ChatGPT conversation identity, subscriber Codex inference, Stop and durable recovery:** only the explicit new kernel's earlier unit simulations exist. Do not claim extension-free autonomous parity or API-free unlimited model turns.

## Source and release policy

- Worktree: `/Users/murphyhoops/Documents/ChatGPT/CoS-Next-WP03`
- Existing original installation: `/Applications/Chat On Steroids.app` (unchanged).
- Both a running old app and Next must never own the same original Tunnel ID simultaneously.
- Work locally; do not push a PR, register fresh MCP connectors, export secret keys, or publish the alpha before the user explicitly authorizes cloud promotion.

## Interruption recovery and second local native build (2026-10-08 23:44 CST)

- Reconciled the actual worktree and prior CI receipts before proceeding; previous complete local `verify:ci` recorded **5,029 standard tests + 2 MCP shutdown tests passed, 130 skipped**, with no failures. No repository changes were replayed blindly.
- Old preview was gracefully stopped, then the newest Next Classic preview was activated successfully from a separate build folder. The application created a **1728 × 1084** native window, logged `app started` and `window loaded`, and maintained its own local data directory. Original CoS app and Tunnel client were not launched.
- The complete Original CoS `src/renderer` and `src/preload/index.ts` remain the frontend and IPC. The previous experimental local dashboard is retained in Git but not used to replace chats or settings.
- Correct macOS ARM64 prebuilds (PTY, Tree-sitter, Tree-sitter-bash) are included in the Next bundle. An additional native Desktop addon gap was identified and closed. The new **local-only** staging script `node scripts/stage-next-classic-desktop.mjs` copies two version-matched arm64 binaries, **not credentials**, from the existing installed original CoS into **gitignored** `resources/packaging/desktop/darwin/arm64`. The `electron-builder.next.yml` now bundles them under `Contents/Resources/desktop` in Next. Binary presence, architecture, dynamic libraries, ad-hoc signature envelope and packaged app launch were checked.
- Latest tested local preview path: `release-next/classic-validated/mac-arm64/Chat On Steroids Next.app` (independent `com.chatonsteroids.next`). **Keep the original installed `/Applications/Chat On Steroids.app` unchanged.**
- The original UI `settings:save` typed IPC and its durable JSON transactional implementation are retained. Prior automated IPC tests exercise setting changes and profile/key ownership in isolated temporary directories. **A hands-on save/restart test inside the user's live window remains unverified**: macOS denied terminal-driven Accessibility clicks (`-25211`), so we did not bypass permissions or silently modify any real preference.
- ChatGPT subscription-backed inference through browser Web UI **still requires a supported transport**. Classic CoS browser delivery depends on its companion for exact conversation identity; restoring its working UI is not proof that extension-free webpage wake, multi-Agent continuation or the v4 verified-principal gates have been solved.

### User-visible Classic workflow

Open the Next Preview and select **返回聊天** for conversations, **工作区** for projects and roots, **连接设置** to review/edit Core credentials/Tunnel (manual Connect only), or **智能体与自动化** to inspect the original Goal/Loop/multi-Agent controls. Changes are local to the `chat-on-steroids-next` userData directory, not to original CoS. Do not run both applications against the same old Tunnel ID. If macOS requests Keychain access for Next Safe Storage, approve through the system dialog only; never send a password through chat.

The feature-parity release is still **HOLD** pending real browser/model delivery, user-observed settings save/restart, full Mission/agent recovery and across-platform native packaging. Source build/test verification does not substitute for these gates.

## Interruption reconciliation and local hardening (2026-10-09)

- Restored local Git state at **7608e57** on `next/v4/classic-workflow-first` with a clean working tree before making further changes. Previous full verification finished with **5,029 tests passed + 2 MCP shutdown tests**, 130 skipped, zero failures.
- Confirmed the latest `classic-validated` Next process remains live with three **Next-owned** Core/Desktop/Plugins Tunnel clients and the original `/Applications/Chat On Steroids.app` is not running. Never started a second tunnel owner or overwrote the running bundle.
- Inspected the real Next application log: the old UI renderer initialized, its window loaded, and its three tunnels connected. Previous captured GUI screenshot showed the actual original navigation (Return to chat, Workspace, Usage, Plugins, Connection settings, Agents & automation, Activity), not the simplified v4 status dashboard.
- Added an explicit `test/next/classic-settings-roundtrip.test.ts` verifying reversible UI and Goal preferences survive JSON save/reload in an isolated synthetic Next profile and never modify a separate old-CoS profile. Together with the existing `settings:save` typed IPC tests, this covers the config storage path but **not yet a user-driven UI click/restart**.
- Added a standalone packaged-app verifier `scripts/verify-next-classic-package.mjs`: checks the correct Next bundle ID, package entrypoint, real chat renderer/preload, eight native ARM64 resources, and macOS code-signing integrity. Successfully ran it against `release-next/classic-validated/mac-arm64/Chat On Steroids Next.app`. This does not trigger network connection or modify any credential.
- Status remains **LOCAL ALPHA / RELEASE HOLD**. The Next Alpha still needs real user-driven settings roundtrip, verified host identity/ChatGPT Web continuation, optional SIWC subscription-backed inference and cross-platform distribution gates. The classic Workflow retains the optional Chrome companion for old browser-dependent behavior; removing that dependency with feature parity has not been established.

### Latest local regression evidence

- **2026-10-09:** `npm run verify:ci` completed exit 0: **5,032 regular tests passed + 2 independent MCP shutdown tests passed**, 130 skipped, zero failed. The dedicated Next Classic settings test ran together with the existing config/IPC suites.
- `node scripts/verify-next-classic-package.mjs <absolute .app path>` passed against the already built `release-next/classic-validated/mac-arm64/Chat On Steroids Next.app`. It verified independent bundle identity, correct main/preload/renderer payloads, 8 native resources with Mach-O ARM64 architecture, and bundle code signature.
- No changes were made to the running Next instance or to user credentials while running these tests; no cloud push.


## Real packaged UI interaction gate (2026-10-09, interruption recovery)

- Latest recorded mainline in this isolated worktree was `413b61e` before this test, with clean Git state and completed `npm run verify:ci`: **5,032 ordinary + 2 MCP shutdown tests**, 130 skipped, zero failures.
- Implemented a reproducible **real Electron packaged-GUI integration test** at `scripts/verify-next-classic-gui.mjs`. It starts the *packaged* `com.chatonsteroids.next` using a fresh isolated HOME and uses an ephemeral **localhost-only Chromium DevTools** connection solely within that synthetic profile. The DevTools server is not enabled in the normal application.
- The test waits for the original `getState` typed IPC state hydration, verifies legacy Chat, New chat, Goal Create plan, Settings, Setup and Workspace controls, navigates into Settings, clicks the actual Theme control, observes the change through the renderer and waits for `settings:save` to persist Next's own `config.json`.
- It then exits the packaged app, starts the same package again against that *temporary* Next profile, and checks the preference persisted across restart. The synthetic **old CoS** profile includes a sentinel whose original SHA-256 is verified unchanged. No real original/Next profile credentials or data are loaded; the app never connects to Tunnel or a model in this test.
- **All integration assertions passed**: `NEXT_CLASSIC_GUI_NAVIGATION=PASS`, `NEXT_CLASSIC_GUI_GOAL_CHAT_SETTINGS_PRESENT=PASS`, `NEXT_CLASSIC_GUI_SETTING_IPC_WRITE=PASS`, `NEXT_CLASSIC_GUI_RESTART_ROUNDTRIP=PASS`, `NEXT_CLASSIC_GUI_OLD_PROFILE_UNMODIFIED=PASS`, `NEXT_CLASSIC_GUI_TEMP_PROFILE=PASS`. The first exploratory test clicked the theme control before IPC initialization and was invalid; the corrected test explicitly synchronizes with `window.api.getState()`.
- This materially closes the **automated real-window settings-save/restart validation** in a synthetic profile. It does **not** establish a live web ChatGPT conversation delivery or ability to wake a browser chat without an extension, a real user-driven settings update to the existing Next profile, subscriber Codex OAuth inference, or G1b/G2b host attribution. Those remain release HOLD.
- Run explicitly on a Mac with the already verified package: `node scripts/verify-next-classic-gui.mjs "$PWD/release-next/classic-validated/mac-arm64/Chat On Steroids Next.app"`. Do not add this native GUI test to headless Linux/Windows CI or call it on a user-configured profile.
