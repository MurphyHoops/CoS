# 07 — 当前开发状态与跨对话交接

**日期** 2026-10-10；**开发分支** next/v4/web-runtime-v1；**隔离工作树** ~/Documents/ChatGPT/CoS-WebRuntime-V1；**基线** 4e204ed。

## GATE 状态（按实际证据）

- **G0 PASS**：原 CoS/P3.6 只读审计、干净独立 worktree、8份实施规格、ChatGPT 资料库副本均存在。原始两个 dirty 工作树及安装 App 完全保留。
- **G1 PASS（初始 transport core）**：新增 contracts.ts、delivery-state.ts、delivery-journal.ts、profile-owner.ts、page-registry.ts、supervisor.ts；浏览器所有权单写者、持久 WAL、单 Actor 在途、代次路由、SEND_ATTEMPTED/AMBIGUOUS 防重发均有测试。尚无网络/真实账号依赖。
- **G2 PARTIAL（Supervisor 生命周期 + CCCC 原始脚本真实调用）**：复用以前验证过的 hidden Electron/CDP；新增 ElectronWebRuntimeSupervisor，先独占 ProfileLease、再使用 Electron session.fromPath(profile)，统一负责隐藏窗口、关闭与再次启动。独立 ARM64 包实际通过截图、点击、输入、Enter、Electron 前台窗口身份不变及同一 Profile 的 Stop/Start。仍未完成独立进程跨 App 重启、真正 macOS 前台应用焦点证明、Profile crash recovery。
- **G3 NOT STARTED**：隔离开发分支尚未对真实 ChatGPT Plus 登录或发消息。
- **G4 NOT STARTED**：一个共享 Connector、两个 ChatGPT 对话真实 A-B-A 配对未开始。
- **G5 NOT STARTED**：Classic 完整 UI/Goal/Agent 尚未接 WebRuntimeAdapter。
- **G6 NOT STARTED**：两个真正模型 Worker 与限流/24h 故障闭环未完成。
- **G7 NOT STARTED**：没有发布、安装替换或推 GitHub。

## 当前已验证的命令和事实

- npm run typecheck -> PASS
- npx vitest run test/web-runtime -> **15 tests PASS**
- npm run verify:ci（含新增 Supervisor 的最终文件集合）-> 251 files passed, 14 skipped, 5174 tests passed, 131 skipped；独立 MCP 关闭测试 2/2 PASS；退出码 0；记录 /tmp/cos-web-runtime-v1-g2-supervisor-full-ci.log。
- 原生 bundle: node scripts/build-next-webfirst-runtime.mjs -> PASS。
- Electron ARM64 package gate: WEB_FIRST_P1_PACKAGE_GATE=PASS、Chrome/Codex 依赖 ABSENT。
- 打包实际 Electron 离线测试: WEB_RUNTIME_G2_BACKGROUND_CDPSMOKE_PASS；WEB_FIRST_OFFLINE_NATIVE_PAGE_CONTROL_PASS；WEB_FIRST_OFFLINE_APPROVED_WEB_GOAL_LOOP_PASS。
- 样本日志：/tmp/cos-web-runtime-v1-full-ci.log、/tmp/cos-web-runtime-v1-g2-native.log；该 /tmp 日志不是用户长期存储，应以 Git 版验证报告为准。

## Git / 用户数据保护

源 P3.6 工作树 ~/Documents/ChatGPT/CoS-Next-P3-Auth 有未提交 P3.7 实验代码；原旧 CoS ~/Documents/CoS 有未提交资源修改，禁止覆盖/清理。此分支复制已验证的后台 CDP 实现以便隔离验证，但没有修改源工作树。

正在运行的 P3.6 App 与其 2 个项目、历史任务、凭据和 Profile 未被本轮替换。复用静态 tunnel-client 二进制到**新分支忽略的本地打包资源路径**供隔离测试，原文件 SHA-256 与复制件一致，未移动凭据。测试窗口在一次性目录运行，不作生产替代。

## 下次续接从这里做

1. 本地 git status/log 和运行 PID/交付收据对齐；确认当前 Git 提交和所有已有测试结果。
2. 将 Electron 浏览器驱动纳入独立 Browser Supervisor 生命周期，并把 ProfileLease 用于真实 Runtime 而非仅单独单测。
3. 完成三次退出/启动、系统前台焦点、崩溃和离线网页实机实验；不自动处理真实登录挑战。
4. 经用户明确批准后测试真实 ChatGPT Plus 网页，完成 G3。
5. 再引入共享 MCP Conversation Pairing 和 Classic Goal/Agent Adapter，不建立第二套任务权威。

**硬红线**：不安装 Chrome 插件、不用 Codex/API 模型推理、不借助 stealth/反检测、不冒用或跨 Worker 权限、不重试未知投递、不删除原用户资料、不以模拟测试声称网页或多 Worker 已完成。


## 2026-10-10 direct CCCC source reuse

- Vendor: src/main/web-runtime/vendor/cccc-webpage-probes.ts includes 3
  verbatim embedded JavaScript callbacks from CCCC commit 561d94f,
  provenance hashes and packaged Apache-2.0 license.
