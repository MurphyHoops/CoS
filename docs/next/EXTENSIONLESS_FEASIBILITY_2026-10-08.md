# CoS 3.1.16 无浏览器插件可行性实测（2026-10-08）

**性质：** 只读产品/架构实验 + 现有测试执行；不开发新运行时代码，不更改已安装 App、系统权限、Chrome 扩展、用户数据、现有任务。
**工作分支：** `next/v4-chatgpt-first-design`。
**实机：** macOS，已安装 `/Applications/Chat On Steroids.app`，版本 3.1.16，`com.chatonsteroids.app`；Chrome `154.0.8037.98`。
**安全边界：** 现有 Chrome 扩展仍处于用户使用环境，未禁用它；以下为**真实 MCP 调用与源码依赖分析**，不是“完全拔掉扩展后的端到端通过”证明。

## 1. 实验结果（精确区分执行与身份）

| 试验 | 实机观测 | 结论 |
|---|---|---|
| CoS Core `exec_command`，显式工作目录 | 执行 date、版本检查、Git 状态成功，退出码 0 | 终端路径可以经官方 MCP → CoS 核心直接调用，不依赖扩展进行操作 |
| 原生 Desktop `observe({what:'windows'})` | 返回 Chrome 窗口列表 | macOS 窗口枚举与扩展控制通道分离 |
| 原生 Desktop `observe({what:'ui', window:174})` | `ACCESSIBILITY_PERMISSION_REQUIRED` | 操作系统 UI 控件不具备当前授权；不可以声称已实现无扩展的完整图形操作 |
| `agents({action:'status'})` | `WORKER_IDENTITY_LOST`；一次重试仍拒绝 | **多 Agent 当前不能在未证明源对话时安全地管理** |
| `session_wait({action:'status'})` | “Exact durable session and conversation identity are required…” | 长任务自动续跑控制不能仅靠未归属 MCP 调用 |
| `project_runtime({action:'status'})` | “Exact durable session and conversation identity are required…” | 机器完成谓词绑定项目需要精确任务/对话身份 |
| Bridge／browser tool 源码审计 | `src/main/browser-control.ts` 需要浏览器扩展客户端；无客户端返回未派发／权限错误 | **现有 background DOM、tabs、network、console 控制依赖 Chrome Companion** |
| 控制测试 | `browser-control.test.ts`、`kernel-desktop-identity.test.ts`、`long-run.test.ts`、`attribution-repair.test.ts`：4 个文件、42 个测试全部通过 | 既有逻辑回归绿色，**不是**扩展已关闭的产品验收 |
| CoS 运行日志（过滤后） | 多次 `no page evidence` 及 `Unattributed`，和代理、长任务拒绝相互印证 | 已有扩展也未能为本次 ChatGPT 对话建立可信映射 |

运行配置仅读取不修改：`autoConnect=true`、`multiAgent.enabled=true`、`allowUnattributedCalls=true`、`selfHealingSessions=true`，目录授权数量 3。**这解释了为什么匿名普通终端可执行，但身份敏感管理操作仍拒绝。** 不能把“普通工具成功”误认为“任务归属已解决”。

## 2. 插件的真实边界
- **可以完全不依赖扩展运行的部分：** CoS Core 的绝对路径文件操作、显式工作目录终端、许多确定性构建/测试、本地会话存储本身、原生桌面窗口枚举以及经 ChatGPT 提供的 MCP 接入。
- **独立于扩展但尚有权限/接口缺口：** macOS UI 自动化（目前被系统 Accessibility 拒绝）；权限配置、原生 Goal/Loop/会话管理的 MCP 功能覆盖不完整。
- **现有代码强依赖扩展：** `browser_tabs`、后台 DOM/网络/Console/按元素操作（Chrome Companion Bridge），ChatGPT 网页请求 ID/对话 ID 观察、Provider 聊天发送/接收确认、Compact & Resume 页面内交付、Self-Healing 的网页代理接力与部分 worker 投递。
- **MCP 本身不能确保：** 获取浏览器 ChatGPT 会话 UUID、读取聊天隐藏历史、代替网页用户发起下一轮思考、无人值守地推进官方 ChatGPT 网页对话。不得把工具请求的传输 ID 误称为原生 ChatGPT 对话身份。

## 3. 无扩展的替代方案：能替换什么，不能替换什么

