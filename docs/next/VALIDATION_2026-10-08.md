# CoS Next | 身份与持久任务方案验证报告

**日期：** 2026-10-08
**分支：** `next/v4-chatgpt-first-design`
**测试范围：** 已安装 CoS 3.1.16 的只读实测、当前生产源码检查、官方 MCP SDK 隔离实验、拟议授权策略的负控测试、现有任务内核回归测试。
**重要限制：** 没有停用 Chrome 插件、没有修改正在运行的 CoS App、没有重启它，没有连接一个新的真实 ChatGPT MCP 诊断端点。**以下不是完整无插件端到端验收**。

## 结论与 Release Gate

**总体判定：研究路线有条件成立，产品升级仍被 G1b/G2b/G3/G4 BLOCK。** 不能宣布“无插件多 Agent、自动续跑、项目管理已修复”。

| Gate | 项目 | 本次结果 | 证据与缺口 |
| --- | --- | --- | --- |
| G0 | 旧版保护、隔离工作目录 | PASS | 旧版 v3.1.16 App 仍在；只在独立 `CoS-Next` 工作树新增本报告与实验测试 |
| G1a | MCP SDK 传递 `openai/session` / `openai/subject` | **PASS（模拟请求）** | 本机安装 `@modelcontextprotocol/server@2.0.0`，工具回调 `ctx.mcpReq._meta` 准确收到模拟 `tools/call` 的两个字段；缺失字段保持缺失 |
| G1b | 真实 ChatGPT → 已连接的 CoS 端点提供该字段 | **NOT VERIFIED** | 真实 v3 Tool Handler 未读取这些字段；当前工具返回无法判断。需要独立诊断连接器，不可从官方文档直接推断此实例 |
| G2a | 独立授权/租约策略的逻辑防护 | **PASS（样例策略）** | 7 项策略单元测试：无可信身份、未绑定、跨对话、跨用户/命名空间、失效 epoch、只读、任务 ID 伪造均 fail-closed |
| G2b | 真实 CoS 连接认证和授权隔离 | **NOT VERIFIED** | `_meta` 由客户端提供，单独不能作为授权凭证；本机服务通过私有 tunnel URL 暴露，不等同已验证 OAuth 用户 |
| G3 | 现有 CoS 的身份依赖工具 | **BLOCK** | 真实安装版 `agents status` → `WORKER_IDENTITY_LOST`，`session_wait status` / `project_runtime status` → exact identity required |
| G3-core | 现有任务内核回归 | **PASS** | 13 个旧版相关测试文件，与新测试联合为 14 个文件：499 passed、9 skipped、0 failed |
| G4 | 去插件的自主创建/驱动 ChatGPT 网页 Worker 和模型自动续跑 | **NOT VERIFIED / NO SUPPORTED HOST TURN TRIGGER ESTABLISHED** | MCP 回调接收工具调用 ≠ CoS 能主动启动 ChatGPT 网页新一轮生成；需独立合法推理适配器或明确改为“等待用户/宿主下一次调用” |
| G5 | 浏览器/桌面全功能等价 | **BLOCK** | 旧 `browser_tabs`/DOM/Network 经 Companion Bridge；macOS UI 读取受 Accessibility 权限阻断；Chrome DevTools MCP 现有浏览器连接尚未做批准后的实机验收 |
| G6 | 网页端订阅优先、额外 API 费用为零 | **PASS（本次测试过程）** | SDK fixture + Vitest 都在本地运行，没有调用计费推理 API；未来模型配额与平台条款仍适用 |

## 实测记录：MCP 工具处理器

使用实际现有依赖 `@modelcontextprotocol/server@2.0.0` 的 `createMcpHandler()` 和 `McpServer.registerTool()`，发送符合 2026-07-28 版本协议的本地模拟请求：

```json
{
  "method": "tools/call",
  "params": {
    "name": "inspect_host_identity",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "openai/session": "session-A",
      "openai/subject": "subject-A"
    }
  }
}
```

工具观察到 `ctx.mcpReq._meta` 包含上述两个 OpenAI 字段；无字段请求返回空，不推断身份。两个请求均 HTTP 200，未要求读取用户文件、Cookie、ChatGPT 对话或配置密钥。此实验表明**无需改 SDK 就能接收到请求元数据**，但不能证明生产 ChatGPT 连接器实际传送。

**官方契约：**
- https://developers.openai.com/plugins/reference （`_meta` 中 ChatGPT 提供的 `openai/session` 与 `openai/subject`）
- https://developers.openai.com/plugins/changelog （2026-01-15 会话元数据变更）

## 源码根因定位（真实 v3.1.16）

