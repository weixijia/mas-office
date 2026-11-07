# 综合：借用 / 集成 / 自研清单与 roadmap 调整建议

- 日期：2026-11-07。这份是 01–05 五份笔记的综合；具体事实、文件路径和来源以各笔记为准。
- 规模：读了约 90 个项目和规范，其中 70 个仓库浅克隆到 `references/repos/`（6.6 GB，不入库），66 个官方文档页存在 `references/docs/`。
- 用途：作为后面逐个专题讨论开发方案的底稿（第 6 节是讨论议程）。

---

## 1. 结论

1. **愿景成立，但"公司 + 办公室 + 真实终端"这个外形已经有人在做，而且做得不差。**

   | 项目 | 形态 | ⭐ | 创建时间 |
   |---|---|---|---|
   | **munder-difflin** | Pixi.js 办公室 + GOD agent + 邮箱 + node-pty | 9.4k | 2026-05 |
   | **Paperclip** | "zero-human company"，CEO + 组织图 | 112k | — |
   | **Gas Town** | Mayor + 固定角色 | 18.7k | — |
   | **AgentSystemLabs/agent-office** | 真实 PTY 会话 + RTS 式提醒队列 | 0.9k | — |

   两家官方也在做多会话总览：`claude agents --json` 已经能报 `blocked` + `waitingFor`。所以单靠"看得见多个会话"，很快就会变成基础功能。

2. **仍然没人做好的，正好是我们要做的那一层：**

   | 空白 | 现状 |
   |---|---|
   | (a) 统一的"需要你"收件箱 | 没人把工具审批、治理决策、checker 举旗、阶段 gate 合到一起，并且能就地答复 |
   | (b) CEO 消费规范化的语义事件流 | 现有项目读的都是邮件、tool result 或原始输出 |
   | (c) 由人设计并锁定、逐角色强制权限的组织 | 只有零星的部分实现 |
   | (d) claim 级别的核对与证据分级 | 所有 MAS 框架都没有；只在评测和核对工具里出现 |
   | (e) 让"重新引导 agent"变得便宜、提高人的掌控感 | ParallelPilot 研究显示现有仪表盘没解决这一点 |

3. **技术上可行，不需要抓屏。**
   - Claude 用 Agent SDK：`canUseTool`、`requires_action`、带 `priority` 的插话、`resume`。
   - Codex 用 `codex app-server`：`waitingOnApproval`、`turn/steer`；支持多客户端订阅同一个 thread，未决审批会重放给新接入的客户端。
   - 最大的技术短板在 Claude 一侧：没有官方方式让同一个会话既能程序化控制，又能显示原生 TUI。

4. **Claude 订阅合规风险低，只要守住规则**（2026-11-07 更正，见第 5 节 R1）。Anthropic 条款明文允许平台运行未修改的 Claude Code、由终端用户用自己的订阅登录。Orca、Conductor、munder-difflin、dsh 用的都是这种方式。被禁止的是提取 OAuth token、冒充官方客户端直连 API，pi 的 Anthropic 登录就是这种做法。

5. **建议的产品一句话**：一家你自己设计、看得见、管得住、会互相把关的 AI 公司。外形借别人的做法，护城河放在 (a)–(e)。

---

## 2. 愿景组件 × 现有最佳实践 × 我们的空白

| 组件 | 现有最佳实践（借鉴来源） | 空白 / 我们要做的 |
|---|---|---|
| 会话控制 | Claude Agent SDK、Codex app-server（02）；Happy 的 SDK↔TUI 切换；Orkas、Vibe Kanban 的 stdio 审批桥（01） | 两家统一到一个 adapter 接口；多种状态证据按优先级仲裁（Gas City、OpenRig） |
| 卡住检测 | Gas City / OpenRig 的证据阶梯；"需要人 = 计数 + 原因"，独立于 working/idle | 映射到协议 0.2 的 `request.*` |
| 待决事项接口 | Gas City `PendingInteraction` / `Respond`；LangGraph `HumanInterruptConfig`；ACP 的选项 `allow_once/always`… | 统一四类请求：工具审批、决策、checker 举旗、阶段 gate |
| 收件箱 | bagidea 的持久化审批队列；claw-empire 的决策收件箱（03）；Paperclip 的五类交互（01） | 合并以上几种，加上等待计时和"不回答会怎样" |
| RTS 式提醒 | agent-office 的 `N` 键跳到下一个等你的人 + 屏幕边缘指针；claude-office 的紧急度打分 | 编组 + 数字键（全行业空白） |
| 点小人 → 抽屉 | W17ant 的 inspector 卡片；pixel-agents / agent-office 的真实 PTY tab | 聊天框真正送进它背后的会话；三个 tab：结构化记录 / 原始终端 / 产出 |
| 中途引导 | munder-difflin：用 hook 的 `additionalContext` 注入指令，不往 TUI 打字；OpenRig 的 typing guard；Claude `priority`、Codex `turn/steer` | 命令带 `delivery: steer|queue|interrupt` |
| CEO / Lead | MS AF Magentic 的 progress ledger + 停滞后重新规划；crewAI 的"经理不持工具"；CAMEL 的恢复策略 | CEO 读事件流；按白名单代为批准，其余上报给人 |
| 组织 / 团队定义 | ChatDev 2.0 YAML（`clear_context`、`dynamic`）；MS AF `approvalMode`；Paperclip `agentcompanies/v1`；OpenRig RigSpec；Bernstein 把角色编译成 `--allowedTools` | 团队设计 v2：锁定、`backend`、逐工具 allow/ask/deny、`reviewerOf`、`gates`、结构签名 |
| 跨厂商审查 | Gas City 按 provider 分 lane 的 review quorum；OMC 的 JSON verdict | 研究任务的 claim 级审查 |
| 核对与证据 | Loki 的 `ClaimDetail` / `Evidence`；FACT 流水线；WebWeaver 内联引用标签；urlhealth（论文） | claim → evidence → urlHealth → verdict（含 unknown），A–D 分级 |
| 协议 | AG-UI interrupt/resume；ACP 的 permission 和 steering；A2A 的 input-required；三态收敛（05） | 0.2：`request.*`、`command.*`、`command.ack`、`agent.stopped`、`mas/inbox` |
| 办公室渲染 | Pixi / Three / Canvas 都有人做；我们的 SVG 在 20 个角色以内够用（03） | 持续显示的交接线、checker→被核对者关系线；不追求美术 |

