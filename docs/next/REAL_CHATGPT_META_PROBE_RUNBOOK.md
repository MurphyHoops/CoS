# CoS Next — G1b ChatGPT live-session probe: deployment and acceptance contract

Status 2026-10-08: **local probe implemented / local tests pass / genuine ChatGPT-to-probe connector not connected.** Do not claim G1b passed.

## Purpose
Prove on a real, current ChatGPT tool call whether MCP `_meta["openai/session"]` and `_meta["openai/subject"]` reach a local CoS Next endpoint, and whether the anonymized session ID is consistent across calls in one conversation and different between two conversations.

This test **does not** create, change or own CoS missions; cannot start agents, wait on jobs, modify projects, access local files or infer the raw ChatGPT conversation URL/ID. No provider reply scraping, cookie collection, browser extension, or paid inference API fallback.

## Prepared files
- `scripts/next/identity-probe.mjs`: isolated HTTP MCP probe, tool names `probe_host_session` and `probe_diagnostics`; binds to **127.0.0.1 only**, random private path, 128 KiB request limit, no persistent call logs. The former returns presence flags and ephemeral per-process HMAC fingerprints, **never raw identifiers**. Both tools are read-only and always return `mission_authorized=false`.
- `scripts/next/identity-probe.d.mts`: isolated probe TypeScript declarations for accurate tests.
- `test/next/identity-probe.test.ts`: runnable HTTP/protocol/discovery/privacy/negative-control tests.
- `test/next/host-session-metadata.test.ts`: SDK simulation and illustrative principal/lease security tests from the earlier checkpoint.

## Live connection prerequisites and safety
The current installed CoS 3.1.16 has a running Secure MCP Tunnel. **Do not reuse its tunnel_id, login credentials, sockets, tokens or production config.** A separate test endpoint must be provisioned. Per OpenAI's current tunnel documentation:
1. Provision a **new** Secure MCP Tunnel in an authorized Platform organization with Tunnels Read + Manage rights, and a dedicated runtime key with Tunnels Read + Use rights. Do not share the key in ChatGPT or commit it to the repository.
2. Ensure this tunnel is associated with the ChatGPT workspace that will add the diagnostic tool. The tool connection/install is a separate user action.
3. Create an isolated runtime data/config context and **separate probe token and local port**. Never copy the live CoS profile.
4. Perform all actual connection/enrollment via ChatGPT Plugins → Add custom MCP server → Tunnel → select the new tunnel ID → review permissions → Create as a plugin. A connector cannot be installed or connected without user action.
5. Local tests can run without a tunnel. They **cannot** prove metadata from ChatGPT; they only prove the MCP SDK accepts it.

### Run the diagnostic process once the prerequisites exist
Use only a terminal on the authorized Mac. Keep credentials in the user's protected environment, not in shell history, repo docs or commands copied into an AI chat.

In the isolated `CoS-Next` worktree, install its normal Node dependencies (`npm ci`); don't share or replace the installed CoS App's data. In one terminal, start the probe with independently chosen values:

```sh
export COS_NEXT_PROBE_PORT=48173  # dedicated free loopback port, example only
export COS_NEXT_PROBE_TOKEN="<independently generated 48+ character private token>"
node scripts/next/identity-probe.mjs
```

The diagnostic intentionally prints the **address without the private URL token**. It never prints ChatGPT request contents or the original session metadata.

On the same host, an independently configured `tunnel-client` can target the **separate** server URL, not the existing CoS endpoint:

```sh
# Keep the private local MCP URL out of command-line arguments; load only into
# the authorized test process environment, preferably from a chmod 600 file.
export CONTROL_PLANE_TUNNEL_ID="$COS_NEXT_TUNNEL_ID"
export CONTROL_PLANE_API_KEY="$COS_NEXT_TUNNEL_API_KEY"
export MCP_SERVER_URL="url=http://127.0.0.1:${COS_NEXT_PROBE_PORT}/probe/${COS_NEXT_PROBE_TOKEN}/mcp,channel=main"
tunnel-client run --health.listen-addr 127.0.0.1:0
```

This is a setup example, **not** an executed live tunnel test. Confirm installed `tunnel-client` flag compatibility and correct control-plane access before starting. Do not use real keys in ChatGPT prompts, project files or support logs. Authentication currently uses tunnel-specific access plus a private local path; this is **not** an OAuth-bound ChatGPT user principal.

### Real ChatGPT acceptance procedure
1. Chat A: invoke `probe_host_session` **twice**, recording only returned booleans, `session_fingerprint`, `subject_fingerprint`, `mission_authorized`.
2. Chat B, with the same connected diagnostic tool and user: invoke `probe_host_session` once.
3. A reload or another turn in Chat A: invoke once more if feasible.
4. Compare: Chat A fingerprints must match within the same test process; A and B session fingerprints should differ; the two subjects should match for the same user if the host supplies subjects. Missing fields are failure to establish identity, **not** permission to guess.
5. Test absence: if host sends no `openai/session`, diagnostics must respond `session_present=false` and no fingerprint. Never match by timing, the active tab, or the most recent `x-request-id`.
6. Test read-only policy: neither tool can perform a mutation or claim authorization, regardless of metadata. This is an observation test, not CoS mission-lease deployment.
7. Stop the diagnostic server and standalone tunnel; verify the old CoS app/connector and extension still work unchanged.

### Gate criteria
**G1b PASS** only after actual ChatGPT calls through this independent connector show consistent session metadata within a chat, isolation between two chats, and repeatability across at least two turns; record observed availability, not hypothetical success.

**G2b PASS** requires a **separate** verified connector principal/authentication and explicitly authorized project/mission binding, plus cross-user/cross-session negative tests on implemented CoS Next authorization code. Host-supplied `_meta` alone is never a secure permission grant.

**G3/G4 PASS** cannot be awarded by this probe: `agents`, `session_wait`, `project_runtime`, and headless web-chat continuation are not exposed in the diagnostic service and remain independently blocked until implemented and tested.

## Official references
- Plugin reference: https://developers.openai.com/plugins/reference
- Plugin changelog (2026-01-15): https://developers.openai.com/plugins/changelog
- Connect and test: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Nonnegotiable constraints
- No production Chrome extension disable/removal, no credential reuse, no active mission reattachment or local session migration in this step.
- No user data, cookies, prompts, tokens or raw anonymized IDs in traces, Git commits or visible diagnostics.
- No unlimited-model-use claims: the browser subscription is subject to OpenAI's actual usage restrictions.
