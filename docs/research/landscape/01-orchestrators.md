# 01 · 终端 / CLI 多 agent 编排器与"公司"层级

- 调研日期：2026-11-07。star 数、license、最近提交时间都是当天用 `gh api repos/<owner>/<repo>` 现查的。
- 本地克隆在 `references/repos/<owner>__<repo>`（不入库）。超过 400 MB 的仓库没有克隆，改用 `gh api` 逐个读文件，条目里会注明。
- 只读了代码和文档，没有运行任何仓库里的代码。

## 类别总结

1. **会话控制分四层，大家都在往上走。** 最底层是 tmux `send-keys` 加 `capture-pane`（Tmux-Orchestrator、claude-squad、Gas Town Tier 0）。往上一层，用 hooks 拿结构化生命周期事件（munder-difflin、parallel-code、agent-deck、OpenRig）。再往上，是 headless 结构化通道：`claude --input-format stream-json --permission-prompt-tool stdio`，以及 `codex app-server` JSON-RPC（Orkas、Vibe Kanban、Sculptor、Crystal）。最上面是"每次唤醒跑一次" `claude --print --resume`（Paperclip、Bernstein、Terragon）。成熟项目一般同时用两到三层，互相兜底。
2. **"卡住 / 等审批"的检测，没有任何一种信号单独可靠。** Gas City 和 OpenRig 的做法都是：hooks、CLI 自报状态、屏幕上的对话框、窗口活动这几种证据**按优先级仲裁**，并且把"需要人"建模成独立的计数加原因，不放进 working/idle 状态机。
3. **层级几乎都只有一到两层**，例如 Mayor → polecat、GOD → agents、Commander → specialists、CEO → CTO → QA。协调者收结果的方式是"邮箱文件 + 事件唤醒"，不是去读原始终端输出。Gas Town 还把**基础设施角色**（Witness 看生命周期，Refinery 管合并队列，Deacon 是看门狗）和干活的角色分开。这一点值得我们注意。
4. **审批分两类，大多数项目只做了一类。** 一类是工具权限审批：Orkas、Vibe Kanban、Gas City 把它结构化地送进 UI；munder-difflin 和 OMC 把它留在原生终端里。另一类是治理审批（招人、战略、计划确认）：Paperclip 做得最完整。还没有项目把两类统一进一个"需要你"收件箱，同时又能看到实时终端。

**最值得借鉴的 3 个**

- **Gas City**（Gas Town 的继任者）：provider 无关的 `PendingInteraction{request_id, kind, prompt, options}` / `Respond{request_id, action, text}` 接口，加上 REST API、`session.pending` 事件，以及按 provider/model 分 lane 的 review quorum。这几乎就是我们协议 0.2 双向化需要的东西。MIT。
- **OpenRig**：证据阶梯（evidence ladder）、"needs-input = count + reason"、六档 typing guard、RigSpec YAML（pods/members/edges）。在"怎样安全地把人的话送进正在跑的会话"这件事上，它考虑得最细。Apache-2.0。
- **munder-difflin**：和我们的愿景最像，Pixi.js 办公室、GOD agent 加邮箱、node-pty。它的设计文档 `HIVE.md` 里有一组现成做法：用 hook `additionalContext` 做中途引导，不往 TUI 里打字；废弃了 Stop-hook 自动续跑，因为它会绕过 HITL；FIPA-lite 消息加 hop 上限；只由主进程提交 git。MIT（美术资源另有授权）。

**没人填的空白**

- 没有项目让协调者消费一条**规范化的语义事件流**。协调者读的要么是邮件，要么是 tool result。
- 没有 **claim 级别的核对和证据分级**，现有的 verdict 全是代码评审式的 pass/fail 加 findings。
- 没有项目把**空间化视图、统一的"需要你"收件箱（工具审批加治理决策）、可接手的原始终端**三者放在一起。
- 由人设计并锁定、**逐角色强制权限**的团队，只有 OpenRig 和 Bernstein 做了一部分。
- 非编码的研究任务只有 Orkas 和 Paperclip 涉及。

---

## 一、重点项目（深读）

### gastownhall/gastown（Gas Town），以及 gastownhall/gascity（Gas City）、gastownhall/beads（Beads）

- https://github.com/gastownhall/gastown（`steveyegge/gastown` 会重定向到这里）· ⭐ 18,724 · MIT · Go · 2026-10-28 · 本地克隆：`references/repos/gastownhall__gastown` @ `466aa41`
- Gas City：https://github.com/gastownhall/gascity · ⭐ 1,496 · MIT · Go · 2026-11-07 · **未克隆**（size 1.87 GB），通过 `gh api` 读取 @ `06372a1`
- Beads：https://github.com/gastownhall/beads · ⭐ 28,571 · MIT · Go · 2026-11-07 · 本地克隆 @ `087a4ec`

**一句话**：Gas Town 是 Steve Yegge 做的多 agent "城镇"：在 tmux 里跑 Claude、Codex、Gemini 等，靠 Beads（基于 Dolt 的图结构 issue tracker）做工作账本和邮件。Gas City 是它的重写版，变成"软件工厂 SDK"：formula 是工作流图，runtime provider 可插拔，自带 React dashboard。

**架构要点**

- **角色**（`docs/overview.md`）：
  - 基础设施角色：Mayor（全局协调）、Deacon（后台看门狗）、Witness（每个 rig 一个，管 polecat 的生命周期）、Refinery（每个 rig 一个，管合并队列）。
  - 干活的角色：Polecat（身份持久、会话临时）、Crew（长期存在、由人直接指挥）、Dog（Deacon 的小工）。
  - 角色定义写在 TOML 里，比如 `internal/config/roles/polecat.toml`，内容包括 `start_command = "exec claude --dangerously-skip-permissions"`，以及健康参数 `stuck_threshold = "2h"`、`consecutive_failures = 3`。
- **派活**：`gt sling <bead> <rig>` 把 bead 挂到 worker 的 hook 上。worker 遵守"Propulsion Principle"：hook 上有活就立刻干，不等确认（`docs/concepts/propulsion-principle.md`）。一批工作用 convoy 跟踪，issue 全部关闭时 convoy 就算"落地"。
- **会话控制**（`docs/agent-provider-integration.md`）分四档：
  - Tier 0：纯 tmux。
  - Tier 1：`agents.json` preset，包括 `ready_prompt_prefix`、`resume_flag`、`process_names`、`non_interactive` 等字段。
  - Tier 2：hooks。
  - Tier 3：深度集成。
