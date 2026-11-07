# 03 · 可视化、游戏化与交互界面

- 日期：2026-11-07 · 调研范围：16 个 GitHub 项目（6 个深读）+ LangGraph Studio / Langfuse agent graphs 文档
- star、license、最近 push 来自 `gh api repos/<owner>/<repo>`（2026-11-07 查询）；"最近提交"取本地 shallow clone 的 HEAD commit 日期。
- 所有克隆位于 `references/repos/<owner>__<repo>`，只读，未运行任何代码。

## 摘要

1. **"点小人 → 看实时记录 → 在界面里回应"这条链路，已经有三个项目做通了，但各自只做了一半。** W17ant/Claude-Office 能在办公室里直接点 **Allow / Allow & remember / Deny** 回应 Claude Code 的权限弹窗（`PermissionRequest` hook 长轮询 + HMAC proof，`server/permissions.js`），但它的聊天框不进真实会话；pixel-agents 和 AgentSystemLabs/agent-office 点小人后打开**真实 PTY 终端**（xterm.js + node-pty），可以打字，但没有结构化的审批卡片。
2. **最接近我们愿景的是 AgentSystemLabs/agent-office**（886⭐，MIT，Three.js）：每个 worker 是 node-pty 里的真实 Claude Code / Codex / OpenCode 会话，hooks 驱动 *working / needs input / done*，红色信标 + 顶栏横幅 + 警报声，**`N` 键按"阻塞优先、等最久优先"跳到下一个需要你的人**，屏幕边缘箭头指向视野外的等待者（`src/client/nextup.ts`、`ui/compass.ts`）。这是本轮唯一真正实现 RTS "idle-worker / alert queue" 的项目。
3. **"需要你"收件箱有两个好样本**：bagidea/bagidea-office 的 `daemon/approvals.js` 把工具权限、项目 trust、团队提案、`STATUS: BLOCKED`、待启用 job 合成**一个持久化队列**，各类各自的 resolver 不变，手机上也能回应；claw-empire 的 `DecisionInboxModal` 则做好了"决策"类条目（agent 请求、评审就绪、超时续跑、评审轮次挑选），每条带编号选项，可"选项 + 追问文字"（`src/components/chat/decision-inbox.ts`）。我们的收件箱应该是两者的合并：权限 + 决策 + checker flag。
4. **CEO 总览**：paulrobello/claude-office 的 **Command Center** 把每个终端的 boss 放进一个跨会话办公室，按 *Needs-you / Working / Done / Ended* 分区（`frontend/src/components/command/`），加上按紧急度打分的 toast 队列（`stores/attentionStore.ts`：permission 90、error/stop 70）。
5. **handoff 线与 hierarchy** 普遍很弱：大多数项目只区分 boss/lead 与 subagent（颜色、座位靠近 lead）。少数动画化的交接：W17ant 让发送者走到接收者桌前，ChatDev 2.0 让精灵沿 DAG 边走，KbWen 播"飞文件"并在两人改同一文件时画桌间连线（`PairLink.jsx`），bagidea 演一段 CEO → Director 的交接步行。没人画**持续存在**的交接线，也没人画 checker → 被核对者的关系。这仍是我们的空白。
6. **渲染技术**：Canvas 2D（pixel-agents）、PixiJS 8（claude-office、claw-empire、ai-town）、Phaser 3（Star-Office-UI、generative_agents、harishkotra）、Three.js / R3F（Claw3D、agent-office、agent-office-3d）、Godot 4（bagidea）、DOM `<img>` + CSS（W17ant）、纯 SVG（KbWen，与我们最像）、Vue Flow DAG（ChatDev 2.0）。我们的 SVG 等距图在 ≤20 个角色的规模下没有性能问题，换引擎不是优先项。
7. **事件接入**几乎全部是 Claude Code hooks（`PreToolUse`、`PermissionRequest`、`Notification`、`Stop`、`SubagentStart/Stop`、`TeammateIdle`、`TaskCompleted`）+ 读 `~/.claude/projects/**.jsonl` 补细节；Codex 通过 app-server / hooks helper，DeepSeek Harness 通过 ACP。与我们协议 0.1 的 hook 路径一致。
8. **游戏化的副作用**：W17ant、agent-office、claude-office 把大量精力放在彩蛋（Dunder Mifflin、开跑车、高尔夫、城堡地牢），信息密度被稀释；我们的目标用户（研究者、分析师）不需要这些。
9. **资产 license 要逐项核对**：Star-Office-UI 代码 MIT 但美术**仅限非商业学习**；W17ant 的 Dunder Mifflin 皮肤明确排除在 MIT 之外（`NOTICE.md`）；pixel-agents 角色基于 JIK-A-4 Metro City 免费包。可以借代码，不要直接搬美术。
10. **建议**：(a) 照 W17ant 的模式做 `PermissionRequest` 的双向审批，"终端优先、resolved_elsewhere"；(b) 照 agent-office 做 `N` 键 + 屏幕边缘指针 + 顶栏计数；(c) 照 claw-empire 做带选项的决策收件箱，但扩展到工具权限和 checker flag；(d) 抽屉里同时提供"结构化记录"（W17ant inspector）和"原始终端"（pixel-agents/agent-office）两个 tab。

---

## 1. 深读项目（6 个）

### pixel-agents-hq/pixel-agents

- https://github.com/pixel-agents-hq/pixel-agents · ⭐ 10,099 · MIT · TypeScript · 最近 push 2026-11-03 · 本地克隆：`references/repos/pixel-agents-hq__pixel-agents` @ b1bafd0
- **一句话**：VS Code 扩展 + `npx pixel-agents` 独立 web app；每个 Claude Code 终端一个像素小人，口号是 "play a game, build a product"。
- **渲染**：React 19 + Vite + **Canvas 2D**，带寻路和角色状态机（`webview-ui/src/office/engine/{renderer,gameLoop,characters,officeState}.ts`）；DOM 叠加层画工具标签、气泡和 context gauge（`office/components/ToolOverlay.tsx`）。
- **事件接入**：两条路径（README "How It Works"）——hooks 模式（`SessionStart`、`PreToolUse`、`PermissionRequest`、`Stop` 等经 hook 脚本发给所有注册在 `~/.pixel-agents/servers/` 的 server，`server/src/hookEventHandler.ts`）；heuristic 模式扫描 `~/.claude/projects/` 的 JSONL（`server/src/transcriptParser.ts`、`fileWatcher.ts`）。统一成 `AgentEvent`，Fastify + WebSocket 推给前端；`core/asyncapi.yaml` 定义消息契约，`core/src/teamProvider.ts` 定义 Agent Teams 的 provider 接口。
- **交互**：
  - 点小人：选中 + 镜头跟随 + **聚焦该 agent 的终端**（`OfficeCanvas.tsx` L604–635）；移动端两步点击（第一下选中，第二下打开终端）。
  - 终端是**真实 PTY**：独立模式下 `node-pty` + 服务端 headless xterm（`server/src/terminal/ptySessionManager.ts`），浏览器 xterm.js（`webview-ui/src/components/TerminalDrawer.tsx`、`TerminalPaneStack.tsx`）；可以在浏览器里给 Claude 打字、回答权限提示。没有结构化审批按钮。
  - `+ Agent` 从目录列表启动新的 Claude Code；agent 卡片条兼做终端 tab（`components/AgentCard.tsx`，状态点 idle 绿 / working 蓝 / attention 黄 / disconnected 红）。
  - 点击气泡即 dismiss（`officeState.dismissBubble`）。
