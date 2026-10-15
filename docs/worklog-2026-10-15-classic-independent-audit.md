# Classic independent audit — 2026-10-15

Baseline `main@5068eace7d1befba0c4268f958c1fd807883cc6e` (3.1.18), isolated branch `fix/classic-independent-audit-final-fence-20261015`. Scope: protect user-authorized browser message custody and durable Mission/Goal/Loop without modifying Next or other dirty worktrees.

Evidence-backed defect: `readCompletedFinal()` lost provider-native completion proof after a late `turn_end(stalled)` for the same Turn. A new test reproduced RED (`null` despite native final) on the baseline; patch made 3/3 focused outcomes GREEN. The integration Bridge/input-policy test then confirmed a settled answer despite a delayed same-turn watchdog.

Repair invariant: late `stalled` only ignored when `turnId` is identical and a providerMessageId-backed final exists. Different turns, absent native final, stops, failures and new questions are not joined; no synthetic resend.

Additional review: input browser-claim custody and restart recoverer deliberately preserve ambiguous authorized sends; this is safer than expiration/replay. MCP correlation requires exact request ID and refuses guess-based cross-chat ownership. Durable recovery/Retry-After retains the prior fail-closed contract; no unrelated edits justified on present evidence.

Gates: full local `verify:ci`; packaged macOS runtime, typecheck and license checks; exact-main GitHub CI; controlled real browser→CoS and CoS→browser E2E, Goal/Loop/Worker/restart, and 24–72 h endurance. Record each result separately, do not present unrun gates as passed.

## Local verification results

- Initial red-before-green audit: same-turn late `stalled` after provider-identified final returned `null` on original 3.1.18 code.
- Final boundary tests: **6/6** PASS (one positive, five negative including stopped/failed/unknown).
- Full `test/completion-input-integration` targeted path: **1/1** PASS.
- Broad focused tests: **352/352** PASS before three additional negative cases.
- Exact-source `npm run verify:ci`: **4,878/4,878** main tests PASS, **129 skipped** by existing policy, and isolated **2/2 MCP shutdown** PASS.
- `npm run dist:dir:mac:arm64`: PASS; pinned tunnel-client/ripgrep checksums PASS; packaged runtime and macOS arm64 bundle smokes PASS (24 Mach-O + eight executable modes).
- Third-party notice/native sources: PASS (92 production packages / 730 source inventory entries).
- Real-account send/receive, 24–72h endurance and other-platform package tests: NOT RUN for this exact candidate.

Installed running Classic: **3.1.17** at initial audit; deployment of 3.1.19 intentionally withheld until live missions are quiescent and remote exact-main CI is green.
