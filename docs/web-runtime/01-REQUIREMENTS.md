# 01 — Mission Contract / 需求与红线

## P0 必须同时满足

- 推理由真实 chatgpt.com 网页完成；使用用户正常登录的 Plus 账户。绝不将 Codex CLI/app-server、API Key、OAuth Responses、OpenRouter 或模型仿冒接口作为自动替代。
- Chrome Companion 扩展不再是必需依赖；安装/升级 CoS 不执行 chrome://extensions、Load unpacked 或扩展升级。
- CoS 独立拥有浏览器 Profile 与目标 Page；不点击主 Chrome、不调用 macOS 全局键鼠或 bringToFront 作为后台工作路径。
- 原始 CoS Classic UI、配置、Goal、Plan、Loop、Agent/Worker、MCP、会话、Durable、Stop、恢复必须保留；只替换浏览器运输适配层，唯一 Mission 权威。
- 不覆盖用户 Keychain、任务/注册项目/原 App/原 Profile，隔离开发 + 增量迁移 + 可回滚。
- 普通低风险授权提供可撤销的范围化“始终允许”；写入与破坏性操作仍受项目授权限制。不要每个只读小动作都重复询问。

## 安全和合规

禁止 Stealth/CAPTCHA/机器人检测绕过、额度绕过、换号自动轮转、ChatGPT 未公开私有接口、Cookie 导出、模型回复的 RUN/FILE 直接调用 shell。Plus 额度不保证无限工作；如果 ChatGPT 网页拒绝自动化或模型限流，进入 WAIT/REVIEW 并提示真实原因，不规避限制。

## 持久性与恢复不可违反

1. Mission ID 本地持久，不能用浏览器标签页 ID 代替。
2. 一项任务一个权威 Goal/Worker 状态机、一个自动续轮所有者。
3. 任一 Worker 只能访问自己已验证的对话绑定和项目权限。
4. 发送前 WAL；点击可能已发生时不能盲目重发；丢失 ACK 不等于请求失败。
5. 用户 Stop 和 Worker 代次 fence 高于所有后台循环。
6. Offline != 模型失败；429 != 登录过期；Chrome DOM 变化 != 已完成。
7. Reply、MCP tool receipt、checkpoint、最终验收互不替代。
8. 任何浏览器实现更换，都不能破坏原生聊天、设置和任务管理。

## Done 的严格定义

不需要 Chrome 扩展安装；App 连续五次升级保留登录 Profile；独立后台网页实测不抢桌面；一条完整的旧版 Goal→真实 ChatGPT 网页→MCP 工具→checkpoint→finish 流程成功；两个真实独立 Worker 不串线；Stop、429、网络断连、重启后不重复副作用；App 安装、设置、Git/GitHub/MCP 的旧功能通过对照清单。