- **层级**：subagent（`Task`）作为负 ID 的临时角色；Agent Teams 的 teammate 是持久角色，座位重排到 lead 旁边（`officeState.ts` `reseatNextToLead`），标签用 `TEAM_LEAD_COLOR` / `TEAM_ROLE_COLOR` 区分。
- **"需要注意"**：`permission` / `waiting` 两种气泡（`office/sprites/bubble-permission.json`）、可选提示音（`notificationSound.ts`）、`Notification(idle_prompt)` 时显示 "Waiting for input"、每个角色头顶的 context window gauge（警告 / 危险 / 临界三档）。
- **布局编辑器**：地板、墙、家具、地毯、宠物、命名 **Areas**（目录映射到区域，新 agent 坐进对应区域），undo/redo，JSON 导入导出，最大 64×64 tiles；外部资产包与 manifest（`docs/external-assets.md`、`scripts/asset-manager.html`）。
- **性能**：代码里没有 agent 数量上限 *(未找到常量)*；Canvas 单线程渲染，按座位数自然受限。
- **资产 license**：代码 MIT。角色"基于 JIK-A-4 Metro City 免费角色包"（README），CHANGELOG #117 称已把专有 tileset 换成开源资产；各资产包的具体 license 仓库内未列出 *(unverified)*。
- **和我们 roadmap 的关系**：办公室交互、会话控制（PTY）、Agent Teams 映射。
- **值得借鉴**：`TeamProvider` 的语义接口（问"谁在团队里"，不问"sidecar 文件在哪"）；hooks + JSONL 双通道；"点小人 = 聚焦终端"；context gauge；Areas 把目录映射到空间。
- **不足 / 我们的机会**：没有收件箱、没有审批卡片、没有 handoff 线；roadmap 里的 "Orchestrator characters / drag a box to form a team / hand work between agents" 还没做（README "Where This Is Going"）——这正是我们的位置，要抢在前面。
- **复用判断**：MIT，可借代码（如 `teamProvider.ts`、transcript parser、PTY drawer）；美术不要直接用。

### W17ant/Claude-Office

- https://github.com/W17ant/Claude-Office · ⭐ 345 · MIT（美术部分例外，见下）· TypeScript · 最近 push 2026-10-16 · 本地克隆：`references/repos/W17ant__Claude-Office` @ 1a9ba71
- **一句话**：等距像素办公室 + Slack 风格聊天面板 + Electron 桌面版；1.1 版加入"✋ Needs you"和在办公室里直接回答权限弹窗。
- **渲染**：React，角色和家具是绝对定位的 DOM `<img>` 精灵（`src/components/Character.tsx`、`FurnitureRenderer.tsx`），CSS 动画；昼夜循环（`daylight.ts`）、事故模式整层变红（`incident.ts`、`components/IncidentLayer.tsx`）。
- **事件接入**：19 个 Claude Code hook 事件 + status line（`hooks/hooks.json`、`hooks/agent-tracker.sh`、`hooks/status-line.sh`）→ Express + WebSocket（`server/index.js`）；聊天存 SQLite（`server/chat-db.js`）；inspector 读 transcript（`server/transcript.js`）。也打包成 Claude Code plugin（`.claude-plugin/plugin.json`）。
- **交互**：
  - **点任何角色 → inspector 卡片**：任务、调用过的每个工具（失败的标红）、tokens 和 model、transcript 末尾（`src/inspector.ts`，每 2s 轮询 `GET /agents/:id`，显示 10 条历史；`components/AgentCard.tsx`）。
  - **权限审批**（`server/permissions.js` 文件头注释写得很完整）：`PermissionRequest` hook POST 事件后长轮询 `GET /permission/:id`；办公室里点 Allow / Allow & remember / Deny 后，hook 从**决策词**自己拼输出（从不打印 server 给的 JSON），并校验 `HMAC(token, nonce + permissionId + decision)`；终端里先回答则记为 `resolved_elsewhere`，迟到的点击返回 409——"**The terminal always wins**"。headless `claude -p` 只等 15s，确认是交互会话后最多等 10 分钟。
  - 聊天面板：和一个 `claude -p` 驱动的"办公室经理"人格对话，按关键词路由到专家角色（`scripts/chat-ai-watcher.sh`）——**不进入真实工作会话**。
  - Agent-to-agent 消息：`scripts/agent-message.py` / `POST /chat/reply` / 部分 A2A 协议（`/.well-known/agent-card.json`、`POST /a2a`）；发送者**走到接收者的桌前**，接收者头顶出现未读 ✉ 徽章；每对 agent 每分钟限 10 条防死循环（`docs/reference.md` "Agent-to-agent messages"）。
  - 白板显示 Claude 的真实 task list（`taskBoard.ts`、`components/TaskBoard.tsx`），被阻塞的任务插红钉。
- **层级**：每个 Claude Code 会话一个"pill"和一个 Claude；subagent 按角色类型分配精灵和桌子；"boss"是用户本人。
- **"需要注意"**：举手 + 提示音 + session pill 变琥珀色 + 权限卡片；部署失败 → "Prod Is Down" 全屋变红、旋转警灯、事故计时、恢复后贴 postmortem（`signals.ts`、`incident.ts`）；Electron 托盘徽章 + 迷你 widget。
- **仪表**：Payroll（成本）、Electricity（tokens/min）、Memory（context 填充）每会话一套，外加 5h rate-limit pill（`meters.ts`、`components/Meters.tsx`）。
- **布局**：固定房间图（`rooms.ts`），无编辑器；有 `PlacementHelper.tsx` 调试摆位。
- **性能**：DOM 精灵，规模小时没问题；无显式上限 *(未见)*。
- **资产 license**：`NOTICE.md`——代码和原创像素美术 MIT；Dunder Mifflin 皮肤（`public/sprites/office/characters/`、`public/sprites/office/props/`、`src/theme.ts` 台词）**不在 MIT 授权内**。
- **和我们 roadmap 的关系**：收件箱、双向协议（面板 → agent 的审批）、办公室交互。
- **值得借鉴**：**整套权限审批协议**（长轮询、决策词、HMAC proof、终端优先、超时与交互会话判定）几乎可以直接搬到我们的 `serve`；inspector 卡片的信息结构；"发送者走到接收者桌前"作为 handoff 动画；A2A 速率限制。
- **不足 / 我们的机会**：聊天框是旁路 LLM，不是真实会话；没有收件箱列表（权限卡片是逐个弹出）；游戏彩蛋占比高。
- **复用判断**：代码 MIT 可借（尤其 `server/permissions.js` + `hooks/agent-tracker.sh` 的 PermissionRequest 段）；美术只借原创部分，并保留署名。

### paulrobello/claude-office

- https://github.com/paulrobello/claude-office · ⭐ 602 · MIT · TypeScript + Python · 最近 push 2026-11-05 · 本地克隆：`references/repos/paulrobello__claude-office` @ 3fe6424
- **一句话**：Next.js + **PixiJS 8** + FastAPI + Zustand 的像素办公室；主 agent 是 boss，subagent 是员工；有跨会话的 Command Center 和多楼层大楼。
- **渲染**：PixiJS（`frontend/src/components/game/OfficeGame.tsx`、`AgentSprite.tsx`、`BossSprite.tsx`），45° 正面俯视（**不是等距**，`docs/architecture/ARCHITECTURE.md` "Sprite Art Style"）；XState 风格状态机目录 `frontend/src/machines/`。
- **事件接入**：Python hooks 包（`hooks/src/claude_office_hooks/event_mapper.py`）→ FastAPI → 每会话一个 `StateMachine` → WebSocket；增量 tail transcript（`docs/fable/ENH-003-incremental-transcript-tailing.md`）；也支持 OpenCode 插件（`opencode-plugin/`）；`docs/research/openai-codex-hooks.md`、`google-gemini-cli-hooks.md` 是调研笔记。可选用 `claude` CLI 或 OpenAI 兼容端点生成 agent 名字和任务摘要（`docs/reference/ai-summary.md`）。
- **交互**：
  - 点角色 → `AgentPopup`（`frontend/src/components/attention/AgentPopup.tsx`），有 "Focus terminal" 按钮。
  - **Focus terminal 的实现**：`POST /sessions/{id}/focus` 在 macOS 上 `osascript 'tell application "Terminal" to activate'`，并可把一段消息**复制到剪贴板**（`backend/app/api/routes/sessions.py` L328–）——这是"没有双向通道时把话送进会话"的权宜办法，只能激活 Terminal.app，不能定位到具体窗口。
  - `CommandBar`：命令面板，按 agent 列出 "focus …"、dismiss-all 等（`attention/CommandBar.tsx`）。
  - 白板 12 种模式，数字键 0–9 / T / B / K 切换（todo、org chart、tool 饼图、kanban、heat map 等，`docs/reference/whiteboard-modes.md`）。
  - 楼层导航（面包屑、电梯）、replay 分页 *(见 v0.23.0 说明)*。
