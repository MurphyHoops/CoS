# P3.6 Web-only Goal/Loop restoration and Classic DOM parity

Date: 2026-10-10. Authorized macOS host, Next branch next/v4/p3-native-trust.

## Website-only inference requirement

The only inference source in this lane is the signed-in ChatGPT WEBSITE, with its normal account usage limits. NO Codex, Codex CLI/app-server, OpenRouter gate model, paid OpenAI/other inference APIs, private ChatGPT model endpoints or quota circumvention.

Classic CoS already had sophisticated browser and goal code, but its goal.ts relied on an OpenRouter model to decide whether to continue. Migrating that implementation literally would silently reintroduce a separate inference bill against the user's requirement. Next's implementation instead uses the visible ChatGPT website, persisted CoS tasks and browser receipts.

## Implemented now

- Native goal-specific website execution: one native approval, up to 3 messages / 15 minutes, exact visible ChatGPT conversation URL, durable per-send Outbox, CDP keyboard input, DOM delivery proof, stable assistant reply, and a fresh durable task checkpoint before an additional turn. Stops on uncertainty, rate limit, page switch, operator stop, task waiting/review or expired run.
- Native Goal menu: new ChatGPT conversation for approved ACTIVE Goal, run bounded existing-chat Goal/Loop, stop, inspect status; independent harmless real website send/reply acceptance with explicit confirmation.
- First new-chat website send waits for actual /c UUID plus exact visible user message before atomically binding temporary Outbox to real chat. Anything ambiguous is held, never auto-replayed.
- Existing registry, project approvals, workbench, plans, local read-only diagnostic workers, AI Worker roster, persistent recovery/Outbox, Core MCP and native exit remain. A roster entry is NOT independent ChatGPT model inference.
- Reused October-2026 browser DOM structural discovery from Classic extension/chatgpt-dom.js: data-turn-key, data-chatgpt-search-unit-key, data-user-message-bubble, data-conversation-role, data-composer-body, data-composer-markdown and composer-stop-button. The legacy author-role selectors remain fallback. JSDOM tests run the exact native inspector scripts against the Classic-style modern fixture.
- Read-only webpage UI inspection returns structure and readiness only; no cookies, tokens, private network API or hidden chats.

## Real webpage evidence and important scope

Two harmless actual ChatGPT website messages were sent from the native Electron window with normal website quota and native user confirmation. The automatic CoS verdict was UNPROVED because its then-legacy message DOM selectors did not identify the new website structure. An actual on-screen screenshot on the authorized Mac demonstrated the browser had received the test message AND displayed the actual expected ChatGPT assistant response COS_NEXT_WEBPAGE_SMOKE_OK. The screenshot and actual chat content were not added to the repository.

The Classic modern DOM logic was then ported and validated in isolated Electron native smoke and browser DOM fixtures. The Mac graphical session subsequently returned no accessible windows / an all-black screenshot, so a further real post-fix website verdict was NOT safely observed. Do not conflate a screenshot-observed real model response with machine-verified delivery/complete proof.

Earlier actual ChatGPT Core calls sent anonymized openai/session and openai/subject to Next. Same-chat fingerprints stable twice. This is host correlation, not OAuth/account principal authorization; identity_verified and mission_authorized deliberately remain false.

## Scope that remains NOT fully accepted

Real post-modern-DOM webpage UI send/reply verdict is pending a live visible GUI session. Independently inferred multi-ChatGPT-worker model sessions, durable multiworker messages/ownership, truly unattended long-running Goal/Loop, cross-chat A/B identity, network failure injection at the model-turn boundary and full Classic parity remain unverified. None of those should be called production complete.

Browser website quota/429 is respected, never bypassed. Project mutations require independent native approval. Stop fences future sends and uncertain sends are never repeated automatically. User task/profile and original Keychain preserved; local Git commit only, no cloud push.

## Real next acceptance

When Mac screen becomes available: run ONE opt-in actual model website test against the latest build and require native machine PASS; then one approved ACTIVE project Goal with new chat + multiple real webpage turns, checkpoint and finish-request receipts; then separate conversations for genuine independently running website AI Workers with scoped ownership and permissions. Keep users' existing configuration and old application intact until parity gates pass.
