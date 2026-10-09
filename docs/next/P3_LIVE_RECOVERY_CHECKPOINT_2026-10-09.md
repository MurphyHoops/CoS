# CoS Next P3 — live continuity/recovery checkpoint, 2026-10-09

## Authority and baseline

**Main development source:** `CoS-Next-P3-Auth`, branch
`next/v4/p3-native-trust`. The feature code baseline is commit `174d1be`
(`fix(next): surface blank ChatGPT webview and bound safe page recovery`).
The P3 worktree had zero pending edits or staged files before this note.

**Previous-version non-target worktrees are NOT clean and must NOT be deleted
or reset:** `CoS-Next-WP03` (Classic experiments) and
`CoS-Next-WebFirst-P1` (earlier P3 staging). The newer P3 branch owns
live Web-First development. Do not mistake older uncommitted/staged edits for
missing P3 work.

## User-reported loss and durable local evidence

The previous interactive shell / agent turn interrupted. On local audit:

- User profile persisted under `~/Library/Application Support/chat-on-steroids-next-webfirst-preview`.
  The private `Partitions/cos-next-web-first-chatgpt` profile still existed;
  credentials/cookies/conversation text were not read or reset.
- Project ledger: 1 registered project. Read grant ledger: 2 persistent grants.
- Task ledger: exactly 1 durable task, phase `waiting`, revision 3.
- MCP operation receipts: 30 events (15 STARTED, 14 SUCCEEDED,
  1 REJECTED), **0 incomplete STARTED actions**.
- No local outbox file / pending web-send receipts. No model messages were
  dispatched during this audit or recovery.
- Local source tree is present at the known P3 path; this inventory finds
  **no evidence of committed P3 code deletion**. It does not prove remote
  ChatGPT history is complete or that all prior unsaved human edits survived.

## White page diagnosis and true app test

The user reported a solid white ChatGPT WebContentsView while native project
sidebar and Core Tunnel worked. The previous code did not expose web view
HTTP/network errors or document-empty conditions and could leave the user
with an unexplained blank pane. Commit `174d1be` added a separate sandboxed
failure overlay, main-frame error classification, bounded one-time blank
reload, and native safe reload without clearing user cookies.

**Independent tests:** 5,100 regular tests + 2 MCP shutdown tests passed,
131 skipped, zero failures. Packaged macOS ARM64 Electron offline fixture
passed real recovery overlay creation, native window visibility, project
find/replace, MCP/task state, input, reply and web message receipts.

**Real profile testing on the user's Mac** started the isolated ARM64 package
`release-next/webfirst-p3-blank-recovery/mac-arm64/CoS Next Web-First Preview.app`
with the existing persisted ChatGPT partition and opt-in aggregate-only health
capture. At 32 seconds:

- `document.readyState=complete`; 88 buttons; 10 history links;
  one visible enabled editable textbox; editor accepted input by DOM readiness
- 132 successful ChatGPT shell resource requests;
  46 successful ChatGPT API requests
- Two HTTP 429 `conversation-list` requests; no recorded network errors
- A macOS native *window-only* capture proved ChatGPT homepage, navigation,
  history panel and interactive composer rendered in the Electron window.
  The temporary screenshot was deleted after inspection.

The 429 response explains that **some history may fail to load or be delayed**;
it does not establish that conversation data have been deleted. A separate
unauthenticated command-line HTTPS request returned 403, but authenticated
Electron's successful UI proves the CLI result is not the page's status.
The original intermittent solid-white incident is now not reproducing in
this live session. Its exact earlier server/graphics fault was not captured,
so do not claim the error overlay alone fixed the root cause.

## App lifecycle recovery

The first diagnostics instance inherited a terminal parent and was unsuitable
for unattended running. It was exited via the native Quit menu with no
Tunnel owner remaining. The same validated app was restarted via `/usr/bin/open
-n -a <bundle>`. The new main process had PPID 1, persisted beyond the
terminal, and a second native window capture showed the homepage and composer
still rendered. Broker and tunnel-client subsequently ran, and ChatGPT Core
`runtime_health` returned successfully from the current chat.

Current identity posture is **not a verified per-conversation principal**:
`identity_verified=false`. The 12-tool Web-First Core surface remains scoped
with individual native consent where required. Read-only grants never imply
write, terminal, or auto-prompt authority. The user-approved task remains
`waiting`; resume/cancel require the native task UI and cannot be inferred
from messages.

## Next-needed P3 work (not a completed claim)

1. Diagnose and avoid aggressive retries on ChatGPT conversation-list 429s;
   page access and historical list availability are distinct gates.
2. Add a crash-safe native health receipt (privacy-sanitized main-document
   error/status and renderer lifecycle only), so a future white-page
   incident can be attributed without reading cookies or messages.
3. Verify actual system-managed window and Tunnel recovery over restart and
   provider network outage, with no duplicate owner and no blind resend.
4. Preserve all Classic Core tool parity and continue the real-page
   bounded work/Goal acceptance. Native provider-final turn evidence and
   verified chat-to-task identity remain absent; unattended auto-submit stays
   disabled.
5. Local Core project registration currently points at the user's test
   `cos next` folder; the real P3 repository needs a separate explicit native
   registration before Cloud Core tools can browse or edit it. Do not bypass
   the user's local project consent UX.

**Resume rule:** inspect actual git HEAD/status, live process ownership,
recent receipts, task ledger, ChatGPT page health and tunnel owner before
running any mutation. Never replay an ambiguous action just because a
previous chat was compacted or interrupted.
