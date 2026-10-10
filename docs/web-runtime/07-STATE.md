# 07 — 当前开发状态与跨对话交接

**日期** 2026-10-10；**开发分支** next/v4/web-runtime-v1；**隔离工作树** ~/Documents/ChatGPT/CoS-WebRuntime-V1；**基线** 4e204ed。

## GATE 状态（按实际证据）

- **G0 PASS**：原 CoS/P3.6 只读审计、干净独立 worktree、8份实施规格、ChatGPT 资料库副本均存在。原始两个 dirty 工作树及安装 App 完全保留。
- **G1 PASS（初始 transport core）**：新增 contracts.ts、delivery-state.ts、delivery-journal.ts、profile-owner.ts、page-registry.ts、supervisor.ts；浏览器所有权单写者、持久 WAL、单 Actor 在途、代次路由、SEND_ATTEMPTED/AMBIGUOUS 防重发均有测试。尚无网络/真实账号依赖。
- **G2 PARTIAL（Supervisor 已实现基础生命周期）**：复用以前验证过的 hidden Electron/CDP；新增 ElectronWebRuntimeSupervisor，先独占 ProfileLease、再使用 Electron session.fromPath(profile)，统一负责隐藏窗口、关闭与再次启动。独立 ARM64 包实际通过截图、点击、输入、Enter、Electron 前台窗口身份不变及同一 Profile 的 Stop/Start。仍未完成独立进程跨 App 重启、真正 macOS 前台应用焦点证明、Profile crash recovery。
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
