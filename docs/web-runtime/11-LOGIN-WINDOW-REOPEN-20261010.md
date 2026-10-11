# CoS Next Standard Chrome: macOS close-window recovery (2026-10-10)

## Observed problem

The user closed the dedicated Chrome window but the dedicated Chrome process stayed
alive (normal macOS app lifecycle). The old CoS tray item disabled "open" during
`USER_LOGIN_STANDARD_CHROME`, so a zero-window process prevented reopening.
A naive second `Chrome --new-window` invocation against the live profile
returned without opening a visible window (read-only System Events count was zero).

Verified original PIDs:
- CoS Next Classic packaged test app: 33660 (own test bundle)
- dedicated visible Chrome child: 33716, PPID 33660
- `SingletonLock` pointed to `MurphydeMacBook-Pro.local-33716`
- `.cos-web-runtime-owner.lock` stamp identified ownerPid=33660
- macOS `System Events` for dedicated PID confirmed 0 windows

Normal AppleEvent app quit removed the original CoS and Chrome PIDs but left
a stale CoS owner lock and Chrome singleton IPC symlinks. Both owners were
verified exited and no process was using the dedicated profile. All four
links/locks were MOVED (not deleted) to:
`~/Library/Application Support/chat-on-steroids-next/browser-runtime/reviewed-orphan-locks-20261010-33660-33716`.

No browser authentication databases, cookies, account tokens, old project
files or chat records were read or modified.

## Code changes (uncommitted)

- `classic-native-runtime.ts`: an explicit user reopening request terminates
  ONLY the known dedicated Chrome child, waits for child exit, safely archives
  exact owned orphan singleton IPC links, releases its ProfileLease, then
  launches a new standard Chrome login window using the same Profile.
  App shutdown now awaits login-child finalization and lease release.
- `chrome-login-locks.ts`: strict standalone owner validation (process exited,
  exact hostname-PID Chrome SingletonLock, profile ownership/mode, symlink type)
  and reversible evidence-preserving renames, never force-closes foreign Chrome.
- `src/main/index.ts`: "Open / reopen ChatGPT login in Chrome" remains enabled
  during login; "Finish login / return to background" explicitly ends owned
  Chrome and resumes the CDP worker transport.
- `test/web-runtime/chrome-login-locks.test.ts`: ensures IPC links are archived
  and Profile account database bytes remain unchanged; rejects foreign/live owner.

## Verification

- `tsc --noEmit -p tsconfig.json` PASS
- `vitest run test/web-runtime test/runtime-enable-and-extension.test.ts`:
  11 test files, 30 tests PASS.
- `node scripts/build-next-classic-runtime.mjs`: PASS.
- Electron builder ARM64 isolated application: PASS.
- `node scripts/next-classic-cli.mjs verify <rebuilt app>`: EXIT 0;
  `NEXT_CLASSIC_NATIVE_NO_EXTENSION_BROWSER_PASS`;
  `NEXT_CLASSIC_NATIVE_PROFILE_AND_WORKERS_RESTART_PASS`.
- New staged App:
  `release-next/chrome-login-reopen-fixed-20261010/mac-arm64/Chat On Steroids Next.app`.
- New real-profile operator-initiated `probe` (NO SEND):
  `NEXT_REAL_ACCOUNT_SMOKE_STATUS=AUTH_REQUIRED`,
  `REASON=no_usable_authenticated_composer`.
- New staged App PID 58353 started owned Chrome PID 58411;
  read-only macOS System Events window count for PID 58411 = **1**.
  This confirms standard Chrome login window was actually created.
- Real ChatGPT Plus send/assistant reply still NOT TESTED/NOT PASSED.
- No GitHub push, no production app installation/replacement.

## User action / next exact gate

Complete normal ChatGPT sign-in in dedicated visible Chrome, then use CoS
menu item `Finish login / return to background`, NOT simply close the
last Chrome window. Next use probe-only to verify authenticated composer and
persisted profile, then permit precisely one new isolated smoke conversation
with journal proof. MCP/Goal/real multi-worker remains HOLD.

Keep both prior dirty worktrees and all existing Profile data unchanged.

## Final integration/CI checkpoint (18:44 local)

After the final source modifications, `npm run verify:ci` exited 0:
**256 passing files, 14 skipped, 5186 passing tests, 131 skipped;**
separate MCP shutdown tests **2/2 passed**.
Log: `/tmp/cos-next-login-window-full-ci-20261010.log`.

Final isolated stage app is `release-next/chrome-login-reopen-fixed-20261010/mac-arm64/Chat On Steroids Next.app`.
SHA-256 of packaged `app.asar`:
`29879b51f9253c5731288429a6dfe9369900ce2e176dd25355483123d5208ef8`.

After safely archiving stale owned lock evidence, actual staged App PID 58353
opened standard Chrome child PID 58411; macOS per-PID window count
**1** verified again at approximately 18:44 local. Dedicated ProfileLease
is held by this running staged App. User login is still required: no real
Plus model turn was sent. Git branch and HEAD remain unchanged and dirty;
no commit, push or production install was performed.