- **层级**：Agent Teams 时 `RoomOrchestrator` 把多个会话合并成一个 `GameState`，lead 固定金色，teammate 按到达顺序分配蓝 / 绿 / 紫 / 橙 / 粉 / 青；`task_created` / `task_completed` / `teammate_idle` 驱动合并后的 kanban（ARCHITECTURE "Multi-Floor / Agent Teams"）。
- **"需要注意"**：`attentionStore.ts` 给事件打紧急度分（permission_request 90 critical 不自动消失；error/stop 70；task_completed 30；subagent_start 10），右上角最多 5 条 toast，点击 toast 打开对应 agent 的 popup（`attention/AttentionToasts.tsx`）。**Command Center** 按 Needs-you / Working / Done / Ended 分区摆放所有会话的 boss，A* 寻路到空位（`components/command/CommandCenterZones.tsx`、`layout.ts`）。context 用"垃圾桶装纸"比喻，compaction 时 boss 跺垃圾桶。
- **布局**：`floors.toml` / `BuildingConfig` 定义楼层、房间与项目映射（`backend/app/core/floor_config.py`）；无可视化家具编辑器。
- **性能**：v0.24.0 把每帧 agent 写入合并成每 tick 一次 store 更新，gameStore 拆成 9 个 Zustand slice；`docs/fable/ENH-005-pixi-rendering-optimizations.md`、`ENH-002-delta-websocket-sync.md` 记录优化方案。
- **资产 license**：仓库只有一个 MIT `LICENSE`，未见单独的美术 license 或来源说明 *(unverified)*。
- **和我们 roadmap 的关系**：CEO 总览、收件箱（toast 队列）、多会话聚合。
- **值得借鉴**：Command Center 的四分区布局（直接对应我们的"CEO 总览"）；紧急度打分 + 是否自动消失的策略；`RoomOrchestrator` "多会话合并成一个场景"的数据流。
- **不足 / 我们的机会**：只读；"focus"只是激活 Terminal.app + 剪贴板；不能审批。
- **复用判断**：MIT，可借思路和部分代码；它的技术栈（Next + FastAPI）比我们重。

### iamlukethedev/Claw3D

- https://github.com/iamlukethedev/Claw3D · ⭐ 2,436 · MIT · TypeScript · 最近 push 2026-11-04 · 本地克隆：`references/repos/iamlukethedev__claw3d` @ 51337f7
- **一句话**：OpenClaw / Hermes / 自定义 runtime 之上的 3D 办公室 "Studio"；gateway 是控制面，"the product is the office"（README）。
- **渲染**：Three.js + `@react-three/fiber` + drei（`package.json`）；核心场景是单个 7,253 行组件 `src/features/retro-office/RetroOffice3D.tsx`；家具为 glb 模型（`public/office-assets/models/furniture/desk.glb` 等）。
- **事件接入**：浏览器 → Studio 同源 WebSocket 代理 → OpenClaw Gateway（`server/`，README "What Exists Today"）；`src/features/agents/state/gatewayEventIngressWorkflow.ts` 处理事件。**不接 Claude Code / Codex hooks**，依赖 gateway 协议。
- **交互**：
  - 点 agent：镜头 orbit target 移到该 agent，并打开它的**聊天面板**（`handleAgentClick` → `onAgentChatSelect`，L2926），消息经 gateway 送入该 agent 的真实 runtime（`features/agents/operations/chatSendOperation.ts`）。
  - **审批**：exec approval 卡片，三个按钮 allow-once / allow-always / deny（`features/agents/components/AgentChatPanel.tsx` L195–220，`features/agents/approvals/` 下 10 个文件管理 pending、过期、暂停策略）；徽章 `NEEDS_APPROVAL_BADGE_CLASS`（`colorSemantics.ts`）。
  - 右键 agent 菜单（目前只有 Copy ID）；点桌子 → "Desk actions"，把 agent 派到该桌（`handleDeskClick`）；hover 显示 tooltip；双击重置相机。
  - 沉浸式空间：standup 会议、GitHub PR review、QA 日志、analytics（`office/screens/GithubImmersiveScreen.tsx`、`components/panels/AnalyticsPanel.tsx`）。
  - Company builder：用自然语言规划公司角色（`features/company-builder/planning.ts`，产出 roles / purpose / soul）。
- **层级**：fleet sidebar（`FleetSidebar.tsx`）列出 agent；多办公室 beta 把远程机器的 agent 渲染成只读的第二间办公室，可发纯文本消息（`docs/multi-agent-beta.md`）。没有 lead → member 的可视化 *(未找到)*。
- **"需要注意"**：审批徽章、`useApprovalMetrics.ts` 统计；状态颜色语义集中在 `colorSemantics.ts`。
- **布局**：`/office/builder` 编辑并发布办公室布局（墙、门、桌、椅、沙发、乒乓桌、咖啡机……，`RetroOffice3D.tsx` L295–370 的家具目录）。
- **性能**：单个巨型组件、大量 `useMemo`；没有看到 agent 数上限 *(未找到)*。
- **资产 license**：MIT；家具 glb 文件名（`bookcaseClosed.glb`、`chairDesk.glb`、`kitchenCoffeeMachine.glb`）与 Kenney Furniture Kit（CC0）一致 *(unverified)*。
- **和我们 roadmap 的关系**：办公室交互（点 → 聊天）、收件箱（审批）、团队设计（company builder）。
- **值得借鉴**："点小人 = 镜头聚焦 + 打开聊天"的一步到位；allow-once / allow-always / deny 三态；审批的过期与暂停策略拆成独立 workflow 模块。
- **不足 / 我们的机会**：绑定 OpenClaw gateway；3D 场景信息密度低；7k 行单文件难维护。
- **复用判断**：只借思路（架构绑定 OpenClaw；3D 不是我们的方向）。

### GreenSheep01201/claw-empire

- https://github.com/GreenSheep01201/claw-empire · ⭐ 1,446 · Apache-2.0 · TypeScript · 最近 push 2026-03-16（近 8 个月无提交）· 本地克隆：`references/repos/GreenSheep01201__claw-empire` @ 66a24ea
- **一句话**："Command Your AI Agent Empire from the CEO Desk"——本地优先的虚拟软件公司模拟器，用户是 CEO，agent 按部门（Planning / Dev / Design / QA / DevSecOps / Ops）工作。
- **渲染**：React 19 + **PixiJS 8**（`src/components/office-view/buildScene*.ts`、`useOfficePixiRuntime.ts`），CEO 办公区 + 走廊 + 部门房间 + 休息室；移动端虚拟方向键控制 CEO 角色走动（`VirtualPadOverlay.tsx`）。
- **事件接入 / 会话控制**：自己 spawn CLI 子进程——Claude `--dangerously-skip-permissions --print --output-format=stream-json --include-partial-messages`，Codex `--yolo exec --json`，Gemini、OpenCode、Kimi 同类（`server/modules/workflow/core/cli-tools.ts` L55–93）；Express 5 + SQLite + WebSocket。
- **交互**：
  - 点角色（Pixi `pointerdown` → `onSelectAgent`，`buildScene-department-agent.ts` L63）→ `AgentDetail` 面板。
  - **CEO Chat 与 `$` 指令**：给组长发指令，可指定会议方式和项目路径；也能从 Telegram / Slack / Discord 等发 `$` 指令（README "Features"）。
  - **Decision Inbox**（`src/components/DecisionInboxModal.tsx`，488 行）：条目类型 `agent_request` / `project_review_ready` / `task_timeout_resume` / `review_round_pick`，每条有编号选项；可"选一个选项 + 附追问"，评审轮次可多选；回复以 `[Decision Reply]` 前缀写回聊天（`src/components/chat/decision-inbox.ts`）。
  - Kanban（Inbox → Planned → Collaborating → In Progress → Review → Done，拖拽）；Active-agent monitor 可**直接 kill 卡住的任务**；终端面板 `TerminalPanel.tsx` 看输出。
  - git worktree 隔离，"merged only on CEO approval"。
