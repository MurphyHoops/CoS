# CoS Next P3.4-D — Real Core Fault Injection and Window Closure

Date: 2026-10-10, authorized macOS host. Branch next/v4/p3-native-trust.

## Real acceptance evidence

1. Existing packaged P3.4-C App was live with 2 registered project directories and 1 waiting Goal at revision 3. Child ownership was verified by exact executable path and PID/PPID.
2. Real Core runtime_health declared 14 local tools, but current conversation only exposes 12 Core tools. identity_verified and mission_authorized were false; publication remains NOT_VERIFIED. These remain HOLD.
3. Core project_read succeeded for the existing read/write fixture, and a path traversal attempt to ../secrets.bin was correctly rejected as RELATIVE_PATH_INVALID. The waiting Goal remained revision 3 before and after fault injection.
4. Real tunnel-client fault injection: SIGTERM sent only after checking exact executable path, parent Broker, and current PID. Broker recreated a new tunnel-client in approximately 2 seconds. Live Core runtime_health and task_status both worked afterwards; Goal phase and revision unchanged.
5. Real Broker fault injection: SIGTERM sent only to the authenticated app's exact Broker PID (never a random process). New Broker and tunnel-client appeared and stabilized. Live Core tool calls succeeded again with no Goal auto-resume.
6. Native keyboard close test: Command-W without an explicit menu accelerator did not reliably invoke native window retirement. macOS accessibility occasionally reported zero visible windows while the Core remained alive. This was NOT accepted as proof of a red-X closing mechanism.
7. Product repair: added ChatGPT 网页 -> 安全关闭主窗口（停止 Core） with CmdOrCtrl+W. It calls the existing fenced native owner.close and proved Core shutdown path. A newly built, independently packaged ARM64 Electron candidate passed package validation and offline markers WEB_FIRST_OFFLINE_SAFE_CLOSE_MENU_PASS, WORKER, GOAL, MCP.
8. **Real UI verification after repair**: launched the new candidate, approved the genuine Core connection through the native authorization sheet, then clicked the exact new native menu item. The parent App PID and both owned Broker and tunnel-client PIDs were verified absent afterwards. No force kill was used.
9. Full npm run verify:ci on changed source exited 0: 5,142 regular tests passed, 131 skipped, zero failures, plus 2 MCP shutdown tests passed.

## Remaining precise boundaries

- Menu click safety is verified; a physical macOS red-X click and arbitrary AppleScript Quit remain unverified given accessibility instability. The visible native Cmd+W menu binding is installed.
- This does not prove any actual model turn acknowledgement, provider 429, rate limit avoidance, AI Worker inference or multiagent write isolation.
- Real platform caller authorization remains UNVERIFIED and the extra locally declared plan MCP tools are not confirmed published to the conversation.
- No Keychain plaintext was read, copied or logged. No original user project file, task or trusted grant was mutated during this test.
- Work remains on real, attested AI worker identity/lease/receipts and authorized worktree isolation; do not claim full production autonomy.

## Operator guidance

Use ChatGPT 网页 -> 安全关闭主窗口（停止 Core） or Cmd+W to request native window shutdown with Core retirement. Keep old core owner clean before relaunch. This specific entrypoint was verified on the real macOS host.