- **送消息进会话有两条路**：
  - (a) `NudgeSession`（`internal/tmux/tmux.go:1777`）：用 flock 跨进程串行化，再 send-keys；`internal/tmux/submit_verify.go` 会探测"消息是不是卡在 composer 里没发出去"（结果分 turn-started / composer-cleared / stranded 等）。
  - (b) 合作式 nudge 队列（`internal/nudge/queue.go`）：消息写成 `.runtime/nudge_queue/<session>/*.json`，由 agent 的 `UserPromptSubmit` hook 在下一个回合边界取走。**这样做是为了不打断正在执行的 tool call。**
  - 另外还有 ACP 代理（`internal/acp/proxy.go`）。
- **卡住检测**：
  - 三套心跳存储（`docs/concepts/heartbeats.md`）。Witness 读 agent 自报的 `--state=working|idle|exiting|stuck`。
  - 判定之前必须用 tmux `window_activity` 交叉验证，避免把"心跳没写"误判成"卡住"。
  - Gas Town 默认跳过权限审批，所以没有审批检测。
- **升级**（`docs/design/escalation.md`）：`gt escalate -s MEDIUM|HIGH|CRITICAL`。链路是 agent → Deacon → Mayor → Overseer（人），每一层可以自己解决，也可以继续上报。每次升级是一个 escalation bead，可以按严重度路由到 mail、email、SMS、Slack。超过 4 小时没人处理会自动再升级。
- **邮件**（`docs/design/mail-protocol.md`）：一封邮件是一个 `type=message` 的 bead，主题用固定格式，例如 `POLECAT_DONE`、`MERGE_READY`，正文带 `Exit: MERGED|ESCALATED|DEFERRED`。
- **合并**：Refinery 处理合并队列（`internal/refinery/engineer.go`、`batch.go`、`safety_stop.go`）。
- **界面**：`gt feed` 三栏 TUI（`internal/tui/feed`），另有 convoy 的 web 视图（`internal/web/templates/convoy.html`）。

**Gas City 新增的部分**（经 `gh api` 读取）

- **待处理交互的检测**：
  - `internal/runtime/tmux/interaction.go` 用正则解析 Claude Code 权限对话框：先找 "Do you want to …?"，再找带 `❯` 光标的编号菜单。**按选项文字作答，不按位置**，附有真实截屏的 testdata。Codex 和 AskUserQuestion 分别在 `interaction_codex.go`、`interaction_question.go`。
  - `internal/pendingwatch/pendingwatch.go` 把这些检测转成 `session.pending` / `session.pending_cleared` 事件，每次状态切换只发一次。状态可以从持久化的 city event log 重建；只有输出变化时才重新截屏。
- **接口与 API**：
  - `internal/runtime/runtime.go:635` 定义了 `PendingInteraction` / `InteractionResponse`，以及可选的 `InteractionProvider` 接口。
  - `internal/api/handler_session_interaction.go` 提供发消息（支持 idempotency key）、查询 pending、按 `request_id` 回答。
  - 运行时实现见 `internal/runtime/`：tmux、subprocess、ACP、K8s、herdr、hybrid。
- **核对**：`internal/reviewquorum/types.go` 定义了 review quorum。每个 lane 带 `{id, provider, model}`，verdict 取值 `pass` / `pass_with_findings` / `fail` / `blocked` / `awaiting_reviewers`。
- **界面**：dashboard 是 React 18（`internal/api/dashboardspa/web/frontend`），里面有 `src/attention/agentNeedsYou.ts` 和 `AttentionSummaryPanel.tsx`。

**Beads**：`bd ready` → `bd update --claim` → `bd close`，是一个依赖感知的工作图，数据存在 Dolt 里，可以 push/pull。`bd setup claude|codex` 会安装 hooks 和 AGENTS.md 片段。

**和我们 roadmap 的关系**：会话控制（M0/M1）、收件箱、CEO 派活、核对（跨厂商 review lane）、协议 0.2 的双向命令。

**值得借鉴**

- 直接照搬 `PendingInteraction` 和 `Respond` 的数据形状，作为协议 0.2 里"需要你"事件和回复命令的结构。
- 回答时**校验 `request_id` 并按选项文字匹配**，防止把答案送到另一个对话框里。
- "合作式 nudge 队列 + `UserPromptSubmit` hook 投递"。
- review quorum lane 的数据结构。
- 升级链和"超时自动再升级"。

**不足 / 我们的机会**

- 全部面向编码，默认跳过权限；概念非常多（Mayor、Deacon、Witness、Refinery、Polecat、Dog、Wisp、Molecule……），上手门槛极高。
- Gas City 依赖 Dolt、bd、tmux、flock，安装重。
- 界面是工程师用的 dashboard，没有空间化和角色语义。

**复用判断**：MIT，可以直接参考代码。屏幕解析部分（`interaction.go` 和它的 testdata）可以移植到 TypeScript。整个系统不适合作为依赖：太重，而且是 Go。

---

### paperclipai/paperclip（Paperclip）

- https://github.com/paperclipai/paperclip · ⭐ 111,914 · MIT · TypeScript · 2026-11-07 · **未克隆**（size 492 MB，超过阈值），通过 `gh api` 读取 @ `061c84d`

**一句话**："如果 OpenClaw 是员工，Paperclip 就是公司"。它是 Node 服务加 React UI，把各家 agent 组织成有组织架构图、预算、治理和审批的"公司"，宣传语是"zero-human companies"。

**架构要点**

- **心跳模型**：agent 不常驻，被派活、收到评论或到了定时时间才"醒来"，跑一次就退出。
  - claude 适配器（`packages/adapters/claude-local/src/server/execute.ts:853`）每次执行 `claude --print --output-format stream-json --verbose [--resume <sid>]`，通过环境变量注入 `PAPERCLIP_RUN_ID`、`PAPERCLIP_TASK_ID`、`PAPERCLIP_WAKE_REASON`、`PAPERCLIP_APPROVAL_ID`。
  - `dangerouslySkipPermissions` 默认为 true（同文件第 446 行）。
  - 适配器目录 `packages/adapters/` 下有 claude、codex、cursor、gemini、grok、hermes、kimi、opencode、pi、openclaw-gateway，claude 和 codex 另有 `acp.ts`。