- **层级**：部门 → 组长 → 员工；会议系统（多轮评审、AI 生成会议纪要）；XP 与排行榜。
- **"需要注意"**：Decision Inbox 计数、超时续跑条目、stale `working` agent 自动恢复（v2.0.4）。
- **布局**：`OfficeRoomManager.tsx` 管理部门房间；部门排序可拖拽。
- **资产 license**：代码 Apache-2.0；`public/sprites/*.png` 角色精灵来源未说明 *(unverified)*。
- **和我们 roadmap 的关系**：CEO、收件箱、团队设计（office pack = 部门拓扑模板，含 `web_research_report` pack：Research Strategy / Crawler Team / Fact Check）。
- **值得借鉴**：**Decision Inbox 的数据结构与"选项 + 追问"交互**；`task_timeout_resume` 作为收件箱条目；office pack 作为可切换的团队模板；kill 卡住任务。
- **不足 / 我们的机会**：所有 agent 跳过权限，收件箱不含工具审批；headless `-p` 跑完即走，不能对运行中的会话追问；项目已停更 8 个月。
- **复用判断**：Apache-2.0 允许借代码（保留 NOTICE）；主要借收件箱设计。

### AgentSystemLabs/agent-office

- https://github.com/AgentSystemLabs/agent-office · ⭐ 886 · MIT · TypeScript · 最近 push 2026-10-09 · 本地克隆：`references/repos/AgentSystemLabs__agent-office` @ 852e2ab
- **一句话**："A 3D office your team shares with its coding agents"——多人共享的 3D 办公大楼，每个 GitHub repo 一层楼，每张桌子一个真实 CLI worker（Claude Code、Codex、OpenCode、Grok、Muse、DeepSeek Harness、Pi、Cursor）。
- **渲染**：Three.js（`package.json`），第一人称 / 第三人称走动（WASD），worker 的终端**实时显示在桌上笔记本屏幕上**（服务端 headless xterm 镜像，按行 diff 每秒数次推送，`docs/how-it-works.md`）；另有 `/lite` 2D 版给手机和慢机器（`src/client/lite.ts`）。
- **事件接入 / 会话控制**（`docs/how-it-works.md`）：
  - 每个 worker 一个 node-pty（`src/server/ptyhost.ts`，独立进程 `agent-office-ptys`，server 重启时 PTY 不死，重连后拿屏幕快照）。
  - Claude worker 启动时带 `--settings .agent-office/claude-hooks.json`，hooks（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Notification`、`Stop`、`SessionStart`）curl 一个只监听 loopback、每 worker 独立 token 的 hook server；OSC 9;4 进度序列兜底捕捉 Esc 取消。
  - Codex 用生成的 command helper；OpenCode 用生成的插件；DeepSeek Harness 走 **ACP**（`session/request_permission` 未决 = needs input）。
  - 成本从 transcript JSONL 的 usage 字段累计。
- **交互**：
  - 走到桌前按 **E**：雇 worker / 打开它的终端（任何人都能打字，多人共享同一 PTY）；**P** 派任务；**C** 看 diff、commit、开 PR；**X** 送回家；**L** 给桌子挂牌子（"Operations"）；**N** 跳到下一个等你的人；Tab 打开所有窗口；Ctrl+Space 语音听写进终端（README "Controls"，`src/client/ui/help.ts`）。
  - GitHub issues / PR 挂在软木板上，可"Hand to a worker"；任务队列按空桌和并发上限自动派工。
  - **agent 管 agent**：`agent-office` MCP server / `office-workers` 命令，worker 可以 list / hire / tell / send home 其他 worker（`src/server/office-workers.ts`、`bin/office-workers.js`）。
  - 会议：多个 worker 坐到会议桌，共享一个 worktree，按轮次写 `.meeting/` 文件（`src/server/meetings.ts`）。
- **层级**：楼层 = 项目；没有 lead/member 树，平级 worker + 会议 + board agent（issues / PR / queue 三个 kiosk agent，queue agent 用 `--disallowedTools Edit Write NotebookEdit` 禁止改文件）。
- **"需要注意"（本轮最完整）**：
  - worker 需要输入时桌上亮**红色信标**，顶栏横幅写明谁、为什么，响警报；完成时跳起来并 ding（README "What it is"）。
  - `src/client/nextup.ts`：`waitingInOrder` 先排 `needs_input` 再排"已完成但没人看过"，各自按等待时长降序；**N** 依次跳转。
  - `ui/compass.ts`：屏幕边缘箭头指向视野外的等待者。
  - 顶栏和 Workers 面板显示等待计数；电梯面板显示每层 busy / waiting 数；其他楼层有人开始等待时弹 heads-up（`docs/features.md`）。
- **布局**：地图是 JSON（`src/shared/maps/`，`docs/maps.md`），可自定义；"Room to grow" 拆墙扩桌。
- **性能**：PTY 镜像按行 diff；`framerate.ts` 监控帧率，慢机器提示切 `/lite`。
- **资产 license**：MIT；`blender/` 目录有自建模型脚本，未见第三方美术声明 *(unverified)*。
- **和我们 roadmap 的关系**：会话控制（PTY + hooks + ACP）、办公室交互、收件箱、M3"可操作的面板"、M4 桌面 app。
- **值得借鉴**：**`N` 键 + 等待排序 + 边缘指针 + 顶栏计数**这一整套 alert queue；"已完成但没人看过"也算等你；PTY host 独立进程、server 重启不丢会话；`/lite` 2D 降级视图；board agent 的工具白名单。
- **不足 / 我们的机会**：没有结构化审批卡片（在终端里回答）；没有组织层级、没有 checker 语义；彩蛋（跑车、高尔夫、城堡地牢）极多；作者明说 "built for one person's workflow"，breaking changes 频繁。
- **复用判断**：MIT，可借代码（`nextup.ts`、`compass.ts`、ptyhost 设计）；整体产品形态（多人 3D 世界）不适合我们。

---

## 2. 其他项目（简表式记录）

以下 10 个项目由并行的只读 Explore 子任务读码整理，我抽查了关键文件（bagidea `daemon/approvals.js`、`daemon/perm.js`，KbWen `PairLink.jsx`）。

### bagidea/bagidea-office

- https://github.com/bagidea/bagidea-office · ⭐ 261 · MIT（美术混合，见下）· JavaScript + GDScript + Rust · 最近提交 2026-11-01 · 本地克隆：`references/repos/bagidea__bagidea-office` @ 68e2d04
- **一句话**：自带 runtime 的"桌面壁纸 AI 办公室"——daemon 起 headless `claude -p` 人格会话（`--resume` 续接），stream-json 变成世界事件；Godot 4.6 HD-2D 场景作为桌面壁纸运行。
- **架构要点**：Node daemon（`daemon/server.js`）→ WebSocket → Godot（`godot/scripts/event_client.gd`、`agent_manager.gd`）；Rust shell + WebView2 overlay（`daemon/overlay.html`）承载聊天和管理；事件 journal `journal.jsonl` 在连接时重放。外部 Claude Code 会话只转发 `UserPromptSubmit` / `PostToolUse` / `Stop`，只用于让 Director 动起来。
- **交互**：壁纸本身不接收输入；在 overlay 的头像栏或 "OFFICE MAP — click an agent to chat" 点 agent → **真实聊天进入该 agent 的可续接会话**（线程、附件、语音、context meter）。CEO 席位通过 Director 下派；任务板、日历、workflow 引擎；7 种手机渠道。
- **审批**：`PreToolUse` hook（`daemon/perm.js`）长轮询 daemon 最多 55s，超时 deny；agent 进入 blocked、播 alert 特效并**走到 Security Center**；overlay 弹出具体命令，Allow / ✓✓ Forever / Deny。**统一收件箱** `daemon/approvals.js`：`tool-permission`、`project-trust`、`proposal`、`blocked`、`job` 五类进一个持久化队列，"The queue is an INDEX plus the round-trip"，各类 resolver 原地不动。
- **层级**：CEO（金色铭牌 + 王冠）→ Director（蓝色）；`DELEGATE:` 时演一段交接步行；`SUB:` 创建的 subagent 是半透明"幽灵分身"，爬上 12 桌的 Ghost Deck，完成后融回主人；卡住 6 分钟回收。MMO 式铭牌带状态 pill（IDLE / WORKING / MEETING / BLOCKED / OFFLINE）。
- **"需要注意"**：`daemon/notify.js` 按事件类型路由到侧栏 🔔、toast、手机或声音，支持 quiet hours 与离开检测；审批铃声 ding / 拒绝 buzz；overlay 的 Security 灯琥珀色脉动。
- **布局编辑器**：`godot/scripts/map_editor.gd`（3×3 房间格、家具、墙、导入 glb/gltf/fbx）。
- **性能**：`MAX_STAFF = 18`（`daemon/constants.js`）；壁纸 30 fps、被遮挡时暂停。
- **资产 license**：代码 MIT；美术混杂——部分 CC0 有 license 文件，xzany 猫**禁止再分发**（`godot/assets/characters/cat/License.txt`），其余只在 README 致谢、仓库内无 license 文件。**不要搬美术。**
- **复用判断**：借 `approvals.js` 的统一队列设计和 `notify.js` 的路由规则；runtime（`claude -p` 人格）与我们"真实官方会话"的定位不同。

### KbWen/agent-virtual-office

- https://github.com/KbWen/agent-virtual-office · ⭐ 68 · MIT · JavaScript · 最近提交 2026-10-30 · 本地克隆：`references/repos/KbWen__agent-virtual-office` @ 48e0e23
- **一句话**：纯 SVG 像素办公室（所有角色和家具都是代码画的 SVG 图元，无位图），`?mode=panel` 可嵌进 IDE 侧栏。
- **架构要点**：hooks 写 `~/.claude/office-status*.json`，`server.mjs` 用 `fs.watch` 合并后经 **SSE** 推送（`/api/status/stream`）；支持 Codex 原生 hooks、Gemini CLI hooks、Antigravity transcript tail。8 个固定角色（pm、arch、dev、qa、ops、res、gate、designer），会话按关键词正则映射到角色（`src/inference/agentRouter.js`）——**不是一会话一角色**。
- **交互**：点角色 → SVG 内的 `AgentInspector.jsx` 弹层（状态、任务、在该状态的时长、活动日志、当日完成清单）；Esc 关闭；右键"戳一下"。无聊天、无审批、无终端。
- **层级 / handoff**：subagent 是染上 lead 颜色的小 helper，桌边围成一圈，最多 3 个后显示 "+N"（`HelperHuddle.jsx`）；**两个 agent 改同一文件时画桌间连线 + 🔗 文件标签**（`PairLink.jsx`）；阶段转换播"飞文件"箭头（`workflowHandoff.js`）。
- **"需要注意"**：`awaiting-approval` ⏳ 青色环、`blocked` 🚫；每种 `reasonCode` 一个不同形状的头顶徽章（`blockedReasonBadge.jsx`）；反复失败检测（`systems/recurringFailure.js`）；只在 blocked ≥30s 且标签页隐藏时才发桌面通知，每段只发一次（`inference/desktopNotifier.js`）。
- **资产 license**：MIT，全部美术由代码生成。
- **复用判断**：与我们技术路线最接近（SVG + SSE）；可借 `PairLink`、原因徽章、"30s + 隐藏才通知"的降噪规则。

### simple10/agents-observe

- https://github.com/simple10/agents-observe · ⭐ 714 · MIT · TypeScript · 最近提交 2026-09-04 · 本地克隆：`references/repos/simple10__agents-observe` @ b3a7238
- **一句话**：Claude Code plugin 形态的会话 / 多 agent 可观测性面板（Hono + SQLite + React）。
- **架构要点**：约 27 个 Claude hook 事件（含 `PermissionRequest`、`PermissionDenied`、`Elicitation`、`TaskCreated/Completed`、`TeammateIdle`、`StopFailure`）；Codex 5 个 hook + transcript 解析；WebSocket 按会话订阅（`app/server/src/websocket.ts`）。
- **交互**：只读。事件流可展开 payload，Pre/Post 合并成一行；timeline 回放（`timeline-rewind.tsx`）；快捷键 `/` 搜索、`a` agents、`f` filters、`b` 侧栏、`e` 事件流（`hooks/use-region-shortcuts.ts`）。**Constellation 主题**：SVG 力导向星图，每个会话一颗星、subagent 是轨道点，点星 → 同一 SVG 内画出径向 subagent 树和 14 行事件 ticker（`dashboard/themes/constellation/`）。
- **"需要注意"**：会话发出 `Notification` 时打 pending 标记、下一次活动自动清除；侧栏铃铛未读数、会话高亮、**favicon 换成告警版**。
- **性能**：`@tanstack/react-virtual` 虚拟列表、agent 更新 debounce、事件签名去重。
- **复用判断**：MIT；借"pending 自动清除"语义、favicon 告警、虚拟化事件流。

### disler/claude-code-hooks-multi-agent-observability

- https://github.com/disler/claude-code-hooks-multi-agent-observability · ⭐ 1,567 · **无 LICENSE 文件**（默认保留所有权利）· Python + Vue · 最近提交 2026-02-08 · 本地克隆：`references/repos/disler__claude-code-hooks-multi-agent-observability` @ 8a6e5cf
- **一句话**：hooks → Bun server（SQLite）→ Vue 事件时间线 + Canvas swimlane 的参考实现，很多后来项目的起点。
- **交互**：点 agent 标签加一条对比 swimlane；`ChatTranscriptModal.vue` 只读 transcript（搜索、角色过滤）。**自定义 HITL 协议**（`app_docs/how_human_in_the_loop_v1_works.md`、`.claude/hooks/utils/hitl.py`）：agent 自己开 WebSocket、POST `humanInTheLoop` 事件，面板显示黄色脉动卡片（Approve/Deny、自由文本、选项按钮），回答经 `POST /events/:id/respond` 回传。原生 `PermissionRequest` 只记录不回应。
- **"需要注意"**：浏览器 Notification "Agent Needs Your Input"、TTS 播报（ElevenLabs → OpenAI → pyttsx3）。
- **性能**：客户端保留 300 条事件，swimlane 30 fps。
- **复用判断**：无 license，**只能借思路**。

### OpenBMB/ChatDev（2.0 web console）

- https://github.com/OpenBMB/ChatDev · ⭐ 34,703 · Apache-2.0 · Python + Vue · 最近提交 2026-10-30 · 本地克隆：`references/repos/OpenBMB__ChatDev` @ 464a681（main 分支；1.0 的 visualizer 在 `chatdev1.0` 分支，未克隆）
- **一句话**：ChatDev 2.0（"DevAll"）的 Vue 3 + Vue Flow 控制台，YAML 定义 workflow，运行页有 chat / graph 两种模式。
- **架构要点**：WebSocket `/ws?session_id=`，消息类型 `log`、`human_input_required`、`artifact_created`、`workflow_completed`、`error`、`session_resumed`；重连时重放最多 1000 条（`server/services/session_store.py`）。
- **交互**：运行页 `frontend/src/pages/LaunchView.vue`（3,705 行）；每个 DAG 节点随机分配一个像素角色（12 种，`src/utils/spriteFetcher.js`），活跃节点走路动画，**边条件满足时精灵沿边从源走到目标**（`animateSpriteAlongEdge`）——这是本轮最直接的 handoff 可视化。单一输入框：`human_input_required` 时输入框发光，回复以 `{type:'human_input'}` 送回（`server/services/prompt_channel.py` 阻塞等待）。节点只 hover 高亮，无单 agent 抽屉。`WorkflowView.vue` 是完整的图编辑器。
- **复用判断**：Apache-2.0；借"精灵沿边走 = handoff"与 human_input gate 的协议形状。精灵来源未说明 *(unverified)*。

### ringhyacinth/Star-Office-UI

- https://github.com/ringhyacinth/Star-Office-UI · ⭐ 7,564 · 代码 MIT / **美术仅限非商业** · HTML + Python · 最近提交 2026-03-11 · 本地克隆：`references/repos/ringhyacinth__Star-Office-UI` @ f29c107
- **一句话**：给 OpenClaw 的"状态小屋"：Phaser 3 单场景（1280×720），6 种状态（idle、writing、researching、executing、syncing、error）各对应一个区域，角色走过去。
- **架构要点**：Flask 后端，主 agent 写 `state.json`，前端每 2s 轮询；访客 agent 每 15s push，UI 每 2.5s 拉取；一次性 join key 每 key 最多 3 个并发。
- **交互**：只有家具可点；agent 不可点、无聊天、无 transcript。`/agent-approve`、`/agent-reject` 端点存在，但前端函数从未调用，`/join-agent` 直接置 approved——**审批是死代码**。"装修房间"抽屉可上传 / 替换精灵、调整位置、用 Gemini 生成背景。
- **"需要注意"**：error 状态把角色移到"bug 角落"并播 bug 精灵；300s 无 push 自动离线。
- **资产 license**：`LICENSE` §2：美术仅限非商业学习，商用必须全部替换；访客角色是 LimeZu 免费包，需署名。
- **复用判断**：状态 → 区域的空间编码是好想法（"在哪儿"就是"在干什么"）；代码与美术都不建议直接用。

### a16z-infra/ai-town

- https://github.com/a16z-infra/ai-town · ⭐ 10,767 · MIT · TypeScript · 最近提交 2026-11-04 · 本地克隆：`references/repos/a16z-infra__ai-town` @ 1b2f7d8
- **一句话**：Convex + PixiJS 的 AI 小镇 starter kit，agent 自主社交，人类可以登录成为一个角色加入对话。
- **架构要点**：状态全在 Convex，客户端 `useQuery` 响应式订阅；引擎 60 tick/s 批成每秒一个 step，客户端用"历史位置缓冲"平滑插值（`src/hooks/useHistoricalTime.ts`）。
- **交互**：点角色 → 右栏 `PlayerDetails.tsx`（名字、描述、当前活动、实时对话 / 上一段对话）；人类 "Interact" 生成化身，点地图移动，可发起对话、接受 / 拒绝邀请，在 `MessageInput.tsx` 打字；`pixi-viewport` 平移缩放；Freeze 按钮。
- **限制**：`convex/constants.ts`：`MAX_HUMAN_PLAYERS = 8`、`MAX_CONVERSATION_MESSAGES = 8`；`ARCHITECTURE.md` 说整局状态每步全量加载，需保持在"几十 KB"，输入延迟约 1.5s。
- **资产 license**：代码 MIT；美术来自 OpenGameArt 等，仅在 README 致谢，各自 license 适用 *(unverified)*。
- **复用判断**：借"人类作为一个角色进入同一空间对话"的隐喻与历史缓冲插值；不是 coding agent 场景。

### joonspk-research/generative_agents

- https://github.com/joonspk-research/generative_agents · ⭐ 22,357 · Apache-2.0 · Python · 最近提交 2023-08-11（停更）· 本地克隆：`references/repos/joonspk-research__generative_agents` @ fe05a71
- **一句话**：Smallville 论文代码；Phaser 3 + Django，Tiled 地图，25 个 persona。
- **交互**：精灵不可点击（无 `setInteractive`）；侧栏列出每个 persona 的当前动作和对话，"State Details" 链到只读的记忆表；replay 和 demo（1–5 倍速）。人类只能在后端终端里 `call -- analysis <persona>`。
- **资产 license**：代码 Apache-2.0；`map_assets/` 含付费素材包原始 zip，**不可复用**。
- **复用判断**：只有历史意义；"每个角色头顶 emoji + 缩写"（pronunciatio）是低成本的状态标签。

### harishkotra/agent-office

- https://github.com/harishkotra/agent-office · ⭐ 405 · MIT · TypeScript · 最近提交 2026-09-24 · 本地克隆：`references/repos/harishkotra__agent-office` @ 58f11f9
- **一句话**：Phaser 3 + Colyseus 的模拟办公室，agent 是 Ollama / OpenAI 兼容 LLM，会互相雇人、派任务。
- **交互**：点角色只切换镜头跟随并派发 `agent-focus` 事件，但**没有监听者**；`AgentInspector` 在 `App.tsx` 里写死为 Alice。全局聊天、TaskBoard `assign-task`、"chaos" 场景按钮；布局编辑器可拖家具。
- **资产**：角色精灵与 pixel-agents 的逐字节相同（JIK-A-4 来源）。
- **复用判断**：反例——演示性强、交互是空壳。

### jefferysha0627/agent-office-3d

- https://github.com/jefferysha0627/agent-office-3d · ⭐ 129 · MIT · JavaScript · 最近提交 2026-11-01 · 本地克隆：`references/repos/jefferysha0627__agent-office-3d` @ 077d302
- **一句话**：Three.js 低多边形办公室，8 张桌子；空闲的 agent 可以溜去玩 Minecraft（Mineflayer bot 画面投到桌上显示器）。
- **架构要点**：不接 hooks，轮询 Herdr 终端复用器（`herdr agent list` 每 3s、`herdr agent read` 每 6s，仅前台标签页），用只读白名单 `execFile`（`lib/sources.js`）。
- **交互**：点 agent（raycaster 或名牌）→ 侧栏显示终端最后几行（只读，打开时刷新加速到 2s）；拖拽平移、滚轮缩放、方向键平移。
- **"需要注意"**：blocked 时名牌红闪 + 头顶 "!"，横幅"X 需要确认，请去终端查看"；无声音、无审批按钮。
- **复用判断**：借"面板打开时提高该 agent 的刷新频率、后台标签页暂停轮询"的节流策略。

### 其他检索到但未深入的项目

- `rolandal/pixel-agents-standalone`（57⭐）、`ray24724919/pixel-agents-multi`、`gcampton/Agent-Pixels` 等是 pixel-agents 的派生，未见新交互。
- `w4llisz/codex-visualizer`（1⭐，MIT）：直接连 `codex app-server` WebSocket（JSON-RPC），显示 context 余量、活跃工具、spawned sub-agents、plan 进度；协议类型由 `codex app-server generate-ts` 生成（README，经 `gh api` 读取）。说明 Codex 侧的结构化事件源是 app-server，可作为我们 Codex 适配器的参考。
- RTS 关键词（"agent rts"）只搜到 0–5⭐ 的游戏原型（如 `codyborn/agent-rts`、`hungnv26/agent-rts`），**没有成熟的 RTS 式 agent 管理界面**。

---

## 3. 平台类参考：LangGraph Studio 与 Langfuse agent graphs（仅文档）

### LangGraph Studio（LangSmith Studio）

- 来源：https://docs.langchain.com/langsmith/studio 、https://docs.langchain.com/langsmith/use-studio（2026-11-07 抓取）
- **Graph mode** 显示"the nodes traversed, intermediate states"；**Chat mode** 面向业务用户，仅限 state 继承 `MessagesState` 的图。
- **交互**：在 graph mode 点 **Interrupt**，"Select a node and whether to pause before or after that node has executed"，在 thread log 里点 **Continue** 恢复；**Edit node state** 改某节点输出；**Fork** / **Re-run from here** 从选中节点的 checkpoint 分叉新 run（time travel）。
- 文档未说明 subgraph / multi-agent 的呈现方式 *(unverified)*。
- **对我们的意义**：断点（"在某角色开始前 / 完成后暂停"）+ 编辑状态 + 从 checkpoint 分叉，正好对应我们 H5 的"阶段之间的人工 gate"和 H6 的"追问只派回需要的角色"。这是开发者视角，我们要做成非工程师能用的版本。

### Langfuse agent graphs

- 来源：https://langfuse.com/docs/observability/features/agent-graphs（2026-11-07 抓取）
- trace 详情里与 Tree、Timeline 并列的 **Graph** tab；trace 中出现非 `span` / `event` / `generation` 类型的 observation 时，Langfuse 视其为 agentic，"from the observations' timings and nesting" 推断图。
- **Aggregated** 视图把同名步骤合并成一个节点（如 `retrieve_docs (3/3)`），循环画成环；**Expanded** 视图把循环展开成按执行顺序的 DAG，可点单个节点检查。
- 纯事后观察，没有任何干预能力；文档未说明多 agent handoff 如何呈现 *(unverified)*。
- **对我们的意义**：Aggregated / Expanded 双视图适合我们的"团队结构图 vs 本次执行回放"；`(3/3)` 计数可以直接用在角色卡上（"finder × 3，已完成 2"）。

---

## 4. 交互设计可借鉴清单

对照我们现在的面板：`panel/office.js` 是只读的 30° 轴测 SVG（"read-only" 写在文件头），点小人 → 侧栏角色卡（`panel/app.js` `select()`）；有 flag / needs-you 状态、活动 feed、handoff 路线高亮（`drawRoutes` / `highlightRoutes`）和结果抽屉（`#drawer`）。**缺的全是"面板 → agent"方向**：抽屉里没有实时记录 tab、没有聊天框、没有审批按钮、没有收件箱、没有跳转快捷键。

