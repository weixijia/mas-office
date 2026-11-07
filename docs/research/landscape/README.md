# MAS Office 竞品与参考项目调研（2026-11）

这个目录存放为下一阶段开发方案做的 GitHub 项目调研。每个类别一份笔记，本文件是共同的背景、模板和索引。

- 本地克隆（不入库，`.omc/` 被 git 忽略）：`references/repos/<owner>__<repo>/`
- 抓取的文档页（不入库）：`references/docs/`
- 上一轮定位讨论稿：[`../positioning.zh-CN.md`](../positioning.zh-CN.md)

## 1. 我们要做的东西（调研的判断标准）

**一家看得见、管得住、会互相把关的 AI 公司。**

- 每个 agent 是一个真实的官方 coding agent 会话：Claude Code 或 Codex，用户用自己的订阅登录。
- 组织是浅层的树状结构：CEO / Lead → 角色，最多再加一层组长。组织由用户设计并锁定，每个岗位单独设定工具和权限。
- **CEO 听所有员工的结构化事件流**（不听原始终端输出），据此派活、重新分配、汇总。
- **像《模拟人生》加 RTS 那样管理公司**：
  - 等距办公室里实时看到每个小人在做什么、和谁交接、谁举旗。
  - 点一个小人，打开它的侧边抽屉：实时记录、进度、它的产出；有聊天框，消息直接送进它背后的会话，可以追问，也可以派下一个任务。
  - 某个会话卡住（等待审批、需要人决定）时，小人举手，同时进入"需要你"收件箱，在界面里批准、拒绝或回复。
  - 原始终端窗格保留，作为"可观看、可接手"的视图。
- **多模型协作以分工为主**：一家写、另一家在干净上下文里审；研究类任务里，finder 并行、checker 独立核对，所有结论挂到 A–D 分级的证据卡上。
- **以 HCI 为设计依据**，降低理解、调用、设计、管理多 agent 系统的门槛：human supervisory control（fan-out、neglect tolerance）、situation awareness、management by exception、span of control、direct manipulation。
- 技术栈：TypeScript 写编排和界面，Python 写 SDK 集成和评测。协议从单向（agent → 面板）扩展为双向（面板 → agent：发消息、批准 / 拒绝、派任务）。

## 2. 现有基础与 roadmap

- **已有**：
  - 协议 0.1（events.jsonl → 确定性 reducer → snapshots）
  - JS / Python SDK
  - CLI：`serve` 带 SSE，`hook claude-code`
  - 等距办公室面板，带结果抽屉
  - no-code kit：Lead 设计并锁定团队，角色作为 subagent 运行，支持追问轮次
  - 角色浏览器
  - Claude Code 状态行
- **roadmap**（`ROADMAP.md`）：
  - M0：评测，以及 `claude -p` / `codex exec` 后端
  - M1：`mas run` 调度、每个角色单独的 harness、checker 返工、resume
  - M2：MCP server，让任意 agent 都能当 Lead
  - M3：终端版界面，加可操作的面板
  - M4：桌面 app

  本轮调研要回答的是：哪些可以借用或集成，哪些必须自己做，执行顺序怎么调。

## 3. 调研要回答的核心问题

1. **会话控制**：如何启动、驱动、恢复一个 Claude Code / Codex 会话；如何检测它卡住或在等审批；如何把用户的话送进去；如何拿到结构化事件。各项目用的是 tmux 发键、PTY、SDK、app-server、ACP 还是 hooks？
2. **层级与协调**：CEO / Mayor 怎么分派任务、怎么收集结果、怎么保存状态（git、数据库、文件）；冲突和合并怎么处理。
3. **界面与交互**：怎样可视化多个 agent，能否点进单个 agent 聊天或审批，怎样处理"需要你"的事件，渲染用的什么技术。
4. **团队与流程定义**：角色、SOP、权限分别用什么格式定义（代码、YAML、Markdown、自然语言）。
5. **质量与核对**：有没有 reviewer / checker / 投票 / 引用核对，怎么实现的。
6. **可复用性**：license 允许借用代码还是只能借鉴思路；项目是否活跃。

## 4. 单个项目的记录模板

```markdown
### <owner>/<repo>

- 链接 · ⭐ stars · license · 主要语言 · 最近提交日期 · 本地克隆：`references/repos/<owner>__<repo>` @ <short sha>（未克隆则写原因）
- **一句话**：它是什么、给谁用。
- **架构要点**：会话怎么控制，层级和状态怎么组织，界面怎么做（引用它仓库里的具体文件路径）。
- **和我们 roadmap 的关系**：对应哪一项（会话控制 / CEO / 办公室交互 / 收件箱 / 团队设计 / 核对 / 协议 / 评测）。
- **值得借鉴**：具体到文件或机制。
- **不足 / 我们的机会**：
- **复用判断**：可直接用代码 / 可作依赖 / 只借鉴思路（受 license 或架构限制），以及理由。
```

所有事实都写明来源；无法从一手来源（仓库代码、官方文档）确认的，标 *(unverified)*。

## 5. 笔记索引

| 文件 | 类别 |
|---|---|
| [`01-orchestrators.md`](01-orchestrators.md) | 终端 / CLI 多 agent 编排器与"公司"层级 |
| [`02-session-control.md`](02-session-control.md) | 双向会话控制、后端与远程客户端 |
| [`03-visualization.md`](03-visualization.md) | 可视化、游戏化与交互界面 |
| [`04-frameworks-research.md`](04-frameworks-research.md) | MAS 框架、公司 / SOP 比喻、研究与核对型 agent |
| [`05-protocols-hci.md`](05-protocols-hci.md) | 协议标准与 HCI / 管理理论文献 |
| [`SYNTHESIS.md`](SYNTHESIS.md) | 综合：借用 / 集成 / 自研清单与 roadmap 调整建议 |
