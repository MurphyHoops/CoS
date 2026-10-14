# Classic 3.1.18 — upstream packaging reliability port

Base: `MurphyHoops/CoS main@7bc5a958d5808e8c4506282a363a6c61c3f00c8f` (Classic 3.1.17).
Branch: `fix/classic-3.1.18-upstream-packaging-retry-20261014`.
Upstream: `totec448-spec/chat-on-steroids main@08f9f5a1ee319dd8905857c264013ea4dd3efb3a` (2.1.37); focused port of [PR #1474](https://github.com/totec448-spec/chat-on-steroids/pull/1474), preserving upstream MIT copyright/license.

Changes: `scripts/fetch-retry.mjs` with bounded transient retries and preserved request headers; tunnel/ripgrep/locked-native-prebuild callers migrated to it; existing reviewed 730 native-source pipeline remains unchanged. `test/fetch-retry.test.ts` ported/adapted with fork-specific source downloader exclusion. Bumped Classic app/companion 3.1.18; protocol stays 15.

Open upstream gap: [PR #1475](https://github.com/totec448-spec/chat-on-steroids/pull/1475) fixes Goal final completion after a long stalled turn reopens on reload. Classic 3.x `readCompletedFinal()` has no equivalent `timelineTurns`/`questionId`; direct paste would risk joining a regenerated answer or an unrelated question. Must first design and test a durable canonical question/response relation before promoting this logic. Keep ID-02 as an acceptance gate.

Real-account test evidence (3.1.17): one fresh ChatGPT browser-origin conversation produced exact final and local canonical message files; it does not validate native CoS input. Desktop screen inspection is currently blocked by Screen Recording permission, and unrelated MCP calls remain intermittently unattributed. See `docs/classic-acceptance-matrix.md`.

Verification: focused downloader 10/10; downloader+extension 194/194; `npm run verify:ci` 4,871+2 tests PASS (129 suite-policy skips); `npm run dist:dir:mac:arm64` PASS; packaged runtime and macOS bundle smokes PASS; 92 production package notices and 730 reviewed native source references checked.

Installation status at build: 3.1.17 was running from `/Applications` with its companion updated; it must be quiesced before replacing. No 3.1.18 live-account E2E has been asserted.
