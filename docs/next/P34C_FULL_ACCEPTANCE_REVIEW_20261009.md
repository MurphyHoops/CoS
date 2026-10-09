# CoS Next P3.4-C: local acceptance and live Core verification

Date: 2026-10-09. Repository: `CoS-Next-P3-Auth`, branch `next/v4/p3-native-trust`. **Do not upgrade the status of unverified capabilities by inference.**

## Test isolation / actual outcomes

| Surface | Evidence and scope | Gate |
|---|---|---|
| Keychain reuse | Isolated native Electron preflight under the original **Next** Keychain service reported secure-storage available; both Classic and earlier Next encrypted credential files exist, decrypt successfully, and carry nonempty expected key/token fields. No key bytes were logged, exported, copied, or passed via shell arguments. | PASS for secure credential availability only |
| ChatGPT HTTPS | Fresh isolated Electron `HTTPS_SMOKE=1` loaded real `chatgpt.com` main frame with `state=loaded`, `lastErrorCode=null`, no blocked navigations. This is not a login/session/inference check. | PASS for transport and navigation only |
| Existing live account context | Production preview was kept on its existing, separate Electron partition; original 2 registered projects and 1 `waiting` Goal preserved. No real provider turn was sent. | PRESERVED; login+available models NOT VERIFIED |
| Live Core connection | Native menu's explicit approval workflow launched a broker and packaged `tunnel-client`. After connection, current ChatGPT conversation successfully called the connected Core tools `runtime_health`, `identity_diagnostics`, `project_list`, `project_ls`, `project_read`, `project_find`, `task_status`. File reads used the dedicated pre-existing read/write fixture, not the broader Documents tree. | PASS for connectivity and those read-only operations |
| Caller identity | Live Core diagnostics returned `identity_verified=false`, `mission_authorized=false`, `authority=UNVERIFIED`. Local tool replies are not an implicit trusted caller lease. | HOLD: authenticated authority not established |
| Tool publication | Live local Core `server_tool_count=14`; the current conversation's exposed Core registry provides 12 tools. `task_plan_status` and `task_plan_update` are implemented in local catalogue but absent from this conversation's exposed connector registry. | HOLD: platform-side publication needs independent verification/update |
| Production AI Worker execution | Four role assignments can be persisted and reviewed. No supported trusted model-bound dispatch/worker conversation receipt yet. | HOLD |
| Model limits / crash / recovery | Synthetic deterministic 429/backoff, Goal task and plan persistence, web outbox uncertain-message and job receipt recovery exercised in local tests and packaged Electron fixture. Actual provider 429 and post-crash replay against an authenticated conversation were not induced. | PASS synthetic; production adverse conditions HOLD |
| Local project writes | `project_replace` passed only on a disposable synthetic project in a packaged Electron process. No real user source was changed for acceptance. | PASS isolated, real write grant integration not exercised |

## Acceptance tools and safeguards

`src/main/next/web-first/native-acceptance.ts` now validates an immutable, concise, secret-free acceptance presentation. The real App menu **本地项目 → 运行一键本机功能验收（只读）** checks native project, Goal, plan, job, AI roster, grant and rate limit ledgers, website navigation, exact local tools/list, and Core broker posture. It must mark actual AI worker inference and ChatGPT tool publication as **HOLD**, even when all local diagnostics are good. It does not read Cookie values, Keychain secrets, HTML or chat text, and does not modify any approval state.

The acceptance action can be repeated after a reload; unlike a synthetic CI gate, it reports real local corrupted-ledger cases as `FAIL` and preserves existing data. Packaged smoke must emit `WEB_FIRST_OFFLINE_NATIVE_ACCEPTANCE_SUMMARY_PASS` before promotion.

## Next non-negotiable blockers for complete autonomy

1. Establish attested real ChatGPT conversation/worker identity and show identity_verified=true by a trusted platform mechanism before claim/dispatch, not metadata supplied by arbitrary tool calls.
2. Verify/update the ChatGPT plugin registry so all 14 declared local tools are discoverable from actual conversations, without bypassing plugin approval.
3. Bind independent AI Worker conversations and per-worker MissionLease, budgets, end-of-turn acknowledgement, 429 cooldown and explicit Stop; mark uncertain sends `REVIEW`, never auto-replay them.
4. For write-capable AI workers use separate isolated worktrees and a single integration authority. Never let multiple model workers concurrently write the same working copy.
5. Run real-account permitted fault injection, authenticated provider-limit tests, and packaging/accessibility verification on macOS, Windows and Linux before `deployment=GO`.

**Scope verdict**: local P3.4-C audit and established Core read-only path are verified. Full production autonomous AI Goal/Loop, trusted caller auth and full remote MCP publication remain HOLD.

## Native lifecycle follow-up
Real connected Core quit through the application menu completed and all owned processes retired, with exact stage receipts. A windowless-main/reconnection race was reproduced and fenced. macOS red-X and externally injected AppleScript Quit are NOT separately accepted. See P34C_NATIVE_EXIT_LIFECYCLE_20261009.md.