- src/main/web-runtime/chatgpt-website-delivery.ts directly executes the
  upstream inspect/send-control JS on owned Chromium, adds 2026 user-bubble
  proof + Actor Target fence + fsynced WAL + no replay.
- 19/19 focused Web Runtime tests passed; packaged synthetic Chromium:
  WEB_RUNTIME_CCCC_UPSTREAM_REAL_CHROMIUM_PASS,
  WEB_RUNTIME_CCCC_NO_REPLAY_PASS, WEB_RUNTIME_CCCC_AMBIGUOUS_HOLD_PASS.
- G3 real ChatGPT Plus webpage, G4 trusted MCP pairing, G5 Classic UI/Goal
  migration, multiworker and crash/429 hardening still NOT PROVEN.


## Final verified direct source reuse (2026-10-10)

- Exactly CCCC SHA 561d94f three verbatim browser JS routines (SHA in vendor/PROVENANCE.md).
- npm run typecheck PASS; Web Runtime focused 19/19 PASS.
- Full npm run verify:ci -> 252 test files PASS, 14 skipped; 5178 tests PASS,
  131 skipped; separate MCP shutdown 2/2 PASS; exit 0.
  Log: /tmp/cos-web-runtime-cccc-direct-ci.log.
- Exact packaged ARM64 Electron: WEB_FIRST_P1_PACKAGE_GATE=PASS,
  no legacy Chrome/Codex bundle dependency,
  WEB_RUNTIME_CCCC_UPSTREAM_REAL_CHROMIUM_PASS,
  WEB_RUNTIME_CCCC_NO_REPLAY_PASS,
  WEB_RUNTIME_CCCC_AMBIGUOUS_HOLD_PASS.
  Log: /tmp/cos-cccc-direct-final-smoke.log.
- Included Apache-2.0 license resource; app.asar SHA-256
  fdcf40cda16477f7b29ed9368b6a7ea67259b82afcab43f7f442580a51086a1a.
- No real ChatGPT account operations, no Classic Goal integration or installer replacement.

## Authoritative version correction

Remote GitHub CoS main = aa50d8d, official source version 3.1.5. Next local descendant = 4e204ed version field 3.1.16, not remote main; ~/Documents/CoS checkout = 3.1.2 (dirty). Original Goal/Agent/BrowserControl/MCP/extension browserPage byte-identical between main and 4e204ed. See 09-UPSTREAM-MAIN-AUDIT-20261010.md. New native broker adapter is still G2 offline only, not active in production or a full Goal flow.

## 2026-10-10 upstream-main correction and native broker G2 milestone

Remote main SHA aa50d8d, package version 3.1.5, is the upstream source
authority. Local Next 3.1.16 is a descendant, not a published/main version.
Verified exact Git blob identity for goal.ts, agents.ts,
browser-control.ts, mcp/tools-browser.ts, extension/browser-control-page.js
across remote main and local Next commit 4e204ed.

Added optional native execution port directly to the original CoS
BrowserControlBroker, and vendored the byte-identical original browserPage
DOM implementation. An isolated packaged Electron offline fixture proves
Classic browser_tabs -> snapshot -> browser_action(click) ->
browser_evaluate result with permission revocation/cross-worker rejection.
This is G2, NOT production Classic App/real ChatGPT acceptance. The current
installed P3.6 preview has not been replaced and no user profile was modified.

Exact latest verification:
- npm run verify:ci: 253 files/5182 tests passed, 14 files/131 skipped,
  independent MCP shutdown 2/2 passed, exit 0.
- packaged Electron ARM64: WEB_FIRST_P1_PACKAGE_GATE=PASS,
  WEB_FIRST_LEGACY_CHROME_AND_CODEX_DEPENDENCY=ABSENT.
- WEB_RUNTIME_G2_BACKGROUND_CDPSMOKE_PASS,
  WEB_RUNTIME_G2_OWNED_PROFILE_RESTART_PASS,
  WEB_RUNTIME_CCCC_UPSTREAM_REAL_CHROMIUM_PASS,
  WEB_RUNTIME_CCCC_NO_REPLAY_PASS,
  WEB_RUNTIME_CCCC_AMBIGUOUS_HOLD_PASS,
  WEB_RUNTIME_CLASSIC316_NATIVE_BROKER_PASS,
  WEB_FIRST_OFFLINE_APPROVED_WEB_GOAL_LOOP_PASS;
  offline binary exit 0.
- packaged app.asar SHA256: 8bbb998b15dc2307f39402302b2db2a7c2079dbf7e86b4049e56de0eed20abda.
- logs /tmp/cos-web-runtime-main-audit-full-ci.log and
  /tmp/cos-main-audit-packaged-smoke.log.

Next incomplete steps remain separate: enable native executor in guarded
Classic startup; integrate real multi-Page actor ownership and shared MCP
pairing; real website turn/ACK; real Goal/Agent and failure recovery.
Do not claim G3+ PASS.
