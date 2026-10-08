# WP01 — ChatGPT MCP Host Identity Diagnostic Implementation

Date: 2026-10-08
Branch: `next/v4/wp01-mcp-identity`
Tracking: canonical Epic #13; design base `next/v4-chatgpt-first-design`
Status: **LOCAL-GREEN / LIVE-G1b-HOLD / G2b-NOT-STARTED**

## Scope delivered

1. `src/main/mcp/host-identity.ts` extracts `openai/session` and `openai/subject` **only from the real MCP handler context**. It accepts bounded non-empty string values and rejects control characters and malformed types.
2. Request-local `AsyncLocalStorage` isolates concurrent tool calls. Per-process random HMAC keys create short, nonreversible diagnostic fingerprints; keys and raw IDs are never written to session logs.
3. The Core registrar wraps actual SDK dispatch with request evidence. The existing exact request-ID/page-correlation ownership route is **unchanged**.
4. `identity_diagnostics` is a read-only Core tool and is **disabled by default**. Only a separately started development process with `COS_NEXT_IDENTITY_DIAGNOSTICS=1` advertises it. Tool arguments cannot activate it. The tool cannot attach, authorize, write, wake or stop missions.
5. New direct SDK tests cover missing/malformed/forged metadata, HMAC domain separation, concurrent ALS isolation, tool discovery default-off, real MCP callback wiring, repeatability, cross-chat distinction, and raw-ID non-disclosure.

## Evidence and nonclaims

- Local macOS Node v26 TypeScript check: `npm run typecheck` **PASS** (2026-10-08).
- Focused cross-module 15-file suite: **490 passed, 9 skipped, 0 failed**. This validates existing Core/MCP/agent/long-run compatibility under synthetic requests.
- Added a legacy 2025-era Streamable HTTP Core request regression alongside the 2026-07-28 request test: metadata arrives on both without promotion to Mission authorization. Latest 4-file MCP-focused run: **193 passed, 9 skipped, 0 failed**; TypeScript check passed. This remains a synthetic-host verification, not real ChatGPT G1b.
- Earlier first-run failures came from unconditional diagnostic tool discovery and a missing `destructiveHint`. Both were fixed before the passing rerun.
- **G1b is not passed:** official metadata transmission in two *real* ChatGPT web conversations has not been validated on the existing connector.
- **G2b is not passed:** an MCP `_meta` string is caller-provided correlation data, not verified account identity or authorization. No new Mission lease is issued.
- **Web autonomous continuation is not established:** a background local supervisor cannot compel ChatGPT Web to generate a new response.
- **Legacy CoS 3.1.16 is untouched:** no tunnel re-registration, production app restart, credential transfer or user-data migration.

## Next gates

- G1b: genuine Chat A→A→B→A per-process fingerprint trial; verify same A, distinct B and absence of raw IDs, with explicit approval for any existing connector maintenance window.
- G2b: principal verification, explicitly approved binding, MissionLease and project scope enforcement, epoch/revocation and negative writes.
- Only after those gates: same-kernel Agent/long-run reconciliation, native local model bridge, independent packaging/migration gates.

CI workflow: `.github/workflows/next-identity.yml`. Test file: `test/host-identity-diagnostics.test.ts`.
