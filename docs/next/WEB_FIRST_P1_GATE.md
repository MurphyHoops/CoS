# CoS Next Web-First P1 — acceptance evidence, constraints, P2 gate

## Immutable product contract

CoS is a local-workspace agent for the **official ChatGPT web service**. It is **not**
a local-model app, a Codex CLI wrapper, or an API-billed chat client. The user
requires no external Chrome/companion dependency and no Codex/API usage caused by
CoS experiments. Ordinary ChatGPT web use remains subject to account usage limits;
no client can guarantee unmetered ChatGPT turns.

## Worktree and source boundary

- Branch `next/v4/web-first-p1` based on `e018520` in a **separate worktree**:
  `/Users/murphyhoops/Documents/ChatGPT/CoS-Next-WebFirst-P1`.
- Original working directory `CoS-Next-WP03` retains its uncommitted Classic
  Chrome-fallback investigations unchanged. There is **no** overwrite, merge,
  rebase, GitHub push, credential copy or automatic release.
- Standalone entrypoint `src/main/next/web-first/web-first-main.ts` uses
  `WebContentsView` + Electron's own Chromium engine. It does **not** import the
  Classic `src/main/index.ts`, companion, Bridge, old userData, Codex or any
  model API. `electron.vite.next-webfirst.config.ts` and
  `electron-builder.next-webfirst.yml` deliberately package only this runtime.

## Security and identity

- User-visible `https://chatgpt.com/`; *no automated chat sending, account
  credentials, Cookie extraction, private endpoint capture or content scraping*.
- Persistent **separate** Electron profile:
  `~/Library/Application Support/chat-on-steroids-next-webfirst-preview`.
  Never imports cookies or keys from Chrome/Classic/other Next.
- `persist:cos-next-web-first-chatgpt` partition with sandbox,
  `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`, no
  preload or renderer IPC and no `<webview>`.
- Top-level navigation restricted to HTTPS ChatGPT and explicitly pinned login
  hostnames; external popups, downloads, webcam, location etc default denied.
  SSO requiring popups/new redirect domains may not work without separately
  reviewing exactly the required identity-provider flow.
- Only category labels `chatgpt/login/blocked` and load error code enter test
  metrics. No full URL, OAuth ticket or model answer is logged.

## Local P1 proof, 2026-10-09

1. TypeScript passes. Exact navigation-policy Vitest suite: **3/3**.
2. Electron ARM64 preview built offline with local installed Electron 44.3.0.
3. Real packaged executable isolated offline `WebContentsView` smoke completed
   and shut down normally: `WEB_FIRST_OFFLINE_VIEW_READY`, exit 0 (~2 seconds).
4. Real packaged executable HTTPS smoke loaded `https://chatgpt.com/` in a
   **fresh throwaway Electron partition**: `WEB_FIRST_HTTPS_OUTCOME` had
   `state=loaded`, `location=chatgpt`, no main-frame load error or blocked
   navigation; exit 0 (~3 seconds). No account login or model request.
5. `verify-next-webfirst-package.mjs` checks app identity, ARM64, bundle
   entrypoint, WebContentsView marker and **zero** classic/Chrome/Codex assets.

**Not yet proven:** authenticated ChatGPT login inside this embedded Electron
client, official web message delivery, the user's Core plugin registration,
trusted caller/session binding, any working local file tool, autonomous chat
continuation, or restart recovery of a signed-in ChatGPT session. Do **not**
turn `P1 webpage loaded` into `P2 local project tools PASS`.

## P2 implementation/approval gates

1. User signs in **only inside the displayed official site**, never in chat or
   through a copied Chrome cookie. Check embedded-login support; if provider
   blocks embedded identity flow, record a genuine **BLOCK**. Do not spoof user
   agents, bypass CAPTCHAs, or call undocumented ChatGPT endpoints.
2. Validate platform plugin availability and the exact published tool schema.
   `Chat_on_steriods_Core` currently advertises only `runtime_health` and
   `identity_diagnostics`, **both returned `Tool not found` in this session**.
   Do not claim the advertised file/exec tools are available yet.
3. Use a separate, explicit project-root approval, scoped read-only Core MCP
   transport, verified host principal and access ledger. An embedded website is
   not automatically a trusted native caller. Do not give raw page JavaScript
   localhost access, native IPC or unrestricted filesystem permissions.
4. First live tool test: an **authorized, read-only** file/project metadata
   request from the signed-in ChatGPT page, recorded once with exact tool-ID,
   project root and session authority. Do not make a model call to test before
   the user explicitly approves consuming normal ChatGPT web usage.
