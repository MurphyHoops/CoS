# CoS Next 4.0 — Canonical Design Index / 跨对话继续入口

**Revision:** 2026-10-08｜**Working branch:** `next/v4-chatgpt-first-design`｜**Current stage:** DESIGN COMPLETE CANDIDATE; implementation gates NOT YET PASSED.

## 阅读顺序

1. [CoS Next 4.0 总体架构蓝图](./COS_NEXT_V4_IMPLEMENTATION_BLUEPRINT.md)：产品边界、A/B 双模型模式、全部任务内核、安全、性能、Tunnel/插件复用。
2. [接口、数据与安全契约](./INTERFACES_AND_SECURITY_CONTRACTS_V1.md)：领域模型、内部类型、MCP API、身份、租约、SQLite/Journal 草案、Agent/CI 回执、负控。
3. [交付里程碑与验收](./DELIVERY_MILESTONES_AND_ACCEPTANCE_V1.md)：WP00–WP10、S0–S5、依赖 Gate、现有连接复用、CI、灰度、回滚、完成定义。
4. [此前身份问题根因](./IDENTITY_AND_DURABLE_RUNTIME_FIX_DESIGN.md)：v3 MCP exact conversation source 受 Chrome Companion page evidence 限制。
5. [本机无插件研究](./EXTENSIONLESS_FEASIBILITY_2026-10-08.md)：实际 CoS MCP Core / Desktop / Agent 的能力差异。
6. [已执行本地验证](./G1B_PROBE_STATUS_2026-10-08.md) 与 [验证报告](./VALIDATION_2026-10-08.md)：合成 metadata 的 SDK 与本地 HTTP MCP；注意并非真实 ChatGPT G1b。
7. [只读真实元数据探针说明](./REAL_CHATGPT_META_PROBE_RUNBOOK.md)；代码见 `scripts/next/identity-probe.mjs`、`test/next/identity-probe.test.ts`。

## 当前以证据为准的进展

- **已确认**：旧 App 3.1.16 在 `/Applications/Chat On Steroids.app`；工作树分离；原生 Core 工具可用；浏览器 Companion 不参与普通终端工具；现有三 Tunnel 可响应本地健康检查。
- **已确认**：`agents(status)` 返回 `WORKER_IDENTITY_LOST`，`session_wait/project_runtime(status)` 返回身份缺失拒绝；这是安全围栏不是多 Agent 内核整体坏掉。
- **已确认**：SDK / 本地 HTTP 接受 `openai/session`、`openai/subject` 合成字段；下一代诊断器自带权限禁用与匿名指纹；阶段性定向测试 `512 passed / 9 skipped / 0 failed`。
- **未确认**：真实 ChatGPT 在当前连接器上是否稳定发送 session metadata（G1b）；已识别 metadata 是否属于经验证的用户（G2b）。
- **未确认**：不经旧 Companion 能否在 ChatGPT 网页**主动**创建或唤醒下一个模型回合。不能因为本地 CI watcher 可持续运行就认定 Web 模型自动续跑。
- **候选路线**：官方 OSS/符合资格的 Sign in with ChatGPT + Codex app-server 支持独立本地模型自治，须正式 OAuth、账号资格、模型能力、额度和断线恢复验收，不共享网页聊天历史。
- **截图现象**：新建 MCP 出现 ChatGPT 应用配置 rate limit，且截图选择的 Tunnel ID 未匹配本地既有三个客户端；不可通过不停创建新的 Connector 来“修”内核。官方 ChatGPT 插件详情支持工具 Refresh。

## 下一轮 Agent 的标准开工序列

1. 先确认 GitHub branch/main/PR/CI、本地三个工作树的 dirty 状态、运行中的 CoS 实例和当前 App 版本。**绝不覆盖旧 CoS 或丢弃现有未提交更改**。
2. 阅读前三份设计文档和上述“已确认/未确认”，任何新证据与设计冲突先增补 ADR，不擅自降低 Gate。
3. 若用户只要求设计/研究：停留在 docs/test/prototype，不安装/重启生产 CoS、不变更 Tunnel、已连接插件或 Cookie；不自动向外发布新 MCP。
4. 若用户明确开始开发：按 WP00 → WP01 → WP02；严格独立 feature worktree，先 fail/negative tests 再实现，完成 PR exact-head CI 和 security read-only 审计。
5. **G1b 真实连接必须有明确操作授权**：独立测试连接（需要平台允许），或用户知情的原 Core 受控维护窗口；不要并发复用同一 Tunnel ID。
6. 从任意 ChatGPT 新对话恢复时先复核已存在 Canonical Issue/PR，避免 duplicate agent/branch/work。将完成结果和 Gate 实证写回工作总账，而不是仅靠聊天文本。

## 不可变的设计语义

- **A = ChatGPT Web + MCP**：默认交互，适用订阅真实额度，不得自启网页推理。
- **B = 本地获授权的 Codex Agent**：独立线程，可有条件自主推理，不能冒充网页 ChatGPT 当前对话。
- **Mission Kernel = 单一 durable authority**：Project → Mission → Agent/Obligation → Evidence → Completion。
- `openai/session` = 匿名会话关联，**不是登录/写入授权凭证**。
- 默认单独计费 API 花费为零；超额度就暂停，不绕过服务配额。
- 尚未验证的 Gate 不可标 PASS；原版 CoS/数据/密钥/连接必须保持可用，可回滚。

## 官方资料基线

- ChatGPT MCP 会话字段：https://developers.openai.com/plugins/reference
- 官方会话字段更新：https://developers.openai.com/plugins/changelog
- 已连接 Custom MCP 工具刷新：https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OSS 使用 ChatGPT 计划：https://developers.openai.com/siwc/token-sharing-open-source
- Codex app-server：https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- 预览限制：https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
