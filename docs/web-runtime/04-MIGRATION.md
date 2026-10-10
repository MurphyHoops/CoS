# 04 — 旧版到新 Adapter 的逐模块迁移

已验证旧版和当前 Next 均保留 src/main/{goal.ts,agents.ts,browser-control.ts,browser.ts,computer/index.ts} 的相同源代码；当前 Web-First 并未接入完整旧功能。

| 模块 | 决策 | 说明 |
|---|---|---|
| src/main/index.ts 与 src/renderer/* | KEEP | 原聊天、设置、工作区及现有 IPC |
| src/main/goal.ts、goal-recovery.ts、durable.ts | KEEP | 唯一任务/完成权威，剥离浏览器唤醒依赖 |
| src/main/agents.ts、agents-recovery.ts | KEEP | Worker 身份、队列、消息与 ACK |
| src/main/session/{continuation,long-run,store,self-healing,input,start-input}.ts | KEEP+ADAPT | 单续轮所有者、Stop、离线等待、恢复 |
| src/main/mcp/{tools-core,tools-plugins,tools-browser,tools-desktop}.ts | KEEP+ADAPT | 原工具目录、scope，browser 后端改走新 Runtime |
| src/main/{bridge,browser-control,browser-wake,browser-preferences,plugin-refresh,ipc}.ts | ISOLATE | Chrome Companion 相关部分封装为兼容层，替换新传输 |
| src/main/next/runtime/classic-main.ts | PREFERRED ENTRY | 先还原完整旧版体验，防止新简化工作台替代它 |
| src/main/next/web-first/{web-outbox,native-web-input,web-reply-observer,host-session-diagnostic}.ts | SELECTIVE REUSE | 保留数据保护、回执和 DOM 验证逻辑，不带上层 Goal 重写 |
| src/main/next/web-first/{agent-roster,goal-workbench,approved-web-goal-loop}.ts | EXPERIMENT | roster 本身明确不启动 LLM；不能视为经典 Agent 替代 |
| extension/* | REFERENCE/ROLLBACK | 现代 DOM 定位可参考，最终生产不依赖安装插件 |

迁移顺序：先建无插件 Driver 端口及测试；再用独立 BrowserOwner 验证真实页面；再做 MCP A-B-A；然后接 Classic Goal/Agent；最后双 Worker + 崩溃/限流/Stop/升级，逐项取消旧 Chrome Companion 在 Next 的必选依赖。

绝不把 CCCC 整套 Rust Daemon 和 CoS 内核同时作为任务权威。CCCC 的 Web Runtime 模块是借鉴的运输协议，而不是新的 Mission Store。

## GitHub main v3.1.5 verification supersedes local version labels

Upstream main aa50d8d has same exact goal.ts/agents.ts/browser-control.ts/mcp/tools-browser.ts/extension/browser-control-page.js blobs as local Next 4e204ed, even though package.json in Next says 3.1.16. Keep original main semantics and selectively integrate audited Next fixes to bridge/continuation/input. See 09-UPSTREAM-MAIN-AUDIT-20261010.md.
