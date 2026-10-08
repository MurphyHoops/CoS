# CoS Next 4.0：接口、数据与安全契约 v1（实施规格）

状态：**SPEC ONLY**｜不修改现有 App/运行状态。本文作为 Issue、PR、单元与对抗测试的共同契约。

## 1. 领域对象：类型约束

```typescript
type HostKind = "chatgpt_mcp" | "siwc_codex_local" | "legacy_companion";
type SourceEvidence = {
  host_kind: HostKind;
  verified_transport_principal: string | null; // 从可信传输层/OAuth 得出，绝不由 tool args 填写
  host_session_fingerprint: string | null; // HMAC over domain/principal/session；不保存 raw _meta
  authenticated_account: string | null;
  mcp_request_id: string | null;
  evidence_kind: "verified" | "correlation_only" | "missing";
  observed_at: string;
};
type MissionLease = {
  lease_id: string;
  mission_id: string;
  principal_id: string;
  binding_id: string;
  epoch: number; // 整数单调递增；任意 Stop/转移均围栏旧代次
  allowed_project_ids: string[];
  capabilities: ("read" | "write" | "command" | "agents" | "wait" | "stop_self")[];
  granted_at: string;
  expires_at: string;
  revocation_id: string | null;
};
type MissionOperation = {
  invocation_id: string;
  idempotency_key: string;
  expected_revision: number;
  lease_id: string;
  expected_epoch: number;
  operation: string;
  args: Record<string, unknown>;
};
type OperationReceipt = {
  invocation_id: string;
  status: "REJECTED" | "ADMITTED" | "DISPATCHED" | "EFFECT_OBSERVED" | "UNKNOWN_EFFECT" | "RECONCILED" | "COMMITTED";
  source_evidence_id: string;
  attempt_number: number;
  external_receipt_id: string | null;
  project_snapshot_sha: string | null;
  observed_at: string;
};
```

约束：`source_evidence` 来自已校验 MCP 上下文/受信本机模型执行器；任何上游 ChatGPT `_meta` 均不构成直接授权。内部 `principal_id` 由本地认证或明确账号关联产生，不把 `openai/subject` 直接当权限。

## 2. MCP 工具面：最小可发现、单一入口

保留现有 Core 工具签名 `read`、`exec_command`、`apply_patch`、`agents`、`session_wait`、`project_runtime` 兼容。新增或改造的工具建议：

| 名称 | 输入关键字段 | 动作/输出 | 权限 |
| --- | --- | --- | --- |
| `identity_diagnostics` | `action=status` | 显示 has session/user metadata、校验结果、匿名指纹；**仅测试/本地管理员开启** | 调用者只读 |
| `runtime_health` | `scope=core/bridge/tunnel/agents` | 版本、能力缺口、连接状态、对应 Gate；不输出 token/path secret | 只读 |
| `mission` | `action=create/list/inspect/status/attach/pause/resume/stop`；`mission_id?`、`expected_revision?` | 统一任务生命周期，细分 action schema 和严格权限 | list/inspect 只读，其他需授权 |
| `mission_evidence` | `mission_id`、`cursor`、`limit`、`kind?` | 审计证据分页；敏感字段脱敏 | 只读且项目 scope |
| `project_contract` | `action=status/bind/verify`、`project_id?` | canonical root、合同、实际验收结果 | verify 可运行检查，需 command |
| `agent` | `action=status/delegate/message/cancel`、`mission_id`、`agent_id?`、`task?` | 同一 broker 的 Agent 管理；兼容旧 `agents` | 分发受认证的 Agent lease |
| `wait` | `action=status/arm/cancel`、`mission_id`、`kind`、`target` | 外部等待与任务义务状态；兼容旧 `session_wait` | arm/cancel 需 lease |
| `claim_continuation` | `mission_id`、`obligation_id`、`executor_kind` | 领取、围栏、确认任务续行责任 | 有效 executor/epoch |
| `delivery_ack` | `message_id/obligation_id`、`receipt`、`state` | 模型执行器实证回执，不由模型自称完成 | 内部授权 executor |

工具名称最终应为 7～10 个稳定业务入口；避免每个小动作都暴露独立工具导致模型选择混乱。`delivery_ack` 若只供内部后台使用，不需要发布到 ChatGPT MCP tools/list。出于兼容，v3 `agents` 和 `session_wait` 要么桥接同一 Kernel，要么保留原功能并明确仅 legacy，不允许两套所有者权威。

