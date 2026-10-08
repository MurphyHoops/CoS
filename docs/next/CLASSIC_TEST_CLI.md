# CoS Next Classic — secure local test CLI (2026-10-09)

**Status: local test tooling only / RELEASE HOLD.** This is a real packaged-Electron UI/IPC and restart test, not a ChatGPT live-delivery certificate and not a production remote-control API. Local branch `next/v4/classic-workflow-first`; no cloud deployment.

## Architecture and authority boundary

- `scripts/next-classic-cli.mjs` launches the exact macOS-arm64 packaged **Next** binary in a randomly generated, owner-only `cos-next-ctl-*` temporary HOME. It does **not** attach to the user's running Next app, existing sessions or original CoS 3.1.16 profile.
- The newly packaged Next main process exposes **one private 0600 UNIX-domain socket** (`control.sock`) inside that temporary HOME. No TCP listener, Chrome DevTools port, general JavaScript evaluation command, generic IPC or remote MCP tool is created by this CLI. Commands are strictly enumerated: `ping`, `status`, `ui-status`, `theme`, `send-fixture`, `outbox`, `quit`.
- The app verifies packaged Next identity, a path under the OS temporary root, a strictly shaped `chat-on-steroids-next` data directory, the private directory's ownership/mode and the explicit test environment before opening the socket. A normal Next instance and any real HOME fail this gate.
- Under this exact synthetic profile, OS Keychain/legacy credentials are **never queried** during initial UI state hydration, and browser bridge, model discovery wake, connection/Tunnel admission and background input startup are denied. The test fixture model merely permits exercising the actual composer; **it is not a claim of user/model entitlement**.
- CLI `verify` interacts with the actual renderer and typed IPC, checks that a reversible theme setting was committed to real disk, sends a synthetic labeled message into the original UI, checks its durable queue ID before/after restart and refuses falsely delivered state. It verifies the legacy synthetic sentinel remained byte-identical and removes the entire temporary HOME.
- The existing `verify-next-classic-gui.mjs` keeps its full real-window and CDP smoke, but uses the same **explicitly isolated** HOME/Socket mode. Its local CDP listener is bound to localhost solely during that dedicated test, and requests have a hard timeout. GUI test is allowed to show a test window; CLI mode keeps the test window in the background.

## Commands (from the CoS Next source worktree)

```sh
APP="$PWD/release-next/classic-cli-validated/mac-arm64/Chat On Steroids Next.app"
node scripts/next-classic-cli.mjs verify "$APP"  # complete one-shot, cleans up
node scripts/next-classic-cli.mjs start "$APP"   # prints a private temporary session HOME and test PID
node scripts/next-classic-cli.mjs status /tmp/cos-next-ctl-<exact-session>
node scripts/next-classic-cli.mjs ui-status /tmp/cos-next-ctl-<exact-session>
node scripts/next-classic-cli.mjs theme /tmp/cos-next-ctl-<exact-session> light
node scripts/next-classic-cli.mjs send /tmp/cos-next-ctl-<exact-session> 'Next CLI fixture: example'
node scripts/next-classic-cli.mjs outbox /tmp/cos-next-ctl-<exact-session>
node scripts/next-classic-cli.mjs restart /tmp/cos-next-ctl-<exact-session>
node scripts/next-classic-cli.mjs stop /tmp/cos-next-ctl-<exact-session>  # graceful stop, verify original sentinel, delete temp HOME
```

Replace `<exact-session>` with the returned value of `home` from `start`. The CLI's `verify` command is the preferred repeatable automated acceptance. If a test fails before its cleanup completes, inspect the exact test PID/HOME; **never** kill the user's separate `classic-validated` app or globally delete arbitrary sessions.

## Validated acceptance (2026-10-09)

