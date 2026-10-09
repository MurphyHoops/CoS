# P3.5: Real Host Metadata and Web-Only ChatGPT UI

## Binding user requirement

The only inference provider in this lane is the signed-in ChatGPT WEBSITE. No Codex, no Codex app-server, no metered inference API fallback. Web messages consume normal site usage and must respect quotas and cooldowns.

## Verified live results

- The native P3.5 packaged App reconnected to the original Core Tunnel after its normal native consent. Existing encrypted Keychain credentials were not copied, exported or printed.
- Actual tool calls from THIS ChatGPT conversation delivered both MCP openai/session and openai/subject metadata to the Core's new identity_diagnostics handler.
- Two consecutive real requests had identical anonymous 24-character HMAC session fingerprints and identical subject fingerprints. Raw IDs never appeared in the responses. The HMAC key lives in the local MCP server process and changes on restart.
- Local real HTTP transport tests verify forwarding of synthetic MCP metadata into the same SDK callback, cross-session distinct fingerprints and invalid-field rejection. This synthetic test is distinct from the live evidence above.
- The existing Electron native-web-input uses Chromium DevTools Protocol to click the prompt editor, input text, press Enter and confirm a newly rendered user message. A durable outbox fence and native one-shot approval prevent blind retries; it is not any Codex model.
- New native menu: ChatGPT 网页 / 检查网页原生操作能力（只读）. It reads only page origin, conversation route validity, editor presence, draft/generation booleans, UI button presence and DOM message counts. It reads no cookies, tokens, hidden model APIs or chat text.
- Real native UI inspection returned CHATGPT with a visible READY editor, but NO concrete conversation route in the embedded page. The model-dispatch gate appropriately returned NOT READY, and no actual ChatGPT model turn was sent.
- The packaged isolated Electron smoke passed the new native webpage-control inspector along with the prior Goal, Worker, Core and browser-continuity fixtures.

## Gate result and limits

G1b = PARTIAL PASS: real host metadata arrived, and same-conversation correlation works. Cross-conversation A/B/A checks are still required while the same Core process is running.

G2b = HOLD: anonymized host metadata is NOT proof of authenticated user identity. Neither the website URL nor the encrypted tunnel is sufficient for authenticated MissionLease, multiworker write, or Stop privileges. Mission authorization must remain false.

Web Computer Use = UI ENGINE AVAILABLE, READINESS VERIFIED. Electron/WebContents and CDP can operate the actual ChatGPT page. The current web account was on the ChatGPT homepage, not a bound Goal conversation, therefore actual model delivery was NOT tested here. The browser usage quota is NOT unlimited, and ordinary provider limits must be obeyed.

## Remaining Web-only execution contract

1. Run cross-chat A/B/A metadata fingerprint tests, without restarting the local Core.
2. Bind the observed session to an explicitly approved native Mission, with scoped capabilities, expiry and revocation. This correlation alone must not elevate identity_verified.
3. Per-worker visible web conversation selection, UI readiness, one-shot send receipt, stable visible reply, uncertain delivery reconciliation and task progress receipt.
4. Bounded, audited web-only queue and explicit waiting on real website cooldowns. Never auto-replay uncertain sends or circumvent a service rate limit.
5. Verify distinct live worker conversations before claiming independent AI Worker inference or unattended loops. This project deliberately does not use Codex.
