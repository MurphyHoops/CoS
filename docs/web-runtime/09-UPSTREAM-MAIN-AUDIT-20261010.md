# 09 — Upstream main source-of-truth audit (2026-10-10)

## Correction of previous version assumption

The authoritative public source of the original CoS is GitHub
https://github.com/MurphyHoops/CoS on branch main, exact commit
aa50d8d57d76dc30d4fd9a7fce18c3ffba249763, with package.json
version **3.1.5** and APP_VERSION **3.1.5**.

The locally checked out ~/Documents/CoS is **3.1.2** at cba4561;
it is behind remote main and has dirty resource changes. Never use it
as the upgrade source or clean its worktree.

The separate Next worktree ~/Documents/ChatGPT/CoS-Next-P3-Auth has
package.json APP_VERSION 3.1.16, Git commit 4e204ed. It is a LOCAL
descendant of current origin/main (git merge-base 4e204ed origin/main
is exactly aa50d8d). It is **not** evidence that remote main/release
is version 3.1.16; do not claim that.

## Authoritative CODE evidence

Git blob SHA equality between origin/main and Next 4e204ed:

| Original module | Git blob prefix | Result |
| --- | --- | --- |
| src/main/goal.ts | 2b60539b7fec | Identical |
| src/main/agents.ts | d9f5929c0001 | Identical |
| src/main/browser-control.ts | 07616d100a8d | Identical |
| src/main/mcp/tools-browser.ts | c6503fd3a9f6 | Identical |
| extension/browser-control-page.js | 7b219e087dfb | Identical |

Therefore the existing agent/goal/browser tool AND DOM engine used for
the no-extension adapter are directly attributable to UPSTREAM MAIN
3.1.5, although the local Next package version was changed later.
This original core may be preserved without downgrading functionality.

Important local Next changes compared with main include bridge.ts,
index.ts, session/continuation.ts, session/input.ts, session/start-input.ts,
connection.ts, IPC/MCP, and new Next modules. They require individual
compatibility and reliability audit; they are not automatically a newer
official stable release or automatically safe to delete. The main Goal
backend supports optional OpenRouter/custom API endpoints, but
goalBackendFor() defaults to the ChatGPT helper for both Goal and Loop.
Preserve the actual website-based ChatGPT route and never silently
switch to OpenRouter/API inference. Classic feature parity and
website-only inference compliance require separate gates.

## Migration authority rule

1. User-facing Classic workflow/module semantics come from remote main
   aa50d8d (source tree). Keep subsequent proven local fixes with audit.
2. Transport must use actual ChatGPT website in owned Chromium; no old
   Chrome extension is required, and no Codex/API fallback for inference.
3. Current Next code is a development derivative, not an official
   3.1.16 main release. For every migrated module use blob identity
   and source diff rather than the package version label.
4. Documented G1/G2 smoke must not be promoted to G3/G4/G5
   until real ChatGPT+MCP+Classic runtime tests prove it.

## Source inspection commands

git show origin/main:package.json
git show origin/main:src/main/version.ts
git rev-parse origin/main
git merge-base origin/main 4e204ed
git diff --name-status origin/main 4e204ed -- src/main src/renderer extension
git rev-parse origin/main:src/main/goal.ts
git rev-parse 4e204ed:src/main/goal.ts
