# CoS Next G1b isolated diagnostic implementation — 2026-10-08

**STATUS:** local MCP probe operational, **REAL CHATGPT SESSION INGEST NOT YET VERIFIED**. The old CoS 3.1.16 app, extension, tunnel, task store and release worktrees were not altered.

## Delivered on `next/v4-chatgpt-first-design`

- `scripts/next/identity-probe.mjs`: separate loopback-only MCP HTTP service. No task management, no autonomous model inference, no destructive tools.
- `scripts/next/identity-probe.d.mts`: accurate TypeScript declaration for tests.
- `test/next/identity-probe.test.ts`: end-to-end local HTTP request parsing, host metadata, HMAC fingerprint consistency, cross-conversation separation, invalid metadata rejection, absence handling, OAuth-not-proven posture, read-only tool discovery, request-size and URL access bounds.
- `docs/next/REAL_CHATGPT_META_PROBE_RUNBOOK.md`: one-time user-approved connection through a *separate* Secure MCP Tunnel; exact acceptance procedure and required trust gates.

## Evidence

1. Isolated MCP SDK test called `probe_host_session` with fabricated `_meta["openai/session"]` and `_meta["openai/subject"]`, observed only anonymous HMAC fingerprint/presence flags. Same source values produce stable fingerprints within the process; different conversations differ.
2. Fake metadata or unverified OAuth never grants mission authority: returned `mission_authorized=false`. There is no CoS Mission operation in this endpoint.
3. HTTP listener binds to `127.0.0.1` only, requires high-entropy path, enforces 128 KiB body limit. Runtime smoke: **HTTP 200, `session_present=true`, `mission_authorized=false`, no token leaked into process logs**; process exited and test port closed.
4. Full targeted CoS regression including earlier new tests and newly added probe tests: **15 files, 512 passed, 9 skipped, 0 failed**, ~17.47 seconds. `npm run typecheck` exit 0.
5. The first iteration of the probe had an over-escaped control-character regex, yielding 5 failing new tests. Fixed the regex, wrote regression cases, reran passing; did not count the original failures as successful. First TypeScript check detected missing `.d.mts`; supplied a declaration and fixed address narrowing; final typecheck passes.

## Gates

| Gate | Status | Why |
| --- | --- | --- |
| Local source isolation | PASS | Only CoS Next worktree artifacts changed |
| SDK extracts host metadata | PASS with synthetic host fields | Actual modern MCP SDK callback reads `ctx.mcpReq._meta` |
| Local network transport | PASS | Real loopback HTTP MCP request/response and discovery |
| Real ChatGPT tools/call sends host metadata to this endpoint | **PENDING, not PASS** | Requires independently connected diagnostic plugin/Tunnel and user enrollment |
| Same ChatGPT conversation fingerprint stable, other chat differs | **PENDING, not PASS** | Unit tests with fabricated values are not a real ChatGPT experiment |
| Scoped principal authorization for active CoS mission | **BLOCK** | `openai/session` is correlation metadata, not authentication; current probe never authorizes a mission |
| Extensionless agents/waits/projects | **BLOCK** | Installed CoS 3.1.16 still requires exact CoS session + conversation for these operations |
| Automatic next ChatGPT Web reasoning turn | **NOT ESTABLISHED** | MCP tool server cannot assume host turn-start capability |
| Extra metered inference billing from this experiment | ZERO | No inference API was called |

## Why the work cannot truthfully be marked as end-to-end verified yet

ChatGPT tool call metadata is documented by OpenAI, and the installed `@modelcontextprotocol/server` receives it in controlled MCP requests. However, current installed CoS tools do not expose raw `mcpReq._meta`, so no *actual* ChatGPT-delivered metadata was observed in this isolated probe. Creating/reusing another remote connection would require separate authorization and must not hijack the existing CoS connector.

The independently configured Secure MCP Tunnel requires a **new `tunnel_id` and runtime authentication key with permission to use that new tunnel**. Those cannot be inferred, reused from the production tunnel or silently obtained. Then the user must explicitly connect the new diagnostic tool in ChatGPT. See the separate runbook for the full steps. Once connected, the assistant can compare at least two calls from Chat A against one from Chat B with this very probe.

Until those calls succeed, preserve the current browser companion, the production Goal/Agent workflow, and the original user data intact.