5. Only after the read-only gate: controlled write/command approvals; durable
   replay fences; native macOS Computer Use separate from AI inference.

## Usage

Build in this worktree without cloud inference:

```
npm run typecheck
npx vitest run test/next/web-first-host-policy.test.ts
npx electron-vite build --config electron.vite.next-webfirst.config.ts
npx electron-builder --config electron-builder.next-webfirst.yml --mac --arm64 --dir --config.electronDist="$PWD/node_modules/electron/dist"
node scripts/verify-next-webfirst-package.mjs "$PWD/release-next/webfirst-p1/mac-arm64/CoS Next Web-First Preview.app"
```

The real standalone Web-First preview is in
`release-next/webfirst-p1/mac-arm64/CoS Next Web-First Preview.app`.
It is a P1 **developer preview**, not a production replacement for Classic.
No `COS_NEXT_WEBFIRST_HTTPS_SMOKE` or `COS_NEXT_WEBFIRST_OFFLINE_SMOKE` needs to be
set for normal interactive use. The smoke flags use disposable userData,
perform no model inference and automatically close.

## P1.1 Google OAuth and post-login UI investigation (2026-10-09)

The user reported seeing a Google Passkey identity challenge and, after login,
ChatGPT's apparently empty/inert chat shell. We investigated the **existing**
Web-First persistent Electron session without inspecting account cookies, text,
conversation titles, credentials, model replies or private response bodies.

### Evidence from the real user profile

- A separately packaged diagnostic build reopened **the same preserved**
  `chat-on-steroids-next-webfirst-preview` profile. The first run completed
  ~60 ChatGPT API requests (56 success, 4 HTTP 4xx) over 32 seconds, no network
  transport error; the initial prompt CSS selector was outdated for the current UI.
- A second fresh-process run had 48 successful API responses and 2 unrelated
  HTTP 404s; **20** conversation links had rendered. No authenticated-API 401/403.
- With guarded login storage and official SSO popup support, another fresh-process
  run reached 47 successful API requests, 0 HTTP 4xx/5xx, 0 network errors,
  10 history links, **one contenteditable + one textbox role** after 6–32 seconds.
  The earlier check for `#prompt-textarea` gave false negatives: ChatGPT's
  current composer is not reliably identified by that legacy CSS selector.
- App logs show repeated Chromium FIDO/Bluetooth authenticator errors on the
  **Passkey** path. This is a separate macOS/Electron authenticator limitation;
  no password/cookie workaround or security bypass was implemented. Alternative
  account-approved verification methods may be required.
- The user's screenshot omitted **CoS projects/tasks** for a different reason:
  P1 is ONLY the embedded ChatGPT web host. It intentionally has no project
  sidebar, Goal/Agent state or working MCP bridge yet. It is not a production
  replacement for classic CoS.

### Hardening changes

- `login-permissions.ts` grants ONLY `storage-access` or
  `top-level-storage-access` for exactly pinned ChatGPT/OAuth HTTPS origins,
  with trusted embedder origin when supplied. Camera/mic, file APIs, screen,
  remote device, clipboard and other permissions remain denied.
- Official Google/OpenAI login URLs can open isolated in-app Electron popup
  windows sharing the Web-First login partition. Arbitrary external URLs,
  `about:blank` unknown-origin popups and nested popups remain blocked. No
  external Chrome is launched or inherited.
- `web-health.ts` aggregates *only* HTTP status counts by hard-coded service
  class, sanitized standard network-error codes, and page control counts. The
  app menu `ChatGPT 网页 → 检查网页健康状态` shows the statistics with no URLs,
  credentials, page text or hidden browser content.
- The safe readiness snapshot now checks `[role="textbox"]` and
  `[contenteditable="true"]` instead of only a legacy ChatGPT composer ID.
  This check indicates node presence; it is not proof of actual cloud Send.
- **Real Chromium input smoke without model use:** in a disposable Electron
  profile, `WebContentsView` loaded an offline HTML text field, received a CDP
  mouse click and `Input.insertText`, then confirmed the exact local input
  value. `WEB_FIRST_OFFLINE_INPUT_PASS`, exit 0. The synthetic fixture never
  loads ChatGPT or consumes any account quota.

The 404s observed on the second run were NOT proved the cause of the blank UI.
The available evidence instead indicates eventual successful post-login API
loading and a stale/inaccurate editor selector in the initial diagnostics.
Do not claim an untested Google Passkey path was fixed. New interactive sign-in,
full Conversation UX and P2 Core MCP remain gated on explicit real observation.