### 4.1 值得采用的交互模式

| # | 模式 | 做得最好的项目 | 关键实现 | 我们怎么用 |
|---|---|---|---|---|
| P1 | **在办公室里回应权限弹窗**，终端优先 | W17ant/Claude-Office | `server/permissions.js`：`PermissionRequest` hook 长轮询；决策词 allow / allow-remember / deny 由 hook 自己拼输出；HMAC proof；他处已回答 → `resolved_elsewhere`，迟到点击 409；headless 15s、交互会话 10 分钟 | 协议 0.2 加 `permission.requested` / `permission.resolved{decidedBy}`；`mas serve` 实现同样的长轮询；抽屉和收件箱都放三按钮 |
| P2 | **统一的"需要你"队列** | bagidea-office（权限 + trust + 提案 + blocked + job）；claw-empire（决策 + 编号选项 + 追问） | `daemon/approvals.js` "INDEX plus the round-trip"，记录持久化、重启后重问；`DecisionInboxItem{kind, options, requestContent}` | 收件箱条目 kind：`permission`、`question`（`AskUserQuestion` / elicitation）、`decision`（Lead 要你拍板）、`flag`（checker 举旗）、`gate`（阶段间人工 gate）；每条可"选项 + 一句话追问" |
| P3 | **`N` 键跳到下一个等你的人** + 屏幕边缘指针 + 顶栏计数 | AgentSystemLabs/agent-office | `src/client/nextup.ts` `waitingInOrder`：needs_input 优先，其次"已完成但没人看过"，各自按等待时长；`ui/compass.ts` 边缘箭头 | 直接照搬排序规则；SVG 视野外的人用边缘箭头；顶栏 "✋ 2 · ✓ 1" |
| P4 | **点小人 = 镜头聚焦 + 打开该 agent 的对话** | Claw3D（聚焦 + 聊天面板一步到位）；pixel-agents（聚焦 + 真实终端） | `RetroOffice3D.tsx` `handleAgentClick`；`OfficeCanvas.tsx` `performTap` | 抽屉三个 tab：**记录**（结构化 transcript，如 W17ant inspector）、**终端**（原始 PTY，可接手）、**产出**（现有结果抽屉）；底部聊天框发进真实会话 |
| P5 | **结构化 inspector** | W17ant/Claude-Office | `src/inspector.ts`：任务、工具调用（失败标红）、tokens、model、transcript 末尾 | "记录" tab 的默认视图；对非工程师隐藏原始 JSON |
| P6 | **按紧急度打分的 toast** | paulrobello/claude-office | `stores/attentionStore.ts`：permission 90 不自动消失、error 70、完成 30 自动消失 | 和 P2 共用一套 severity；只有 ≥ high 才出 toast，其余只进 feed |
| P7 | **CEO 总览按状态分区** | paulrobello/claude-office Command Center | Needs-you / Working / Done / Ended 四区，A* 走到对应区 | 我们是单团队，可做成"状态即位置"：举手的人走到 Lead 桌前排队（agent-office 城堡地图里完成者"在王座前排队"也是同一思路） |
| P8 | **handoff 动画** | ChatDev 2.0（精灵沿 DAG 边走）；W17ant（发送者走到接收者桌前）；KbWen（飞文件 + `PairLink` 共改同一文件连线） | `LaunchView.vue` `animateSpriteAlongEdge`；`PairLink.jsx` | 现有 `drawRoutes` 上加一次性"递文件"动画，交接完成后线保留为淡色，可点开看交接内容 |
| P9 | **降噪规则** | KbWen | `desktopNotifier.js`：blocked ≥30s 且标签页隐藏才发系统通知，每段一次 | 系统通知只用于 needs-you；同一 episode 只发一次 |
| P10 | **pending 自动清除 + favicon 告警** | simple10/agents-observe | 下一次活动清除 `pending_notification_ts`；`favicon-alert.svg` | 浏览器标签页标题加 "(2)"、favicon 变色 |
| P11 | **context / 成本仪表挂在角色身上** | pixel-agents（头顶 context gauge 三档）；W17ant（Payroll / Electricity / Memory） | `ToolOverlay.tsx`；`meters.ts` | 角色卡显示 context 填充和本轮成本；超阈值时变色而非弹窗 |
| P12 | **2D 降级视图** | AgentSystemLabs/agent-office `/lite` | `src/client/lite.ts` | 我们的 M3 终端版界面 = 同一 snapshot 的另一种渲染 |
| P13 | **派任务 / 送回家 / kill 卡住的 agent** | agent-office（`P` / `X`）；claw-empire（Active-agent monitor 的 kill） | `src/server/office-workers.ts` `POST /tell`、`/home` | 角色右键菜单：追问、派下一个任务、中断（Esc）、结束 |