- **agent 怎么操作公司**：agent 没有专用工具，按 skill 的规定**用 curl 调 Paperclip REST API**（`skills-releases/paperclip/v7-roster/SKILL.md`）。流程是 checkout 任务 → 写评论 / 建子任务 / 改状态 → 退出。每个写请求都带 `X-Paperclip-Run-Id`，用于审计。
- **组织与团队定义**：
  - 团队用 `agentcompanies/v1` 格式，即 Markdown 加 frontmatter：`TEAM.md` 里写 `manager: agents/ceo/AGENTS.md`、`includes`、`requiredSkills`；`AGENTS.md` 里写 `role`、`reportsTo`、`skills`。示例见 `packages/teams-catalog/catalog/bundled/company-defaults/core-exec-team/`。
  - 组织架构图页面：`ui/src/pages/OrgChart.tsx`。
- **人机交互**（`maps/feature-map/questions-and-approvals.md`）：
  - 交互分五类：questions（单选、多选、自由文本，可分页）、confirmations（接受、拒绝、要求修改）、plan-review、governance（董事会正式审批，例如招人、CEO 战略）、tool-review（应用工具调用：允许一次、总是允许、拒绝）。
  - 每条交互都挂在原任务上，有 audience 规则，并且保证 **"一次回答只触发一个续跑"**（多次点击、刷新、多个标签页都不会重复执行）。
  - agent 用 `POST /api/issues/{id}/interactions`（kind `ask_user_questions`）发问，人用 `.../respond` 回答。
  - UI 入口包括 `/decisions`、Inbox（`ui/src/components/BlockedInboxView.tsx`、`DecisionShelf.tsx`）、`/approvals/pending`。
- **生命周期**（`doc/AGENT-LIFECYCLE.md`）：`pending_approval → preparing → verifying → ready → pausing/paused → terminating`。招人需要董事会批准；CEO 的初始战略也要先批准，CEO 才能把任务推进到 `in_progress`（`docs/guides/board-operator/approvals.md`）。
- **状态**：Postgres（`packages/db`）。调度见 `server/src/modules/run-dispatch`、`wake-queue`、`active-run-watchdog`。原子化 checkout 加执行锁，防止同一个任务被抢跑。
- **其他**：预算和成本控制；可以通过 Slack、Discord、Telegram 回答问题（实验功能）。

**和我们 roadmap 的关系**：CEO、收件箱、团队设计（模板格式）、治理 gate。

**值得借鉴**

- **交互类型的分类，加上"一次回答只续跑一次"的语义**，可以直接作为我们"需要你"收件箱的数据模型。
- `agentcompanies/v1` 用 Markdown 描述团队，和 H5"可导出、可分享的团队模板"高度对口。
- 阶段之间加人工 gate（CEO 战略要批准后才能执行）。
- "唤醒原因 + 唤醒载荷"注入环境变量的心跳模式，适合做我们的 `mas run` 无头后端。

**不足 / 我们的机会**

- agent 跑一次就退出，**看不到正在进行的终端**，也不能中途接手。
- 工具权限默认全放开，人工审批只在治理层面。
- 界面是任务管理器，不是空间化视图。
- SKILL 很长，规则极细（"一次 shell 调用只发一个 API 请求"等），说明靠 prompt 让 agent 自己调 API 并不稳。
- 没有 checker 或证据分级。

**复用判断**：MIT。交互模型、团队模板格式和 UI 交互流程都可以借鉴。整个系统作为依赖太重（Postgres、插件系统）。可以考虑"兼容 agentcompanies/v1 导入"。

---

### HarnessMD/munder-difflin（Munder Difflin）

- https://github.com/HarnessMD/munder-difflin · ⭐ 9,414 · MIT（代码；LimeZu 像素美术资源另有授权，需署名，见 `LICENSE-ASSETS`）· JavaScript/TypeScript · 2026-11-07 · 本地克隆 @ `80a1dbb`

**一句话**：Electron 桌面 app，把 claude、codex、agy、grok、kimi 等真实 CLI 包装成"你的克隆体"办公室。Pixi.js 2D 办公室里每个 agent 是一个小人，由 GOD agent（Michael）派活、路由和升级。2026-05 创建，增长很快。

**架构要点**

- **两个数据平面**（`docs/ARCHITECTURE.md`）：
  - Terminal plane：`PtyManager` 用 `node-pty` spawn 每个 CLI，按 id 通过 IPC 推送字节，xterm.js 渲染（`src/main/pty.ts`）。
  - Event plane：provider bridge 把 hook payload POST 到 hook server（`src/main/hooks.ts`）。
- **Hive**（`HIVE.md`）：一个本地 git 仓库，**只有主进程提交**，避免 `index.lock` 冲突。
  - 每个 agent 只写自己的 `agents/<id>/outbox/`，由 router 搬进收件人的 `inbox/`。
  - 共享文件：`registry.json`、`tasks.json`（任务账本）、`board.md`（只由 GOD 写）、`log.jsonl`（驱动 UI 的活动流）。
- **消息格式**是 FIPA-lite（`HIVE.md` 第 4 节）：`act: request|inform|propose|query|agree|refuse|done`，带 `hops`（上限防止乒乓循环）、`requires_reply`、`needs_human`。
- **GOD agent** 是一个普通的 `claude` 进程。路由和裁决的策略写在它的 system prompt 里："调 prompt，不改代码"。
- **人怎么介入**：
  - 点击桌子可以看实时终端并直接打字。
  - **中途引导**（`hooks.ts` 约第 525 行）：把操作员的指令排队，在下一个 `UserPromptSubmit` 或 `PostToolUse` hook 里以 `additionalContext` 注入，"不往 TUI 里脆弱地打字"。
  - **暂停或禁用工具**：在 `PreToolUse` 返回 `permissionDecision: deny`。
  - **较慢的人工审批**故意留给 Claude 原生的权限提示，可以用 `/remote-control` 在手机上批。
  - `Notification` 事件里的 idle 或 "waiting for your input" 会触发桌面通知（约第 583 行）。
- **教训**（`hooks.ts` 约第 498 行注释）：原先用 Stop hook 返回 `decision: block` 让 agent 自动读邮件、继续干活，后来**撤掉了**，因为这"绕过了 HITL 安全，并且可能在用户回答问题时继续花钱"。现在改成在 renderer 里做"只在空闲时投递"（`src/main/workerWake.ts`）。
- **熔断器**（`src/main/breaker.ts`）：检测重复的相同工具调用和失控循环，依次 steer → constrain → stop。

**和我们 roadmap 的关系**：办公室交互、CEO、收件箱、会话控制。几乎覆盖了 M3/M4 的设想。

**值得借鉴**

