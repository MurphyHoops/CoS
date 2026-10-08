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