### 2.1 MCP 输入示例（结构示例，不是凭据）
```json
{
  "action": "inspect",
  "mission_id": "00000000-0000-4000-8000-000000000001",
  "expected_revision": 21
}
```

服务端无论收到什么 `mission_id`，都必须先从当前真实 MCP CallContext 中发现已批准的 `Binding`，不能根据用户消息里的 UUID 越权。

## 3. 生产身份 Adapter 实施

### 3.1 入口
- `src/main/mcp/server.ts`：不破坏现有有界 JSON body、Host/Origin 与 request-id 归一化，保留 `inboundRequestId()` 作为工具调用 correlator。
- `src/main/mcp/kernel.ts`：把 `McpCallContext` 从 `Pick<ServerContext,'sessionId'>` 扩展为可安全访问 `mcpReq._meta` / verified transport，先调用 `deriveCallerEvidence()`，后决定是否允许取 Mission lease。
- 注意不同 MCP Handler 类型：`server.registerTool()` 回调上下文含 `ctx.mcpReq._meta`；`server.server.setRequestHandler("tools/call")` 使用 `request.params._meta`，不能机械套用一个回调结构。
- `src/main/session/recorder.ts`：保留旧 request-ID/网页证据归属算法供 Legacy 使用；新增 `HostSessionBindingResolver`，先尝试经过验证的 Host Session，遇矛盾 fail closed，不再临时按时间猜。
- `src/main/mcp/tools-plugins.ts` 的 `pluginManager.call(name,args)` 不传播上游 `_meta`；**不要通过下游插件绕过本入口身份验收**。如确需携带诊断信息，只传服务端创建的最小、受信内部上下文，不透传原始主体/令牌。

### 3.2 Trust levels
- `CORRELATION_ONLY`：识别到 `openai/session` 但未确认账号/本机批准，只能最小自包含 read/status。
- `AUTHENTICATED_OPERATOR`：验证过本机操作者/ChatGPT connector 信任边界；可发起明确本地授权。
- `AUTHORIZED_MISSION`：拥有指定 Mission+Project scope、有效 epoch 的 lease，允许按 capability 控制。
- `AUTHORIZED_AGENT_EXECUTOR`：受 Mission Kernel 派生委托、带 quota/expiry/revision 的 worker，可以领取自己的任务，但不得冒充 prime。
- `LEGACY_EXACT_PAGE`：旧扩展来源的 exact request ID，可以在旧版兼容通道工作，**不升级成另一个授权主体**。

### 3.3 授权缓存
- `allowed := authenticated ∧ binding_exists ∧ same_principal ∧ same_host ∧ lease.valid ∧ same_epoch ∧ same_project ∧ capability_allowed`。
- 写调用前、外部命令 admission 时、消息派发前、CI wake/cancel 等异步回调时均检查 lease；任何时间触发的 revocation 使后续写入被围栏。
- 对 `list` 和 `status` 同样实施项目级隔离；不能用 error 透露其他用户是否有某个 Mission。
- 记录 `DENIED_MISSING_HOST_SESSION`、`DENIED_NOT_BOUND`、`DENIED_CAPABILITY`、`DENIED_STALE_EPOCH`、`DENIED_SCOPE` 等代码，前端提示具体如何恢复，但不输出私密标识。

## 4. 数据库与 Journal 推荐

第一版可沿用既有 Durable 工具，新的 Next 索引建议用 SQLite WAL；在正式代码设计评审后选定一种**唯一的事务权威**，不能同时维护 SQLite 和旧 JSON 中相互冲突的状态。

```sql
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL,
  profile_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE missions (
  mission_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  finish_contract_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE host_bindings (
  binding_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  host_session_hmac TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  UNIQUE(namespace, principal_id, host_session_hmac, mission_id)
);
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_id TEXT,
  runtime_thread_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE obligations (
  obligation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  UNIQUE(mission_id, source_event_id, kind, epoch)
);
CREATE TABLE invocations (
  invocation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  effect_receipt_json TEXT,
  UNIQUE(mission_id, idempotency_key)
);
CREATE TABLE journal (
  journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  redacted_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
```

- SQL 示例是**逻辑 schema，不是迁移脚本**；后续须补充 FK、enum CHECK、索引、事务顺序、签名/备份恢复策略、快照协议和版本迁移验证。
- 所有状态变化通过单一 Kernel Transaction API 完成，`missions.revision` 必须 compare-and-swap。
- Journal 不直接保存密码、原始 ChatGPT ID、用户输入正文、外部进程环境或完整上下文。
- Legacy import 只复制经用户允许的事实和可核验证据；Keychain 和 Connector/Tunnel 密钥不导入。