- 中途引导用 hook `additionalContext`，不往 TUI 打字。
- 单一提交者 + outbox/inbox 搬运。
- FIPA-lite 的 act 和 hop 上限。
- "小人走到工位"由 `PreToolUse`/`PostToolUse` 驱动，替代 PTY 抓屏。
- Stop-hook 续跑的反面教训。

**不足 / 我们的机会**

- 工具审批不进统一收件箱，仍在各自的终端里。
- 没有锁定的团队设计、checker 或证据。
- 部分功能只在付费 Pro 版里（README 提到侧栏 Inbox、"Asked you" 等，是否闭源 *(unverified)*）。
- 核心定位是"你的克隆体替你干活"，和我们"可审计的团队"不同。

**复用判断**：代码是 MIT，可以借用（注意 LimeZu 美术不能随意分发）。它是最直接的竞品，应该重点盯 roadmap 和 issue。

---

### mvschwarz/openrig（OpenRig）

- https://github.com/mvschwarz/openrig · ⭐ 8,718 · Apache-2.0 · TypeScript · 2026-11-07 · 本地克隆 @ `a0f410e`

**一句话**：用 YAML 定义 agent 团队（rig），一条命令启动。本地 daemon 用 SQLite 存状态，在 tmux（可选 Herdr）里跑原样的 Claude Code、Codex、Pi，通过 CLI、TUI、MCP server 驱动。

**架构要点**

- **整体结构**（`ARCHITECTURE.md`）：
  - daemon 基于 Hono，提供 HTTP 端口 7433，状态在 `~/.openrig/openrig.sqlite`。
  - 运行时适配器 `packages/daemon/src/adapters/{claude-code,codex-runtime,pi-runtime,...}-adapter.ts`。
  - 实时更新走 SSE（`/api/activity/events`）。
  - Web UI 已进入维护模式，主力界面是 TUI（`packages/tui`）。
- **RigSpec**（`docs/reference/rig-spec.md`）：`pods → members{id, agent_ref, runtime, profile, cwd}` 加 `edges`，还有 `culture_file`、启动文件、服务（docker compose）、checkpoints。
- **活动状态**（`docs/reference/agent-state-taxonomy.md`）：
  - 三个正交轴：session、activity、resumability。
  - **needs-input 不是状态值，而是 `{count, reason}`**，例如 "permission prompt"、"usage limit"、"classifier hold"。
  - `unknown` 是一等值："诚实的 unknown 胜过自信的错误"。
- **证据阶梯**（同文件第 115 行起）：
  - r3：Claude 的 `sessions/<pid>.json` 自报。
  - r2：生命周期 hooks。
  - r4：屏幕上可见的 needs-input 界面元素，只在 needs-input 这个信号上压过自报。
  - r1：窗口活动采样，作为兜底。
  - 新证据源先进入 trial，在生产中积累一致的观测后才升级为权威（Codex hook 需要至少一小时内 50 次一致）。
- **送消息进会话**（`docs/reference/seat-delivery.md`）：typing guard 有六档（`off`、`draft-aware`、`openrig-urgent`、`urgent-only`、`sends-only`、`hold`）。**永远不在用户的草稿上打字。**
  - 消息与工作分离：`rig queue create` 建一条持久化队列记录，再往 seat 里打一条很短的唤醒指针。"唤醒不等于认领，以队列状态为准。"
- **权限**：daemon 自己的 kernel 权限较宽；团队的 seat 按 rig spec 或 profile 设置权限。有"non-interruptive mode"（`docs/reference/non-interruptive-mode.md`）。

**和我们 roadmap 的关系**：会话控制、团队设计（锁定 YAML）、M2 MCP server、M3 TUI。

**值得借鉴**

- 证据阶梯和 "needs-input = count + reason" 可以直接用在我们的 reducer 设计里。
- typing guard 的分档。
- "持久化队列记录 + 短唤醒"的投递语义。
- RigSpec 作为团队锁定格式的参照。

**不足 / 我们的机会**

- 没有统一的人工审批收件箱，需要的是"注意力计数"。
- 没有 checker 或证据分级。
- 文档极其工程化，非工程师难以上手。
- Web UI 已放弃。

**复用判断**：Apache-2.0，可以借用代码，需保留 NOTICE。最值得读的是 `activity-taxonomy.ts` 和 `seat-delivery-guard.ts` 的设计。

---

### Orkas-AI/Orkas（Orkas）

- https://github.com/Orkas-AI/Orkas · ⭐ 9,081 · MIT · JavaScript/TypeScript · 2026-11-07 · 本地克隆 @ `7f8a980`

**一句话**：面向终端用户的本地桌面"AI 团队"。Commander 拆解目标，派给 16 个内置专家（研究、写作、PPT、视频、电商等），也能派给本机已登录的 Claude Code、Codex、OpenCode、OpenClaw、Hermes。

**架构要点**

- **外部 CLI 的统一入口**是 `src/main/features/local_agents/runner.ts`：每次派活 spawn 一次，所有后端事件持久化到 `events.jsonl`，作为权威回放日志。
- **Claude 后端**（`backends/claude.ts:768`）参数为 `--output-format stream-json --input-format stream-json --include-partial-messages --permission-prompt-tool stdio`。
  - CLI 发来的 `control_request`（`can_use_tool`）被翻译成审批请求。
  - `AskUserQuestion` 被单独桥接成表单（约第 411 行）。
- **Codex 后端**（`backends/codex.ts`）：`codex app-server --listen stdio://` JSON-RPC，流程是 `initialize` → `thread/start|resume` → `turn/start`，然后监听 `codex/event` 通知。
- **审批桥**（`cli_permissions.ts`）：主进程把请求推给 renderer，等待 allow-once / allow-run / deny。**没有 renderer 能接收时直接拒绝；无人应答时超时自动拒绝。** 授权只存在内存里，所以 resume 的会话不会带着旧授权进入新任务。
- **Commander 的派活工具**（`src/main/features/group_chat/bus.ts:9719`）是 `dispatch_to`：
  - `mode: sync|async`；async 先返回一个准入回执，结果出来后再触发 Commander 的后续回合。
  - `message` 字段要求写"执行契约"（动作、预期结果、验收标准）。
  - `resume` 字段写"该 agent 停下来问用户、拿到答案之后，Commander 接着做什么"。
- **调度**：`ConversationScheduler` 保证同一个 actor 串行执行，有每个会话的并发上限，嵌套派活受 `workerSlots` 限制（`bus.ts` 文件头注释）。

**和我们 roadmap 的关系**：会话控制（M0 后端）、CEO（Commander 派活契约）、收件箱（审批桥）。

**值得借鉴**

