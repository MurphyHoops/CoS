# 2026-10-13 Classic recorder and recovery compatibility backport

## Problem

Classic CoS 3.1.16 could deliver user messages to current ChatGPT but fail to record the assistant answer. Live diagnosis showed the current ChatGPT shell no longer exposes the legacy canonical shape expected by Fiber protocol v12: the rendered exchange is rooted at `data-turn-key` and the React model exposes typed `turn.items[]` entries such as `user-message`, `chatgpt-reasoning-group` and `assistant-message`.

The same installation could also amplify ChatGPT conversation-history rate limits. Recovery reloads perform full conversation loads; reloading while a response is streaming or while ChatGPT has supplied a history Retry-After can turn one transport failure into repeated history loads and a visible “conversation could not be loaded” failure.

## Source and scope

Reference repository: `totec448-spec/chat-on-steroids` at `461b97018ce6a993601231dd9bd4a5af7a93417d` (2.1.35).

This branch selectively backports recorder/recovery mechanisms into the existing Classic 3.1.16 architecture. It does not replace the CoS 3.x Goal/Loop, session, worker, MCP or UI layers.

Adapted upstream work:

- PR #319 / #318: modern shell anchors and typed `turn.items[]` projection.
- `9c7c50a81d0b87672bb61f597078bdb689d2f045`: do not reload a streaming page for attribution repair.
- `f3d6d1fdb8845cbe6970fe009e44e4bde25b1bf6`: ignore hidden routed pages retained by ChatGPT.
- `d1170dfba58638897afda1ceb2b7726ba264f11d` and `db04ea9e34bb49053f2bc7538fadeebc38f70b0c`: observe conversation-history 429 Retry-After, including the bounded headerless fallback.
- `2eeb0474baea397d0cf55c89a14ac5faea2ab54f`: conversation-scoped history backoff through the browser recovery boundary.

Contributor attribution is recorded in `CONTRIBUTORS.md`.

## Recorder changes

Fiber protocol advances from 12 to 13. The MAIN helper now:

- recognizes the modern `data-turn-key` / typed search-unit shell while retaining legacy `conversation-turn` support;
- converts only `user-message` and `assistant-message` items into the existing canonical message shape;
- never projects `chatgpt-reasoning-group` private reasoning;
- treats an assistant item as terminal only when `completed === true`, `phase === "final_answer"`, and `turn.status === "complete"`;
- ignores renderer-local `WEB:*` and `local-chatgpt:*` identities as durable conversation ids;
- ignores ChatGPT page surfaces kept mounted but hidden after routing;
- replaces any older MAIN-world helper listener after extension reinjection, rather than allowing an old protocol listener to keep answering scans.

The extension/app build identity advances to `cos-3.1.16-upstream-modern-recorder-v6` so already-open documents cannot silently retain the previous recorder.

## Recovery changes

The passive MAIN-world usage observer now recognizes an exact same-origin GET 429 for a conversation-history route and projects only:

- the exact conversation id;
- observation time;
- bounded provider Retry-After deadline.

No response body, cookie, credential or conversation text crosses this boundary. If Retry-After is absent, the observation uses a bounded 60-second conservative hold.

The content recorder converts this into a non-recoverable blocking `chat_error` carrying `retryAt`. The bridge keeps a per-conversation history deadline and refuses both queued repair handout and final `/repairs/claim` while that deadline is active.

For unattributed recovery, the browser asks the target page for native streaming state first. A responsive streaming page is not reloaded; the incident remains retryable for a later pass.

## Validation

Focused validation before full-suite verification:

- `test/fiber.test.ts`: 93/93 passed, including the October 2026 `turn.items[]` structure, private-reasoning exclusion, and identity-only nested MCP tool-call projection.
- `test/usage-observer.test.ts`: 28/28 passed, including Retry-After, bounded headerless fallback, HTTP-date and foreign/non-GET rejection.
- `test/extension.test.ts`: 184/184 passed, including streaming no-reload and recovery controls.
- `test/content-script.test.ts`: 628/628 passed, including exact history-limit journal projection.
- `test/bridge.test.ts`: 454/454 passed, including a handed-repair race fenced by a newer Retry-After.
- Combined focused run: 1,387/1,387 passed.
- `tsc --noEmit -p tsconfig.json`: passed.
- `git diff --check`: passed.

Full local verification completed after the focused gates:

- `npm run verify:ci`: PASS.
- Main Vitest run: 190 test files passed, 13 skipped; 4,858 tests passed, 129 skipped.
- Isolated `test/mcp-shutdown.test.ts`: 2/2 passed.
- Privacy history gate, notices/native-source verification, Electron load and TypeScript typecheck all passed before the test run.
- Total passing tests in the CI-equivalent verification: 4,860.
- macOS arm64 directory packaging: PASS with pinned tunnel-client v0.0.15 and ripgrep 15.2.0 checksum verification.
- Packaged-runtime smoke: PASS for Electron 44.3.0, Sharp/libvips, PTY, tree-sitter, MCP and Desktop helper.
- macOS bundle smoke: PASS for 24 thin arm64 Mach-O payloads, 8 launchable binaries, deployment floors and ad-hoc sealed resource envelope.

## Real ChatGPT E2E and local install

After the package gates passed, the verified arm64 bundle replaced the existing Classic 3.1.16 installation without changing the live Classic data root.

A single disposable authenticated ChatGPT conversation was used for the real recorder gate. There was no automatic resend:

- one unique user marker was submitted once;
- the real ChatGPT page completed with the exact requested assistant marker;
- the page exposed the current typed user and assistant search units;
- the Classic session store created one `user_message` and one `assistant_message` for the test;
- the assistant record came from `source: "extension"`, had `state: "final"` and `final: true`, and retained the real rendered assistant bytes;
- the renderer path consumes `renderedHtml` alongside canonical message text, so the modern rendered answer is displayable rather than merely present in page DOM;
- throughout the v6 boot and E2E window there was no conversation reload, fresh executor, history 429, Retry-After recovery or provider access-limit event.

The disposable browser tab was closed after evidence capture.

The installed Classic companion identity is now `cos-3.1.16-upstream-modern-recorder-v6`, and the stable support-directory extension was automatically refreshed to the same build without deleting/re-loading the Chrome extension.

## Local cleanup

After successful E2E, obsolete local Next/Preview installations and their support directories, old extension-path backups, the temporary pre-v6 rollback bundle, and the old Canary backup were removed. The active Classic data root and its session/configuration data were preserved.
