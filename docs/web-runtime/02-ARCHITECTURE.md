# 02 — 架构、目录与职责

## 逻辑拓扑

CoS Classic UI（聊天/设置/Goal/Plan/Agent）⇄ Classic Mission Kernel（goal.ts/agents.ts/session/*/durable.ts）⇄ **ChatGPTWebRuntimeAdapter**（仅传输）⇄ Browser Supervisor（独立 Profile；Actor→Page Target 映射）⇄ 真实 ChatGPT 网站。

ChatGPT 通过 HTTPS 的单个已认证 MCP Connector 调用 CoS Core/Plugins/Desktop；本地 Connector 对会话与 Mission Grant 联合校验。Browser Delivery（发消息）与 MCP Return（操作本地）是两条不同路径。

## 计划中的源码目录

~~~text
src/main/web-runtime/
  contracts.ts             # Turn/Actor/Page/Delivery typed protocol
  profile-owner.ts         # Exclusive lease, pid/start-time verification
  browser-driver.ts        # CDP driver boundary, allowlisted page actions
  supervisor.ts            # Owned browser lifecycle, health, stop
  page-registry.ts         # Per-Actor stable page target, generation fence
  chatgpt-dom.ts           # Versioned webpage probes, Classic selectors
  delivery-state.ts        # Pure persisted outbox transition rules
  delivery-worker.ts       # Single-flight per Actor, exact echo receipt
  reply-observer.ts        # Unique assistant turn and settle proof
  pairing.ts               # MCP ↔ web Actor binding protocol
  connector-routing.ts     # Authenticated connector/session correlation
  cooldown.ts              # Quota, 429, auth, offline typed waits
  recovery.ts              # WAL reconcile, no blind replay
  adapter.ts               # Legacy BrowserDeliveryPort implementation
  diagnostics.ts           # Privacy-preserving local status
src/main/next/runtime/classic-main.ts # Existing Classic UI entry
src/main/{goal,agents,durable,bridge,browser-control,browser-wake}.ts # Existing core
src/main/session/*, src/main/mcp/* # Existing durable and MCP stack
test/web-runtime/          # Unit, fake-CDP, packaged offline, fault tests
docs/web-runtime/          # This contract + current state
~~~

这里是**目标目录**：只为已实际实现的模块创建源文件，不提前创建空壳工具或重复的 Goal 内核。

## 本地运行数据目录（例子，最终经 app.getPath(userData) 确认）

~~~text
~/Library/Application Support/chat-on-steroids-next/
  browser-runtime/
    profile/                # 升级不删除的独立 Chromium 登录目录
    profile-owner.lock      # 单持有者锁，0700/0600
    owner.json              # PID、进程创建标识、执行代次
    actor-bindings.json     # 经过验证的绑定，不包含原始 token
    delivery.jsonl          # 发送/回执/状态 WAL
    recovery.json           # 断线/停止/配额等待、最后代次
    logs/                   # 轮转脱敏日志
~~~

Profile 绝不放进 .app、Git 或临时发布目录；不得与用户普通 Chrome 的 Profile 共用；同一 Profile 同时只能由一个 CoS BrowserOwner 运行。系统只有一个活跃 Core Tunnel。登录窗口只在用户请求时显示，隐藏页面投递不聚焦。

## 运行进程约束

UI 可以退出，但 Runtime 状态必须可靠持久；普通软件升级替换程序文件时保留 Browser Profile。Chrome Runtime 子进程由 Supervisor 独占，回收必须验证 PID、创建身份、Profile 路径，不能误杀主浏览器；Actor 对话由 TargetId 选择，不能由“当前活动标签页”选择。
