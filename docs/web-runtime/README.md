# CoS ChatGPT Web Runtime v1 — 资料库目录

**2026-10-10；实施分支** next/v4/web-runtime-v1；**状态**：规格冻结／G0 已建立，开发与验收按分阶段证据推进。

**不变目标**：真实 ChatGPT Plus 网页是推理与交互入口；可以使用独立浏览器，但不使用 Chrome Companion 插件；不使用 Codex、额外付费模型 API、ChatGPT 私有接口或反检测手段；不抢用户主窗口/鼠标/键盘；保留 CoS Classic 的完整聊天、设置、Goal、Plan、Agent、MCP、Session、Durable、恢复工作流。

## 按此顺序阅读

1. [01-REQUIREMENTS.md](01-REQUIREMENTS.md) — 使命契约、安全红线、成功定义。
2. [02-ARCHITECTURE.md](02-ARCHITECTURE.md) — 进程拓扑、源码目录、持久 Profile 目录、所有权。
3. [03-CONTRACTS.md](03-CONTRACTS.md) — 端口接口、Actor 配对、Web 投递状态机、ACK、429。
4. [04-MIGRATION.md](04-MIGRATION.md) — 旧 CoS、Next Classic 与 Web-First 逐项迁移。
5. [05-ACCEPTANCE.md](05-ACCEPTANCE.md) — 真实验收、故障注入、发布与回滚。
6. [06-SOURCE-AUDIT.md](06-SOURCE-AUDIT.md) — CCCC 与轻量项目的源码证据与取舍。
7. [07-STATE.md](07-STATE.md) — 每次开发更新的唯一交接状态。
8. [08-VALIDATION-20261010.md](08-VALIDATION-20261010.md) — 本轮 Git/TypeScript/Vitest/打包 Electron 证据。\n9. [09-UPSTREAM-MAIN-AUDIT-20261010.md](09-UPSTREAM-MAIN-AUDIT-20261010.md) — 当前远端 main 3.1.5 与本地 Next 3.1.16 的真实 Git 对比。

这是 Git 版本化权威规格；ChatGPT 资料库另存面向多对话阅读的整合副本。调整协议必须同时更新测试、规格和开发状态。实验不能代替实机验收。

**Authoritative origin:** remote CoS main at aa50d8d (version 3.1.5). The local Next 3.1.16 tree is a descendant/experimental derivative. See 09-UPSTREAM-MAIN-AUDIT-20261010.md for verified file blob comparison; do NOT use the local version string as authority.