### 官方 Chrome DevTools MCP（优先评估普通网页控制）
Chrome >=144 支持 `chrome-devtools-mcp --autoConnect` 附着到正在运行的 Chrome；用户需要打开 `chrome://inspect/#remote-debugging` 并在 Chrome 许可弹窗授权。当前是 Chrome 154，版本门槛满足，但**本次未启用远程调试、未请求高权限附件，也未进行官方 CDP 实机握手**。
- 优点：可在用户批准后对现有 Chrome 会话进行开发者工具级别的调试/DOM/网络访问，无需专有 CoS 扩展。
- 局限：调试权限很宽，可访问整个浏览器 Profile；需要最小权限/敏感标签页排除/审计/用户同意；不构成 ChatGPT 原生对话任务归属凭据。不要为本测试新建浏览器或触碰用户现有 Chrome 扩展。
- Chrome 136 起不能仅给默认 Chrome Profile 添加 `--remote-debugging-port` 达成老式方式；优先采用官方 144+ 有用户授权的 attach 方式，或隔离 Chrome for Testing。
- 官方： https://developer.chrome.com/docs/devtools/agents/get-started/configuration ; https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session ; https://developer.chrome.com/blog/remote-debugging-port

### macOS 原生 Accessibility/Screen Recording
- 与扩展独立，已证明可以枚举窗口；更深的 UI 控件访问缺少系统权限。即使授权，也不直接等价后台单标签页 DOM/网络诊断，也不能供 CoS 安全“猜”ChatGPT 消息 ID。

### 官方 ChatGPT MCP
- 用户继续在 ChatGPT 网页推理，MCP 将本地执行工具交给 CoS。默认不使用另外付费 API；网页端并非无限额，必须尊重其真实使用限制。
- 最值得保留的方案；**必须显式定义 mission_id、作用域、执行租约与确认机制**，不能用猜测的网页对话身份。
- 不支持由 CoS 后台凭空发起网页 ChatGPT 推理回合。对续跑需要支持的宿主触发，或用户回到网页，或独立获得授权的模型运行时；不要把无限自动发送 ChatGPT Web 作为目标。

### 本地独立推理运行时（可选）
- 官方许可的 Codex app-server / eligible Sign in with ChatGPT 作为另一路模型引擎（需要资格/配额核验）。与原生网页聊天的 transcript 不共享，不暗示订阅无限额或没有任何限制。
- 默认不得自动购买 API 额度，也不得通过浏览器自动化规避提供商限制。

## 4. 重新判定的工程方向（基于结果，不是先验假设）

**结论 A（成立）：** 优先把 CoS Core 改造为 ChatGPT-first、extension-optional 的本地任务执行引擎；普通读取、代码、构建、Git 等工具无需专有扩展。
**结论 B（未成立）：** 目前不能移除 Chrome Companion 后仍保证现有多 Agent、session_wait、project runtime、网页自动续跑与精确归属全部可用。
**结论 C（可实施但未验证）：** 普通非 ChatGPT 网页控制用官方 Chrome DevTools MCP 替换部分 Chrome Companion 能力，并配合 macOS 桌面原生驱动；必须另外实现显式、可信的 CoS Mission API。
**结论 D（产品边界）：** 自己掌控的 CoS 任务持久性可以不依赖 ChatGPT 网页；“原生 ChatGPT 对话自动复活/自动继续推理”在不支持的宿主接口下不保证，不得宣传为已实现。

建议先创建**extensionless capability parity gates**，按“真实无扩展、至少两个 ChatGPT 对话、一个长任务、一个权限拒绝、一次重启、一次归属冲突、一次 Stop”全面审计，作为删除扩展依赖的必要条件。**旧 CoS 3.1.16 的扩展与 GUI 在这些 Gate 达标前必须保留。**

## 5. 下一组安全验证（需要另行开展，本轮未授权扩大当前浏览器调试权限）

1. 创建独立的 Chrome DevTools MCP 授权测试窗口/场景，Chrome 154 用户明确准许后，证明无 CoS Companion 的 tab/DOM/network 基本功能、观察权限边界、拒绝机制和安全隔离。
2. 在独立 CoS 数据目录与测试进程中断开 Companion，完整执行 Core 文件/终端及任务管理测项，比较失败代码；不得影响目前已安装软件及用户会话。
3. 以 ChatGPT MCP 官方可证来源为准审计调用者身份是否可信。若无原生对话 ID，建立显式授权 session lease/mission gate 并测试并行两个聊天跨租约冲突。
4. 在无网页自动发送的情况下验证 CI 等待、进程结果收集与本地任务恢复，明确“本地恢复”与“自动续写 ChatGPT 网页”是不同承诺。
5. macOS Accessibility/Screen Recording 权限的手工授权与纯读测试；未经用户明确同意不改变系统设置。

## 6. 本轮变更与验证的保护边界
- 未禁用 Chrome Companion；未启用 Chrome 远程调试；未请求敏感 Chrome Profile 的 DevTools 授权。
- 未更改 `/Applications/Chat On Steroids.app`、CoS config、授权目录、密钥、项目业务代码或正式用户数据。
- 原 CoS / CoS Next Git worktree 分离。本实验结论是**安全可行性预审，不是无扩展产品验收**。
