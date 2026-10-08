# CoS Next 4.0：里程碑、CI、安全验收和回滚合同 v1

日期：2026-10-08。**仅设计；不得自动修改旧版应用或开始迁移。**

## 1. 总体工作包和依赖

| 包 | 工作 | 预计改动位置 | 验收产物 / Gate |
| --- | --- | --- | --- |
| WP00 | 冻结现有基线、建立 Epic/CI | `docs/next/`、`.github/workflows/` | G0：版本、hash、CI、旧 App/数据保护 |
| WP01 | ChatGPT 元数据入口 | `mcp/kernel.ts`、`mcp/server.ts`、`mcp/inbound.ts` | G1b：2 个真实 ChatGPT 对话的 Session 证据 |
| WP02 | Principal、HostBinding、MissionLease | `next/identity/`、`next/auth/` | G2b：可信认证+本地批准，跨会话攻击零越权 |
| WP03 | Mission/Project 统一状态 | `next/mission/`、`session/store.ts` | G3a：授权/Revision/状态/完成谓词 |
| WP04 | 多 Agent 执行器解耦 | `agents.ts`、`agents-recovery.ts`、`next/executor/` | G3b：Prime/Worker/消息与持久恢复 |
| WP05 | CI/Process Wait 和项目闭环 | `session/long-run*.ts`、`project-runtime.ts` | G3c：外部回调一次归集、未知副作用不重放 |
| WP06 | 可选官方 SIWC/Codex 本地 Agent | `next/executor/codex/` | G4：资格、配额/Token、thread resume、真实回合 |
| WP07 | 无插件浏览器/桌面工具 | `browser-control.ts`、`mcp/tools-browser.ts`、`tools-desktop*` | G5：非 ChatGPT 网站后台/原生控制授权与安全 |
| WP08 | Next 独立包和权限/日志 | `index.ts`、`config.ts`、`scripts/package.mjs` | G6：bundle、userData、Keychain、Ports 分离 |
| WP09 | 拷贝式迁移与回滚 | `next/migration/` | G7：旧数据不可变、回滚、跨 App 项目写锁 |
| WP10 | 灰度与版本发布 | `.github/workflows/`、release | G8：全证据审核、签名包、验收报告 |

**优先级**：WP00 → WP01(G1b) → WP02(G2b) → WP03 → WP04/WP05 → WP06 → WP07/WP08 → WP09 → WP10。

**允许提前并行**：WP07 非 ChatGPT 浏览器在独立测试环境验证；WP08 独立 App ID/签名审计；WP06 仅模拟 OAuth/线程协议。真实 Mission 操作绝不能越过 G2b。

## 2. 建议工程迭代与估算

| 迭代 | 工作包 | 规划级估算 |
| --- | --- | --- |
| S0 | G1b 真实元数据与旧版保护 | 2–4 工程日 + 平台限流/连接等待 |
| S1 | 认证、Mission 存储与权限 | 5–10 工程日 |
| S2 | 多 Agent、CI 等待和项目完成 | 7–14 工程日 |
| S3 | SIWC/Codex 本地自治（独立资格门） | 5–10 工程日 + 账号资格 |
| S4 | 非 ChatGPT 浏览器、桌面、打包 | 5–12 工程日 |
| S5 | 灰度、真实工作流、回滚 | 4–8 工程日 |

以上仅为可分派开发工作量粗估，非承诺日期；关键路径由真实 ChatGPT 连接元数据、账户资格和授权审批决定。S1/S2 测试可提前用模拟已授权 Caller，但绝不能算生产 G1b/G2b 已通过。

## 3. 真实会话身份 G1b：两种可选测试路径

之前已验证：安装的 MCP SDK 可以读取合成 `openai/session`、`openai/subject`；独立 `scripts/next/identity-probe.mjs` 测试服务可在回环 HTTP 上返回匿名指纹；最近定向回归 **512 passed / 9 skipped / 0 failed**，类型检查通过。

