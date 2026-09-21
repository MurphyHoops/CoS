# CoS 3.x setup and operation

This is the current setup guide for the standalone CoS 3.x runtime.

For architecture, read [architecture.md](architecture.md).

## 1. Install matching components

Install the CoS desktop app and use the companion extension shipped with the same version.

After updating either component:
- restart/reopen CoS;
- reload the unpacked companion extension;
- refresh/reconnect the CoS custom app in ChatGPT if the MCP schema changed.

App/extension protocol mismatch is a configuration error, not a recovery condition.

## 2. Approve workspace capabilities

In **Settings → Workspace**, choose the folders CoS may access and review enabled capabilities.

Important distinctions:
- approved roots grant file-tool scope;
- a local project associates one folder with a mission;
- command execution starts in the selected workspace but runs with normal OS-user privileges;
- browser/desktop capabilities are separate permissions;
- read-only mode removes effective mutation abilities.

Durability never expands permissions.

## 3. Connect Core MCP

In **Settings → Setup**, configure the Core endpoint and add/refresh it in ChatGPT Developer mode.

The Core surface is permission-sensitive. A fresh or refreshed conversation may expose a different tool list when capabilities changed.

When a new tool such as `session_wait` is added, refresh the custom app and start/rebind an executor that has the current tool schema.

## 4. Pair the companion extension

Load the extension directory as an unpacked Chromium extension and keep the matching version loaded.

The extension provides:
- provider conversation identity;
- native turn evidence;
- browser delivery/acceptance evidence;
- background browser wake/repair support.

It does not own mission identity. CoS local durable state does.

## 5. Start work

A task should be attached to the intended local project before mutation.

CoS records the mission/session and binds the current provider conversation as an executor. The conversation is replaceable; the mission is not.

## 6. Long-running work

For active reasoning/tool work, use the provider turn normally.

For slow external conditions, do **not** hold the provider turn open with repeated polling. Use the durable wait path:

```text
executor performs active work
→ external condition begins
→ session_wait arms local supervision
→ source turn yields
→ CoS watches locally
→ condition resolves
→ one durable continuation is queued
→ authorized executor resumes
```

Built-in wait kinds:
- `github_run`
- `process`
- `timer`

See [long-run-runtime.md](long-run-runtime.md).

## 7. Compact & Resume

Use Compact & Resume when context pressure requires a fresh provider conversation.

The replacement keeps:
- the same local mission/session;
- project/workspace;
- pending obligations;
- worker family;
- queued user input;
- process custody;
- continuation/recovery provenance.

The source conversation is fenced after the replacement transaction commits.

## 8. Self-Healing

Self-Healing may repair or replace an unusable executor.

It does not blindly replay work. After replacement, the new executor must reconcile actual local state before performing unresolved mutations.

Explicit user Stop/cancellation remains terminal for that obligation.

## 9. Goal and Loop

Goal and Loop are mission drivers:
- Goal may stop when the finish line is satisfied.
- Loop continues in-scope work until disabled or the mission terminates.

They do not create a second mission and must not manufacture work without a durable obligation.

## 10. Workers

Workers are subordinate executors owned by a Prime mission.

They can sleep, revive or be replaced. Their reports are persisted before delivery so the Prime can recover them after transport or tab failure.

## 11. Updates

Canonical releases are published from:

https://github.com/MurphyHoops/CoS/releases

Do not install builds from historical or external branches as if they were CoS 3.x releases.

## 12. Troubleshooting order

When a long task appears stuck:

1. check CoS is running;
2. check Core/extension connectivity;
3. inspect the durable session/mission state;
4. inspect active wait/recovery/worker state;
5. inspect actual process/Git/filesystem effects;
6. only then decide whether a mutation still needs to run.

Do not infer "not executed" from a missing model/tool response.

## 13. Platform notes

Windows, macOS and Linux are supported targets.

The current macOS target is macOS 13 Ventura or newer.

On Linux, when unprivileged user namespaces are disabled, the AppImage may use the documented `--no-sandbox` fallback. Prefer the DEB if you do not want that fallback.

## 14. Security

Read [../SECURITY.md](../SECURITY.md) before enabling command, browser or desktop control.
