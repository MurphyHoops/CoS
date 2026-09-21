# Generic Long-Run Runtime — 2026-09-20

## Goal

Generalize the P5 durable Long-Run Runtime so it is reusable across projects and fix the host-surface failure where ChatGPT can expose Core code mode without exposing `session_wait` as a direct tool.

Baseline: clean `main@6e2408432f51ed0b8d9db5721fba776218732881`.
Development branch: `feature/generic-long-run-runtime`.

## Root failure

The durable wait implementation required `session_wait` to be called directly, while the kernel rejected nested `session_wait`. A host that exposed only code mode therefore had no legal path to arm a WaitContract. This was a contract contradiction between tool exposure and lifecycle enforcement, not a GitHub- or project-specific failure.

## Implementation

- Added a code-mode terminal-yield path for `session_wait action=arm`. Successful arm durably publishes the wait, stops remaining QuickJS, discards earlier explicit emissions, refuses later nested admission and returns only the wait receipt.
- Direct `session_wait` remains preferred. The compatibility wording is projected only on surfaces that actually register the tool.
- Nested arm uses the existing durable source-request fence and allows exactly the outer `exec` plus the wait child in the in-flight count. Sibling mutations remain fail-closed.
- Extracted GitHub Actions, retained process and timer observation into a generic `LongRunWaitProvider` registry.
- Extended WaitContract with an internal semantic provider target and bounded provider data. Public custom-adapter fields are `provider_target` and `provider_data`; unknown providers fail closed.
- Added `ProgressCertificate` as the generic durable-progress primitive while preserving the old progress-call adapter.
- Kept project lifecycle policy out of Core; `docs/long-run-runtime.md` documents the adapter boundary.

## Regression evidence

Targeted runtime/MCP/authority suites passed, including:
- successful code-mode arm cuts all remaining JavaScript and later mutation;
- concurrent sibling admission cannot cross the terminal-yield boundary;
- refused arm leaves the script live for reconciliation;
- real MCP code-mode fallback arms a timer wait, fences the old request, and permits cancel;
- custom provider dispatch resolves through the registry and queues one stable continuation;
- timer ACK-loss retry retains its original durable deadline;
- Session Tools Off does not advertise or describe `session_wait`.

A full `npm test` after the surface-aware fix passed: 182 test files passed, 13 skipped; 4,661 tests passed, 129 skipped; 0 failed.

One earlier parallel run exposed an existing timing-sensitive terminal-result receipt assertion; its isolated rerun and the subsequent complete `code-mode-mcp` and full-suite runs passed. No production change was made for that non-reproducible timing event.

Formal and packaged gates also passed:

- `npm run verify`: privacy/history, notices/native sources, typecheck, Electron resolution, 4,659 ordinary tests + 129 skipped, then 2/2 isolated MCP shutdown tests.
- `npm run build`: production main/preload/renderer bundle passed.
- `npm run dist:mac:arm64`: macOS arm64 DMG/ZIP built; the bundle was ad-hoc sealed.
- `smoke-packaged-runtime`: packaged Electron 44.3.0, Sharp, libvips, node-pty, tree-sitter and the macOS desktop addon executed successfully.
- `smoke-macos-bundle arm64`: 24 thin Mach-O payloads, 8 launchable executable modes, deployment floors, metadata and the unsigned/ad-hoc policy passed.
- `smoke-macos-gui arm64`: packaged app reported app started, window loaded and renderer state ready, then shut down cleanly.
- Installed canary `app.asar` SHA-256 matched the packaged candidate exactly; the prior application bundle remains available as a rollback copy during acceptance.

Installed-live MCP acceptance used the current signed-in ChatGPT request identity and the canary's real random Core endpoint without printing or persisting its secret URL. Raw Core exposed both `exec` and `session_wait`; the acceptance intentionally called only `exec` for admission. Nested timer arm returned the durable wait receipt, discarded pre-arm output, never ran post-arm JavaScript, and a subsequent source-request read was refused with `WAIT_ARMED_FINISH_TURN`. The local supervisor then moved the wait to `resolved`, created one `wait_resolved` obligation and exactly one after-turn continuation row. Cleanup used the source executor's permitted cancel path; wait/work ended `cancelled`, the one continuation row retired `cancelled`, and it never crossed Send authorization.

The current ChatGPT tool snapshot still does not expose a direct `session_wait` tool (nor a CoS-specific nested tool entry), so the final provider-host presentation path cannot be asserted from this conversation alone. The installed HTTP transport, exact request attribution, terminal yield, durable supervisor, source fence and continuation retirement were exercised end-to-end.

## Remaining release gates

- final diff/privacy audit
- commit, push and PR
- branch/PR CI and review

Evidence levels remain separate: installed-live MCP acceptance proves the canary transport/runtime path; it does not by itself prove a future ChatGPT connector snapshot will surface the same tool presentation.

## 2026-09-21 stability follow-up

A later shared-tree pass closed additional lifecycle gaps discovered while using the runtime for
long UEOT verification runs:

- Added a durable per-session autonomy pause so Stop/Off prevents Long-Run dispatch,
  Self-Healing admission and queued continuation delivery until the user explicitly re-enables
  automation.
- Marked CoS-authored continuation/user-role rows as `automatic`, preserving that provenance
  through recording and Goal input history so machine continuations cannot become new human
  requirements after reload or migration.
- Carried exact fresh-chat opening command provenance into buffered browser observations and
  reconciled it before recorder restore, preventing a replacement chat from becoming a shadow
  session before its A→B transaction commits.
- Accepted ChatGPT's Markdown transport escaping for continuation/recovery markers without
  weakening canonical prompt identity, and aligned the resume claim window with the browser
  command lifetime.
- Tightened desktop-input send authority: an app-owned native user row receives local generation
  authority only after its exact durable ACK. After ACK the accepted row is re-observed so its
  generation can settle normally.
- Tightened stuck-composer recovery by re-proving the latest user question as well as the exact
  assistant terminal, so a new user request arriving during the probe cannot authorize recovery
  of the previous turn.

Validation after these fixes:

- `git diff --check`: PASS.
- Focused Long-Run / code-mode / Goal / bridge / content / Self-Healing / continuation / session
  matrix: 9 files passed, 1,489 tests passed, 3 skipped.
- Full `npm run verify`: privacy/history, notices/native sources, typecheck and Electron
  resolution passed; 181 ordinary test files passed and 13 skipped (4,665 tests passed,
  129 skipped), followed by 2/2 isolated MCP shutdown tests.
- The prior committed `bf394cc` baseline was checked independently: its original
  `content-script` suite passed 618/618. Three regressions introduced by the follow-up patch were
  therefore treated as real regressions, fixed at their ownership boundaries, and the current
  suite now passes 619/619.
