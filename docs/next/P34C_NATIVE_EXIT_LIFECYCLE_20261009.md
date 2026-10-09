# P3.4-C native Quit and Core recovery audit

Date: 2026-10-09. Branch: next/v4/p3-native-trust.

## Verified, reproducible

1. Real macOS application Quit **via the app's own menu** passed on an active Core Tunnel. An opt-in, nonsecret stage log recorded MAIN_BEFORE_QUIT, NATIVE_SHUTDOWN_ENTER, CORE_TUNNEL_STOPPED, CORE_LISTENER_STOPPED, CORE_CLOSE_FINISHED, NATIVE_SHUTDOWN_DONE, and MAIN_EXIT_APPROVED. The main app PID, its Broker, and the tunnel-client were all absent after the test.
2. Native Disconnect Core Tunnel separately terminated its Broker and child while leaving the main app present.
3. Earlier builds had a shutdown/recovery race: an orphan tunnel or background main process could outlive the window; recovery could spawn a replacement during retirement. Old owners were reconciled only through exact executable identity and PID/parent proof, with no change to Keychain or durable project data.
4. The corrected Broker intercepts before-quit and waits for its owned tunnel stop receipt. The native host's single-flight shutdown synchronously freezes recovery, then closes Core and the MCP listener before app exit. A recovery policy regression denies retries when closing/quitting, even across async awaits.
5. The packaged macOS ARM64 Electron smoke passed native Goal, project, local MCP, two-Worker checks, AI Worker allocation/removal and read-only acceptance. The full CI run passed 5,142 regular tests, 131 configured skips, zero failures, and 2 independent MCP-shutdown tests.

## Explicitly not verified

- A raw AppleScript tell-application-to-quit event was inconsistent with the actual native menu Quit. Keep the two distinct.
- macOS red-X / AXClose could not be driven reliably via the local accessibility adapter, so that **specific input gesture remains a HOLD** rather than an accepted real-device case.
- ChatGPT caller identity_verified and remote complete MCP tool publication remain HOLD; 14 local tools do not prove remote availability of task_plan_status or task_plan_update.
- Real parallel AI model sessions, authorized multiagent worktree isolation, model quota recovery and unattended Goal Loop remain HOLD, not implicit in the local AI Worker roster.
- No Keychain plaintext was copied, displayed or persisted as part of this audit.

## Operator instructions

For now, the verified way to exit a connected app is the app's own Quit menu. After restarting, inspect the read-only one-click local acceptance menu. Do not allow a second tunnel while ownership is uncertain. This is closure of the **native menu Quit lifecycle**, not all possible quit gestures or autonomous AI.