- stream-json 的 control protocol 加 `codex app-server`，是目前**最干净的双向通道**，审批、提问、结构化事件一次拿全。
- 失败即拒绝（fail-closed）的审批状态机，授权只在内存里。
- `dispatch_to` 的参数设计（同步或异步、验收标准、resume 指令）。
- `events.jsonl` 作为权威回放日志，和我们协议 0.1 的思路一致。

**不足 / 我们的机会**

- 外部 CLI 只是"一次一派"的 headless 子进程，没有可接手的终端视图。
- 团队由 Commander 自由组建，不是由人锁定。
- `bus.ts` 有约 1.2 万行，耦合很重。
- 部分功能只在打包版里有（共享项目、云同步）。

**复用判断**：MIT。claude 和 codex 后端的协议处理可以参考，甚至移植。它自己说 codex 部分"modelled after multica's codex.go"。

---

### Yeachan-Heo/oh-my-claudecode（OMC，`omc team`）

- https://github.com/Yeachan-Heo/oh-my-claudecode · ⭐ 40,660 · MIT · TypeScript · 2026-11-07 · 本地克隆 @ `0564555`

**一句话**：Claude Code 的多 agent 插件集，也就是本机正在用的这套。`/team` 是会话内的原生团队；`omc team N:codex|claude|gemini|cursor "..."` 在 tmux pane 里起真实的 CLI worker（`README.md:148,177`）。

**架构要点**

- **运行时**：`src/team/runtime-v2.ts` 是事件驱动的，替代了旧的 done.json 轮询。完成通过 CLI API 的生命周期迁移（claim-task、transition-task-status）、worker 心跳和状态文件来检测。
- **各 CLI 的启动参数**（`src/team/model-contract.ts`）：Codex 和 Cursor worker **故意用常驻的交互式 pane，不用 `codex exec` 或 `-p`**。
- **通信**：
  - 文件邮箱（`src/team/inbox-outbox.ts`、`tmux-comm.ts`），消息带 `notified_at` 和 `delivered_at`。
  - leader 的收件箱是 Markdown 文件（`src/team/leader-inbox.ts`）。文件头注释说明：leader 的通知走文件，不走 send-keys。
  - 空闲的 worker 用 send-keys 推一下，这只在 pane 显示 ready 且没有进行中的任务时才做（`src/team/idle-nudge.ts`）。
- **跨厂商核对**（`src/team/cli-worker-contract.ts`）：critic、code-reviewer 等角色交给非 Claude 的 CLI 时，worker 把 `{verdict: approve|revise|reject, summary, findings[{severity, file, line}]}` 写到约定的 JSON 文件里，由 leader 读取后写回任务。
- **worktree 模式**（`docs/TEAM-WORKTREE-MODE.md`）：
  - 每个 worker 一个 worktree，协调状态集中在 leader 那边的 `.omc/state/team/<name>/`。
  - 有工作区是脏的就拒绝创建 worktree，脏的 worktree 不会被强制删除。
  - 合并用 `--no-ff`，失败一律 abort（`src/team/merge-coordinator.ts`）。
- **信任对话框**：`src/team/tmux-session.ts:3413` 起识别 Claude、Codex、Cursor 的信任提示，并且"受保护的输入永远不替用户回答信任对话框"。

**和我们 roadmap 的关系**：M1（`mas run`）、核对（跨厂商 verdict 契约）、M3 终端视图。

**值得借鉴**

- 跨厂商 reviewer 的 JSON verdict 契约，可以直接作为我们 checker 的输出格式基线，再加上 claim 字段。
- 用 leader 的收件箱文件代替往协调者的终端里打字。
- worktree 的安全规则。

**不足 / 我们的机会**

- 只用 tmux 和文件，没有结构化的审批通道，权限提示只能靠人进 pane 里点。
- 没有可视化（只有 HUD 状态行）。
- 概念和模式极多（2026 年刚退役了一大批 skill），学习成本高。

**复用判断**：MIT。思路和契约格式可以直接借用。不适合作为依赖：它是 Claude Code 插件生态，演进很快。

---

## 二、中等深度项目

### stablyai/orca（Orca）

- https://github.com/stablyai/orca · ⭐ 118,319 · MIT · TypeScript · 2026-11-07 · **未克隆**（2.5 GB），通过 `gh api` 读取 @ `e280eb0`
- **一句话**：桌面和移动端的 "AI orchestrator"，每个 agent 一个 worktree，可以在 chat 和原生终端之间切换。
- **架构**（`docs/site/content/docs/cli/orchestration.mdx`，标注为实验功能）：
  - 对象：**Run**（命名空间 + 协调者收件箱）、**Task**（`pending/ready/dispatched/completed/failed/blocked`，带依赖）、**Dispatch**（一次尝试，是 `worker_done` 的权威来源）、**Message**（`status/dispatch/worker_done/escalation/question/heartbeat`）、**Decision gate**（协调者提出的问题，未解决前阻塞对应任务）。
  - 协调者起完 worker 就结束当前回合，worker 汇报、提问或停下时由 Orca 唤醒协调者，协调者再执行 `orca orchestration check`。
  - `worker_done` 必须带 `--outcome succeeded|failed`、`--task-id`、`--dispatch-id`、`--files-modified`。
- **值得借鉴**：Run、Task、Dispatch、Decision-gate 这套对象模型清晰，"唤醒协调者而不是让它轮询"。可以作为我们 MCP server（M2）工具集的蓝本。
- **复用判断**：MIT，可以借鉴接口设计。规模和 star 数说明这是主流用户已经在用的东西（本机也装了它的 skill）。

### asheshgoplani/agent-deck（Agent Deck）

- https://github.com/asheshgoplani/agent-deck · ⭐ 1,222 · MIT · Go · 2026-11-07 · 本地克隆 @ `fb9e676`
- **一句话**：一个 TUI 加 web 视图，统一管理多个 tmux 里的 Claude、Codex、OpenCode 会话，显示 running / waiting / idle。
- **架构**：
  - `internal/sessionstatus/sessionstatus.go` 把"hook → 状态"的推导收敛到一处，此前三个界面各算一份，结果不一致。
  - Codex 的 hook 新鲜度窗口是 running 20 秒、waiting 5 秒；hook 过期后回退到 tmux pane 标题。
  - **Conductor**（`README.md:613`）是常驻的 agent 会话，监视其他会话："有把握就自动回复，没把握就升级给你"，可以接 Telegram、Slack、Discord（`internal/session/conductor_bridge.py`）。
