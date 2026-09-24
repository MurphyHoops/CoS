# CoS 3.1.1 代码审计整改实施记录

日期：2026-09-24

基线：`MurphyHoops/CoS@641347a61a2933112de9671b2bf16b6599b0d55d`

输入审计：`docs/code-audit-development-plan-2026-09-24.zh-CN.md`

## 1. 基线对账

整改开始时本地 `Cos 2` 目录包含完整源码，但 `.git` 没有提交历史。恢复网络后执行 `git fetch origin --prune`，确认 `origin/main` 正好为审计基线 `641347a`；随后逐文件比较远端树的 590 个跟踪文件，本地缺失 0、内容差异 0。工作树因此可以安全接回 `origin/main` 历史，审计报告继续作为新增证据文件保存。

这也修正了审计报告中的一项证据限制：最终 `verify:privacy` 将在真实远端 Git 历史上运行，而不是在 0 commits / 0 tags 的归档仓库上运行。

## 2. 已实施整改

### P1-A：Settings 过期前态与跨账本副作用

`settings:save` 不再在配置串行器之外捕获 `before` 后继续执行控制副作用。所有依赖前态的操作都进入 `updateConfig(..., afterPublish)` 的同一串行操作，并使用该次提交真实的 `previous/published`：Goal draft 退役、master Off 清理、MCP surface 失效、worker pause/persist、bridge 生命周期、Desktop publication、插件刷新和登录启动项都不会被后到的保存越过。

Master Off 使用 durable Goal-switch/reply 清理；从 Off 再切 On 时，在发布 On 配置之前先跨过同一 durable barrier，确保前一次失败或仍在排队的清理不会在 On 之后重新落盘。新增竞态测试真实暂停 `goal-switches.json` 的原子 rename，并交错 Off→On；On 在 Off 的清理落盘前不能完成，旧 per-chat override 最终不会复活。

同一个恢复原则也应用到 multi-agent：Off 会先把 worker authority 收紧并持久化；如果该持久化失败，配置已经是 Off，但下一次 Off→On 在发布 On 之前必须再次 `persistAgentAuthorityNow()`。故障注入覆盖了 `ipc-swarm.json` 第一次 rename 失败、随后 re-enable 和模拟 restart，旧 active run 不会从磁盘复活。

浏览器设置入口也使用相同前向恢复语义。全局 Goal Off 的 reply retirement 在重复 Off 上保持幂等，Off→On 先补齐失败的 reply tombstone；auto-compaction Off→On 先重新执行 durable cancellation，避免上一轮 Off 的待取消 ticket 在重新启用后恢复。

### P1-B：Goal/Loop 可见状态与 A→B 投影

Goal objective、per-chat switch 和 reply acceptance/move 改为 owner 内串行的候选快照：先构造不可见 candidate，`writeDurableNow` 成功后一次性发布 Map。写失败时 live state 保持此前已接受值，并用该权威快照覆盖 durable writer 保留的失败 generation，避免失败写在后台重试后反向出现。

Goal reply ledger 的 production durable writers 现在共用 `serialGoalReply`：accept/move、provider pause/resume、ACK retirement、显式 On/Off、silence withdraw/defer、master Off、rebind retirement 都不会再对同一 whole-file snapshot 并发写入。revocation 路径仍可先收紧 live authority，但失败后会把同一个保守快照保留为待收敛 generation。

Master Off 是收紧权限的例外：先把 live switch 投影收紧，再等待 durable write；失败时保持收紧状态并重试同一个安全快照。这样 UI 不会收到虚假成功，同时并发 bridge eligibility 也不会继续使用已撤销的 override。

普通 Compact & Resume 的 session metadata 仍是 A→B 主提交。提交后，Goal objective/switch 通过各自 owner 的 immediate durable barrier 向 B 收敛，并在 WAL 完成前把 A 的旧 Goal reply debt durably retire；任何一个 secondary ledger 失败时 continuation WAL 保持 `committing`，重启/重试只向 B 前进，不把已经提交的 session 回滚到 A。reply retirement 的 retry 即使 live tombstone 已经是 handled，也会重新跨过 durable barrier，不能因为“没有新的内存变化”提前提交 WAL。

历史 resume-shadow repair 也改成 durable target-wins projection：同一旧 run 存在时先同步修复 broker ownership 以 fence B，再由 Goal owner 将 A 的 objective/switch/reply 持久收敛到 B；如果 B 已有更新状态则只删除 A 的 stale projection。live Prime 已先到 B 也不能作为 durable ACK：重试会重新跨 broker fsync barrier。无 Goal/workspace/switch/reply 残留的纯 broker 场景则由 broker owner 的 pending critical revision 阻止过早返回，直到该 A→B revision 真正持久化。

`continuation.test.ts` 以前没有初始化 durable store，导致该文件里的 `writeDurableNow` 实际是 no-op；测试夹具已修正为真实临时 `state/`，并覆盖 Goal projection 中途失败、reply-retirement 写失败、legacy switch 写失败后的 forward recovery。

### P1-C：Block/Release 的 durable ACK 与删除顺序

`setChatBlocked` 现在由 blocked-chats owner 自己串行化，并把返回 Promise 作为真正的 ACK 边界。Block 在写盘前先收紧 live fence，写失败时仍保持 blocked 并重试同一个保守快照；Release 先把 removal 持久化，再移除 live fence，失败时继续保持 blocked，并用当前权威快照覆盖 durable writer 可能保留的失败 generation。

