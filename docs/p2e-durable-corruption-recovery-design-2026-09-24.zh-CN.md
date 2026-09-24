# P2-E durable corruption / recovery 设计

日期：2026-09-24
基线：`main@6ec117ae9256df3ad099e4f74d4113c66b3b8875`
分支：`feature/p2e-durable-corruption-recovery`

## 1. 目标与边界

P2-E 修复的不是“JSON 解析报错”本身，而是**控制账本损坏被解释成空权威状态**的问题。
当前 `readDurable()` 把 missing、malformed JSON 与 I/O failure 都折叠成 `null`；
多个 owner 又会把 schema-invalid row 静默跳过，导致 pending debt、revocation、worker authority、
continuation WAL 或 browser command custody 在重启后看起来从未存在。

本项目必须同时满足：
- durable read 明确区分 `missing / valid / corrupt / io_error`；
- JSON 完整性与 owner schema 完整性分层处理；
- authority-bearing ledger 的 corrupt 绝不等价于 empty；
- recovery 不得重新授权旧 executor，不得自动重放 ambiguous mutation；
- backup 只是 checkpoint evidence，不是第二个 authority；
- 恢复策略由 owner 声明，协调器只负责分类、暂停与呈现；
- 保持现有 `broker durable → Long-Run durable → Goal/Loop durable` 顺序；
- 不恢复已撤销的 P2-F，不把 provider transport suspension 当作 corruption recovery。

## 2. 非目标

- 不把 `durable.ts` 变成全局数据库或跨 owner 事务管理器。
- 不声称 temp-file + rename 已提供断电级 durability；本阶段仍以应用 crash/restart 为保证边界。
- 不允许 stale backup 因“能 parse”就自动覆盖 primary。
- 不在恢复路径猜测 ChatGPT conversation、worker、request、turn 或 send outcome。
- 不把展示缓存、目录缓存等 rebuildable state 升格为关键控制账本。
- 不用一个全局“恢复默认值”覆盖 owner 自己的失败语义。

## 3. 现状风险图

| Ledger / owner | 当前坏文件行为 | 权威风险 | P2-E policy |
| --- | --- | --- | --- |
| Goal objectives | null/坏行变空 | 目标丢失，驱动 silently stops | pause Goal owner；backup 仅经 schema/replay check |
| Goal switches | null/坏行变空并回退全局设置 | 可能错误重新启用/改变模式 | strict fail closed；禁止全局 fallback 取得新 authority |
| Goal replies | null/坏行丢 pending debt | 自动 continuation 债消失或 tombstone 丢失 | strict pause；不得从 stale backup 复活 pending |
| swarm | null/坏 owner 被丢弃 | worker identity/message custody 消失 | strict agent pause；old executor 默认拒绝 |
| retired-workers | null/坏行丢 lease | 已退役 worker 可能重新获得工具 | strict agent pause；恢复前旧 worker fail closed |
| continuations | null/坏 entry 被丢弃 | A→B WAL 消失、旧 A 可能重新取得 authority | strict continuation pause；只用 session meta 做独立证明 |
| long-run | null/坏行丢 epoch/debt/wait | wait/owed work 或 stale-executor fence 消失 | strict long-run pause；UUID orphan 继续 stale |
| blocked-chats | null/坏行变无 block | rogue chat 重新获得本机工具 | strict MCP safety pause；绝不按 empty 启动 |
| session-input | null 被 `?? []` 接收 | durable outbox/receipt 消失 | input-delivery pause；不自动 resend |
| bridge-commands | missing/corrupt 都近似 empty plan | command custody/ACK ambiguity | browser-command pause；仅独立 session proof 可重建 recovery command |
| request correlations | null/坏行弱化 attribution | caller proof 下降 | fail closed attribution；可重建部分才重建 |
| chat-models / usage-cache 等 | null/invalid 可重建 | 无 mutation authority | rebuildable cache；允许降级 |## 4. 分层架构

### 4.1 durable I/O 层：只报告事实

在 `durable.ts` 增加新的判别式读取 API；旧 `readDurable()` 暂时保留给明确可降级的兼容调用。

```ts
type DurableReadResult<T> =
  | { kind: 'missing' }
  | { kind: 'valid'; value: T }
  | { kind: 'corrupt'; reason: 'json'; error: string }
  | { kind: 'io_error'; error: string };
```

该层不理解 Goal、worker、continuation，也不把 schema invalid 判为 empty。

### 4.2 checkpoint 层：备份只保存已经接受的 generation

关键账本采用 `<name>.backup.json`。现有 primary durable commit 继续是 control transition 的唯一
ACK barrier；只有该 barrier 成功后，owner 才把同一已接受 snapshot 写成 recovery checkpoint。
backup 写失败不得把一个已经接受的 primary transition 重新解释成失败，否则会制造新的
“primary 已前进、live owner 却认为提交失败”的歧义窗口。