- **值得借鉴**：状态推导单一来源的教训；Conductor 作为"代你回复的值班 agent"。
- **复用判断**：MIT，可以借鉴思路。

### Dicklesworthstone/ntm（NTM）以及 mcp_agent_mail

- https://github.com/Dicklesworthstone/ntm · ⭐ 462 · **MIT + OpenAI/Anthropic 限制附加条款** · Go · 2026-11-07 · 本地克隆 @ `dda19c5`
- **一句话**：把 tmux 变成本地控制平面，整合 spawn、工作分诊、Agent Mail、文件锁、安全策略与审批（`ntm approve`）、REST/SSE/WebSocket/OpenAPI 以及 `--robot-*` JSON 接口（`README.md`）。
- 配套的 `mcp_agent_mail`（⭐ 2,232，已弃用，改由 Rust 版接替）给 agent 提供身份、收件箱和文件预留。
- **注意**：LICENSE 附加条款规定"不向 OpenAI、Anthropic 及其关联方授予任何权利"。**我们如果和这两家有关联，就不能用它的代码。**
- **值得借鉴**：文件预留（reservation）作为并行编辑的冲突预防手段；robot JSON 接口。

### johannesjo/parallel-code（Parallel Code）

- https://github.com/johannesjo/parallel-code · ⭐ 1,082 · MIT · TypeScript（Electron + SolidJS）· 2026-11-06 · 本地克隆 @ `33e48b8`
- **一句话**：每个任务一个 worktree，Board 按"需要你、已停止、工作中、在 PR 里"排序，`Ctrl+Tab` 跳到下一个等你的任务。
- **架构**：
  - `electron/agent-hooks/status.ts` 把线上状态**刻意只定为三种：`working | waiting | done`**。idle 从不由 hook 报告，而是从 done 或证据过期推出。`waiting` 带 `prompt: permission|question`、`toolName`、`toolUseId`。
  - `src/lib/task-brief.ts` 用 LLM 从会话里提炼 `{goal, now, needsYou}` 一行摘要。
- **值得借鉴**：三态加提示类型的最小线上契约；把 "needsYou 一句话"做成卡片字段；"跳到下一个等你的"这种快捷操作（对应 HCI 的 management by exception）。

### BloopAI/vibe-kanban（Vibe Kanban）

- https://github.com/BloopAI/vibe-kanban · ⭐ 28,614 · Apache-2.0 · Rust + TS · 2026-11-04 · 本地克隆 @ `08064e0` · **README 声明项目正在关停**
- **架构**：
  - Claude 执行器使用 `--permission-prompt-tool=stdio`、`--output-format=stream-json`、`--input-format=stream-json`（`crates/executors/src/executors/claude.rs:168,190`）。
  - Codex 用 `app-server`（`codex.rs:453`，`codex/jsonrpc.rs`）。
  - 审批服务在 `crates/services/src/services/approvals.rs`。
- **值得借鉴**：Rust 实现的 control protocol 和 app-server 客户端，可以和 Orkas 对照着看。项目停止维护说明"看板 + 并行编码"这条路的商业化很难。

### smtg-ai/claude-squad（Claude Squad）

- https://github.com/smtg-ai/claude-squad · ⭐ 8,744 · **AGPL-3.0** · Go · 2026-08-20 · 本地克隆 @ `ce1ffb4`
- **架构**：tmux 加 worktree 的 TUI。检测提示的方式是在 `capture-pane` 的内容里**查固定字符串**（`session/tmux/tmux.go:246`：Claude 查 "No, and tell Claude what to do differently"，Gemini 查 "Yes, allow once"）。AutoYes daemon 自动回车（`daemon/daemon.go`）。
- **评价**：最朴素的基线。AGPL 不能直接借用代码。

### sipyourdrink-ltd/bernstein（Bernstein，也叫 chernistry/bernstein）

- https://github.com/sipyourdrink-ltd/bernstein · ⭐ 1,193 · Apache-2.0 · Python · 2026-11-07 · 本地克隆 @ `05268e5`
- **一句话**："协调环路里没有 LLM"。用 YAML 声明 phases、roles、depends_on，由纯 Python 调度器确定性地执行，可以重放；工作放在 worktree 里，经过合并门禁。
- **架构**：`src/bernstein/adapters/claude.py:478` 起执行 `claude --permission-mode bypassPermissions --max-turns N --output-format stream-json --include-hook-events --no-session-persistence --allowedTools <按角色> --max-budget-usd <按范围> --json-schema <结果 schema>`。
- **值得借鉴**：**角色到 `--allowedTools` 的编译，加上用 `--json-schema` 强制结构化结果**，正好对应我们日志 8.5 的"角色权限强制执行"，以及 checker 结构化输出的需求。
- **复用判断**：Apache-2.0，但项目由一人维护、处于 beta。

### openai/symphony（Symphony）

- https://github.com/openai/symphony · ⭐ 27,964 · Apache-2.0 · Elixir（参考实现）+ `SPEC.md` · 2026-09-15 · 本地克隆 @ `be10a1b`
- **一句话**：轮询 Linear 等 tracker，每个 issue 一个工作区，用 Codex app-server 跑；交付物是 CI 结果和 PR 这类工作证明。运行结束于 workflow 定义的交接状态（例如 `Human Review`）。
- **架构**：
  - 核心是一份语言无关的规范 `SPEC.md`，鼓励"让你的 agent 按 SPEC 自己实现一个"。
  - `WORKFLOW.md` 是 front matter 加 prompt 模板（第 5 节）。
  - 第 10.5 节要求"审批请求和需要用户输入的事件**不能让运行无限期卡住**"，实现必须写清楚自己的策略。
- **值得借鉴**：把编排器写成 SPEC 加 conformance；`WORKFLOW.md` 格式；"交接状态 = 人工 gate"。

### imbue-ai/sculptor（Sculptor）

- https://github.com/imbue-ai/sculptor · ⭐ 246 · MIT · Python + Electron · 2026-11-07 · 本地克隆 @ `5435bd4`
- **一句话**：并行编码 agent 的桌面 app，深度集成 Claude Code 和 Pi。
- **架构**（`docs/help/integrated_harnesses.md`）：Claude Code 以 stream-json 加 control protocol 运行。**禁用内置的 `AskUserQuestion` 和 `ExitPlanMode`，换成自己注册的同名替代工具**：Claude 阻塞在这次工具调用上，Sculptor 渲染原生面板收集答案。待回答的问题在 app 或 harness 重启后仍然保留。
- **值得借鉴**：**用替代工具接管"提问"和"计划确认"**，这样 UI 拿到的是结构化表单，而不是从终端里解析出来的文本。