**尚未验证**：真实 ChatGPT 调用是否将字段送达该服务。不得从单元测试推断通过。

**A. 独立连接**：在平台配置限流解除且用户明确授权后，单独创建 Dev Tunnel/插件；原 CoS 3.1.16 不变。这是最纯粹的隔离方案。

**B. 已有 Core Connector 受控切换**：如果仍无法新建 MCP，在**事前得到用户另行批准的维护窗口**，把带只读 `identity_diagnostics` 的兼容 Core 构建挂接到现有 Core 通道：
1. 保存旧包/配置/hash/任务状态、三 Tunnel 的可恢复状态。
2. 确认当前没有未完成的不可中断任务；不同时运行两个占用同一 Tunnel ID 的客户端。
3. 先本地 Inspector 验证兼容端点和所有既有工具；只允许读字段存在/匿名指纹。
4. 若工具定义新增，用 ChatGPT 插件详情 **Refresh**，不反复创建新的 MCP。
5. Chat A 连续调用两次，Chat B 同一用户调用一次，回到 A 再调用一次。
6. 验证 A 指纹相等、A/B 不同、缺失字段安全降级、无原始 ID/密钥/聊天正文日志。
7. 恢复旧服务或在更严格验证后决定保留兼容版本；复查旧 Core、Desktop、Plugins。
8. 任一步失败即回滚并记录 BLOCK；不称 G1b 通过。

**不得选择**：强制原 CoS 在运行时被本地代理篡改；将新客户端与旧客户端并发登记到同一 Tunnel ID；从旧隧道/Keychain复制令牌当新 Connector 凭据。

G1b 只是会话*相关性*，而非账户级授权。G2b 要单独验证受信 Principal、用户批准、lease、撤权。

## 4. 必测安全/并发矩阵

| 情景 | 结果要求 |
| --- | --- |
| 同用户 Chat A/B 分属两个 Mission | 不允许 B 读/写 A 未批准任务 |
| 同一个 `openai/subject` 但不同会话 | 不能天然共享 Mission 权限 |
| `_meta` 缺失、伪造、过长、对象、冲突 | Fail closed；不得触发写 |
| 传入别人的 mission UUID | 没有本地绑定则一律拒绝 |
| 旧 Agent ACK 与新 epoch 竞争 | 旧 ACK 不得修改新 Mission |
| 同一个 effect 重试或网络回包丢失 | Journal 去重 + UNKNOWN_EFFECT reconciliation，不二次执行 |
| Stop 和 Worker 同时申请写权限 | Stop 围栏任何新的旧 epoch 写入 |
| CI 完成事件重复/进程退出重复 | 至多一个有效 obligation；不伪造模型接收 |
| CI Green 但 resulting-main/ledger 不满足 | 任务继续 HOLD/IN_PROGRESS |
| Web A 无后续宿主回合 | 只允许 `NEEDS_USER_OR_HOST`，不得称自动推理完成 |
| SIWC B 账号无权限/额度耗尽 | `WAITING_MODEL`；不转付费 API |
| CoS 进程崩溃/重启 | 任务重建，无重复写入，证据连续 |
| Mac Accessibility 未授权 | 桌面控制拒绝，不影响核心项目工具 |
| Companion 下线 | New Kernel 可正常启动和执行，与 v3 网页 adapter 明确分离 |
| 既有 Tunnel 发生 503/限流 | 限流退避，平台环境故障不能当用户任务成功 |

## 5. 可审计 GitHub 任务治理