### 4.2 应避免的模式

- **旁路聊天冒充"和 agent 对话"**：W17ant 的聊天框是另一个 `claude -p` 人格，不进入真实会话；harishkotra 的 inspector 写死为 Alice、点击事件没有监听者。我们的聊天框必须直达真实会话，否则不要放。
- **"focus terminal" 只激活 Terminal.app + 剪贴板**（paulrobello `sessions.py` `/focus`）：定位不到具体窗口，用户还要自己粘贴。我们有 PTY / app-server / SDK 时不需要这个权宜办法。
- **跳过权限换流畅**：claw-empire 全部 `--dangerously-skip-permissions`，于是收件箱里没有工具审批；这与我们"管得住"的定位冲突。
- **游戏彩蛋压过信息**：Dunder Mifflin 皮肤、跑车、高尔夫、城堡地牢、Minecraft。游戏感应来自直接操作和反馈（举手、排队、走过去交接），不来自无关小游戏。
- **会话 ≠ 角色的映射**：KbWen 把会话按关键词正则塞进 8 个固定角色，用户看到的角色和真实会话对不上。我们必须一会话一角色，或者明确标出"这是 subagent"。
- **只在终端里能审批**（pixel-agents、agent-office、agent-office-3d 的横幅只说"去终端看"）：对非工程师门槛太高。
- **巨型单文件场景组件**：Claw3D `RetroOffice3D.tsx` 7,253 行、ChatDev `LaunchView.vue` 3,705 行、Star-Office-UI `index.html` 4,889 行，都是功能堆进渲染层的结果。我们保持 reducer / snapshot 与渲染分离。
- **审批死代码**：Star-Office-UI 有 approve / reject 端点但从未调用。功能要么端到端打通，要么不露出。
- **直接搬美术**：Star-Office-UI 美术非商业、W17ant 皮肤排除在 MIT 外、bagidea 猫禁止再分发、generative_agents 含付费包。