### stravu/crystal（Crystal，现为 Nimbalyst）

- https://github.com/stravu/crystal · ⭐ 3,129 · MIT · TypeScript · 2026-02-26（已弃用，转为 Nimbalyst：⭐ 2,039，MIT）· 本地克隆 @ `1e18e0b`
- **架构**：`main/src/services/panels/claude/claudeCodeManager.ts:72` 使用 stream-json。权限通过 MCP permission server 桥接（`mcpPermissionServer.ts`、`mcpPermissionBridge.ts`、`permissionIpcServer.ts`），属于"`--permission-prompt-tool` 指向 MCP 工具"那一派。
- **评价**：早期参考实现，已经不再演进。

### terragon-labs/terragon-oss（Terragon）

- https://github.com/terragon-labs/terragon-oss · ⭐ 261 · Apache-2.0 · TypeScript · 2026-02-10 · 本地克隆 @ `83142a1` · **2026-01 关停时发布的快照**
- **架构**：云端沙箱里跑 Claude、Codex、Amp、Gemini（`packages/daemon/src/{claude,codex,amp,gemini}.ts`，codex 用 `exec`，其余用 stream-json）。`terry` CLI 可以把任务接到本地继续。
- **评价**：说明"云端后台 agent + 用户自己的订阅"这条商业路线很难走。

### ruvnet/ruflo（原 claude-flow）

- https://github.com/ruvnet/ruflo（`ruvnet/claude-flow` 会重定向到这里）· ⭐ 81,139 · MIT · TypeScript · 2026-11-07 · **未克隆**（664 MB），通过 `gh api` 读取 @ `3fe9d70`
- **一句话**：以 MCP 工具集加 Claude Code 插件为主。宣称有 "Queen-led hierarchy (Raft, Byzantine, Gossip)"、100+ agent、向量记忆。
- **架构**：`hive-mind spawn --claude` 只是生成给 Claude Code 用的 spawn 命令（`.claude/commands/hive-mind/hive-mind-spawn.md`），实际的 worker 多半是 Claude Code 自己的 subagent。共识算法是否真的参与了 agent 决策 *(unverified)*。
- **值得注意**：`v3/@claude-flow/cli/src/services/worker-daemon.ts:212` 的注释承认后台 daemon 曾经"在许多天里泄漏了数万次 headless `claude --print` 调用"，后来改为默认关闭。**这是"后台自动唤醒"在成本上的反面教训。**

### Jedward23/Tmux-Orchestrator

- https://github.com/Jedward23/Tmux-Orchestrator · ⭐ 1,813 · **无 license** · Python/Shell · 2025-07-14（已不活跃）· 本地克隆 @ `7193530`
- **一句话**：最早的 Orchestrator → Project Manager → Engineer 三层 tmux 结构，靠 `send-claude-message.sh` 实现：`send-keys` 文本，`sleep 0.5`，再 `send-keys Enter`。agent 用 `schedule_with_note.sh` 给自己安排检查时间。
- **评价**：只有历史意义。没有 license，不能借用代码。

### josstei/maestro-orchestrate（Maestro）

- https://github.com/josstei/maestro-orchestrate · ⭐ 486 · Apache-2.0 · JavaScript · 2026-11-02 · 本地克隆 @ `285aede`
- **一句话**：一份 39 个专家的插件，可以装进 Claude Code、Codex、Antigravity、Qwen Code（`README.md` 的 Runtime Targets 表）。用的是**各 harness 原生的 subagent**（`invoke_subagent`、`spawn_agent`），不是多会话。
- **评价**：属于"同一 harness 内部编排"一类，和本类别的多会话编排是互补关系。

---

## 三、只看了 README 的其他项目（未深读，结论均 *(unverified)*）

| 项目 | ⭐ | 一句话 | 为什么值得后续看 |
|---|---|---|---|
| OrchestratorInc/agent-orchestrator | 14,215 | 桌面和移动端，主 agent 规划后起 worker；CI 失败、review 评论、冲突都回给负责那个分支的 worker | "按 PR/CI/review 自动分道"的看板 |
| omnigent-ai/omnigent | 11,272 | Databricks 出品的 meta-harness，一个会话里混用 Claude Code、Codex、Cursor 等，可以让一个 agent 审另一个 | 跨厂商的同一会话；OpenRig 文档提到它的"strict-liveness 拆分" |
| herdrdev/herdr | 48,961 | "the runtime your coding agents live on"，被 Gas City 和 OpenRig 用作可选的终端后端 | 可能属于 02 类（会话控制） |
| HKUDS/ClawTeam | 5,552 | "Agent Swarm Intelligence"，一条命令跑完全流程 | 学术团队的 swarm |
| AgentsMesh/AgentsMesh | ~2.4k | 远程 PTY 沙箱、channel 协作、内置看板 | channel 式的 agent 间通信 |
| h5i-dev/h5i | ~0.9k | 多个 CLI 做同一个任务，互相 review，再由中立 verifier 回放测试后合并 | 跨厂商互评加 verifier |
| the-open-engine/zeroshot | ~2.1k | planner、implementer 加独立 validators 循环，直到验证通过或给出可复现的失败 | 独立验证环 |
| kortix-ai/CompanyOS | 20,486 | "company as code"，多人使用的 AI 公司操作系统 | 公司隐喻；license 是 NOASSERTION |

数据来源：`gh search repos`，以及 `bradAGI/awesome-cli-coding-agents` 的 "Orchestrators & autonomous loops" 一节。

---

## 四、横向对照：会话控制和"卡住检测"

| 手段 | 代表 | 能拿到什么 | 代价 |
|---|---|---|---|
| tmux `send-keys` + `capture-pane` 查固定字符串 | claude-squad、Tmux-Orchestrator | 一切 CLI 都能接 | 依赖时序，没有投递确认，字符串会随版本变化 |
| tmux 加带结构的屏幕解析 | Gas City `interaction.go`、OMC 的信任提示识别 | pending 的 kind、prompt、options，可以按选项回答 | 每个 CLI 版本都要维护 testdata |
| hooks（`PreToolUse`、`PostToolUse`、`Stop`、`Notification`、`UserPromptSubmit`、Codex 的 `PermissionRequest`） | munder-difflin、parallel-code、agent-deck、OpenRig r2 | 回合边界、工具和"等待"类事件；还能**反向注入** `additionalContext` 或返回 deny | 要改用户的 settings；Codex hook 的可信度还在验证中 |
| CLI 自报状态 | OpenRig r3（Claude `sessions/<pid>.json`） | busy、idle、waiting | 未公开的内部格式 |
| headless 双向结构化通道（`--input-format stream-json --permission-prompt-tool stdio`、`codex app-server`、ACP） | Orkas、Vibe Kanban、Sculptor、Crystal（MCP 版）、Gas City ACP | 结构化的审批和提问、完整事件、可以 resume | 没有原生 TUI，"可接手的终端"要另想办法 |
| 每次唤醒跑一次（`--print --resume`） | Paperclip、Bernstein、Terragon | 简单，适合排队和预算控制 | 中途不能插话，审批只能靠跳过权限 |

