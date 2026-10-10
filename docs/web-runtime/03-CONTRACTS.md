# 03 — 接口与状态机（实现前冻结）

## TypeScript 端口

~~~typescript
interface BrowserDeliveryPort {
  start(profile: ProfileLease): Promise<RuntimeHealth>;
  bindActor(req: PairingRequest): Promise<VerifiedBinding>;
  deliver(turn: TurnEnvelope, signal: AbortSignal): Promise<DeliveryReceipt>;
  observe(actorId: string, turnId: string): Promise<ReplyReceipt | Pending>;
  reconcile(deliveryId: string): Promise<ReconcileReceipt>;
  stop(actorId: string, generation: number): Promise<StopReceipt>;
  status(): Promise<RuntimeHealth>;
  shutdown(): Promise<void>;
}
~~~

TurnEnvelope 必须有 missionId、actorId、actorGeneration、turnId、deliveryId、bindingRevision、payloadDigest、截止期限和 capabilityScope。PageDriver 只实现 owned profile 的 open/observe/click/type/capture/close，不提供全局鼠标/键盘命令，也不决定 Goal 是否完成。

## 严格投递阶段

QUEUED → CLAIMED → STAGED → SEND_ATTEMPTED → ACCEPTED → REPLY_STARTED → REPLY_SETTLED → TOOL_ACKED（需要时）→ TURN_COMPLETED。

FAILED_PRE_SEND：已证明提交没有发生，有限重试。
AMBIGUOUS：提交可能发生但网页回执不可验证，**禁止自动重试**，只能只读对账或人工决策。
REVIEW：网页模型认为已完成，但最终证明尚未由现有任务系统确认。

发送前确认 Actor 所属 Page Target、精确对话 URL、草稿与附件状态、生成状态、精确 payload；写入 SEND_ATTEMPTED 后才能执行点击；回执必须是**本轮完整 marker 出现在绑定会话的用户消息**，不能使用旧消息、助手引用、清空输入框等替代。回复另由新 assistant message ID、稳定完成证据确认。

## 会话身份配对

UNBOUND → PAIR_PENDING（单次，≤10 分钟）→ MCP_RECEIPT → WEB_ECHO_VERIFIED → BOUND。正常重启复用绑定；更换会话必须新代次验证成功后才切换权威。一个共享 Connector 为多个 Worker 提供工具；authenticated connector + host _meta 会话关联 + Actor generation + 项目权限是分立证据。缺少 openai/session 或冲突绑定，禁止默认到 Prime / 最近 Worker。原始 meta/token 不落盘，采用加盐/密钥保护的摘要。

## 故障分类

PAGE_CHANGED、AUTH_EXPIRED、MODEL_BUSY、RATE_LIMITED、NETWORK_OFFLINE、SEND_AMBIGUOUS、STOP_REQUESTED、TOOL_ERROR、BROWSER_CRASH、MCP_DISCONNECTED、PROJECT_GRANT_REVOKED 不能合并为一个失败。恢复时先检索收据、队列和拥有权，再决定是否发起新请求；429 冷却受网站约束，无账户/模型轮转规避。

## 权限

Browser Profile 仅证明网页登录；模型生成的操作文本不能获取文件或 shell 权限。需要可验证的 MCP 调用、有效 Actor→MissionLease 与项目 scope；写操作保持单独用户授权/可撤销项目级授权。Stop 与代次变化即时失效。