## 5. 最小 RPC：内部执行器协议

```json
{
  "envelope_version": 1,
  "mission_id": "00000000-0000-4000-8000-000000000001",
  "agent_id": "worker:proof-review",
  "executor_kind": "codex_local",
  "epoch": 9,
  "invocation_id": "inv-uuid",
  "obligation_id": "obl-uuid",
  "expected_revision": 30,
  "deadline_ms": 180000,
  "tool_caps": ["read", "command"],
  "payload_digest": "sha256:...",
  "source_evidence_digest": "sha256:..."
}
```

### 5.1 消息状态与回复
`QUEUED → CLAIMED → ACCEPTED → MODEL_TURN_STARTED → MODEL_TURN_COMPLETED → REPORT_CONFIRMED`；
失败有 `MODEL_TURN_FAILED`、`DELIVERY_UNKNOWN`、`CANCELLED`。不可从 `MCP HTTP 200`、`tab_opened`、`model_turn_started` 直接跳到 `REPORT_CONFIRMED`。

### 5.2 B 引擎回执
- 记录 `Codex thread_id`（单机受保护）、`turn_id`、`turn.status`、模型 ID 和 provider 错误类别。
- `turn/completed` 是事件名；仍要检查 `turn.status == completed`。失败、取消、超时需留下 backlog，不静默重试可能重复副作用的调用。
- 私密线程消息历史保存在独立安全目录，跨 Web chat 只导入经过同意的任务状态和必要证据。

## 6. Project completion 接口的契约

```json
{
  "project_id": "ueot-lean",
  "mission_id": "mission-uuid",
  "completion_contract_version": 1,
  "required": [
    { "kind": "lean_compile", "target": "selected_theorem_module" },
    { "kind": "proof_hygiene", "forbid": ["sorry", "admit", "new_axiom"] },
    { "kind": "ci", "head_sha_required": true, "resulting_main_required": true },
    { "kind": "ledger", "checked_against_main": true }
  ],
  "status": "IN_PROGRESS",
  "evidence": []
}
```

不同项目由 Project Profile 的 allowlisted verifier 确定实际完成目标，而不是在 v4 核心写死 UEOT；上表仅示意具体项目适配。对 UEOT-GI 应有实验注册、统计 gate、负控与正式 deployment decision。不能用用户/Agent 报告单独替代机器谓词。

## 7. 需要测试的安全不变量（每条都有自动化 Gate）

1. `same ChatGPT session + same authenticated principal` 在绑定有效时可重复读出同一 Mission；未绑定仍拒绝。
2. `different host sessions` 同用户不得读/写另一会话私有任务，除非明确授权 attach；其他用户必须严格拒绝。
3. `_meta` 假造/缺失/畸形、错误 principal、错误项目、错误 epoch、过期 lease、撤权必须拒绝，且外部写调用计数为 0。
4. 重复 `idempotency_key` 不能产生第二次相同写操作；不同 payload 复用 key 返回冲突。
5. `STOP` 在抢占/启动/完成与进程重启竞态中生效；旧 Worker 迟到 report/ack 不得修改新代次。
6. 外部命令已发送但没有 receipt：进入 `UNKNOWN_EFFECT`，不得立即 retry；通过真实 Git/文件/进程核验后转 `RECONCILED`。
7. Worker 能读取自身 inbox，不能读取别的 Worker inbox/控制 Prime；配额/长度/队列上限来自配置和现场能力。
8. ChatGPT host `openai/session` 只说明关联，缺任何可确认的模型 callback 时自动恢复状态必须标 `NEEDS_USER_OR_HOST`。
9. 同一 Tunnel 不允许两个 dispatcher 同时接管；重启/切换要验证当前消费者租约并保证旧实例可恢复。
10. Mac/Windows/Linux 路径、权限、持久化和 package tests 无平台隐式假设。

## 8. 出口与兼容版本策略
- CoS 3.1.16 客户端 ABI 保留至 v4 核心 Gate 成功；新 Mission API 可先以实验 feature flag 隐藏。
- 对话内工具缓存更新通过 ChatGPT Plugins → Refresh 的明确流程，不用重复创建插件绕过配置限流。
- 旧任务不能仅改 JSON 字段就被视为新会话绑定；迁移必须生成用户批准的 binding 映射，并保留原证据。
- 若官方会话元数据未送达，阻断写权限和 Agent 控制，但允许人工批准的独立显式任务操作，不能伪造 G1b PASS。
