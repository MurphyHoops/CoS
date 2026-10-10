# 05 — 开发阶段与测试/发布门禁

证据级别：L0 只有文档；L1 类型检查与单测；L2 实际打包 Electron/Chromium 离线集成；L3 真实 ChatGPT 网页与远程 MCP 收据；L4 旧版完整产品等价和长期异常注入。不能用“几千单测通过”替代 L3/L4。

## G0 — 治理与状态对齐

只读核对所有旧工作树、Git、运行 PID、已安装包、真实用户 Profile；创建独立开发工作树，保留原有数据，不清理 dirty 文件。完成目录、任务范围、接口与验收标准。

## G1 — 纯运输协议

实现纯状态机、验证器、profile lease / 页面归属端口。覆盖错误 Actor、代次变更、两个并发 Claim、未授权目标、模糊发送、重复 ACK、Stop、崩溃前后不同状态。所有测试无真实账号、无需联网。

## G2 — 真正后台浏览器

固定临时测试 Profile，启动实际受管 Chrome/Chromium，离线页面点击、输入、滚动、观察和截图；断言用户当前前台窗口及鼠标键盘焦点不变化；关闭重启至少三次；PID/锁/崩溃恢复可靠。只借鉴 CCCC BrowserOwner，无扩展、无 Stealth。

## G3 — 真实网页一次往返

明确批准后使用独立 Plus Profile 登录，创建一条无项目秘密的 ChatGPT 新对话，精确用户消息回执、真正新助手回复、网页完成状态；打开有草稿/切换对话/登录过期时应 HOLD。普通重启仍登录。网页反自动化限制出现时暂停，禁止绕过。

## G4 — 可信 Connector 与 Actor 路由

一个共享 HTTPS MCP Connector，配对 nonce 和 MCP 收据，再与绑定网页对话核验。真实 A→B→A，代次切换、旧 Actor、缺失 meta、撤销授权全部拒绝；用户项目只由已有 MCP 权限访问。

## G5 — Classic 完整真实 Goal

从旧 UI 创建 Goal/Plan，分配真实 Worker，在网页执行，并经已有 MCP 完成一次授权本地读、写、测试，保存 checkpoint 和 finish-request；无第二套任务状态，旧 UI 设置持久保留。

## G6 — 多 Worker / 异常恢复

至少 Builder/Auditor 两个实际独立网页对话，不串任务、工具、收据；Stop 单 Worker 不影响另一位；模拟断网、限流、隧道重连、App 重启、浏览器崩溃、投递中断；不重复不确定副作用。低频 24h 本地 Supervisor 稳定性测试，不虚构 Plus 无限额度。

## G7 — 发布

连续五次升级程序、零次重装 Chrome 插件，Profile/任务/设置均保留。实机包与 Git SHA 匹配；CI 成功，回滚保留旧 App。直到 L4 实际通过才宣称“完整替换旧 CoS”。本地测试优先，未通过不推云端。

执行日志只记录标识摘要、状态、时间、版本、错误类型；不输出 Cookie、Prompt 全文、模型原文、认证密钥。每一个 PASS 附确切测试命令、日志、SHA、运行设备和测试账号授权范围。
