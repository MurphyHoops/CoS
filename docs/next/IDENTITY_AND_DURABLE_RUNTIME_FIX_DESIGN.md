# CoS Next: 任务身份、多 Agent 与自动续跑的无扩展修复路线

日期：2026-10-08。状态：**只读源码审计与方案设计，不实施业务代码或切换当前运行版本。**

## 1. 结论

根因不是 CoS 的任务执行/持久化内核整体故障，而是 CoS v3.1.16 将 ChatGPT 对话身份严格依赖旧式“HTTP 请求 ID ↔ 浏览器扩展中的页面证据”匹配；当前网页/Connector 缺少对应证据时，普通允许 Unattributed 的自包含工具能够执行，而 `agents status`、`session_wait status`、`project_runtime status` 因缺失 `conversationId`/`sessionId` 被拒绝。该 fail-closed 行为是正确的，不能以“用活动标签页、时间接近或用户说的任务 ID”代替它。

**可以工程性地修复 ChatGPT MCP 操作中的身份发现和 CoS 本地任务授权；但不能声称仅凭 MCP 就可在无人操作时自动启动 ChatGPT 网页的新推理回合，也不能声称无需扩展就能在网页创建/管理原有独立聊天 worker。**

## 2. 源码证据

1. `src/main/mcp/kernel.ts`：`type McpCallContext = Pick<ServerContext,'sessionId'>`（仅保留 MCP 传输会话）；`requestIdOf()` 返回 HTTP ingress 的 `x-request-id`；`callerConversation()` 只调用 `freshCallOrigin(tool, startedAt, requestId)`；`setCallerConversation()` 进一步依赖 `requestCorrelation(requestId)` 获取 CoS 本地 session。
2. `src/main/session/recorder.ts`：`freshCallOrigin()` 完全依赖已存在的 `requestCorrelation(requestId)`，没有官方请求元数据旁路。
3. `src/main/agents.ts`：缺失调用方确切身份时，返回 `WORKER_IDENTITY_LOST`，保护 Prime/worker 的独立任务历史。
4. `src/main/mcp/long-run-tool.ts` 和 `project-runtime-tool.ts`：显式要求 `caller.sessionId && caller.conversationId`，不允许未归属调用操作长期任务或项目任务。
5. 已安装 v3.1.16 实机通过 ChatGPT MCP 调用 `agents status` 一次及重试均返回 `WORKER_IDENTITY_LOST`；`session_wait status` 与 `project_runtime status` 也因确切身份缺失被拒绝；普通显式工作目录的 `exec_command` 成功。运行日志有 `no page evidence / Unattributed`，符合上述机制。
6. **SDK 有技术承载位置**：本地 `@modelcontextprotocol/server` 类型定义的 `ServerContext.mcpReq._meta` 是原始请求元数据；现有 v3 `kernel.ts` 从未读取此字段。是否实际收到 ChatGPT `openai/session` 仍需要在隔离环境验证。

## 3. 官方新增机制与区别

官方 ChatGPT Plugins Reference 明确称：每次工具调用的 `_meta["openai/session"]` 是用于工具请求关联的匿名对话标识；`_meta["openai/subject"]` 是匿名用户标识。官方 2026-01-15 Changelog 宣布该会话字段已加入 ChatGPT 工具调用。它们与不稳定的 `MCP-Session-Id` 传输标识、HTTP `x-request-id` 工具调用 ID、网页 URL 中的 conversation ID **不是同一种东西**。

参考：
- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/changelog
- https://developers.openai.com/plugins/build/auth
- https://community.openai.com/t/chatgpt-does-not-echo-back-mcp-session-id-anymore-violating-mcp-transport-rules/1380087

重要限制：`openai/session` 是**关联线索而非天然权限凭证**；不能认为任何客户端自带的 `_meta` 就具有不可伪造的安全性。授权应来自服务器验证过的连接身份（OAuth / 受控隧道 + 本地批准），再绑定 `host_namespace / authenticated_principal / host_session / mission_id / execution_epoch`。匿名会话 ID 不自动授权访问项目、历史、进程或其他 agent。

## 4. 建议修复架构（优先复用当前 CoS 核心）

