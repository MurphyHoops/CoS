# Classic 3.1.17 — restart-safe provider history-pressure evidence

## Scope and canonical base

Starting base: `MurphyHoops/CoS main@9a9c01fe68ac696ab7365c915c0c4b944aec5f0e`.
Branch: `fix/classic-3.1.17-durable-history-pressure-20261013`.
No Next WebRuntime work and no change to bridge protocol 15.

## Fault

Classic previously held HTTP 429 conversation-history Retry-After evidence in the in-memory `providerHistoryBackoffUntil` map. A reversible Bridge stop/start retained that map, but an Electron process restart discarded it, potentially allowing browser repair to reload history during the provider-imposed wait.

## Change

1. Persist valid bounded per-conversation Retry-After deadlines as `provider-history-backoff.json` in the existing local durable state store before returning from the recorded observation path.
2. Restore valid unexpired deadlines at Bridge startup **before** command recovery and before publishing automatic browser repairs.
3. Reject malformed/IO-failed pressure ledger restores for automatic browser repair with a fail-closed hold. Ordinary chats and explicit Stop remain available. A manual review of the damaged file is needed before allowing automatic repair again; this is not an automatic bypass of rate limits.
4. Repeated provider evidence attempts durability again even when the deadline was already installed in RAM (an earlier fsync failure must not become a false success).
5. Preserve exact conversation specificity, expiry, prior longer deadlines and existing `/repairs/claim` recheck. No background refresh or new executor is triggered merely by observing a limit.

## Verification

Full `npm run verify:ci`: PASS (4,861 main tests, 2 MCP Shutdown), TypeScript and privacy/notices gates passed. Bridge integration 457/457 PASS, including new restart-snapshot and repeated-provider-write regression tests. `dist:dir:mac:arm64` PASS, pinned native SHA verification PASS, packed runtime and bundle smokes PASS.

## Deployment boundary

3.1.17 is built as a candidate under `release/mac-arm64` but **not** installed into `/Applications`. The existing Classic 3.1.16 and live tunnel processes were left untouched to avoid interrupting an active session. No real ChatGPT E2E or long-run endurance result is claimed for this candidate.

## Next

Validate real-account chat send/final and 429 hold from a controlled, disposable session, then 24–72h Goal/Worker durability against a frozen acceptance matrix. Compare upstream #1399 and #1402 changes before adding automatic Stop/Continue rotation. Consolidate recovery owners before adding further background retry paths.