### 4.3 RTS 式 affordance 的现状

| RTS affordance | 出现在哪里 | 缺口 / 我们的做法 |
|---|---|---|
| **Idle-worker alert**（空闲工人按钮） | agent-office `N`：needs_input + "已完成未查看"；claw-empire 的超时续跑条目；Claude Code 的 `TeammateIdle` 被 pixel-agents / paulrobello 用来更新状态 | 只有 agent-office 做成了"一键跳过去"。我们：`N` = 下一个需要你的人，`Shift+N` = 下一个空闲可派活的人 |
| **Alert queue**（事件队列，点击跳转） | paulrobello toast（点击打开 popup）；bagidea 🔔 侧栏列表；agents-observe 铃铛未读数 | 都是列表或 toast，没有和地图位置联动的"按空格跳到最近一次事件"。我们：收件箱条目点击 = 镜头移到该角色 + 打开抽屉 |
| **Minimap** | agent-office 的电梯面板（每层 busy / waiting 计数）近似；bagidea overlay 的 "OFFICE MAP" 快照 | 没有真正的小地图。我们的办公室一屏能放下，不需要小地图；用顶栏状态条（每个角色一个色点）替代 |
| **Control groups**（编组 + 数字键） | pixel-agents roadmap 写着"drag a box to form a team"，未实现；paulrobello 的数字键 0–9 是切白板模式，不是编组 | 全行业空白。我们的团队由用户设计并锁定，编组天然存在（finder 组、checker 组）：数字键选组、组内群发追问 |
| **Hotkeys** | agent-office 最全（E / P / C / N / X / L / T / Tab / Esc）；agents-observe（`/` `a` `f` `b` `e`）；paulrobello CommandBar 命令面板 | 我们：`N` 下一个、`I` 收件箱、`A` / `D` 批准 / 拒绝当前条目、`Enter` 聚焦聊天框、`Esc` 关闭抽屉、`1–9` 选组、`⌘K` 命令面板 |
| **Selection + context menu** | Claw3D 右键菜单（目前只有 Copy ID）；KbWen 右键"戳一下" | 右键菜单装 P13 的动作 |
| **Unit status over head**（血条） | pixel-agents context gauge；bagidea MMO 铭牌 + 状态 pill；W17ant 未读 ✉ 徽章 | 我们已有 flag / needs-you 图标；补 context 条和"有未读交接"徽章 |
| **Rally point / 派兵** | agent-office "Hand to a worker"、点桌子派人（Claw3D `handleDeskClick`） | 把收件箱里的 checker flag 拖到某个角色身上 = 派它返工 |