---

## 3. 借用 / 集成 / 自研清单

**直接作为依赖或参考实现（license 允许）**

| 项目 | 用法 | License |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | Claude 后端 | 见其条款 |
| `codex app-server` + `generate-ts` | Codex 后端，类型按用户本机版本生成 | Apache-2.0 |
| `xterm.js` + `node-pty` | 抽屉里的原始终端 tab | MIT |
| AG-UI / ACP | 字段词汇和语义映射，不绑定字段名 | MIT / Apache-2.0 |

**照着机制重写（MIT / Apache，可以参考代码）**

| 来源 | 借什么 |
|---|---|
| W17ant `server/permissions.js` | 长轮询审批、`resolved_elsewhere`、409 |
| agent-office `nextup.ts` / `compass.ts` | `N` 键和屏幕边缘指针 |
| Gas City | `PendingInteraction` 数据结构、review quorum |
| OpenRig | 证据阶梯、typing guard |
| munder-difflin `HIVE.md` | 中途引导、hop 上限、只由主进程提交 |
| Paperclip | 交互类型划分、团队模板格式 |
| ChatDev 2.0 / MS AF | 团队 YAML schema |
| Loki / FACT | claim 和 verdict 结构、核对流水线 |

**只借思路**

| 来源 | 原因 |
|---|---|
| disler 的 observability | 没有 license |
| NTM | license 明确排除 Anthropic 和 OpenAI |
| Star-Office-UI 美术、W17ant 的 Dunder Mifflin 皮肤、bagidea 的猫、generative_agents 素材 | 非商业或不可再分发 |
| pi 的登录方式 | 冒用 Claude Code 的 OAuth client id，绝对不能用 |

**必须自研（护城河）**
- 统一收件箱和请求模型
- CEO 事件流和代理批准策略
- 锁定组织的编译器：team design v2 → 各后端的权限和配置
- claim / evidence / verdict 核对层
- 双向协议 0.2 + reducer + conformance
- 面向研究和决策任务的界面整合

---

## 4. 建议的架构

```
┌──────────────── UI（浏览器面板 / 之后 Tauri 桌面）────────────────┐
│ 办公室（概览）· 需要你收件箱（行动）· 小人抽屉：记录/终端/产出/聊天 │
└───────────────▲──────────── SSE ───────────┬──── POST commands ───┘
                │                             ▼
┌──────────── mas daemon（TypeScript，扩展现有 mas-office serve）────────────┐
│ events.jsonl（单一事实来源）→ reducer → snapshots + mas/inbox              │
│ command router：message / respond / assign / interrupt → adapter           │
│ CEO：读规范化事件流，写 ledger，按白名单代为批准，其余上报                 │
│ org compiler：team design v2 → 各后端的工具 / 权限 / 系统提示              │
└──────▲──────────────────────────────▲──────────────────────────▲─────────┘
       │ Claude Agent SDK（每角色一个 query）│ codex app-server（共享，unix socket）│ hooks（兼容外部会话）
   Claude Code 会话               Codex threads（官方 TUI 可同时挂上）   用户自己开的会话
```

**原则**
- 事件日志是唯一的事实来源，命令也写进日志，这样可以回放、续跑、审计。
- reducer 只根据观测到的事实改变状态：中断命令被接受，不等于 agent 已停止。
- 人永远可以接手原始终端。

---

## 5. 风险