因此 backup 更新是可重试的恢复冗余，不授予 mutation authority。crash 可以合法留下旧 backup，
甚至留下 primary valid 而 checkpoint 缺失；恢复时 backup 只能作为候选，绝不能因 parse 成功
直接获得执行 authority。primary missing 也绝不能自动从 backup resurrection，因为 missing 可能是
一次已经接受的显式清空。owner 必须用独立 durable proof 判断 backup 是否 replay-safe。

### 4.3 owner schema 层：整份 snapshot 校验

每个 authority owner 提供 snapshot decoder/validator。
任何会改变 authority 的 row invalid，都把**整个 snapshot**判为 schema corruption，
而不是继续“跳过坏行、恢复其余行”。允许 repair 的字段必须是明确向后兼容、且不会扩大 authority 的字段。

### 4.4 recovery coordinator：协调，不接管 owner

新增独立 recovery coordinator，职责仅限：
- 记录 `ledger / failure class / primary-or-backup / owner domain`；
- 持有进程内 pause domain；
- 向 IPC/renderer 暴露可见 recovery incident；
- 允许 owner 在独立 proof 成立后声明 recovered；
- 禁止在 incident 未解决时自动 mutation/replay。

建议 domain：
`goal`、`agents`、`continuation`、`long-run`、`blocked-tools`、
`input`、`browser-command`。

coordinator 不直接调用 `restoreGoal*`、`restoreSwarm` 等，也不跨文件提交事务。

## 5. Backup 恢复规则

自动使用 backup 必须同时满足：
1. primary 确认为 corrupt，而不是普通 I/O failure；
2. backup JSON 与 owner schema 都完整有效；
3. owner 能证明 backup 不会授予比当前独立 durable evidence 更多的 mutation authority；
4. backup 中所有 send/dispatch/claim 状态维持原有 ambiguity，绝不降级成 `not-attempted`；
5. 恢复成功后先把安全 candidate 重新 durable，再发布 live state。

不能满足上述条件时：保持 primary 原样作为 forensic evidence，owner 进入 recovery pause。
用户可以看到原因，但系统不得自行“清空并继续”。

## 6. Failure matrix

| Failure | Rebuildable cache | Authority ledger | Backup handling | Required outcome |
| --- | --- | --- | --- | --- |
| 文件不存在 | empty/default | owner 明确允许的 first-run empty | 不读 backup 作为“历史 resurrection” | 正常启动或 owner-defined empty |
| truncated JSON | null/cache rebuild | corruption incident | 仅候选 | pause 或安全恢复，绝不 empty |
| malformed JSON | null/cache rebuild | corruption incident | 仅候选 | 同上 |
| schema-invalid snapshot | cache discard | corruption incident | backup 也必须过完整 schema | 不逐行丢 authority |
| primary corrupt + backup valid | cache 可直接 rebuild | owner replay-safety 决定 | safe owner 可恢复，否则 pause | 不自动重放 mutation |
| primary + backup corrupt | cache rebuild | manual recovery pause | 无 authority source | 显式可见、禁止自动执行 |
| backup stale | 忽略即可 | 默认不自动接受 | 必须用独立 proof/monotonic rule | 不复活已 retire/handled work |
| backup partial/truncated | 忽略 | 与 primary 双坏等价 | 不覆盖 primary | pause |
| I/O permission/error | cache 暂时 unavailable | 不等价 corruption/missing | 不擅自换 backup 绕过 I/O | pause/retry，保留证据 |
| restart during recovery | cache 正常 | 每次重新检测同一坏 primary | incident 可重复构造 | pause 不因重启消失 |
| old executor calls during incident | n/a | 必须拒绝相关 mutation domain | n/a | old executor rejection |
| ambiguous send/command | n/a | 状态保持 ambiguous | stale backup 不得改成 unsent | no automatic replay |
| recovery rewrite fails | n/a | live state不得提前发布 | backup 保持 evidence | 继续 pause，可重试 |

## 7. Owner-specific acceptance

- **blocked-chats**：corrupt 时最保守；在恢复前不能因为未知 block set 而允许 ChatGPT 本机工具。
- **agents/swarm + retired-workers**：统一进入 agents pause；未证明 current run/retirement 的旧 worker 不获工具。
- **continuation**：session metadata 仍是 A→B commit authority；可用于判定 `committing` 的方向，但不能凭它重造不存在的 send。
- **long-run**：缺 ledger 时 UUID-shaped orphan message 继续判 stale；corrupt 时所有自动 wait/owed continuation 停放。
- **Goal**：objectives/switches/replies 分账本保留 owner 边界；任一 authority ledger corrupt 时该 chat 的自动 Goal/Loop 不获得新发送权。
- **session-input / bridge-commands**：任何已 claim / attempted / dispatched uncertainty 都维持 fail closed，不把 backup 旧状态当成 resend permission。

