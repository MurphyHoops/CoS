# CoS Next — live legacy credential/host attribution experiment (2026-10-08)

**Scope:** Read-only authentication-path validation using the existing installed CoS 3.1.16 application; old application was temporarily launched as the sole Tunnel owner, then gracefully quit. No credential copied or printed, no additional MCP registered, no new workflow launched, no source pushed.

## Evidence observed from the original application

- Original install: `/Applications/Chat On Steroids.app` (v3.1.16), separate from CoS Next's isolated macOS ARM development bundle.
- Original userData contains an encrypted `secrets.bin` (mode 0600) and a `config.json` whose `tunnel.kind` is `openai`. Core, Desktop and Plugins Tunnel IDs are configured; exact IDs and secret material intentionally **not recorded**.
- Launching the original app as the sole Tunnel owner started its three genuine `tunnel-client` children. Original app diagnostic logs recorded three successful Tunnel connection events.
- The running, authenticated old **Core** MCP connector successfully processed a real ChatGPT-origin read-only `read({paths:['/cos']})` call and returned the expected local repository directory listing.
- **Crucial negative evidence:** that genuine result included the app's **Unattributed** identity notice. The tool could not authoritatively identify the exact calling ChatGPT conversation. An authenticated tunnel does not establish authenticated **end-user conversation identity**.
- The original app was gracefully quit after the probe, and its `tunnel-client` processes were no longer running. Old source worktree and Next source worktree were kept separate.

## Precise authorization conclusions

| Gate | Result | Evidence / remaining blocker |
|---|---|---|
| Existing OpenAI Tunnel control-plane credential and registered IDs | **PASS (live path)** | Old client established three connections and accepted a real ChatGPT MCP tool call |
| Real ChatGPT ↔ old CoS Core tool traffic | **PASS (live read)** | Directory listing returned from the installed app via existing plugin |
| Unique, independently verified ChatGPT conversation / principal | **NOT PROVEN** | Live call was explicitly Unattributed; a forged `openai/session` in MCP `_meta` is not authorization |
| Reusing this control-plane credential to authorize **Next** Mission/Agent/Stop | **BLOCKED** | Different credential purpose; Next G2b verified-host resolver remains disabled |
| ChatGPT plan entitlement through local Codex app-server | **NOT TESTED** | Old CoS `openaiApiKey` controls Tunnel access, not Sign in with ChatGPT plan OAuth consent. A distinct SIWC authorization is required. No authentic subscription-token inference turn was run |
| Installed Next app with no tunnel contention | **PRESERVED** | Next did not start a Tunnel during the experiment; old app closed after test |

**Do not** copy `secrets.bin`, extract credential plaintext, reuse old OpenAI Tunnel API Key as Codex `ACCESS_TOKEN`, infer authorization from `_meta`, run simultaneous same-ID tunnel owners, or silently fall back to metered API.

## Local regression cross-check

- After the live call, the original app and all three of its tunnel-client children were gracefully stopped; process inspection confirmed no lingering owner.
- Next's identity-probe, loopback MCP, Mission gateway and lease security focused suite passed **46/46 tests**, and TypeScript typecheck passed. These are isolation controls, not substitutes for G1b live account identity or genuine plan inference.

## Next production-gate experiment

1. Add a locally approved, scoped verified-principal adapter (SIWC OAuth if suitable) independent of model-supplied MCP arguments; test anonymous, revoked, mismatched project/conversation and epoch fences.
2. Enroll Next through the documented **Sign in with ChatGPT** OAuth flow with user consent for plan inference and locally protected storage. Do **not** import an old CoS control-plane key as OAuth.
3. Install/point to an official Codex app-server binary and run one minimal plan-backed model turn with a specific selected model; record only status/cost-source/turn result (no tokens), then test app-server restart and thread resume.
4. For browser-based ChatGPT, keep the continuation **OWED** until a real host/user-created turn is observed. Never fake webpage turn wake or exceed usage limits.

Official guidance: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server and https://developers.openai.com/siwc/token-sharing-open-source/sign-in .
