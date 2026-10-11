# CoS Next Web Runtime — 2026-10-11 Real Account Recovery / HTTPS Proxy / HTTP 403 Audit

## Authoritative mission
Same existing branch, same CoS Classic Goal/Agent/MCP authority. Never use
OpenAI API/Codex as a replacement or require a Chrome Companion extension.

## Recovered live state
- Branch: `next/v4/web-runtime-v1`; HEAD remains
  `4fc7e531103903c31b70e89b222cb05e1286cfaf`.
- Original staged Classic App PID 58353 was still alive when recovered.
  Dedicated Chrome login child PID 19168 belonged to it, with exact Profile
  owner/OS lock. User reported normal ChatGPT login.
- On explicit continuation the known login Chrome child alone received
  SIGTERM, its exact ProfileLease released, and managed background Chrome
  restarted on the SAME dedicated `standard-chrome-profile`, no credential copy.
- Original BrowserControlBroker via live Desktop MCP returned a browser ID and
  initially failed `browser_tabs new` with `CHROME_CDP_TIMEOUT: Page.navigate`.
  No real prompt was sent, and the attempted open was not replayed.

## Diagnosis, confirmed root-cause layer

Mac system proxy at test time: HTTP and HTTPS were enabled, proxy
`127.0.0.1:1082`. The local MacPacket listener was present.
No system proxy or network settings were changed.

- Original Chrome headless CDP on `https://example.com/` and
  `https://chatgpt.com/`: `Page.navigate` timed out after 10 seconds;
  attempting `Runtime.evaluate` after the failed ChatGPT navigation also
  timed out.
- Manual explicit HTTP proxy request to `example.com`: HTTP 200.
- Manual explicit HTTP proxy request to `chatgpt.com`: HTTP 403.
- With explicit existing system proxy passed to an isolated disposable
  **standard Chrome CDP Pipe**, `https://example.com/` navigation accepted
  in approximately 1686 ms, page URL matched.
- Normal everyday browser behavior and headless automated requests may differ;
  HTTP 403 does **not** prove the user's Plus session is expired.

### Source fixes added, uncommitted
- `src/main/web-runtime/chrome-proxy.ts`: bounded read of macOS
  `scutil --proxy`; only validated local HTTP(S) proxy arguments, no credentials,
  no PAC modification, no global network mutation.
- `src/main/web-runtime/chrome-pipe.ts`: apply configured proxy at Chrome
  process launch, enable CDP Network domain, capture **Document HTTP status only**
  (no response body/header/cookies), preserve distinct target sessions.
- `src/main/web-runtime/browser-driver-electron.ts` and
  `chrome-supervisor.ts`: expose an optional target-local HTTP document status
  on the already-existing browser computer contract.
- `src/main/web-runtime/real-account-smoke.ts`: distinguish website
  HTTP errors (`WEB_UNAVAILABLE`) from actually visible login controls
  (`AUTH_REQUIRED`) and from no authenticated editor (`WEB_UNAVAILABLE`).
  This removes the false 'just log in again' behavior on an inaccessible site.
- `test/web-runtime/chrome-proxy.test.ts`: pure tests for local proxy, PAC,
  untrusted host, malformed port, distinct HTTP(S) proxy configuration.

## Packaged real profile validation
New isolated ARM64 bundle:
`release-next/http-diagnostics-20261011/mac-arm64/Chat On Steroids Next.app`

SHA-256 `Contents/Resources/app.asar`:
`25459e474fe36df304eb4984a483dfd3e93b5662ac92c87a2a58dac9222491cb`.

App PID 39158 launched using the original dedicated Profile with the new
Chrome CDP pipe and exact proxy flag. The real website probe returned:

```
NEXT_REAL_ACCOUNT_SMOKE_STATUS=WEB_UNAVAILABLE
REASON=website_http_403
```

This is a **confirmed real network/browser-site BLOCK**, not a successful
ChatGPT Plus inference. NO real model message was sent, NO existing research
conversation touched, NO private account secrets recorded.
Do not bypass CAPTCHA, Cloudflare/service blocks, rotate accounts, use stealth,
or claim real completion.

## Validated tests
- `tsc --noEmit -p tsconfig.json` exit 0.
- `vitest run test/web-runtime test/runtime-enable-and-extension.test.ts`:
  **12 files, 34 tests passed**, exit 0.
- `node scripts/build-next-classic-runtime.mjs`: exit 0.
- Isolated ARM64 electron-builder packaging: exit 0.
- Packaged Classic verification: exit 0, exact markers
  `NEXT_CLASSIC_NATIVE_NO_EXTENSION_BROWSER_PASS` and
  `NEXT_CLASSIC_NATIVE_PROFILE_AND_WORKERS_RESTART_PASS`.
- `npm run verify:ci`: exit 0;
  **257 files/5190 regular tests passed** and 14 files/131 tests skipped;
  additional MCP shutdown 2/2 passed.
  Full log `/tmp/cos-next-proxy-full-ci-20261011.log`.
- `git diff --check`: exit 0.
- Working tree remains DIRTY and preserved; no overwrite/reset, npm reinstall,
  credential migration, GitHub push, production release, or production install.
- Prior P3 worktree and older CoS user resource changes remain untouched.

## Strict remaining gate / next execution
1. Restore authorized normal website access through the user's ordinary,
   permitted Chrome/network path; verify an authenticated composer on the
   exact managed browser Profile. If HTTP 403 persists, HOLD.
2. Perform exactly ONE isolated, unique-marker **new conversation** send and
   verify user echo, settled assistant reply and durable journal states. Never
   replay AMBIGUOUS.
3. Real Connector pairing/nonces, Actor Generation/Scope, A→B→A Worker
   conversations, MCP tool ACK and original Goal/Loop completion.
4. Stop/restart/throttle/offline/focus, installer upgrades/rollback; then
   local commit + GitHub PR/CI and user-approved production replacement.

### Operational caution
The staged Classic App is a **test package only**. Its real-web health is
currently blocked at HTTP 403. Do not mistake synthetic Worker fixtures
or a tool tunnel handshake for real Plus inference/MCP/Goal closure.