## 8. 实施顺序

1. 先补 `durable.ts` 的 typed read 与 checkpoint primitives，保留旧 API 兼容缓存。
2. 新增纯 recovery coordinator 与 incident/domain 状态，不接任何 owner mutation。
3. 为关键 ledger 增加完整 snapshot validator；测试先证明 schema-invalid 不再被部分接受。
4. 启动路径改为 owner-by-owner 恢复，先恢复 fence/暂停，再开放 bridge/MCP。
5. 接入 renderer 可见 recovery 状态与明确人工处置文案。
6. 逐 owner 开放安全 backup recovery；不能证明 replay-safe 的保持 paused。
7. 补 restart、old executor、ambiguous mutation、backup stale/partial 故障注入。
8. 只运行受影响的定向测试与 typecheck；全部稳定后再决定是否需要一次最终全量 verify。

## 9. 首批验收测试

- `durable.test.ts`：missing / valid / truncated / malformed / I/O 分类；primary/backup barrier 与 stale backup。
- `blocked-chats.test.ts`：坏 primary 不等于 empty；restart 后仍拒绝工具；双坏保持 pause。
- `agents.test.ts`：swarm/retired schema corruption 不丢 authority；旧 worker 调用被拒绝。
- `continuation.test.ts`：corrupt WAL + session A/B/third identity；不从 backup 自动 resend。
- `long-run*.test.ts`：corrupt epoch/debt/wait；orphan UUID stale；restart 不消费 wait/dispatch budget。
- `goal*.test.ts`：三账本任一损坏不触发自动 draft/send；stale backup 不复活 handled reply。
- `session-input*.test.ts`：corrupt outbox 不变成空队列；ambiguous receipt 不 resend。
- `bridge.test.ts`：corrupt command ledger 不投递旧 command；session recovery 仅重建有独立 durable proof 的 recovery command。

完成标准不是“所有坏文件都自动修好”，而是：**没有任何损坏能被误解释成新的执行许可或不存在的任务债。**


## 10. 已实现的 owner 策略

当前独立分支已经接入三个 authority owner：

- **blocked-chats / blocked-tools**：primary 必须整份 schema-valid；corrupt、I/O failure、
  schema-invalid、以及 primary missing + backup surviving 都进入全域工具 recovery pause。
  backup 只作 evidence，不自动恢复用户撤销过的工具权限。
- **long-run**：primary 必须完整证明 execution epoch、work obligation、wait contract 的 lineage
  与 state consistency；损坏时 runtime polling、broker UUID delivery、execution ticket、
  MCP handler 与所有 mutation 都 fail closed。
- **continuation**：Compact & Resume WAL 先整份校验再发布；truncated/malformed、schema-invalid、
  primary missing + surviving backup、I/O failure 都进入 `continuation` recovery pause，backup 只作
  evidence，不自动复活 A→B transaction。`awaiting-chat/claimed/committing/committed` 必须保有
  durable handoff id 与非空 brief；不可能的 Send identity、重复 open session/source authority 整份拒绝。

Long-Run 明确保留旧字段兼容：缺失 `sourceRequestId`、`providerBudgetAt`、
`completionCheckClaimedAt`、`providerKey/providerData` 按既有保守语义归一化。
`wait_resolved/wait_failed` 的 `sourceTurnId` 不允许缺失/为空；`dispatching/queued`
的 `inputId` 必须是 durable v4 UUID。

合法的 stale terminal history 是例外：fulfilled/cancelled work 或 terminal wait 在 A→B carrier
迁移后可以留在旧 generation，因为旧实现本就不会把它们重新发布为 authority。
validator 会验证其时间/lineage 后丢弃这些历史行，而不是把合法快照误判为 corruption。

Stop 仍保持最高优先级：Long-Run recovery pause 不允许新执行，但也不能阻断 session/browser/
self-healing 的 Stop 撤权链。Long-Run 自身无法持久化取消时只记录告警，并继续保持 recovery pause。

Continuation recovery pause 同时冻结 owner mutation、MCP handler、Compact/Resume browser redeem/ACK、
自动 compaction、Goal/silence browser repair、Emergency Resume、tab reuse/close 与 attribution retry budget。
已存在的 resume browser command 只作为 inert custody 保留：restart/TTL 不删除，恢复前也不打开、
不 redeem、不 ACK、不重新 Send。普通 Stop 和与 continuation 无关的显式撤权仍保持可执行。

尚未接入 owner schema/pause 的关键账本仍包括 Goal 三账本、swarm/retired-workers、
session-input 与 bridge-commands；后续按同一原则逐 owner 推进，不共享 mutation authority。