**第一层：Host Identity Adapter**
- 核实 `mcpReq._meta["openai/session"]`、`["openai/subject"]` 在当前官方 ChatGPT 插件连接器的真实请求中是否存在，缺失比率、跨连续工具调用稳定性以及两对话隔离性。
- 仅在经过验证的连接身份下接受此元数据；对旧工具调用继续支持 exact request-ID/page evidence，禁止将时间、当前活动标签页或模型编写的 ID 作为来源证据。
- 把 `host_session_id` 映射到 **CoS 自己的局部 conversation surrogate**，而非宣称它是 ChatGPT 内部的原生 conversation UUID 或网页 URL。

**第二层：Mission Binding / Authorization**
- 使用 CoS 持久化 `mission_id`、`operator_account`、`host_session_binding`、`project_scope`、`execution_epoch`、`lease_revision`、`delegation_rights`、`effect_receipt`。
- 会话第一次开始时，由受信认证及明确项目绑定建立任务；已存在任务的恢复采用独立、可审计授权/本地批准，而不是仅靠知道任务 ID。
- 原有 stale-owner fencing、blocked chat、Stop、超时、中断、重试/幂等与不确定副作用核对继续保留。
- 匿名或缺元数据调用只能执行明确定义的自包含非跨任务工具；关联错误一律拒绝。

**第三层：Mission API（改造接口而非重写核心）**
- `mission_list / inspect / attach / resume / status / stop`；`agents status / spawn / message / finish`；`external_wait`；`project_runtime`，均以当前认证主体和 CoS mission lease 验证。
- CoS 本地调度和 CI watcher 可自主执行确定性工作，不产生新模型推理回合。

**第四层：Model Execution Adapter（不能误混为身份修复）**
- ChatGPT 网页 + MCP：模型主动调用 CoS；CoS 只能保存待续工作，在受支持的用户操作或宿主下一轮模型调用中继续。未获官方授权的网页自动注入/抓取不能用来替代插件。
- 如需真正无人值守多 Agent 推理，应研究获许可的 Codex app-server / ChatGPT 登录计划使用；这些是独立模型任务，不是用户网页聊天历史。配额、API 账单和账户权限都需要独立 Gate。
- 需要分开衡量：`local_wait_resolved`、`continuation_owed`、`model_turn_delivered`、`model_turn_accepted`，绝不能把前两者误认为“网页 ChatGPT 自动续跑成功”。

## 5. 建议测试顺序与验收 Gate

G0（只读当前版）：现有 3.1.16 和用户数据保留，隔离 Next 分支；校验原失败的三条工具调用及日志。

G1（真实元数据探针）：隔离 MCP 进程打印“字段是否存在/格式有效”的匿名布尔和哈希等隐私安全诊断，不记录令牌、原始 ID、聊天正文；同一聊天调用两次、另一聊天调用一次，验证同一会话一致、跨聊天不同。测试真实缺失场景。**未实测成功前不得宣称无插件身份已经解决。**

G2（安全）：任意伪造 `_meta`、错误用户、错误任务绑定、stale worker、并发两聊天都不可越权，stop/cancel 立即撤权。测试 session/user 信息源不可信时 fail closed。

G3（能力恢复）：`agents status/spawn/message/finish`、`project_runtime status/check`、`session_wait arm/status/cancel` 均在无 Chrome Companion 的隔离运行时可完成有权限的路径；已核实元数据被正确映射。

G4（真正续跑）：CI 完成、掉线、重启、工具回复丢失后本地 obligation 严格一次记录；网页模型是否能自动进入下一轮需官方 host 回调能力证明，否则明确改为待领取；不要模拟成功。

G5（无插件功能等价）：从 3.1.16 原有功能清单审计 Core、网页、桌面、Goal/Loop、compact/rebind、多 Agent、历史和权限的差异，无法复刻的功能显式列出。

G6（用户成本）：默认仍使用 ChatGPT 网页订阅和 MCP，不自动启用单独付费 API，也不绕过 OpenAI 使用额度。

## 6. 设计决定（待真实 G1 决定）

- **建议继续 CoS Next，无需放弃核心功能。**
- 身份发现的实现优先采用官方 `openai/session` 及可信认证作用域，不再把 Chrome Companion 作为唯一 join 来源。
- 在 G1/G2 通过之前：不把 v3 原生 ChatGPT 多窗口自动 worker 与无插件方案视为已等价，不下线旧 Companion。
- 在 G3/G4 通过之前：不宣称自动续跑和项目管理修复闭环。
- 本文件只添加设计与验收条件；本轮不修改、安装、更新、重启现有 CoS。