| # | 风险 | 应对 |
|---|---|---|
| R1 | **Claude 订阅合规（已更正为低风险）**。`legal-and-compliance` 页面的 "Can customers offer Claude Code in their products?" 一节明文允许产品运行 Claude Code，条件有两个：二进制不改，并且每个终端用户用自己的 API key 或订阅登录。同页还写明"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code"。禁止的是：给自己的产品提供 claude.ai 登录、代用户中转订阅额度、收集或中转凭证，以及冒充官方客户端（pi 的做法）。剩下的现实约束是额度："ordinary, individual usage"，并发多个会话会更快撞到用量上限 | 守住 5 条规则：① 只运行未修改的 `claude`（用户安装的或 SDK 自带的）；② 不做登录按钮，引导用户自己运行 `claude auth login`；③ 不读、不存、不转发凭证，用 `claude auth status` 查询；④ 不替用户付费或转售用量；⑤ 不把 Claude / Anthropic 的名字和 logo 用作我们的品牌。另外：默认并发上限 + 用量提示；以后做云端托管时再签 Commercial Terms。Codex 侧官方欢迎嵌入 |
| R2 | Claude 没有"同一会话可控 + 原生 TUI"的官方方式 | 先做自绘 transcript + "接手"（停 SDK → `claude --resume`）；spike channels relay |
| R3 | Codex app-server 是 experimental，协议变化快 | 类型按本机版本生成，adapter 层隔离 |
| R4 | 竞品迭代快，赛道淘汰也快（Vibe Kanban、Crystal、Terragon 已出局） | 不比外形，守 (a)–(e)；尽早拿评测和用户研究数据 |
| R5 | 成本和额度：每个角色一个会话，最多 12 个并发 | 默认小团队、预算上限、CEO 停滞检测（参考 ruflo 泄漏数万次调用的教训） |
| R6 | 范围膨胀：想"整合所有最优解" | 每个功能都要对应 (a)–(e) 之一，否则不做 |

---

## 6. 建议的 roadmap 调整

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| **S0 可行性 spike**（1–2 周） | Claude 和 Codex 各一个 adapter；浏览器里完成"看到卡住 → 点它 → 批准或回复 → 继续"闭环；同时测 R1 / R2 的几个开放问题（02 §7.5） | 两家都跑通闭环，并有一份风险结论 |
| **S1 协议 0.2 + 收件箱 + 抽屉** | `request.*` / `command.*` / `mas/inbox`、reducer 和 conformance；面板加收件箱、`N` 键、抽屉聊天和终端 tab | 1 个 Lead + 2–3 个角色、两家混用的真实运行 |
| **S2 组织与 CEO** | team design v2 和编译器（逐角色权限、`reviewerOf`、`gates`）；CEO ledger 和代理批准；kit 迁移 | 用户设计并锁定的组织能自动跑完一个任务，例外上报给人 |
| **S3 核对层 + 评测**（原 M0 评测并入） | claim / evidence / verdict、FACT 式 checker、URL 检查；评测：单 agent（等 token 预算）vs 团队 vs `/deep-research` vs DR 产品 | 拿到"团队核对后 claim 支持率提高多少"的数据 |
| **S4 用户研究 + 打包** | CHI 式实验：tmux/OMC vs Office vs Office+CEO，fan-out 4/8/12（05 §B.4）；Tauri 桌面版 | 一篇论文初稿和一个可安装的版本 |

原 roadmap 中，M2 的 MCP Lead 推迟到 S2 之后再评估；M3 的"可操作面板"提前，成为 S1 的核心。

---

## 7. 讨论议程（逐个专题讨论）

| # | 专题 | 要你决定的问题 | 主要依据 |
|---|---|---|---|
| T1 | ~~Claude 合规与登录路线~~ 已基本定：按 R1 的 5 条规则走用户自己的登录 | 剩下的问题：默认并发上限多少 | 02 §7.4、本文 R1 |
| T2 | 会话控制方案 | SDK 优先还是 PTY + hooks 优先；"接手"体验能接受到什么程度 | 02 §7、01 第 1 节 |
| T3 | 协议 0.2 | `request` / `command` 命名空间与字段；和 AG-UI / ACP 的映射 | 05 §A |
| T4 | 界面：收件箱、抽屉、RTS | 请求分几类；快捷键；抽屉 tab；办公室要不要换引擎 | 03、05 §B |
| T5 | CEO 设计 | CEO 是否本身就是一个 Claude / Codex 会话；代理批准的白名单；ledger | 04 第 2 节、05 P7 |
| T6 | 团队设计 v2 与权限 | YAML 还是 Markdown；`cli:` / `mcp:` 自由填写还是白名单；编译目标 | 04 第 3 节、01 |
| T7 | 核对与证据 | claim 模型；checker 流水线；A–D 分级谁来定 | 04 第 3 节、positioning |
| T8 | 评测与 CHI 研究 | 任务集；指标；是否投 CHI 2027 | 05 §B.4、positioning |
| T9 | 竞品策略 | 对 munder-difflin / Paperclip / Gas City：竞争、集成（接它们的事件）还是贡献 | 01、03 |
| T10 | 技术栈与发布 | 新包名或 monorepo 结构；Tauri 时间点；kit 和课堂版怎么处理 | 开发日志 §8 |

建议顺序：**T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10**。T1 和 T2 决定 S0 spike 怎么做，越早定越好。