**结论**：RTS 隐喻里最有价值、也最少人做的是 **idle-worker 按钮 + 编组 + 和地图联动的 alert queue**。agent-office 证明了前一项可行；后两项是空白，正好对应我们"锁定的团队"和"checker 举旗"这两个差异点。

---

## 5. 对比表

图例：✅ 有，端到端可用 · ◐ 部分 / 旁路 · ✗ 无。"真实会话"指 Claude Code / Codex 等官方 CLI 会话。

| 项目 | ⭐ | 代码 license / 美术 | 渲染 | 事件接入 | 点击角色 | 发消息进真实会话 | 结构化审批 | "需要你"汇总 | 层级 / handoff 可视化 | 快捷键 / RTS 跳转 |
|---|---|---|---|---|---|---|---|---|---|---|
| pixel-agents | 10,099 | MIT / 角色基于 JIK-A-4 | Canvas 2D (React) | hooks + JSONL | 聚焦真实终端 | ✅ PTY 终端 | ✗（终端里答） | ◐ 气泡 + 声音 | lead / teammate 颜色、座位靠近 lead | ✗ |
| W17ant/Claude-Office | 345 | MIT / Office 皮肤除外 | DOM 精灵 (React) | 19 hooks + status line | inspector 卡片 | ◐ 聊天是旁路 LLM | ✅ Allow / Remember / Deny | ◐ 举手 + 卡片 | 走到接收者桌前 | ◐ 斜杠命令 |
| paulrobello/claude-office | 602 | MIT | PixiJS 8 | hooks + transcript tail | popup + focus | ◐ 剪贴板 + 激活 Terminal | ✗ | ✅ 紧急度 toast + Command Center | boss / 员工、teammate 配色 | ◐ 命令面板、白板数字键 |
| Claw3D | 2,436 | MIT / glb 疑为 CC0 | Three.js (R3F) | OpenClaw gateway | 聚焦 + 聊天面板 | ✅ 经 gateway | ✅ once / always / deny | ◐ 徽章 | ✗ | ✗ |
| claw-empire | 1,446 | Apache-2.0 / 精灵来源未知 | PixiJS 8 | 自己 spawn `-p` stream-json | AgentDetail | ◐ CEO 指令（非运行中会话） | ✗（skip permissions） | ✅ Decision Inbox | 部门 / 组长 / 会议 | ✗ |
| AgentSystemLabs/agent-office | 886 | MIT | Three.js + `/lite` 2D | PTY + hooks + ACP + plugins | 走近按 E 开终端 | ✅ 共享 PTY | ✗（终端里答） | ✅ 信标 + 横幅 + 计数 | 平级 + 会议 | ✅ `N`、边缘箭头、全套热键 |
| bagidea-office | 261 | MIT / 美术混杂 | Godot 4 壁纸 + WebView overlay | 自有 daemon（`claude -p --resume`） | overlay 聊天 | ✅（仅它自己起的会话） | ✅ Allow / Forever / Deny | ✅ 统一 approvals 队列 + 手机 | CEO → Director、幽灵 subagent | ✗ |
| KbWen/agent-virtual-office | 68 | MIT / 代码生成 SVG | SVG (React) | hooks → 文件 → SSE | SVG 内 inspector | ✗ | ✗ | ◐ 原因徽章 + 降噪通知 | helper 围桌、PairLink、飞文件 | ◐ Esc / Space |
| simple10/agents-observe | 714 | MIT | DOM + SVG 星图 | ~27 hooks + Codex | 过滤 / 星图钻取 | ✗ | ✗ | ◐ 铃铛 + favicon | 径向 subagent 树 | ✅ `/` `a` `f` `b` `e` |
| disler observability | 1,567 | **无 license** | Vue + Canvas swimlane | 12 hooks | 加 swimlane / 只读 transcript | ✗ | ◐ 自定义 HITL 协议 | ◐ 浏览器通知 + TTS | ✗ | ✗ |
| ChatDev 2.0 console | 34,703 | Apache-2.0 / 精灵来源未知 | Vue Flow DAG + 精灵 | 自有 WebSocket | 仅 hover | ◐ 单一 human_input 框 | ✗ | ◐ 输入框发光 | ✅ 精灵沿边走 | ✗ |
| Star-Office-UI | 7,564 | MIT / **美术非商业** | Phaser 3 | 轮询 state.json | ✗（只有家具可点） | ✗ | ✗（死代码） | ◐ bug 角落 | ✗ | ✗ |
| ai-town | 10,767 | MIT / OpenGameArt | PixiJS + Convex | Convex 订阅 | 详情 + 对话 | ◐ 人类作为角色聊天（模拟 agent） | ✗ | ✗ | ✗ | ◐ 平移缩放 |
| generative_agents | 22,357 | Apache-2.0 / 含付费包 | Phaser 3 | 文件锁步 | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ replay |
| harishkotra/agent-office | 405 | MIT / pixel-agents 精灵 | Phaser 3 + Colyseus | 模拟 LLM | ✗（空壳） | ◐ 全局聊天（模拟） | ✗ | ✗ | 关系列表 | ◐ 缩放 |
| agent-office-3d | 129 | MIT | Three.js | 轮询 Herdr | 只读终端末行 | ✗ | ✗ | ◐ 红闪 + 横幅 | ✗ | ◐ 方向键平移 |
| LangGraph Studio（文档） | — | 商业 | 图 + chat | Agent Server | 节点状态 | ✅ chat mode | ◐ interrupt / continue | ✗ | 图结构 | ✗ |
| Langfuse agent graphs（文档） | — | 商业 / OSS | 图 | trace observations | 节点详情 | ✗ | ✗ | ✗ | 推断图（聚合 / 展开） | ✗ |
| **MAS Office（现状）** | 13 | MIT | SVG 轴测 | 协议 0.1 events.jsonl + hooks | 侧栏角色卡 | ✗ | ✗ | ◐ flag / needs-you 状态 + feed | ✅ handoff 路线 + checker flag | ✗ |

**谁最接近我们的愿景**：交互闭环看 AgentSystemLabs/agent-office（真实会话 + alert queue）和 W17ant（结构化审批）；"公司"语义看 claw-empire 和 bagidea（CEO、收件箱）。四者没有一个同时具备：真实官方会话 + 结构化审批 + 统一收件箱 + 锁定的组织层级 + checker 语义。这个组合就是我们要占的位置。
