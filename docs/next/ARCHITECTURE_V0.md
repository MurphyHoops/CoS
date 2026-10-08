# CoS Next / ChatGPT-first Architecture — Design Contract v0.1
> 2026-10-08 | DESIGN-ONLY | branch: `next/v4-chatgpt-first-design` | No runtime/product change authorized.

## 0. Primary user requirement (hard constraint)
1. **Default thinking interface remains the user's ChatGPT website**, using their existing subscription and whichever models/features their plan currently permits.
2. **Default additional metered OpenAI API spend is zero.** Do not require a separately billed API key for normal ChatGPT-first MCP workflows.
3. Preserve existing CoS v3.1.16 app, session data, permissions, companion and release branches. CoS Next must not overwrite or silently migrate them.
4. Investigate removal of **Chrome/Edge browser companion extension as a required dependency**; do not confuse a browser extension with the separately authenticated **ChatGPT MCP connector/app**.
5. Preserve core features and safety invariants (durable missions, source-of-truth state, command/process custody, multi-agent, exact receipts, stop, lease fencing, recovery, CI supervision).
6. Design/research only. No implementation, installation, runtime migration or release until a later explicit task.

**Not a requirement:** unlimited model inference. Subscription inclusion is not an unlimited automation entitlement. Enforce all account/model-specific usage caps and OpenAI terms; never bypass throttles, scrape web replies programmatically, harvest session cookies or shift accounts/chats to evade restrictions.

## 1. Verified baseline and current gaps
- Source baseline: 2026-10-08 local CoS 3.1.16, commit `fbbafb545514399ab60f6967b0c5bfc163360bb4` (not the older remote main). v3 installed app remains `/Applications/Chat On Steroids.app`; this branch is a clean separate worktree.
- Current CoS Core and Desktop MCP tools can be called from ChatGPT; local file/terminal and browser-tab-list tests passed.
- Calls still sometimes arrive as **Unattributed**: exact ChatGPT conversation/request ownership is unproven. Inference from active browser tab/current UI/time proximity is insufficient for mutation authority.
- v3 companion observes page DOM/Fiber and SSE/WS request IDs. Provider UI changes invalidate these observers.
- ChatGPT history list has shown HTTP 429; CoS local durable session store must not assume provider history is available.
- PTY cap improvements exist in v3.1.16; preserve child/process custody invariants.
- Native UI currently owns some settings, session/Goal/Loop management, logs, capability approval; MCP is not feature-complete for these.

## 2. Decision: two distinct supported inference modes
### A. Default: ChatGPT Web + CoS MCP, extensionless
`Human → ChatGPT website → official MCP connector/tunnel → CoS local mission kernel → tools`.
- ChatGPT website generates the reasoning; local CoS never calls an inference API to complete these user-driven turns.
- No browser companion needed for CoS file/command/mission tools. Permissioned browser control must use an independent browser-control adapter, never scraping ChatGPT's provider UI.
- CoS must **not** claim it can get an authoritative ChatGPT conversation ID, pull that conversation's hidden history, push model turns, or autonomously restart a ChatGPT conversation through MCP. MCP tools are invoked by the host; the server cannot originate a web ChatGPT assistant turn.
- Exactly-once local effects and external CI/process wait can be durable locally. Returning to ChatGPT for further reasoning requires a supported host-initiated continuation or user return.
- Success metric: user completes routine work entirely in ChatGPT using a stable, no-browser-extension connector.

### B. Optional: authorized local agent with ChatGPT plan usage
`Human/approved trigger → CoS local mission kernel → Codex app-server (or eligible Responses API) with Sign in with ChatGPT → tools`.
- Eligible local/open-source tools can obtain user-approved ChatGPT plan usage via the official OAuth flow, **not browser cookies**; check account and model entitlement at runtime.
- This is **not the user's ChatGPT webpage conversation** and does **not grant access to its history**. It has its own thread/mission identity.
- Plus app usage has a shared five-hour limit among participating apps; Pro is not subject to that particular five-hour limit but remains subject to applicable policies/other limits. Preview endpoints and model availability may change.
- Engine must persist its own model context/thread, renew tokens securely, handle unsupported parameters, store=false streaming and backpressure; no automatic credit purchase/paid overflow.
- Success metric: safe bounded autonomous continuation with a policy-compliant local agent; quota exhaustion parks and preserves work instead of disguising failure.

### C. Strictly opt-in: separately billed API
- Not in MVP defaults. Explicit user budget and visible billing boundary. Never silently fallback from A/B into metered API.

## 3. Browser-extension elimination strategy
- **Do not replace companion with arbitrary programmatic scraping of chatgpt.com**, DOM interception, cookie reuse, extensionless WebDriver on ChatGPT pages, or hidden network interception. This is brittle, cannot prove MCP source ownership and can violate terms.
- Remove companion as a **hard requirement** for A/B. Keep legacy v3 companion unchanged in old CoS and optionally provide compatibility-only adapter later, off by default.
- Browser tools may use an independently authorized, managed Playwright/CDP browser context (not an uncontrolled user Chrome debug port) for non-ChatGPT web pages; native desktop uses explicit macOS Accessibility/Screen Recording grants. Feasibility and protected tabs require audit. No use of either to bypass provider limits.
- A ChatGPT MCP app/connector remains needed for mode A. Browser-extension-free ≠ connector-free.

## 4. Mission ownership without provider conversation introspection
### Source of truth
`mission_id` (local immutable UUID), `mission_revision`, `execution_epoch`, `work_obligation_id`, `tool_invocation_id`, process and effect receipts, explicit operator authorization, allowed resource scopes.

