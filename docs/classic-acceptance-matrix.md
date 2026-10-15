# Classic 3.x acceptance matrix — release and long-run gates

Canonical product: the Classic standalone 3.x app with Chrome companion, durable Goal/Loop, Prime/Worker, MCP and project runtime. Next WebRuntime is an isolated experiment and is **not** a substitute for these gates.

## Three independent verdicts

- **Synthetic PASS** — typecheck + focused unit/contract + full `verify:ci` at the exact commit, with all exemptions/skips recorded.
- **Packaged PASS** — exact-commit clean arm64/x64/Windows/Linux release build where applicable, pinned SHA-256 verified downloads, native prebuild/MCP smoke, stable Chrome companion build identity and bridge-protocol parity.
- **Real-account PASS** — one disposable ChatGPT conversation with one message; prove CoS input queued → native user UUID → dispatch ACK → Fiber typed `assistant-message` final with stable identity → canonical `messages.json` and CoS UI. Check `Goal Off`, `Loop Off`, no stale recovery; never use repeated new chats as a repair strategy.

An individual layer passing must never be presented as the other layers passing.

## Required scenario matrix

| ID | Scenario | Positive evidence / rejection condition |
|---|---|---|
| CHAT-01 | CoS text input → ChatGPT | Unique marker emitted once; exact user UUID, ACK, conversation identity and no duplicate dispatch |
| CHAT-02 | ChatGPT final → CoS | Typed Fiber canonical final, correct messageId/turnId, persisted `assistant_message final`, UI receipt |
| CHAT-03 | Long context + Markdown | No private reasoning/I/O captured; only visible prose and allowed presentation |
| MCP-01 | Core/Desktop/Plugin calls | Authenticated exact callId/server/tool identity, owner attribution, durable result without cross-chat leakage |
| GOAL-01 | Goal/Loop next turn | Exactly one owed reply after confirmed final, no stale-silence or duplicate replay |
| WORK-01 | Prime/Worker A→B→A | Distinct conversation owners; no cross-attribution, reuse dead worker only with valid authority |
| STOP-01 | Stop during tool and recovery | Durable Stop fences late ACK, restart and queued side effects; unknown external mutation is audited first |
| WAIT-01 | External `session_wait` | CI/timer/process wait persists when model turn closes, resolves once, no busy model polling |
| RESTART-01 | Restart 20 times | Same Mission and obligations; no duplicate non-idempotent execution |
| LIMIT-01 | HTTP 429 Retry-After | Conversation-specific durable hold survives full app process restart; no reload/claim/reopen during backoff |
| LIMIT-02 | Unreadable pressure ledger | Fail closed for automatic browser repair, visible manual reconciliation path |
| STREAM-01 | Live streaming page | Never auto-reload an actively streaming answer; no feedback recovery storm |
| RECOVER-01 | Silence / no-tab / network | One recovery owner, bounded escalation, no replacement while Browser only; no blind resend on lost ACK |
| ID-01 | Local → server identity | No duplicated sessions on provisional URL or UUID rotation; reject cross-chat identity conflicts |
| ID-02 | Reload after stalled long turn | Only same canonical unanswered question can share response ownership; a new question or Regenerate must not be joined |
| UPDATE-01 | In-place upgrade | Saved user data, stable extension path and automatic matching companion update; no manual extension reimport |
| LONG-24 | 24-hour controlled run | Durable Goal/Worker continues with audited holds; no unresolved silent stall or duplicate mutation |
| LONG-72 | 72-hour production-like run | Repeated network, CI and restart transitions recover; resource/PTY/browser window growth stays bounded |

## Exact 2026-10-14 evidence (not an endorsement of all rows)

- Classic 3.1.17 `main@7bc5a95`: GitHub CI jobs P5 Lifetime Gate and Verify macOS arm64 `success`.
- 3.1.17 installed on the authorized Mac after verified backup; companion automatically moved from 3.1.16 to `cos-3.1.17-history-pressure-v1`; local bridge `/hello` reported app 3.1.17 protocol 15.
- Browser-origin test chat `6acf8231-7834-83ec-aa1f-7990c71e7961`: unique prompt and matching visible final; CoS Session `2026-10-14-9476a24e` independently stored the canonical `user_message` and `assistant_message` with `state=final`, `final=true`.
- That confirms browser → CoS recorder path **only**; CHAT-01 (native CoS desktop input) and full UI receipt remain **NOT VERIFIED**, partly because the desktop inspection tool reports `SCREEN_PERMISSION_REQUIRED`.
- Some tool calls from unrelated existing chats still appear as `Unattributed activity` after 20s evidence grace. This is an open identity/transport issue, not proof that the stored browser-origin chat failed.
- Do **not** mark ID-02, LONG-24 or LONG-72 passed until purpose-built identity tests and real endurance evidence exist.
- Classic 3.1.19 independent audit adds same-turn native final / late `stalled` fence with red-before-green proof and five fail-closed cases. This narrows but does not close **ID-02** (different-turn same-question proof remains absent). Upstream 2.1.37 PR #1475 fixes ID-02 using `timelineTurns/questionId`; Classic must first migrate an equally strict identity proof.

## Promotion order

1. Freeze an exact commit and verify upstream divergence / source hashes.
2. Focused contract tests → full local verify → clean packaged native smoke → GitHub exact-main CI.
3. Quiesce active missions, snapshot config/state, preserve rollback .app, install once, confirm same bundle and companion build.
4. Disposable real-account input/final chain, then MCP/Goal/Worker/Stop, then 24-hour and 72-hour endurance with explicit diagnostic logs.
5. A failed gate holds distribution; do not declare success based only on thousands of unit tests.
