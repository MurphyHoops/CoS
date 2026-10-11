# CoS Next — Persistent standard Chrome webpage gate and live account lane

## Operator requirement
Continue existing Classic/Goal/Agent/MCP implementation on branch
`next/v4/web-runtime-v1`. **Actual ChatGPT Plus website** must supply
model inference (no Codex, OpenAI API, or browser extension).
Never erase prior dirty worktrees or production installation.

## Evidence (same Mac, 2026-10-11)
- Correct macOS HTTP/HTTPS system proxy is 127.0.0.1:1082.
- Headless Chrome CDP Pipe used real Profile but official ChatGPT returned 403.
- Unmodified **headful** standard Chrome with CDP Pipe / identical proxy
  reached chatgpt.com with HTTP 200. Disposable unlogged Profile showed a
  normal login page after the React UI finished loading.
- Packaged staged Classic App using headful/offscreen Chrome with the
  **existing dedicated signed-in Profile** returned:
  `NEXT_REAL_ACCOUNT_SMOKE_STATUS=EDITOR_READY REASON=authenticated_page_composer_ready`.
  This is real authenticated webpage input readiness, not a synthetic fixture.
- One new launch with `COS_NEXT_REAL_ACCOUNT_SMOKE=send` returned
  `WEB_UNAVAILABLE REASON=composer_not_ready_auth_unproven`. NO model
  message was sent; user-data `send-once.claim` was still absent.
- A browser snapshot of a CoS-owned independent page then exposed the
  official website security interstitial, title "请稍候…", body:
  "验证成功。正在等待 chatgpt.com 响应" and
  "Enable JavaScript and cookies to continue".
  This is distinct from expired authentication.
- Previously existing packaged smoke timeout waited only 16*350ms,
  falsely treating an unready page as login failure.

## Architecture correction (source, uncommitted)
1. Launch ordinary standard Chrome, default offscreen;
   persistent session and CDP Pipe, no extension.
2. Use existing local system proxy from `scutil --proxy`, do not mutate it.
3. For owned Chrome's *same* page target, allow operator-only CDP window
   bounds change to reveal/hide the **same process and Profile**.
   This permits normal website security verification without logout/restart.
4. `web-gate.ts` classifies: EDITOR_READY, LOGIN_REQUIRED,
   SECURITY_CHECK_REQUIRED, HTTP_BLOCKED, OTHER_SITE, PAGE_LOADING,
   COMPOSER_OCCUPIED. It consumes only minimal DOM booleans/status codes,
   no page content or private data.
5. `real-account-smoke.ts` preserves an existing official homepage instead
   of repeatedly navigating. It waits up to 30s for normal page readiness,
   never clicks challenges. A persistent exclusive `send-once.claim` plus
   original fsynced DeliveryJournal enforces at-most-once real smoke dispatch
   across process crashes and ambiguous delivery.
6. CoS tray adds user-invoked "Show managed Chrome for website verification",
   "Return managed Chrome offscreen", "Check official ChatGPT website (no send)",
   "One-time isolated website reply test". These target the current Chrome,
   avoiding restarts. Exact result statuses are displayed in the tray/log.
7. Original Classic Goal/Agent and MCP remain the owner; smoke is separate.

## Verification and gates
- Before this latest change the full `npm run verify:ci` passed
  5190 tests plus 2 MCP shutdown tests.
- After modifications, TypeScript and 13 targeted test files (38 tests)
  passed; isolated real-app bundle build and packaged Classic CLI verify passed.
- Full repository CI rerun is being collected separately.
- Authentic real Plus response/Tool ACK/Worker A->B->A/Goal completion:
  **NOT YET CERTIFIED**. Keep HOLD until each actual end-to-end proof exists.
- Do not bypass CAPTCHA, website challenge or access restrictions.
- Do not claim that synthetic multi-worker fixture is live multi-worker success.
- No Git push, production install, account cookie extraction, external API
  substitution or credential copy.

## Final independent packaged run (after new gate) — 2026-10-11 15:47 CST
- Authentic durable Profile and non-headless/offscreen Chrome were inherited.
- Packaged App PID 18528 owns Chrome child PID 18536 and leaves its process
  alive, without extra Chrome login processes or Profile reset.
- One-shot real send request **did not send**: website gate returned
  `SECURITY_CHECK_REQUIRED website_verification_required` after the bounded
  readiness wait. This is a verified official site interstitial, NOT lost login.
- Durable `send-once.claim` does not exist (safe; no outbound test prompt).
- Operator visibility via CDP Browser window bounds was tested on an
  isolated Chrome fixture; no daily Chrome input injection.
- Branch unchanged `next/v4/web-runtime-v1`, HEAD `4fc7e53`,
  all existing dirty files retained; no commit/production install.
- Final code snapshot builds as
  `release-next/livegate-final-20261011/mac-arm64/Chat On Steroids Next.app`
  and its native/Classic offline package test exits 0.
- `npm run verify:ci` on the previous (pre-final-tray-UX-only) code passed
  **5194 tests + 2 MCP shutdown**; final TypeScript and 38 focused tests passed.
  No unsupported claim of full CI on the final tray-text-only snapshot.
- Real Plus model reply / original Goal-Worker-MCP chain remain HOLD until
  an official site verification permits interaction. Manual verification
  should occur in the *same running CoS-owned Chrome* via the
  **Show managed Chrome for website verification** tray action.

## Pre-push final-snapshot verification (2026-10-11)
- Final unchanged source passed `tsc --noEmit -p tsconfig.json`.
- `npm run verify:ci`: 258 test files / 5194 tests passed, 14 files / 131 tests skipped; separate MCP shutdown 2/2 passed, exit 0.
- `git diff --check` PASS. Live message/Goal gate still HOLD on official security verification.