- `src/main/mcp/kernel.ts`：工具的服务上下文声明为 `Pick<ServerContext,'sessionId'>`，只读取 SDK 传输 session ID；请求 ID 来自 `inboundRequestId()`，通过 `callerConversation()` / `freshCallOrigin()` 查找关联；**没有消费 `ctx.mcpReq._meta`**。
- `src/main/session/recorder.ts`：`freshCallOrigin()` 严格按 `requestCorrelation(requestId)` 寻找扩展证明的聊天归属，无法凭 HTTP request id 单独反推对话。
- `src/main/mcp/long-run-tool.ts`、`project-runtime-tool.ts`：调用要求 `caller.sessionId` 和 `caller.conversationId` 都存在；`agents` 同样 fail closed。
- `src/main/agents.ts`、`src/main/bridge.ts`：独立网页 worker bootstrap、唤醒、报告转发仍有实际的浏览器 Companion 传输依赖。即使身份源恢复，也不自动消除这一依赖。
- `src/main/mcp/server.ts`：私有隧道 URL 作为访问控制的设计，不等于 ChatGPT `openai/subject` 是服务端已认证、不能伪造的用户 ID。

**必须区分**五种对象：单次 `x-request-id`、MCP 传输 `sessionId`、官方 `openai/session` 匿名对话标识、CoS 持久 `mission_id`、网页真实 conversation UUID。不能混用或假定同一值。

## 独立验证代码与运行命令

新增：`test/next/host-session-metadata.test.ts`，**只添加测试样例，不连接/修改现有 CoS 运行时**。

测试组成：7 项 MCP SDK 元数据字段传输/缺失/类型/伪造参数测试 + 7 项独立授权策略负控 = **14/14 passed**。

联合原代码回归：

```text
Test Files  14 passed (14)
Tests       499 passed | 9 skipped (508)
Duration    17.41 s
```

另执行 `npm run typecheck`：退出码 0。

曾首次回归两项失败，原因是隔离 CoS Next 路径下缺少打包的 `rg` 可执行文件，导致 shell exit 127；将 PATH 明确指向**现有** hotfix 工作树的 `resources/packaging/rg/darwin/arm64` 后，**同一回归组 499 passed / 0 failed**。这个环境缺口已经核对，不应算作 CoS 产品故障。

复测已安装 CoS 的真实工具时：

```text
agents(status)       → WORKER_IDENTITY_LOST
project_runtime      → Exact durable session and conversation identity are required
session_wait(status) → Exact durable session and conversation identity are required
```

没有创建 Worker、没有 arm wait、没有执行项目 check，也没有更改用户任务。

## 建议的下一步实现和验收（不得跳过）

1. **G1b：隔离版真实连接器探针。** 在下一代临时端点只记录字段有/无、有效/无效、在本地盐下的稳定匿名散列以及`ctx.http.authInfo`是否存在；不记录明文原始会话 ID、Token、工具内容或真实 ChatGPT 消息。连接该**独立测试连接器**需要用户明确执行 ChatGPT 连接动作。不更换旧连接器，也不影响安装版。
2. **G2b：可信权限。** 明确认证主体/访问端点来源及威胁模型；`openai/session` 只能做可信主机通道上的相关性证据，不能把任意客户端自报 `_meta` 当作授权。CoS 持久记录任务确认、项目根目录、scope、epoch、撤销；两个聊天、两个用户、过期 Worker 跨租约全部不得写入他人的任务。
3. **G3：共享 Mission Kernel 接口。** 在 Next 新版本中添加调用者适配层及仅限已授权的 `mission inspect/attach/status`，然后恢复 `agents`、`session_wait`、`project_runtime` 的身份相关操作。保留 v3 原有 rollback、Stop 和不确定副作用保护。不要直接修改正在运行的 3.1.16。
4. **G4：推理执行与传输解耦。** 多 Agent 的任务队列/状态机保持 CoS 自己持久化，具体 Worker executor 改成显式 `host:interactive_chatgpt_web`（只能响应宿主驱动）或合规独立 `provider:local_agent`（验证权限/额度/账户），不以后台浏览器模拟网页发送来绕过使用限制。
5. **G5：真实无插件断连。** 单独的 Next data dir/隧道/浏览器调试环境；禁用的必须是**隔离实例**里的插件依赖，不能影响原 CoS。验证浏览器控制、原生 UI 授权、多 Agent、长任务、掉线、重启、Stop、冲突拒绝与 CI 自动恢复。
6. **G6：无额外 API 账单。** 默认 ChatGPT 网页 + 官方 MCP；保留人工/合规订阅推理适配选择，不启用有单独计费的 API fallback，不规避服务限额。

## 本轮禁止推断的结论

- SDK 支持官方 `_meta` **不意味着**当前实际 ChatGPT → CoS 隧道传送该字段；
- 14 项拟议 policy 测试通过 **不意味着**生产 CoS 已实施这套授权；
- 499 个旧版/隔离测试通过 **不意味着**端到端多 Agent 或网页自动续跑已修复；
- 本地 CI/进程 watcher 可继续工作 **不意味着**模型无需用户/宿主动作就能重新生成 ChatGPT 网页回复；
- 没有用额外 API 进行这次实验 **不意味着**任何 ChatGPT 模型具有无限配额。

**总体：保留原版稳定环境，继续 CoS Next。先完成真实主机元数据和可信认证的 G1b/G2b，再进入可验证的任务管理工具适配与 Worker 执行适配。**