`sessions:block` 会等待这个 durable barrier 后才向 UI 报成功。删除 session 时也先完成 durable Release；若 Release 失败，session row 和 recorder binding 都保留，用户仍有同一入口可重试。

### P2-D：首次窗口显示不再拥有浏览器打开权

首次 `BrowserWindow.show` 在模型目录 unknown 时仍可做被动发现，但只调用 `startChatModelDiscovery(false)`。窗口显示本身不会创建 ChatGPT tab；显式 Refresh 和真实输入投递仍按各自操作持有 `allowOpen` 权限。对应 window lifecycle 测试断言首次 visible discovery 的参数为 `false`，重复 show 与退出路径不会重复触发。

### P2-E：保留为独立 recovery / transaction 设计

只读架构审计确认，当前 `durable.ts` 仍把 read/parse failure 折叠成 `null`，而多个 authority-bearing ledger 的 restore 会把 null 当成空状态。现有 provider transport suspension 与 recovery fence 都不是控制账本损坏的统一恢复边界，直接复用会混淆各 ledger 的 owner 语义。

安全实现需要先把 durable read 改为可区分的结果（missing / valid / corrupt / I/O failure），再由各 owner 明确决定严格校验、备份恢复、人工暂停与可重建缓存策略；关键账本还要补截断 JSON、非法 schema、备份恢复、旧执行者拒绝以及“不得重放 ambiguous mutation”的恢复测试。因此 P2-E 作为单独 transaction/recovery 项目继续设计，不在当前整改补丁中仓促落地。

### P2-F：原审计项撤销

复核真实 `641347a` 基线后确认，Recording Off 不是当前产品状态。`config.ts` 会把 legacy `record` / `retainDays` 输入统一规范成 `record: true`、`retainDays: 0`，相关 config 测试已经覆盖保存和重载。此次只修正规范文字，不为不可达的 Recording-Off 状态增加新的 Goal gate。

### P2-G：规范与源码重新对齐

`AGENTS.md` 已删除不存在的 `session/retention.ts` 路径，明确历史记录没有按年龄自动裁剪，并更新 §21：startup model discovery 已是 passive、repair handout 需要 exact claim、Goal durable publication 已修正，剩余跨 ledger 问题按 forward-recovery transaction 处理。`mcp/surfaces.ts` 注释也从“两种 surface”修正为 Core、Desktop、Plugins 三种。

新增 `test/repository-map.test.ts`，扫描 `AGENTS.md` 中显式列出的 `src/*.ts` 路径并要求它们真实存在，防止同类路径漂移再次静默出现。

## 3. 验证记录

整改相关的定向回归先覆盖 `ipc`、`goal`、`continuation`、`blocked-chats`、`bridge`、输入投递、MCP/code-mode、window lifecycle 与 repository map：10 个测试文件共 1,047 passed、12 skipped；随后 `typecheck` 通过。P2-F 纠正后额外运行 `config` + repository map，59/59 passed。

Prime 只启动了一次全量 `npm run verify`。历史隐私检查在真实 Git 历史上通过（296 commits、1 tag），notices 校验通过（92 个生产包、7 个 catalog 条目、730 个 native source archive/patch），typecheck 通过。主 Vitest 执行到结束时为 183 个文件通过、13 个文件跳过、4,712 个测试通过、129 个跳过；唯一失败是 `packaging.test.ts` 仍搜索整改前的 `next.ui.theme` 源码字符串，而生产实现已改用 config serializer `afterPublish` 的权威参数 `published.ui.theme`。

该契约测试随后更新为检查 `published.ui.theme`，并与 `ipc.test.ts` 定向重跑：102/102 passed；独立的 `mcp-shutdown.test.ts` 2/2 passed。`git diff --check` 与 `npm run typecheck` 再次通过，`npm run build` 成功生成 main/preload/renderer bundle。Vite 仍报告审计时已经记录的两项 dynamic-import/static-import chunk 提示，没有新增 build failure。

全量 verify 后的只读复审进一步发现并修复 transaction 边界：multi-agent failed Off→On、normal rebind reply retirement、Goal reply whole-file serializer、legacy resume-shadow durable repair，以及 broker/Long-Run/Goal 的跨账本发布顺序。最终顺序固定为 session 主提交后 `broker durable → Long-Run durable → Goal/Loop durable → rebuildable projection`；任一 barrier 失败都让 continuation WAL 保持 `committing`，重试只向 B 收敛。最新 `continuation.test.ts` 83/83 passed，`long-run.test.ts + long-run-runtime.test.ts` 35/35 passed；四个精确故障窗口回归（broker fsync、Long-Run fsync、legacy same-process retry、pure-broker pending revision）4/4 passed。worker-4 对原两个 ordering blocker 复审 CLEAR，worker-3 对最后 pure-broker gate 与并发 revision/owner 语义复审 CLEAR。

所有源码和测试修复完成后，Prime 按约束只启动了一次**最终** `npm run verify`：`verify:privacy` 在真实 Git 历史上通过（296 commits、1 tag），`verify:notices` 通过（92 个生产包、7 个 catalog 条目、730 个 native source archive/patch），typecheck 通过；主 Vitest 为 184 个文件通过、13 个文件跳过，4,722 个测试通过、129 个跳过；随后独立 `mcp-shutdown.test.ts` 2/2 passed。整条命令 exit code 0。最终 verify 后仅追加本段证据记录，源码与测试未再修改；`git diff --check` 仍通过。

本记录证明源码、自动测试、完整 Git 历史隐私门禁和本机 production build；它不替代打包安装后的 GUI、Windows/Linux 原生路径或真实 ChatGPT 页面实机验收。