建议正式开工时创建一个 Canonical Epic：**CoS Next 4.0 — Extensionless Mission Runtime**。
- Canonical 设计分支为 `next/v4-chatgpt-first-design`；每个 WP 用 `next/v4/<topic>` 独立 branch/worktree。
- WP00～WP10 每项最多一个 Canonical Issue，记录 Owner、当前 Gate、标准、测试、阻断、准确 SHA、关联 PR。
- 工作单状态：`DESIGN` / `IMPLEMENTING` / `CI_GREEN` / `SECURITY_REVIEWED` / `READY_FOR_RELEASE` / `HOLD` / `RELEASED`。
- 一个 Agent 对话恢复任务时先检查 Issue、branch、未提交数据、CI 和本地状态，不重复创建 Work Package。
- 任何真实身份/委托/Stop/外部副作用代码变更须增加失败注入和 READ-ONLY 审计结论 `CLEAR/BLOCK`。
- PR exact-head CI 绿不等于 resulting-main 绿；合并后必须复核实际 main，必要时恢复 ledger/发布索引。

### 5.1 建议 CI Jobs
- `next-identity`：MCP v2 metadata、HostBinding、跨会话与缺失值负控。
- `next-lease-security`：Principal、Project Scope、Epoch、撤权、竞态和拒绝无副作用。
- `next-mission-journal`：事务、重启、重复请求和未知效果核对。
- `next-agents`：Prime/Worker、消息去重、队列/配额、复苏和交付 ACK。
- `next-longrun-project`：GitHub CI 与子进程状态、completion contract、结果误报负控。
- `next-siwc-model`：CI 默认 Mock；用户另行授权后做真实模型 smoke，不能未经许可使用个人订阅凭据。
- `next-package-isolation`：macOS、Windows、Linux 分别校验签名/路径/密钥/打包/回滚。
- `next-release-gates`：记录 G1b 真机/外部证据为 manual gate；不可把模拟测试判为真机 PASS。

所有 Jobs 之外，还必须执行已有 `npm run verify:ci` 及相关平台 package smoke；旧 CI 不得因为 Next 开发被降级/删除。

## 6. 并行安装、切换与回滚

1. 旧版始终保留 `/Applications/Chat On Steroids.app`、`com.chatonsteroids.app` 和旧 userData/Keychain。
2. Next 采用暂定独立 `com.chatonsteroids.next`、`Chat On Steroids Next.app`、新的 app-support、socket、log、Keychain service、签名/自动更新 Channel。
3. Next 与旧版不得同时无锁写入同一个项目/工作树；需要项目级 interprocess lease 或明确选择一个写入所有者。
4. 拷贝迁移前备份、盘点、审计旧 session/Goal/Agent/CI/Keychain；只复制用户许可的非秘密数据，旧版永久可回滚。
5. 如 Core Tunnel 必须切换所有权，要显式维护窗口和旧消费者恢复脚本；不在两个实例上同时启动同一 ID。
6. 旧工具 ABI 在新版必须保持，新增工具在现有 ChatGPT App 设置中 Refresh；不能把插件配置限流当作重建 App 的理由。
7. Release Notes 说明 A 是交互式网页推理，B 是独立本地授权模型，二者的历史和额度不共享；旧版独有的网页自动 Worker 不可在 A 上宣称已等价。

## 7. 最终完成定义 / Release Gate

最终提交报告必须包含：
- Chat A/Chat B 真机匿名会话隔离证据、可信主体 + MissionLease 授权测试；
- 真正无 Companion 的 Core 文件/终端/项目/Agent/长等待端到端验收；
- 有权限本地 B 下多个 Worker、真实 CI 等待、重启、Stop、未知写入和 quota pause；
- 一个真实 UEOT 项目型任务通过机器 completion contract（或等效长期项目），而不是口头成功；
- macOS/Windows/Linux CI 与 packaged smoke 通过，项目和旧 CoS 数据未被改变；
- 原版可用、Next 独立、安全回滚演练有实证；
- 额外单独计费 API 默认零支出，未绕过服务提供商的配额。

不满足完整产品 Gate 就维持 `HOLD` 或显式缩减已发布功能承诺，绝不将单项 SDK 测试当成整套 CoS 4.0 完工。

**本文件只是里程碑和验收合同，不创建 Issue、不改业务代码、不切换 Tunnel、不安装新版应用。**