### Safety model
1. HTTP/MCP transport auth authenticates the caller's allowed connector/account where supported; do **not** infer ChatGPT conversation identity unless the provider cryptographically or otherwise authoritatively supplies it.
2. User explicitly creates/attaches a mission; local CoS issues a bounded, resource-scoped execution lease after its own approval check. A guessed user-supplied mission ID or model-written text alone is **not** sufficient authority to take over another mission.
3. If no exact conversation identity is available, show `conversation_identity=unavailable` and restrict cross-mission operations, worker resurrection, destructive actions and automatic handoff. Prefer a local trusted approval or fail closed.
4. Journal intent before dispatch and effect receipts after admission; use idempotency keys; reconcile ambiguous outcomes against actual Git/process/file system state before any retry.
5. Enforce epoch fences and stop/cancel regardless of frontend. Access removal immediately restricts future mutations.
6. No misleading equivalence between native web conversation continuity and local mission continuity.

### Proposed interface domains (schemas for later design, not built)
- `mission_create`, `mission_list`, `mission_inspect`, `mission_attach`, `mission_status`, `mission_pause`, `mission_stop`
- `mission_obligations`, `mission_events`, `mission_evidence`, `mission_finish_check`
- `project_bind`, `project_runtime_check`, `agent_status`, `agent_delegate`
- `external_wait_arm/status/cancel`, `runtime_health`, `runtime_diagnostics`
- Keep ordinary filesystem/terminal/browser/desktop tools small and separately permissioned; do not expose raw config/secrets or arbitrary privileged ledger writes.

## 5. Runtime and packaging isolation
- Working brand **CoS Next** only; choose final public name after naming/license audit. Legacy CoS retains original app ID `com.chatonsteroids.app`, product name and userData.
- Before any Next binary exists: require unique bundle ID, application name, macOS app-support userData, Keychain namespace, bridge/IPC/tunnel identities, launch service, logs, protocol handlers and update channel.
- Default installation side-by-side; initial migration must be **copy-only/read-only**, explicit, versioned, backed up, schema-tested and reversible. Do not import passwords, browser cookies, app tokens or sessions silently.
- Aim for a macOS background daemon/menu-bar runtime with an optional minimal admin panel for permission, connection, usage and emergency stop. GUI is not daily interaction surface. Assess signing/notarization and autostart rather than presuming Electron window hidden solves supervised startup.

## 6. Quota / reliability / policy design
- Meter **model turns vs. local deterministic work** separately. Avoid model calls for CI polling, static analysis, file hashing, waiting and receipts when deterministic services suffice.
- Observe provider-returned limit errors as terminal-for-this-attempt; persist wait until reset, never change identity/model/account to evade restrictions.
- Mode A: respect host available UI functionality; CoS cannot force a background web assistant turn when the user is absent.
- Mode B: explicit per-app allowance, model availability, remaining budget/limits where exposed; no automatic spend from credits; token renewal per official OAuth contract.
- Metrics: per-mission completion accuracy, proof of owner, duplicate side effects (target zero), recovery safety, P95 tool latency, total model calls/mission, additional metered API spend (default zero), and user-visible permission prompts.

## 7. Research gates before coding
- **G0 baseline**: immutable v3.1.16 snapshot, separate worktree, test manifest and old app preserved.
- **G1 extensionless interactive MVP**: from real ChatGPT Web → Core MCP → local read/write/build with extension disabled; correct permission checks.
- **G2 identity/security**: prove caller authentication and scope; demonstrate safe fail-closed behavior when native conversation ID absent and two chats attempt conflicting operations.
- **G3 durability**: crash/restart, lost replies, long external GitHub CI, Stop, stale worker and idempotent retries never double-apply mutations.
- **G4 quota/policy**: no API key needed in A; verify no separately billed API usage; 429/quota exhaustion pauses, no scraping/bypass.
- **G5 optional B feasibility**: eligible OAuth → Codex app-server thread → tools → resumable local mission without extension; record real plan limitations and current preview unsupported features.
- **G6 parity**: legacy v3 mission/agents/session/policy capabilities checklist, and manual recovery when unsupported.
- **G7 side-by-side**: old installed app and all previous data untouched, separate application identity/storage/ports/tunnel/secrets; opt-in migration and rollback verified.
No v4 development until security/feasibility ADR is reviewed.

## 8. Open questions for feasibility (no assumptions)
1. Does the current ChatGPT MCP transport expose any trustworthy, stable per-conversation caller claim? If no, what UX/approval boundary permits safe mission attachment without conflating chats?
2. Can this user's actual plan and selected model expose the desired MCP write surface? Existing successful calls do not establish every plan's entitlement.
3. Which host mechanisms, if any, officially allow an external durable service to request new reasoning turns? Never assume MCP can drive autonomous ChatGPT Web turns.
4. Is mode B's preview sign-in OAuth and available model catalog adequate for UEOT Lean, GitHub work and agent delegation at sustained load within the account's included allowance?
5. What real browser/desktop actions require companion-only internals versus an independent authorized browser driver?
6. What minimal approved user-visible consent panel is needed without recreating a second chat UI?

## 9. Primary references (verified 2026-10-08)
- ChatGPT Plus limits and API billing separation: https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus
- Model/plan allowance details: https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt
- Terms: https://openai.com/policies/terms-of-use/
- Sign in with ChatGPT OSS plan usage: https://developers.openai.com/siwc/token-sharing-open-source
- OAuth quickstart: https://developers.openai.com/siwc/quickstart
- Eligible-app usage/limits: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Codex app-server: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- Preview limits: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- ChatGPT MCP/developer mode current plan-specific rollout: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt
- Existing implementation: `docs/architecture.md`, `docs/tool-surface.md`, `src/main/mcp/`, `src/main/index.ts`, `extension/`.

### Status
DESIGN ONLY. This ADR is exploratory; no code, user data, app installation, migration, new MCP server or production connection has been changed.
