# 06 — GitHub 项目源码依据与取舍

## CCCC

仓库 https://github.com/ChesterRa/cccc ，检查基线 561d94f（main，2026-10-09），Apache-2.0。

- crates/cccc-web/src/browser_surface/owner.rs：chromiumoxide BrowserOwner；独立 Profile，headless/system 两种模式，PID 与 Handler 生命周期。
- .../profile_owner.rs：ProfileLease、文件独占锁、PID+进程创建身份、SingletonLock 防误杀。
- .../prompt_submission.rs：草稿、Page Target、发送控件、完整 marker 和投递回执的严格判定；Verified/Deferred/Ambiguous。
- crates/cccc-web/src/routes/web_model_delivery.rs：每 Actor 受保护 Worker、发送中断与有限重试、模糊状态不重发。
- .../web_model_delivery_completion.rs：浏览器提交与持久完成是不同事件。
- .../web_model_connector_session.rs、.../web_model_connector_store.rs：一个已认证 Connector，配对 Actor 并根据 host session metadata 与 generation 路由。
- docs/release/v0.4.41_release_notes.md：多 ChatGPT Actor 共用登录/Connector，独立对话与 Page Target，准确回执与手工 Check and resume。
- docs/guide/web-model-runtime.md：模型/账号需支持远程 MCP；浏览器投递与 MCP pull 分开；本地 localhost 不直接是可用的云端 MCP URL。

借鉴 BrowserOwner/状态回执/Actor 配对/恢复；不整合 Rust CCCC Daemon、不引入其 Goal 状态权威或 Codex/Grok/Voice 分支。

## chatgpt-browser-agent

仓库 https://github.com/abdallhMoukdad/chatgpt-browser-agent ，检查基线 5f193cc（master，2026-04-27），MIT。

- chatgpt.js：Puppeteer-core + Chrome 单 Daemon、固定 ~/.chatgpt-poc-profile、HTTP localhost 端口及会话 URL 存档，简单收发和附件。
- mcp-server.js：chatgpt_ask/status/stop 3 工具，60s prompt 去重。
- agent.js：模型回答解析 RUN/FILE 并本地执行，最大20轮。

可借鉴小型持久 Daemon/健康检查和 CLI smoke。**不能复制** headless:false、page.bringToFront、Stealth/反检测、单 Page 串行架构、旧版 DOM 选择器或未经授权的 RUN/FILE shell 执行。

两个项目都不是官方无限 ChatGPT 网页 API；账号、页面变化、反自动化限制及正常使用限额属于实际验收风险。复制代码须满足许可证；CoS 优先自主实现架构思想。