对我们的含义：

1. 正常运行时走**结构化通道**：Claude 用 stream-json control，Codex 用 app-server。
2. 需要"观看 / 接手"时，切到 tmux 或 PTY 里的原生 TUI，用 `--resume` 接上同一个 session。Orca 支持在 chat 和终端之间切换，OpenRig 支持 resume，说明这条路可行。
3. 在 hooks 和屏幕解析的基础上做 OpenRig 式的证据仲裁，用来兜底和交叉验证。

---

## 五、对照总表

| 项目 | 会话控制 | 层级 | 人工交互通道 | 跨厂商 | License | 活跃度（最近 push / ⭐） |
|---|---|---|---|---|---|---|
| Gas Town | tmux send-keys、nudge 队列（`UserPromptSubmit` hook）、ACP proxy | Mayor → Witness/Refinery → Polecat；Deacon 看门狗 | `gt mail`、`gt escalate` 分级链路，email/SMS/Slack | 是（10+ CLI，按角色指定 agent） | MIT | 2026-10-28 / 18.7k |
| Gas City | tmux、subprocess、ACP、K8s、herdr 运行时 | formula 图、review quorum | REST `pending` / `respond`、React dashboard 的 attention 面板 | 是（review lane 可以指定 provider） | MIT | 2026-11-07 / 1.5k |
| Paperclip | 心跳式 `claude --print --resume`，部分走 ACP | 组织架构图：CEO → CTO → …，董事会是人 | 任务线程里的 questions、confirmations、plan-review、governance、tool-review；Inbox 和 Decisions 页面；聊天渠道 | 是（10+ 适配器） | MIT | 2026-11-07 / 111.9k |
| munder-difflin | node-pty 加 hooks socket | GOD（Michael）→ agents | 点小人看终端并打字；hook `additionalContext` 引导；原生权限提示；关键事项由 GOD 升级 | 是（12 种 CLI） | MIT（美术另有授权） | 2026-11-07 / 9.4k |
| OpenRig | tmux 或 Herdr、hooks、Claude 自报状态、Pi RPC | rig → pods → members，边有类型 | `rig send` 加 typing guard、持久化队列、TUI、MCP | 是（Claude、Codex、Pi） | Apache-2.0 | 2026-11-07 / 8.7k |
| Orkas | stream-json control（stdio 审批）、`codex app-server`、ACP | Commander → 16 个专家加外部 CLI | renderer 审批弹窗（允许一次 / 本次运行允许 / 拒绝）、AskUserQuestion 表单 | 是 | MIT | 2026-11-07 / 9.1k |
| OMC `omc team` | tmux pane、文件邮箱、send-keys 推空闲 worker | leader → N 个 worker | 进 pane 操作；leader 收件箱 `.md` | 是（claude、codex、gemini、cursor、grok、agy） | MIT | 2026-11-07 / 40.7k |
| Orca | 原生终端或 chat 双模式、`orca` CLI | Run → Task → Dispatch | Decision gate、协调者收件箱、question 消息 | 是 | MIT | 2026-11-07 / 118.3k |
| agent-deck | tmux 加 hooks（有新鲜度窗口） | Conductor 值班 agent | TUI 或 web；Telegram、Slack、Discord | 是 | MIT | 2026-11-07 / 1.2k |
| NTM | tmux、Agent Mail、REST/SSE/WS | 扁平，人当 overseer | `ntm approve`、mail 收件箱 | 是 | MIT + 排除 OpenAI/Anthropic 的附加条款 | 2026-11-06 / 0.5k |
| parallel-code | node-pty 加 hooks（working / waiting / done） | 扁平 | Board 上的"需要你"、`Ctrl+Tab`、diff 评论回传 | 是 | MIT | 2026-11-06 / 1.1k |
| Vibe Kanban | stream-json control、`codex app-server` | 看板，扁平 | 审批服务、看板 | 是 | Apache-2.0 | 2026-11-04 / 28.6k（**正在关停**） |
| claude-squad | tmux 加字符串匹配 | 扁平 | 进 pane 操作；AutoYes | 部分 | AGPL-3.0 | 2026-08-20 / 8.7k |
| Bernstein | headless `claude` 加 `--allowedTools` / `--json-schema` | YAML phase/role DAG，不用 LLM 调度 | 策略审批、FIDO2 | 是（50+ 适配器） | Apache-2.0 | 2026-11-07 / 1.2k |
| Symphony | `codex app-server` | tracker issue → 一次运行 | 交接状态（例如 Human Review） | 规范中立（参考实现用 Codex） | Apache-2.0 | 2026-09-15 / 28.0k |
| Sculptor | stream-json control，替换 AskUserQuestion 和 ExitPlanMode | 每个工作区多个 tab，扁平 | 原生问题面板，重启后保留 | Claude、Pi，以及任意终端 | MIT | 2026-11-07 / 0.2k |
| Crystal / Nimbalyst | stream-json 加 MCP permission server | 扁平 | 审批弹窗 | Claude、Codex | MIT | 2026-02-26 / 3.1k（已弃用） |
| Terragon | 云沙箱，headless | 扁平 | Web、Slack、GitHub @ | 是 | Apache-2.0 | 2026-02-10 / 0.3k（关停快照） |
| ruflo | MCP 工具加 Claude Code subagent | "Queen" 拓扑 *(unverified)* | Claude Code 本身 | 宣称 5 家 provider | MIT | 2026-11-07 / 81.1k |
| Tmux-Orchestrator | tmux send-keys 加 sleep | Orchestrator → PM → Engineer | 进 pane 操作 | 否 | 无 | 2025-07-14 / 1.8k（不活跃） |
| Maestro | 各 harness 原生 subagent | 编排者 → 39 个专家 | harness 原生 | 是（每个 harness 一个插件） | Apache-2.0 | 2026-11-02 / 0.5k |