- Packaged `com.chatonsteroids.next` ARM64 app signature and 8 native resources passed `verify-next-classic-package.mjs`.
- **CLI `verify`: PASS** — protected local socket; real packaged renderer; settings persisted across restart; original UI submission accepted into durable outbox and recovered by exact ID; no false `sent` state; forbidden arbitrary-code command rejected; original profile sentinel unchanged; disposable home removed.
- **Packaged GUI `verify-next-classic-gui.mjs`: PASS** — original Chat/Goal/Settings navigation, actual theme click, IPC write/restart, offline input enqueue/restart, no transport startup, original sentinel unchanged. CDP is **only** enabled in this isolated GUI test and bounded by timeouts.
- Tests are local-only; **no real ChatGPT user message was sent**. Native shell/test success is not evidence of ChatGPT connector identity, true model response, web continuation, trusted G1b/G2b or extensionless multi-agent/Goal authority. The already-running user's Next app remains a separate process and its registered original Tunnel IDs are not reused by these tests.

## Still blocked

1. Real ChatGPT MCP identity and delivery: current ChatGPT Core/Desktop connector requests report Tunnel client offline; exact two-chat session/principal evidence is not available. Never invent identity or silently change the registered connector.
2. Optional authorized Codex app-server live inference, quota and recovery: not established by a synthetic model fixture.
3. Production MissionLease, actual provider send/receipt, browser-free continuation, Stop/unknown-effect and cross-platform packaging gates remain independently HOLD.

**Promotion:** keep work local until all live authorization and delivery gates are truly verified; do not push, publish or install a replacement over the old CoS app merely because synthetic QA passed.

## Final local regression receipt

- `npm run verify:ci`: exit 0; **5,036 ordinary tests passed + 2 standalone MCP shutdown tests passed**, 130 skipped, 0 failures, after extending native-window VM lifecycle tests to distinguish hidden synthetic CLI mode from opt-in visible GUI QA.
- Independently tested `start`, `status`, `ui-status`, `theme`, `send`, `restart`, `outbox`, `stop` as separate shell commands; the message remained exactly `queued` with the same UUID after restart and the session's old-profile sentinel remained unchanged.
- Current user Next `classic-validated` process was not restarted or replaced. Read-only live check found the saved tunnel IDs exist but the currently connected ChatGPT Core/Desktop tools still report offline (no Tunnel client seen for 300 seconds); that is not a model-delivery PASS.

## Real Next live diagnostics & receipt audit (2026-10-09)

This extension is **read-only** against the real running app. It never opens the synthetic
control socket, reads credentials, changes settings, or sends a user message:

```sh
node scripts/next-classic-cli.mjs live-doctor
node scripts/next-classic-cli.mjs live-marker
node scripts/next-classic-cli.mjs live-receipt <exact-test-UUID>
```

`live-doctor` uses real app process inventory, real Next config presence (tunnel identifiers
are counted **not displayed**), authenticated localhost `/health` probe (401 expected),
existing model catalogue, Chrome ChatGPT tab count and app-start-relative tunnel log evidence.
It never equates a cached model list or a running process with account authorization.
`live-marker` generates a harmless unique new-chat prompt to be submitted using the actual
Next UI **only after** successful live connection. `live-receipt` reads only its exact
UUID-labeled row from the Next durable outbox and the associated session's event journal,
then reports separate browser receipt / user record / assistant response / ACK / turn-finish
booleans. It does not output conversation messages, IDs of unrelated sessions or secrets.
A provider reply cannot be claimed unless a fresh assistant event actually exists.

**Actual current state:** live Next running (PID checked in local session); three saved
connector IDs, Chrome open with ChatGPT tabs, protected bridge 401. No live tunnel-client,
and Core/Desktop connector read calls were unavailable. Attempted OS UI Connect automation
was explicitly denied by macOS Accessibility (-25211); do not bypass. The sole interactive
blocker is opening Next's already-visible window and clicking its **Connect** control once,
or enabling system-approved Accessibility automation for the controlling application.
No real account test was sent in this round. The real-delivery acceptance stays HOLD.
