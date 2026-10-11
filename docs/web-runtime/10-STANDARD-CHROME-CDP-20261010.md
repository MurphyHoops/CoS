# CoS Next — Standard Chrome CDP Pipe + Profile Handoff (2026-10-10)

## Scope and provenance

Canonical worktree: `~/Documents/ChatGPT/CoS-WebRuntime-V1`
Branch: `next/v4/web-runtime-v1`
Initial HEAD (before today's uncommitted integration): `4fc7e531103903c31b70e89b222cb05e1286cfaf`.

This is one continuation of CoS Next Web Runtime V1, **not a new Goal/Agent scheduler**.
No remote push, release, installation replacement, or migration of old CoS user data has happened.

## Implemented (uncommitted)

- `src/main/web-runtime/chrome-pipe.ts`: direct standard Google Chrome CDP pipe over private child FDs 3/4; per-target flat SessionID; bounded evaluation; page navigation; input dispatch; process shutdown. No network CDP port or Chrome extension.
- `src/main/web-runtime/chrome-supervisor.ts`: dedicated `standard-chrome-profile`, `ProfileLease`, OS Chrome SingletonLock check, headless background targets, page ownership, screenshot and original `BackgroundWebComputer` interface.
- `src/main/web-runtime/classic-native-runtime.ts`: real mode selects Chrome; fixtures keep Electron. Visible standard Chrome login is mutually exclusive with background browser on the SAME Profile. BrowserControlBroker remains the only original Classic browser authority.
- `src/main/web-runtime/classic-multi-page-executor.ts`: original BrowserControlBroker-compatible numeric tab handling; async supervisor page support.
- `src/main/index.ts`: tray opens standard Chrome, shows status, allows explicit cancel; no Electron OAuth login.
- `browser-driver-electron.ts` and `chatgpt-website-delivery.ts`: optional transportTargetId disambiguates Chrome and Electron bindings.
- Regression tests: `test/web-runtime/chrome-pipe.test.ts`, `chrome-supervisor.test.ts`.

The original delivery journal must record `SEND_ATTEMPTED` before a browser send. `AMBIGUOUS` is non-replayable. This unchanged safety contract is not proof of complete real model dispatch.

## Ground-truth command receipts

Standard Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
`Chrome/155.0.8059.39`.

Direct isolated Chrome Pipe probe:
```
PIPE_VERSION=Chrome/155.0.8059.39
TARGET_CREATED=true
CDP_PIPE_TEMP_PROFILE_PASS
```

Local TypeScript and `vitest run test/web-runtime test/runtime-enable-and-extension.test.ts`: **28/28 passed**, 10 test files, exit 0.
Native Supervisor initially failed due premature Chrome SIGTERM causing a macOS `SingletonLock` race; after giving `Browser.close` time for natural exit, the isolated two-target / same-profile-restart test passes.

`node scripts/build-next-classic-runtime.mjs`: **exit 0**, 5,513,408-byte bundled runtime.
`electron-builder --config electron-builder.next.yml --mac --arm64 --dir --config.directories.output=release-next/chrome-pipe-20261010`: **exit 0**.
Test-only package: `release-next/chrome-pipe-20261010/mac-arm64/Chat On Steroids Next.app`.

`node scripts/next-classic-cli.mjs verify <test-only-app>`: **exit 0**:
```
NEXT_CLASSIC_NATIVE_NO_EXTENSION_BROWSER_PASS
NEXT_CLASSIC_NATIVE_PROFILE_AND_WORKERS_RESTART_PASS
```
Isolated App confirmed original chat/Goal/settings renderer, two independent synthetic Worker pages, no false delivery, profile restart and no change to the disposable old profile. These are **synthetic**, not real Plus test results.

`npm run verify:ci`: **exit 0**;
255 test files passed, 14 skipped, 5184 tests passed, 131 skipped;
separate MCP shutdown 2/2 passed.
Log: `/tmp/cos-next-chrome-full-ci-20261010.log`.

## Live website probe, state of 2026-10-10 18:15 local

The staged packaged Classic App is running with `COS_NEXT_CLASSIC_WORKFLOW=1` and `COS_NEXT_REAL_ACCOUNT_SMOKE=probe`. No model prompt was sent.
```
NEXT_REAL_ACCOUNT_SMOKE_STATUS=AUTH_REQUIRED
REASON=no_usable_authenticated_composer
```
The App transitioned from background CDP Chrome to visible STANDARD Chrome dedicated to the same `standard-chrome-profile`. Observed process PID 33716, VISIBLE, no CDP pipe. This is NOT the user's everyday Chrome process, and no credentials or Cookie bytes have been inspected, copied or logged.

**Operator action:** in the separate standard Chrome window, sign in normally to `https://chatgpt.com/` (Google/system authentication as required), then close ONLY that dedicated Chrome window. CoS reclaims this Profile after Chrome exits. Do not re-send the smoke test while visibility/acceptance is ambiguous.

## Strict remaining gates (HOLD)

1. Post-login authenticated composer read and persistent login after restart in exact same Chrome Profile.
2. Exactly-once real isolated test chat: user echo, settled assistant marker, journal receipts.
3. Session nonce + MCP Connector identity, model-associated native MCP tool ACK; not equivalent to MCP tunnel handshake.
4. Real A→B→A Worker page and Generation isolation.
5. Original Classic Goal→Plan→Agent→web inference→MCP→next turn→Finish with Stop/resume/rate limit tests.
6. Real macOS foreground focus invariance, upgrade/rollback/no overwrite of old CoS.
7. Then local commit/review, GitHub push/PR/CI and explicit user-approved installation. **No production deployment or completed-Goal claim.**

Caution: dedicated login Chrome and managed headless Chrome may not hold the profile simultaneously. If `SingletonLock` indicates another live owner, fail closed; do not force remove the lock or clone credentials. Keep existing dirty worktree and earlier experiment worktrees untouched.
