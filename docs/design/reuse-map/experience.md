# 复用地图 · 体验侧（C9–C15）

- 日期：2026-11-07。范围：C9 "需要你"收件箱、C10 办公室视图、C11 小人抽屉、C12 核对与证据、C13 研究角色的工具、C14 评测、C15 打包。
- 依据：`CLAUDE.md` §1–2、`docs/research/landscape/SYNTHESIS.md` §4（架构）、`03-visualization.md`、`04-frameworks-research.md`、`05-protocols-hci.md` §A.4 / §B、`01-orchestrators.md`；我们的 `panel/{model,office,app}.js`、`panel/style.css`、`panel/index.html`、`kit/harness/*.md`、`kit/.mcp.json`。
- 本文引用的每个参考路径都在 `references/repos/<owner>__<repo>/` 的固定 commit 上用 `ls` / `grep` / `sed -n` 核对过。没能核对的写了 *(unverified)*。所有参考代码只读过，没有构建或运行。
- 新读代码的三个仓库：`stablyai/orca` @ `e280eb0`、`paperclipai/paperclip` @ `b8e02fc`、`ruvnet/ruflo` @ `3fe9d70`。注意：`01-orchestrators.md` 里写的 Paperclip 是 `gh api` 读的 `061c84d`，本文所有 Paperclip 行号以克隆的 `b8e02fc` 为准。

## 怎么读这份图

**复用模式**（规则见 `CLAUDE.md` §2）
- **依赖**：加成 package 依赖。`mas-office` npm 包目前零依赖，加运行时依赖要先找维护者。
- **改编**：复制后修改。只限 MIT / Apache-2.0 / BSD / ISC 来源。文件头写 `Adapted from <repo>@<sha> <path> (<license>)`，在 `THIRD_PARTY_NOTICES.md` 加一条；Apache-2.0 来源还要带上它的 NOTICE。
- **只借思路**：照设计重写，不复制代码。

**怎么放进我们的代码**
- 面板是纯 HTML/JS 的 IIFE 模块：`window.MASModel`（纯函数，有 `panel/tests/model.test.js`）、`window.MASOffice`（SVG 绘制）、`app.js`（UI）。
- 改编来的**纯逻辑**（排序、计时、解析、判定）放进 `model.js`，或者新开同样风格的纯模块（例如 `panel/inbox.js`），并配测试。
- React / Tailwind / shadcn 组件**不要整块搬**：我们取它的数据结构和交互，用我们的 DOM 和 SVG 重画。
- 视觉语言沿用 `style.css`：图纸底色 `--sheet`、墨线 `--ink`；朱红 `--verm` 用于"需要你"，钴蓝 `--cobalt` 用于提问，赭石 `--ochre` 用于警告，鼠尾草绿 `--sage` 用于完成；`Archivo` + `Red Hat Mono`；图标是代码画的 SVG。不引入别人的品牌色和美术。
- 协议对齐 `05` §A.4 的 0.2 草案：`request.opened/resolved`、`command.*`、`command.ack`、`agent.stopped`、`mas/inbox.json`。

## 总览

| 组件 | 首选参考 | 复用模式 | 估计省下的工作量 *(估计)* |
|---|---|---|---|
| C9 "需要你"收件箱 | W17ant `server/permissions.js`（权限往返）+ bagidea `daemon/approvals.js` / `notify.js`（统一队列 + 通知规则）+ Paperclip 交互模型（kind / status / outcome / resolver policy） | 改编（W17ant、bagidea、agent-office 的纯 JS/TS 逻辑）+ 只借思路（Paperclip 和 Orca 的 React UI） | 约 8–12 人日：权限长轮询和"终端优先"的边界情况、请求生命周期枚举、通知降噪规则都已经有人踩过坑 |
| C10 办公室视图 | AgentSystemLabs/agent-office `nextup.ts`、`ui/compass.ts`、`features/needsyou/logic.ts`；KbWen `PairLink.jsx` | 改编 | 约 4–6 人日：`N` 键排序、边缘指针、等待计时与提醒。编组和数字键没人做过，要自研 |
| C11 小人抽屉 | Paperclip `TranscriptEntry` + `parse-stdout.ts`；Orca `transcript-line-decoders-{claude,codex}.ts`；pixel-agents PTY 镜像（`ptySessionManager.ts`、`terminalClient.ts`） | 改编（解析器、PTY 管理）+ 依赖（xterm.js、node-pty）+ 只借思路（Orca 卡片 UI） | 约 10–15 人日：Claude 和 Codex 的记录格式解析、diff hunk、断线重连快照是最费时的部分 |
| C12 核对与证据 | Loki `data_class.py` + prompts；FACT `utils/validate.py`；WebWeaver 引用标签；Gas City `internal/reviewquorum` | 改编（schema、prompt、quorum 合并）+ 只借思路（Paperclip 逐项裁决） | 约 6–10 人日：claim / evidence / verdict 的 schema 和判定 prompt 已经验证过。URL 健康检查和 A–D 分级要自研 |
| C13 研究工具 | 我们的 `mas-browser`（chrome-devtools-mcp）+ GPT Researcher `scraper/scraper.py` 的拦截页启发式 + DeepResearch `inference/prompt.py` 的 `EXTRACTOR_PROMPT` | 依赖（已在用）+ 改编（启发式规则、prompt） | 约 2–4 人日：主要是 prompt 和"读到的是不是有效页面"的判定 |
| C14 评测 | DeepResearch Bench（RACE + FACT）、SAFE | 依赖（作为外部评测工具，固定版本） | 约 10+ 人日：任务集、评分流水线、判定 prompt。HCI 实验埋点没有现成实现，要自研 |
| C15 打包 | pixel-agents（同一个 web UI 同时跑在 VS Code webview 和独立 server）；Orca（同一个 renderer 打 Electron 包和 web 包） | 只借思路（架构）+ 依赖（Electron 或 Tauri 工具链） | 约 3–5 人日：主要省在少走弯路（node-pty 原生模块、签名、自动更新） |

---

## C9 "需要你"收件箱

### 我们要做什么

在 daemon 里，把各后端的待决事项统一成 `request.opened` / `request.resolved` 写进 `events.jsonl`，由 reducer 产出 `mas/inbox.json`。面板加一个收件箱列表（侧栏 cell 或抽屉 tab）。条目分五类：工具审批、提问、决策、checker 举旗、阶段 gate。每条可以"选项 + 一句话"就地答复，显示已等多久、阻塞了谁、不回答会怎样。按规则发系统通知，并有降噪。`routeTo: lead` 的请求先给 CEO，CEO 只能处理白名单里的 kind。

### 首选参考

**1. W17ant/Claude-Office @ `1a9ba71`（MIT）：权限审批的往返协议**
- 取什么：整套 `PermissionRequest` 往返。
  - hook POST 事件，然后长轮询 `GET /permission/:id`；
  - 决策只传一个词（`allow | allow-remember | deny`），输出由 hook 自己拼，从不打印 server 返回的 JSON；
  - `HMAC(token, nonce + permissionId + decision)` proof；
  - 终端里先答了就记为 `resolved_elsewhere`，迟到的点击返回 409（"The terminal always wins"）；
  - headless 会话 15 s 过期，确认是交互会话后最多等 10 min；
  - 广播 `permission_resolved{decidedBy: office|terminal|timeout}`。
- 文件：`server/permissions.js`（360 行，文件头 L1–60 是完整的设计说明）；hook 一侧是 `hooks/agent-tracker.sh` 的 PermissionRequest 段。
- 模式：**改编**。它是纯 Node JS，和 `mas-office serve` 同栈，可以几乎原样移植到 `packages/node/src/cli/`。
- 改造要点：
  - 把 `permission_*` 广播改写成 0.2 的 `request.opened{kind:"approval", source.raw}` 和 `request.resolved{outcome, by}`；`decidedBy` 对应 `by.kind`（`human` / `policy` / 终端 = `superseded`）。
  - token 校验沿用我们 `serve` 现有的会话 token。
  - "allow-remember" 对应 ACP 的 `allow_always`。
  - 这只覆盖 hook 路径（用户自己开的 Claude 会话）。SDK 和 Codex app-server 路径的审批走 C1/C2 的 adapter，但**统一走同一个收件箱**。

**2. bagidea/bagidea-office @ `68e2d04`（代码 MIT）：统一队列与通知规则**
- 取什么：
  - "The queue is an INDEX plus the round-trip"：各类请求的 resolver 留在原处，收件箱只做索引和分发；
  - 记录持久化，daemon 重启后条目还在，但等待中的内存回调会丢，由发起方重问（hook 会重新轮询）；
  - `DEFAULT_OPTIONS` 按 kind 给默认按钮；
  - `MAX_HISTORY = 400`；
  - `notify.js` 的规则表：`KINDS × WHERE{centre,toast,channel,sound} × WHEN{always,quiet,away}`，approval 和 blocked 默认到处都发，done 只进中心列表；还有 quiet hours 和离开检测。
- 文件：`daemon/approvals.js`（221 行，L1–50 是设计说明、KINDS 和 DEFAULT_OPTIONS）、`daemon/notify.js`（188 行，L1–40 是 KINDS / WHERE / WHEN / DEFAULT_RULES）、`daemon/perm.js`（55 s 长轮询，超时即 deny）。
- 模式：**改编**。零依赖的 CommonJS，直接可用。
- 改造要点：
  - 我们的持久化不是单独的文件，而是 `events.jsonl` 回放（事件日志是唯一事实来源），所以 approvals 的 "record" 换成 reducer 的 `inbox` 快照；
  - KINDS 换成 `approval | question | decision | flag | gate`；
  - notify 的 `channel`（Telegram 等）先不做，只保留 `centre / toast / sound / os-notification`。

**3. Paperclip @ `b8e02fc`（MIT）：交互的数据模型与语义**
- 取什么（词汇和规则，不取实现）：
  - kind 枚举：`packages/shared/src/constants.ts` L273 `ISSUE_THREAD_INTERACTION_KINDS`，含 `ask_user_questions`、`request_confirmation`、`request_checkbox_confirmation`、`request_item_verdicts`、`suggest_tasks`。
  - 状态：L345 `ISSUE_THREAD_INTERACTION_STATUSES`（`pending / accepted / rejected / answered / cancelled / expired / failed`）。
  - 续跑策略：L356 `CONTINUATION_POLICIES`（`none / wake_assignee / wake_assignee_on_accept`）。
  - 谁能答：`RESOLVER_POLICIES`（`anyone / not_creator / human_only`）。`not_creator` 正好对应"checker 不能批自己"，`human_only` 对应"CEO 不能代批"。
  - 结果 outcome：`packages/shared/src/types/issue.ts` L1389 起的 `AskUserQuestionsPayload / Answer / Result`（`optionIds` + `otherText`，即"选项 + 自由文本"），以及 L1646 起 `RequestConfirmationResult.outcome` 里的 `superseded_by_comment`、`superseded_by_newer_request`、`stale_target`、`withdrawn`。
  - 行为规则：`maps/feature-map/questions-and-approvals.md`：
    - dismiss 不等于回答；
    - 一次回答只触发一次续跑（多次点击、刷新、多标签页都不重复）；
    - 计划改版后旧批准失效；
    - 工具审批的"决定状态"和"执行结果"分开记录。
  - 阻塞原因分组与排序：`ui/src/lib/blockedInbox.ts` L8–107：`BlockedReasonVariant` 六类；`compareBlockedAttention` 先按 severity，再按 `stoppedSinceAt` 由早到晚；`formatStoppedAge`（L251）。
  - 收件箱交互：`ui/src/components/DecisionTriageStrip.tsx` 的 snooze 预设和 "decide by" 截止时间；`InboxAgentPolicyControl.tsx` 的 `open / allowlist / disabled` 三档，可以作为"CEO 代批白名单"设置界面的样板。
- 模式：
  - 枚举和 outcome 词汇：**只借思路**（我们按 0.2 自己命名，对齐 ACP / AG-UI）；
  - `blockedInbox.ts` 的排序和年龄格式化：**改编**（纯函数，MIT）；
  - React 组件（`DecisionCard.tsx` 627 行、`IssueThreadInteractionCard.tsx` 4,170 行）：**只借思路**，太重，并且依赖 tanstack-query 和 shadcn。
- 改造要点：
  - 我们的 `request.resolved.outcome` 建议取 `selected | submitted | declined | cancelled | expired | superseded`（05 §A.4），再加 Paperclip 的 `stale`（目标已变，例如计划改版）。
  - `resolverPolicy` 进 0.2 作为 `request.opened.data.resolver`，由 `serve` 强制执行（只有 UI 会话 token 能写 `origin.kind: human`）。

**4. AgentSystemLabs/agent-office @ `852e2ab`（MIT）：等待计时与提醒**
- 取什么：
  - `src/client/features/needsyou/logic.ts`：
    - `waitKey = id@waitingSince` 把每一次等待当成一个 episode；
    - `unattended(w) = viewers.length === 0`；
    - `waited()` 第一分钟不显示，之后显示 "4 min" / "1 h 05 min"；
    - `REMIND_EVERY = 30_000`。
  - `src/client/notify.ts` L27 `waitingOnSomeone`：`needs_input`，或者 `done && !acked`（做完了但没人看过，也算等你）。`DesktopNotifier` 在条目被处理后**关掉对应的系统通知**。
- 模式：**改编**（纯 TS 函数，去掉类型标注即可放进 `model.js`）。
- 改造要点：`waitingSince` 对应 0.2 的 `request.opened.ts`；`viewers` 换成"该 agent 的抽屉或收件箱条目是否正在打开"。

**5. KbWen/agent-virtual-office @ `48e0e23`（MIT）：系统通知降噪**
- 取什么：`src/inference/desktopNotifier.js` L1–40：
  - blocked 持续 ≥30 s **且**标签页隐藏，才发系统通知；
  - 每个 episode 只发一次；
  - 用 `tag: office-blocked-<id>` 让操作系统替换同一个 agent 的旧通知；
  - 权限请求必须由用户手势触发；
  - 反复失败另发一次（`systems/recurringFailure.js`）。
- 模式：**改编**（纯 JS，和我们同栈）。

**6. stablyai/orca @ `e280eb0`（MIT）：通知准入策略**
- 取什么：`src/renderer/src/attention/agent-attention-policy.ts` 的 `resolveAgentAttention`。不发通知的情况有：工作区已静音；`coordinatorOnlyNews`（worker 做完的消息只给协调者，不打扰人）；会话已不在；用户正在看的那个界面只投递、不标未读。`agent-attention-contract.ts` 给未读原因分类（`agent-completion / terminal-bell / manual-mark-unread`）。另外 `src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts` L198–212 的 `decision_gates` 表（`pending / resolved / timeout`，`options` JSON）是一个最小的 gate 持久化样板。
- 模式：准入规则 **改编**（纯函数，117 行）；gate 表 **只借思路**。
- 改造要点：`coordinatorOnlyNews` 正好是 management by exception：finder 交接给 Lead 时不通知人，只有 `routeTo: human` 或 CEO 上抛的请求才通知人。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| paulrobello/claude-office @ `3fe6424` | 紧急度打分：permission 90、critical 不自动消失；error/stop 70；最多 5 条 toast | `frontend/src/stores/attentionStore.ts` L69–141 | 改编（MIT）。只取分数和是否自动消失的表 |
| GreenSheep01201/claw-empire @ `66a24ea` | 决策条目类型（`agent_request / project_review_ready / task_timeout_resume / review_round_pick`），编号选项加追问 | `src/components/chat/decision-inbox.ts`、`src/components/DecisionInboxModal.tsx` | 只借思路（Apache-2.0）。它靠正则匹配聊天里的 `[Decision Reply]` 判断是否已答，太脆，不要照搬 |
| gastownhall/gascity @ `06372a1` | `PendingInteraction{request_id, kind, prompt, options}` / `InteractionResponse{request_id, action, text}`；答复必须对上 request id，否则拒绝 | `internal/runtime/runtime.go` L630–660、`internal/api/pending_interactions.go` | 只借思路（MIT，Go） |
| microsoft/magentic-ui @ `d3c9d13` | 三档审批策略 `auto_approve / require_approval_untrusted / require_approval_all` | `docs/configuration.md` L124–139、`src/magentic_ui/approval.py` | 只借思路（MIT，Python） |
| simple10/agents-observe @ `b3a7238` | 下一次活动自动清除 pending；favicon 换成告警版；铃铛未读数 | 见 `03` §2 | 只借思路（MIT） |
| iamlukethedev/claw3d @ `51337f7` | 审批的过期与暂停策略拆成独立模块 | `src/features/agents/approvals/execApprovalPausePolicy.ts` 等 10 个文件 | 只借思路（MIT）。架构绑定 OpenClaw gateway |
| disler/claude-code-hooks-multi-agent-observability @ `8a6e5cf` | 自定义 HITL 卡片（Approve/Deny、自由文本、选项按钮），回答经 `POST /events/:id/respond` 回传 | `app_docs/how_human_in_the_loop_v1_works.md` | **只借思路**。仓库没有 LICENSE 文件，README 也没有授权说明，默认保留所有权利 |

### 坑与注意

- **"终端优先"要求 hook 有超时**：Claude Code hook 默认超时 600 s，headless `claude -p` 会在所有 PermissionRequest hook 结束后立刻自动拒绝（W17ant 文件头）。我们的长轮询上限必须小于 hook 超时，并且区分交互会话和 headless 会话。
- **持久化的条目不等于还在等的回调**（bagidea）：daemon 重启后，收件箱条目可以从日志重建，但发起方要能重问。重建出来、已经没有人等的条目要标成 `expired` 或 `superseded`，不能让人去答一个已经失效的请求（Paperclip 的 `stale_target` 也是这个意思）。
- **代批越权**：CEO 通过 MCP 发出的 `command.respond` 一律标 `origin.kind: agent`；`resolver: human_only` 的条目 daemon 直接拒绝。
- **声音素材**：Orca `resources/notification-sounds/*.mp3` 没有来源和授权声明（`resources/licenses/` 里只有 ripgrep 和 shadcn）*(unverified 来源)*，不要复制。agent-office 的提示音是 WebAudio 合成的（`src/client/sound/`、`features/needsyou/sound.ts`），可以改编合成参数。
- **Orca 和 Paperclip 都带 Claude / Codex 的 logo**（Orca `resources/claude.webp`、`README.md` L221；Paperclip `ui/public/brands/`、`doc/assets/logos/claude.svg`）。按 `CLAUDE.md` §3 第 5 条，不得用作我们的品牌元素；收件箱里标注后端时用文字（"Claude Code"、"Codex"）。
- 打断策略要遵守 05 §B P3：默认 negotiated（举手 + 收件箱，不抢焦点），只有 `urgency: high` 才出 toast 和声音；人正在某个抽屉里打字时不弹 toast。

### 必须自研

- 五类请求的**统一模型**和 reducer 规则，把 checker 举旗和阶段 gate 也纳入 `request.*`。没有任何参考把这两类和工具审批放在同一个队列里。
- **"不回答会怎样"**：阻塞了几个下游角色（由 `handsTo` / `waitingOn` 推算），以及超时后的默认动作。
- CEO 的 `routeTo` 和岗位级白名单，以及代批历史供人事后复核（05 §A.4、P7）。
- 提问预算（P11）和断点批量投递（P3）。
- 收件箱和办公室联动：点条目时镜头移到该角色并打开抽屉（见 C10、C11）。

---

## C10 办公室视图

### 我们要做什么

保留现有的 30° 轴测 SVG（`panel/office.js`，规模 ≤20 个角色，不换引擎）。在上面加：
- 持续显示的交接线：现在的 `drawRoutes()` 用 `M.gridRoute` 画 `handsTo` 路线；
- checker → 被核对者的关系线；
- 举手、等待计时、原因徽章；
- RTS 操作：`N` 键跳到下一个等你的人、屏幕边缘指针、顶栏计数、编组和数字键；
- CEO / 总控概览：状态即位置。

### 首选参考

**1. AgentSystemLabs/agent-office @ `852e2ab`（MIT）：alert queue 全套**
- 取什么：
  - `src/client/nextup.ts`（78 行）：
    - `waitingInOrder` 先排 `needs_input`，再排"做完未看"，各自按 `waitingSince` 从早到晚；
    - `needyFirst`：列表只在有人卡住时才变动；
    - `waitingLabel`：显示 "🙋 2 need you · ✅ 1 done"；
    - `class NextUp`：一轮里不重复访问，开始新的一次等待就算新人，走完一轮后从头再来。
  - `src/client/ui/compass.ts`（139 行）：视野外的等待者在屏幕边缘显示箭头，带 `MARGIN = 46` 和 `SPACING{side:56, across:110}` 防重叠，并避开 HUD 面板区域。
  - `src/client/features/needsyou/`：信标、横幅、提醒（`logic.ts` 见 C9）。
  - `src/client/lite.ts`：2D 降级视图，按紧急度列出所有 worker、终端和发 prompt 的输入框。
- 模式：
  - `nextup.ts`：**改编**，几乎原样，只需去掉 TS 类型；
  - `compass.ts`：**改编**排布算法，把 `THREE.Vector3` 投影换成 SVG 的 `getScreenCTM()` / `getBoundingClientRect()`；
  - `lite.ts`：**只借思路**。
- 改造要点：
  - `WorkerInfo.status` 映射到我们的 7 态 status 和 `flagKind`；`acked` 换成"该角色的结果或抽屉已被打开过"。
  - 我们的办公室一屏能放下，边缘指针只在抽屉或侧栏遮住小人、或窄屏缩放时才需要。
  - 横幅不要做成全屏闪烁（agent-office 有屏幕边缘闪光加警报），沿用我们安静的图纸风格，用朱红色的手和计时数字。

**2. KbWen/agent-virtual-office @ `48e0e23`（MIT，美术全部是代码生成的 SVG，技术路线和我们最像）**
- 取什么：
  - `src/components/PairLink.jsx`（56 行）：桌间画淡色虚线（`strokeDasharray 3 3`、`opacity .45`），中点加文件标签，`pointerEvents="none"`，不动人物位置；
  - `src/components/blockedReasonBadge.jsx`：每种 `reasonCode` 一个不同形状的头顶徽章；
  - `src/components/HelperHuddle.jsx`：subagent 围在桌边，超过 3 个显示 "+N"；
  - `src/inference/workflowHandoff.js`：阶段交接时的飞文件动画。
- 模式：**改编**（JSX 很薄，改写成我们的 `svg()` helper 调用）。
- 改造要点：
  - 交接线复用 `drawRoutes`：交接完成后保留淡线，点线可以看交接内容（03 §4.1 P8）。
  - checker → 被核对者用另一种线型，例如钴蓝点划线，从 team design v2 的 `reviewerOf` 推出；有 flag 时线变朱红。

**3. paulrobello/claude-office @ `3fe6424`（MIT）：CEO 总控**
- 取什么：Command Center 按 Needs-you / Working / Done / Ended 四区排布。文件：`frontend/src/components/command/layout.ts`（L53–77 定义 ZONES）、`CommandCenterZones.tsx`。
- 模式：**只借思路**（PixiJS + React，技术栈不同）。
- 改造要点：我们是单团队，可以"状态即位置"：举手的人走到 Lead 桌前排队，完成的人回到休息区（`office.js` 已有 `goStation` / `toIdle` / lounge 布局）。多团队概览以后再做。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| stablyai/orca @ `e280eb0` | 列表视图按注意力排序：`waiting 0 · blocked 1 · permission 2 · failed 3 · … · done 9 · idle 10`，注释说明"用户主动 Stop 不算新闻" | `src/renderer/src/components/activity/activity-thread-grouping.ts` 的 `ACTIVITY_STATUS_GROUP_RANK` | 改编（MIT）。用作顶栏状态条和 `/lite` 列表的排序 |
| paperclipai/paperclip @ `b8e02fc` | 组织架构图页（汇报关系、角色卡） | `ui/src/pages/OrgChart.tsx`（690 行） | 只借思路（MIT）。我们的组织图就是办公室本身加 Lead 的引线 |
| pixel-agents-hq/pixel-agents @ `b1bafd0` | 头顶 context gauge 三档；teammate 坐到 lead 旁边 | `webview-ui/src/office/components/ToolOverlay.tsx`、`webview-ui/src/office/engine/officeState.ts` L657 `reseatNextToLead` | 只借思路（MIT） |
| AgentSystemLabs/agent-office | 小地图的近似：电梯面板显示每层 busy / waiting 计数 | `src/client/ui/elevator.ts` | 只借思路。我们一屏放得下，用顶栏色点条代替小地图 |
| OpenBMB/ChatDev @ `464a681` | 精灵沿 DAG 边从源走到目标，作为一次性交接动画 | `frontend/src/pages/LaunchView.vue` `animateSpriteAlongEdge` | 只借思路（Apache-2.0）。3,705 行的单文件是反例 |

### 坑与注意

- **不换引擎**：PixiJS（claude-office、claw-empire、munder-difflin）、Three.js（agent-office、Claw3D）在 ≤20 个角色时没有收益，还会失去 SVG 的可访问性和文本清晰度。Claw3D `RetroOffice3D.tsx` 7,253 行，是"功能堆进渲染层"的反例；我们保持 `model.js` 纯函数和 `office.js` 绘制分离。
- **美术一律不搬**（逐项核对过）：

  | 来源 | 实际条款 | 不能复制的东西 |
  |---|---|---|
  | ringhyacinth/Star-Office-UI（manifest 记为 NOASSERTION） | `LICENSE` §1：代码 MIT；§2：**所有美术仅限非商业**，商用必须全部替换；§3：访客角色是 LimeZu 免费包，需署名 | 全部精灵、背景、家具、按钮皮肤和资产索引 |
  | W17ant/Claude-Office | `NOTICE.md`：代码和原创像素美术是 MIT；Dunder Mifflin 皮肤**不在 MIT 授权内** | `public/sprites/office/characters/`、`public/sprites/office/props/`、`docs/images/` 里的角色预览、`src/theme.ts` 里的台词 |
  | HarnessMD/munder-difflin | `LICENSE-ASSETS` 和 `src/renderer/src/assets/ATTRIBUTION.md`：tileset 是 LimeZu Modern Interiors，用的是**作者购买的** Complete Version licence（必须署名，不得转售）；角色是 `scene/office/portraitArt.ts` 程序生成的，属于 MIT | `src/renderer/src/assets/tilesets/*.png`：我们没有买授权。`portraitArt.ts` 虽然是 MIT 代码，但画的是 *The Office* 剧中人物，有肖像和商标风险，也不要用 |
  | bagidea/bagidea-office | `godot/assets/characters/cat/License.txt`：可以用在游戏项目里，但**不得作为游戏素材再分发或转售**，不得做成 NFT；其余美术只在 README 致谢，仓库里没有 license 文件 | 猫和其他所有美术 |
  | joonspk-research/generative_agents | `map_assets/Cute RPG World 40 usd packet/*.zip` 是付费素材包原文件；README L135 致谢 PixyMoon | 全部地图素材 |
  | pixel-agents | 角色"基于 JIK-A-4 Metro City 免费包"（README L48），仓库里没有素材 license 文件 *(unverified 条款)* | `webview-ui/public/assets/` 里的角色 |
  | paulrobello/claude-office、claw-empire、agent-office | 只有代码 LICENSE，美术来源没有说明 *(unverified)*。agent-office 的模型由 `blender/` 脚本生成 | 不复制位图和模型 |

- 游戏彩蛋不要做（03 §4.2）：游戏感来自直接操作和反馈，不来自无关小游戏。
- 原因徽章和计时都要满足 `prefers-reduced-motion`（`office.js` 已有 `reduced()`）。

### 必须自研

- **编组和数字键**：全行业空白（03 §4.3）。我们的团队由用户锁定，组本来就有（`groups` / 未来的 `stages`）：`1–9` 选组，组内群发追问，`Shift+N` 跳到下一个空闲可派活的人。
- checker → 被核对者的关系线，以及交接线的持续显示和点击查看，在现有 `drawRoutes` / `highlightRoutes` 上扩展。
- SA 三层在办公室上的编码（05 §B.1 #8）：L1 看小人和 `say`，L2 看阶段进度和谁阻塞谁，L3 看预计完成时间和"不回答会停几个人"。
- 快捷键表：`N`、`Shift+N`、`I` 收件箱、`A` / `D` 批准或拒绝当前条目、`Enter` 聚焦聊天、`Esc`、`1–9`、`⌘K`（03 §4.3）。现在 `app.js` 只处理 `Escape`（L545–549）。

---

## C11 小人抽屉

### 我们要做什么

把现有的结果抽屉（`#drawer`，`app.js` 的 `drawerHtml` / `renderDrawer`）扩展成每个角色的抽屉，有四个 tab：
- **记录**：结构化 transcript，包括工具调用、失败标红、diff、提问和审批卡；
- **终端**：xterm.js 原始 PTY，可以接手；
- **产出**：该角色的 `outputs/work/<role>.md` 和 source cards；
- 底部**聊天框**：直接送进真实会话，`delivery: steer | queue | interrupt`，并显示 `command.ack`。

transcript 解析放在 daemon 侧，面板只消费规范化之后的条目。

### 首选参考

**1. Paperclip @ `b8e02fc`（MIT）：规范化 transcript 模型和逐行解析器**
- 取什么：
  - `packages/adapter-utils/src/types.ts` L716–733 的 `TranscriptEntry` 联合类型，一共 19 种：`assistant / thinking / user / tool_call{toolUseId, parentToolUseId} / tool_result{isError} / init / result{tokens, costUsd} / diff{changeType, additions, deletions} / runtime_request{requestKind, status, choices, fields} / run_result{disposition, verification[], remainingWork[], blocker} / run_terminal{turnState, runState}` 等。
  - `StdoutLineParser = (line, ts) => TranscriptEntry[]`。
  - 实现：`packages/adapters/claude-local/src/ui/parse-stdout.ts`（149 行）、`packages/adapters/codex-local/src/ui/parse-stdout.ts`（303 行）。
  - 路径脱敏：`packages/adapter-utils/src/log-redaction.ts` 的 `redactTranscriptEntryPaths`。
- 模式：类型和两个解析器 **改编**（MIT），改写成纯 JS，放到 `packages/node/src/` 的 transcript 模块，并配 fixture 测试。
- 改造要点：
  - 它解析的是 `claude --print --output-format stream-json` 的 stdout。我们的 SDK 消息形态与之同构；hook 路径还需要读 `~/.claude/projects/**.jsonl`，见下面的 Orca。
  - `runtime_request` 不要单独存，直接映射成 0.2 的 `request.opened`，让抽屉和收件箱共用同一个对象。
  - `run_result.verification[]` 只有 `passed / failed / not_run`，是代码任务语义；研究任务的核对结果走 C12 的 verdict。

**2. stablyai/orca @ `e280eb0`（MIT）：磁盘 transcript 解码和卡片设计**
- 取什么：
  - 解码器：
    - `src/main/native-chat/transcript-line-decoders-claude.ts`（211 行，`decodeClaudeTranscriptLine` L75）：从 `toolUseResult.structuredPatch` 取真实行号的 hunk，`MAX_EDIT_PATCH_HUNKS = 40`、每个 hunk 最多 400 行；识别中断标记和注入的 user 消息；
    - `transcript-line-decoders-codex.ts`（301 行，`decodeCodexTranscriptLine` L33）：Codex rollout JSONL 的 `response_item`（message / reasoning / function_call / local_shell_call / custom_tool_call / *_output）和 `event_msg`（user_message / agent_message / turn aborted / context_compacted）。
  - 类型：`src/shared/native-chat/native-chat-types.ts`（`NativeChatBlock`：text / tool_call / tool_result / edit patch / subagent group / background task；`NATIVE_CHAT_SOURCES = transcript | hook | scrape` 及优先级）。
  - 每个 CLI 版本的真实 hook 和 transcript fixture：`src/shared/__fixtures__/claude-*.jsonl`。
  - UI 卡片（React，看设计）：`src/renderer/src/components/native-chat/` 下的 `NativeChatToolRun.tsx`（同类工具调用折叠成一行加计数）、`NativeChatDiffCard.tsx` / `NativeChatTurnDiffRollup.tsx`（一轮的 diff 汇总）、`NativeChatApprovalCard.tsx`（L19–40：卡片占住输入区，可以折叠成一条、把输入框还给用户）、`NativeChatQuestionCard.tsx`、`NativeChatQueuedMessageList.tsx`。
  - 发送语义：`src/shared/native-chat/input/native-chat-follow-up-behavior.ts`（`'queue' | 'steer'`）。
- 模式：
  - 两个解码器：**改编**（MIT，纯函数，依赖几个小 helper，需要一起搬）；
  - fixture：**改编**作为我们的测试数据，保留署名，并先检查里面没有个人路径；
  - 卡片 UI：**只借思路**。
- 改造要点：
  - 解码器输出统一转成 Paperclip 式的 `TranscriptEntry`，避免两套模型；
  - "工具调用折叠成一行"和"一轮 diff 汇总"是"记录" tab 默认视图的关键，非工程师默认看不到原始 JSON（03 P5）。

**3. pixel-agents-hq/pixel-agents @ `b1bafd0`（MIT）：原始终端 tab**
- 取什么：
  - 服务端：`server/src/terminal/ptySessionManager.ts`（350 行）。一个 agent 一个 PTY；用 `@xterm/headless` 加 `SerializeAddon` 镜像屏幕；浏览器断开不杀 PTY，重连时用序列化快照补回错过的内容。
  - 浏览器：`webview-ui/src/terminal/terminalClient.ts`（164 行）、`webview-ui/src/components/TerminalPane.tsx`（254 行）、`TerminalDrawer.tsx`。
  - 设计文档：`docs/design/standalone-terminal.md`。
- 模式：PTY 管理和客户端 **改编**；`@xterm/xterm`、`@xterm/headless`、`@xterm/addon-serialize`、`@xterm/addon-fit`、`node-pty` **依赖**（MIT，不在 references 里）。
- 改造要点：
  - 依赖要放进一个可选的包，例如 `@mas-office/terminal`，或者 daemon 的 optional dependency，不破坏 `mas-office` 零依赖。这需要维护者决定。
  - 面板侧可以从 daemon 静态提供 vendored 的 `xterm.js` 和 `xterm.css`，保持 `panel/` 不需要构建。

**4. HarnessMD/munder-difflin @ `80a1dbb`（代码 MIT）：聊天框怎么送达**
- 取什么：`src/main/hooks.ts` L520–580：把操作员的指令排进队列，在下一个 `UserPromptSubmit` 或 `PostToolUse` hook 里作为 `additionalContext` **只投递一次**，"不往 TUI 里脆弱地打字"；一个 hook 只能返回一个 `additionalContext`，所以要和其他注入合并。L498 附近的注释讲了 Stop-hook 自动续跑被撤掉的原因（绕过 HITL，还会继续花钱）。
- 模式：**改编**（逻辑很短）。
- 改造要点：这只是 hook 路径（外部会话）的 `delivery: steer` 实现。SDK 会话用 `streamInput` + `priority`，Codex 用 `turn/steer`，这些属于会话控制组件。送达后由 adapter 写 `command.ack{status: applied}`，抽屉显示"已送达 / 已应用"。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| W17ant/Claude-Office @ `1a9ba71` | inspector 卡片的纯模型：`HistoryKind = tool / failed / status / completed / message`，打开时每 2 s 轮询，显示 10 条，server 不可用时有降级 | `src/inspector.ts`（289 行，L1–30）、`server/transcript.js` | 改编（MIT）。用作"记录" tab 的折叠摘要头 |
| simple10/agents-observe @ `b3a7238` | Claude 和 Codex transcript 的用量、成本、subagent 归属解析，以及模型价格表 | `app/server/src/transcript-parser/{agents/claude.ts, agents/codex.ts, types.ts, models-pricing.ts}` | 改编（MIT）。用于抽屉顶部的成本和 context 仪表（03 P11） |
| AgentSystemLabs/agent-office | PTY host 是独立进程（`agent-office-ptys`），server 重启时 PTY 不死，重连后拿快照 | `src/server/ptyhost.ts`（252 行）、`docs/how-it-works.md` | 只借思路（MIT） |
| stablyai/orca | 生产级的 headless 终端仿真和快照重放 | `src/main/daemon/emulation/headless-emulator.ts`、`src/renderer/src/components/terminal-pane/` | 只借思路。太大，耦合重 |
| anthropics/claude-agent-sdk-typescript @ `49dd8ef` | SDK 会话的聊天输入（`streamInput`、`priority`） | — | **依赖**，不得 vendor 源码。`LICENSE.md`：© Anthropic PBC，All rights reserved，使用受 Commercial Terms 约束（manifest 记为 NONE） |

### 坑与注意

- **Claude 的 JSONL 格式没有文档，会随版本变化**。Orca 按 CLI 版本收集 fixture（如 `claude-helper-kill-2.1.310-*.jsonl`），我们也要为每个支持的版本保留 fixture，解析器遇到未知记录要原样跳过，不能抛错。
- **不要往 TUI 里打字**。Orca 的 `native-chat-pty-send-queue.ts` 文件头说明了为什么要串行化 "clear + body + 延迟 Enter"：否则会撞上模型切换确认框等对话框。这正好说明这条路很脆。我们只在用户亲自操作"终端" tab 时才直接写 PTY。
- **transcript 含个人路径和可能的密钥**：渲染前做路径脱敏（参考 Paperclip `log-redaction.ts`）；绝不读取或显示凭证文件（`CLAUDE.md` §3 第 3 条）。
- 聊天框必须直达真实会话，否则就不要放（03 §4.2：W17ant 的聊天框是旁路 LLM）。
- 接手终端时要给出一屏上下文摘要（05 §B.1 #9）。

### 必须自研

- **三层透明**的抽屉布局（05 §B.1 #21、P5）：在做什么（`say` + 当前工具）、为什么（计划和引用的证据）、接下来和把握（下一步、ETA、证据等级）。
- 把 transcript 条目、`request.*`、`command.*` / `command.ack` 合成同一个时间线：审批卡就地出现在记录里，也同时出现在收件箱里。
- "接手"流程：停掉 SDK 会话 → `claude --resume` 进 PTY → 交还（SYNTHESIS R2）。
- 产出 tab 对接 kit 的 `outputs/work/*.md` 和 source cards（`kit/harness/formats.md`）。

---

## C12 核对与证据

### 我们要做什么

实现 04 §3.2 的数据模型：
- `claim{id, text, span, serves, author, checkworthy, sources[]}`
- `evidence{id, sourceCard, url, quote, relationship, grade A–D, urlHealth, fetchedAt}`
- `verdict{claimId, checker, backend, status: supported|partial|contradicted|unknown|not-checkworthy, method, steps}`

Lead 写结果时用内联标签包住陈述。checker 走 FACT 式流水线：抽取 → 去重 → 抓页面 → 逐条判定 → 汇总。URL 健康由 harness 用确定性代码检查。可以做跨厂商的审查 quorum。结果抽屉逐句高亮，顶部显示可信度条；contradicted 或 unknown 超过阈值时进收件箱。

### 首选参考

**1. Libr-AI/OpenFactVerification（Loki）@ `6e1ee9e`（MIT）：claim 和 evidence 的 schema 与流水线**
- 取什么：
  - `factcheck/utils/data_class.py`：`Evidence{claim, text, url, reasoning, relationship}`（L24–29）；`ClaimDetail{id, claim, checkworthy, checkworthy_reason, origin_text, start, end, queries, evidences, factuality}`（L40–66，factuality 取 "Nothing to check." / "No evidence found" / [0,1]）；`FCSummary{num_claims, num_checkworthy_claims, num_verified_claims, num_supported_claims, num_refuted_claims}`（L81–98）。
  - 五步流水线：`factcheck/__init__.py` L82–146（decompose + `restore_claims` 映射回原文位置 → checkworthy → query generation → retrieve → verify）。
  - 判定 prompt：`factcheck/utils/prompt/chatgpt_prompt.py` L101–129（`SUPPORTS / REFUTES / IRRELEVANT`）。
- 模式：schema 和 prompt **改编**（MIT，保留署名）；不作依赖（2024-10 起停更）。
- 改造要点：
  - `start / end` 改成我们内联标签的 span，这样不需要事后 `restore_claims`；
  - `relationship` 加上 FACT 的 `unknown`（页面无效）；
  - `factuality` 的连续值只用在汇总，单条 claim 的 verdict 用枚举。

**2. Ayanami0730/deep_research_bench（FACT）@ `f2735b5`（Apache-2.0）：checker 流水线骨架**
- 取什么：
  - 流程：`run_benchmark.sh` L72–93 依次跑 `utils.extract` → `deduplicate` → `scrape` → `validate` → `stat`；
  - `utils/extract.py`（202 行）：一条事实引了多篇来源时拆成多条 (fact, ref_idx, url)；
  - `utils/validate.py` L10–55：中英两版判定 prompt。先判断参考页是否有有效内容，"page not found" 之类则全部判 **unknown**；能全部或部分找到判 supported（数字允许四舍五入）；否则 unsupported。
- 模式：判定 prompt 和步骤划分 **改编**（Apache-2.0，带 NOTICE）。评测时整套 **依赖**（见 C14）。
- 改造要点：
  - `scrape` 在 FACT 里走 Jina Reader API（`utils/api.py` L83、L218 `https://r.jina.ai/`）。我们的 checker 用 `mas-browser` 或 WebFetch 自己抓，抓到的原文存进 source card。
  - "partial" 要单独成一类，FACT 把部分支持也算 supported。

**3. Alibaba-NLP/DeepResearch（WebWeaver）@ `f72f75d`（Apache-2.0）：生成时就带上 claim span**
- 取什么：
  - `WebAgent/WebWeaver/prompt/write_prompt_multi_hop_2.py` L96–107：`<qwen:cite id="id_x,id_y">陈述</qwen:cite>` 包住每条事实陈述；
  - `search_user_prompt_id_3.py` L11–14：提纲每个小节后附 `<citation>`，缺引用的小节下一轮继续搜。
- 模式：标签格式和 prompt 措辞 **改编**（Apache-2.0）。
- 改造要点：
  - 标签名改成我们自己的 `<claim id="c3" src="currys-xm6">…</claim>`，src 指向 kit 的 source card id（`kit/harness/formats.md` 里的 `sources[].id`）；
  - 渲染时去掉标签，`model.js` 的 `renderMarkdown` 需要识别它并输出可高亮的 `<span data-claim>`；
  - 写进 `kit/harness/operations.md` 的 Lead 步骤。

**4. gastownhall/gascity @ `06372a1`（MIT）：跨厂商审查 quorum**
- 取什么：
  - `internal/bootstrap/packs/core/formulas/mol-review-quorum.toml`（207 行）：两条只读审查 lane，各自指定 provider 和 model，再由一个 synthesis agent 汇总。每条 lane 的输出契约包括 `verdict ∈ {pass, pass_with_findings, fail, blocked}`、`findings[]{severity,title,body,file,line}`、`evidence`、`usage`、`read_only_enforcement`（审查前后各跑一次 `git status` 对比）、`failure_class ∈ {none, transient, hard}`；可以重试 3 次，用尽后 soft_fail。
  - 确定性的汇总器：`internal/reviewquorum/finalize.go` 的 `Finalize`，以及 `mergeLaneFindings` / `findingKey` 去重；`types.go`（`LaneConfig`、`LaneOutput`、`Finding`、`Evidence`、`Summary`）；`classify.go`（失败是否可重试）。
- 模式：契约字段和 Finalize 的合并规则 **改编**（MIT，Go 改写成 JS）。
- 改造要点：
  - finding 换成按 claim 计的 verdict；两条 lane 对同一 claim 判定不一致时，不由 LLM 汇总，**直接作为 `request.opened{kind:"flag"}` 进收件箱**。
  - `transient`（额度、限流）和 `hard` 的区分要进 UI：额度不足时不要显示成"核对失败"。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| google-deepmind/long-form-factuality（SAFE）@ `9d27158` | 多步搜索后判定的循环；`max_steps = 5`、每次搜索 3 条结果；先过滤与问题无关的 fact | `eval/safe/rate_atomic_fact.py`、`eval/safe/config.py` L44–55 | 改编（Apache-2.0）。manifest 记为 NOASSERTION，实际条款见文末 license 核查 |
| assafelovic/gpt-researcher @ `3582a68` | 判断抓到的是不是有效页面：拦截页标记（Cloudflare、"verify you are a human" 等，只检查前 5,000 字符）、词表 dump 检测、未解码的 PDF 检测 | `gpt_researcher/scraper/scraper.py` L40–106（`_BLOCK_PAGE_MARKERS`、`_looks_like_block_page`、`_looks_like_word_list`、`_looks_like_unextracted_pdf`） | 改编（Apache-2.0）。正好对应 `urlHealth: blocked` 和"页面无效 → unknown" |
| paperclipai/paperclip @ `b8e02fc` | 人对 checker 结果逐项裁决：`RequestItemVerdictValue = approve / reject / defer`、`requireReasonOn`、`allowBulkApprove`、`supersedeOnUserComment`；`IssueExecutionPolicy.maxReviewRounds`：agent 发起的返工超过轮数就升级给负责人 | `packages/shared/src/types/issue.ts` L1618–1700、L754–780 | 只借思路（MIT）。用于"checker 举旗 → 人逐条裁决"的收件箱卡片 |
| stanford-oval/storm @ `fb951af` | `Information{url, title, description, snippets[], citation_uuid}`，以 url 为唯一键；Co-STORM Moderator 挑"已检索但没被引用"的片段 | `knowledge_storm/interface.py` L41、`knowledge_storm/collaborative_storm/modules/co_storm_agents.py` L159 `class Moderator`（docstring L160–167） | 只借思路（MIT）。"找到了但没用上的来源"作为 checker 的一个指标 |
| langchain-ai/open_deep_research @ `1b7d2e8` | compress 阶段"只清理、不删陈述"；每个唯一 URL 一个引用编号 | `src/open_deep_research/prompts.py` L186–219 | 改编 prompt（MIT） |
| TauricResearch/TradingAgents @ `9fa1196` | 决策类任务的正反辩论加裁判结构化输出 | `tradingagents/agents/schemas.py` | 只借思路（Apache-2.0） |

### 坑与注意

- **我们的 A–D 不是 verdict**。`panel/model.js` L13 `EVIDENCE = {A: 'Can be bought or run', B: 'Study with data', C: 'Demo or marketing', D: 'Opinion'}` 是**来源类型等级**；supported / contradicted 是**来源和陈述的关系**。两者在数据上要分开存，UI 上也要分开显示（例如来源徽章显示等级，句子高亮显示 verdict）。所有参考都没有 A–D 这一层。
- **urlhealth（arXiv 2604.03173）没有找到公开仓库** *(unverified)*。`live / stale / hallucinated` 三态加 Wayback 查询要自己写。这是确定性代码，不交给 LLM。
- **同厂商审查独立性有限**（04 引定位稿：约 60% 同错率）。跨厂商 lane 要用用户自己登录的 Codex 和 Claude，不能为了 quorum 去调 API（`CLAUDE.md` §3）。
- FACT 判定 prompt 的默认判官是 OpenAI 模型（`utils/api.py` L13–22 `RACE_MODEL / CLEAN_MODEL / FACT_MODEL`）。checker 改编 prompt 没问题，但评测时判官要固定，并且和被测系统不同厂商（见 C14）。
- GPT Researcher 超过轮数会**静默放行**：`multi_agents/agents/orchestrator.py` 的 `_route_human_feedback`（L107 起，docstring 写明 "force-accept after max_plan_revisions"），这是反例。我们超过 `maxRounds` 就进收件箱。
- `ruvnet/ruflo` 的 `v3/@claude-flow/claims` 是"认领工单"，不是事实 claim，命名容易混淆，与 C12 无关。

### 必须自研

- claim / evidence / verdict 合在一起的 schema，以及 0.2 事件 `claim.added`、`evidence.checked{urlHealth}`、`verdict.recorded`（04 §3.3）。需要 RFC 和 JS + Python reducer 的 conformance case。
- URL 健康检查：HTTP 状态、重定向、内容有效性（借 GPT Researcher 的启发式）、Wayback 查询，结果记成 `live / stale / hallucinated / blocked`。
- A–D 分级的判定规则：谁来定、用什么依据（SYNTHESIS T7）。
- clean-context 的 checker 角色：只看工作文件和 source card（`kit/harness/formats.md` 的 `reviewerOf`、`cleanContext`）。
- 结果抽屉的逐句高亮、可信度条、"checker 抓到了什么"一节（`app.js` `resultExtras` / `sourcesHtml` 扩展）。

---

## C13 研究角色的工具

### 我们要做什么

研究角色运行在用户自己的 Claude Code 或 Codex 会话里。工具是：
- 会话自带的 WebSearch / WebFetch；
- 我们的 `mas-browser`：`kit/.mcp.json`，chrome-devtools-mcp 1.12.0，`--isolated`，屏蔽 localhost、私网、元数据地址，并用 PAC 把解析到私网的域名送到死代理（`kit/.claude/mas-browser.pac.js`）。

我们不托管搜索 API。我们要做的是：告诉角色怎么搜、怎么判断抓到的页面有效、怎么把原文摘进 source card，以及怎么在团队设计里分配 `web search` / `browse the web`（编译成权限属于组织编译器组件）。

### 首选参考

**1. 我们自己的 `mas-browser`（依赖 `chrome-devtools-mcp`，固定 `@1.12.0`）**
- 已经在用（`development_log.md` §5.2）。chrome-devtools-mcp 的 license 本轮没有核对，它不在 references 里 *(unverified)*。

**2. Alibaba-NLP/DeepResearch @ `f72f75d`（Apache-2.0）：抽取 prompt**
- 取什么：`inference/prompt.py` L37–50 的 `EXTRACTOR_PROMPT`：给定网页内容和用户目标，输出 `rational`（定位相关段落）、`evidence`（**尽量保留原文上下文**）、`summary`。相关实现在 `inference/tool_visit.py`（`Visit`，按 95k token 截断，L24–40）。
- 模式：prompt **改编**（Apache-2.0）。
- 改造要点：映射到 kit 的 source card：`evidence` 对应卡片里的 `> "…"` 原文引语（C12 的 verdict 依据），`summary` 对应卡片正文，`rational` 不落盘。写进 `kit/harness/roles.md` 的 finder 指令。

**3. assafelovic/gpt-researcher @ `3582a68`（Apache-2.0）：页面有效性判断**
- 取什么：`gpt_researcher/scraper/scraper.py` L40–106 的三个启发式（见 C12）；`gpt_researcher/retrievers/` 下 20 多种搜索后端的适配层（tavily、serper、searx、arxiv、semantic_scholar、pubmed_central 等）。
- 模式：启发式 **改编**；retriever 层 **只借思路**（我们不托管搜索）。
- 改造要点：启发式可以写成给角色的检查清单（"如果页面是验证码或拦截页，改用 `browse the web`"），也可以在 daemon 侧对 source card 的原文做确定性检查。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| langchain-ai/open_deep_research @ `1b7d2e8`（archived） | 派活工具要求 `research_topic` 写成"至少一段话"；并发上限在工具层强制；`think_tool` 反思；搜索后对网页做摘要 | `src/open_deep_research/state.py` L15–21（`ConductResearch` / `ResearchComplete`）、`deep_researcher.py`（L291–319 超过并发的调用直接回错误）、`utils.py` L44 `tavily_search`、L175 `summarize_webpage`、L220 `think_tool` | 只借思路（MIT）。Lead 的派活约束写进 kit |
| stanford-oval/storm @ `fb951af` | 多视角提问；十几种 retriever 适配（`YouRM`、`BingSearch`、`SerperRM`、`BraveRM`、`SearXNG`、`DuckDuckGoSearchRM`、`TavilySearchRM` 等） | `knowledge_storm/rm.py` L13–1108 | 只借思路（MIT） |
| Alibaba-NLP/DeepResearch | 缺引用的小节继续搜，作为 finder 的循环条件 | `WebAgent/WebWeaver/prompt/search_user_prompt_id_3.py` L11–14 | 改编 prompt（Apache-2.0） |
| google-deepmind/long-form-factuality | checker 的多步搜索上限 | `eval/safe/config.py` L44–55 | 只借思路 |

### 坑与注意

- 这些参考都是 Python 加付费搜索 API（Tavily、Serper、Jina）。在我们的架构里主要用它们的 **prompt 和规则**，不搬运行时。
- **网页内容是数据，不是指令**（`kit/AGENTS.md` L92 已写）。抽取 prompt 改编时要保留这一条，并且不让角色把网页里的"指令"写进 source card 的正文区。
- `mas-browser` 只在 Claude Code 下生效，Codex / Antigravity 下有没有对应机制没有核实（`development_log.md` L311）*(unverified)*。跨厂商 checker 如果用 Codex，要确认它的浏览能力。
- 不登录、不购买、不上传（kit 规则）；被拦截的页面应标为 `blocked`，不要绕过。

### 必须自研

- 角色工具词表到各后端权限的确定性编译（`development_log.md` L257：`web search`、`browse the web`、`mcp:`、`cli:` …），属于组织编译器组件，这里只提需求。
- source card 的写入规范：原文引语、抓取时间、URL、A–D 等级，以及与 C12 evidence 的一一对应。

---

## C14 评测

### 我们要做什么

两类评测：
1. **产出质量（M0 / S3）**：单 agent（等 token 预算）对比团队、对比 `/deep-research`、对比 DR 产品。指标是 RACE（报告质量）、FACT（引用准确率和有效引用数），以及我们自己的 claim 级指标：supported 比例、contradicted 数、unknown 数、坏链率。
2. **HCI 实验（S4）**：tmux/OMC 对比 Office 对比 Office+CEO，fan-out 4/8/12（05 §B.4）。指标包括 TTN、TTR、上下文切换次数、单次交互时间、SAGAT 三层、NASA-TLX、信任校准。

### 首选参考

**1. Ayanami0730/deep_research_bench @ `f2735b5`（Apache-2.0）：作为外部评测工具依赖**
- 取什么：
  - 100 个博士级任务：`data/prompt_data/query.jsonl`、`data/criteria_data/criteria.jsonl`（各 100 行）；
  - RACE：`deepresearch_bench_race.py`，加 `prompt/criteria_prompt_{en,zh}.py`、`score_prompt_{en,zh}.py`；
  - FACT：`run_benchmark.sh` L72–93 及 `utils/`。
- 模式：**依赖**。在单独的评测目录里固定 commit 运行，不进 npm 包。判定 prompt 已在 C12 改编。
- 改造要点：
  - 我们的 `outputs/result.md` 要导出成它的 `raw_data/<model>.jsonl` 格式，需要一个导出脚本（`mas-office export` 扩展）。
  - 判官模型默认是 OpenAI（`utils/api.py` L13–22），抓网页用 Jina API（需要 `JINA_API_KEY`）。两者都要固定版本，并写进实验记录。

**2. google-deepmind/long-form-factuality（SAFE）@ `9d27158`（代码 Apache-2.0）**
- 取什么：atomic fact 拆分、相关性过滤、多步 Google 搜索判定，以及 F1@K。
- 模式：**依赖**（作为第二个独立的事实性指标）。
- 改造要点：LongFact 提示集属于"other materials"，适用 CC-BY-4.0，论文和数据发布时要署名。

**3. 我们自己的 `events.jsonl` + `command.*`：HCI 埋点的数据源**
- 05 §A.4 已经把命令和回执放进同一条日志：
  - TTR = `request.opened` 到对应的 `command.respond`（`origin: human`）；
  - Σ 阻塞时间由 `waitingOn` 推算。
- TTN 和上下文切换需要新增 UI 遥测事件（例如 `ui.viewed{requestId|agentId}`、`ui.focus{surface}`）。这些事件只写本地，用于研究，默认关闭。

### 备选参考

| 仓库 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|
| Libr-AI/OpenFactVerification @ `6e1ee9e` | claim 级汇总统计 `FCSummary` | `factcheck/utils/data_class.py` L81–98 | 改编（MIT）。用于我们的 claim 指标 |
| stablyai/orca @ `e280eb0` | "已读"的定义：一轮（turn）在被确认之前都算未读，确认时间要不早于该轮开始；做完的 agent 会话结束后仍可确认 | `src/renderer/src/attention/agent-attention-acknowledgement.ts` | 只借思路（MIT）。用于给 TTN 中的"注意到"下操作定义 |
| simple10/agents-observe @ `b3a7238` | 事件时间线回放 | `app/client/src/components/timeline/timeline-rewind.tsx` | 只借思路（MIT）。用于实验的脚本化回放 |
| 我们的 `panel/model.js` | `buildDemoScript` / `demoStatusesAt`（L823–865） | — | 自有代码。扩展成"在受控时间点注入事件"的回放器（05 §B.4） |
| langchain-ai/open_deep_research @ `1b7d2e8` | 可以作为一个开源 DR 基线系统（README 记载曾列 DeepResearch Bench 第 6） | — | 依赖或只借思路（MIT，已归档；需要 LangGraph 和 API key） |
| microsoft/magentic-ui @ `d3c9d13` | simulated user 机制（论文里 GAIA 完成率从 30.3% 升到 51.9%）；代码里只在 `src/magentic_ui/magentic_ui_config.py` 找到相关配置 | — | 只借思路 *(unverified：实现细节)* |
| ruvnet/ruflo @ `3fe9d70` | 反面教训：后台 daemon 无上限运行，"leaked tens of thousands of headless `claude --print` sweeps"（一个 daemon 跑了 19 天），之后加了 12 h TTL 和默认关闭的显式同意开关 | `v3/@claude-flow/cli/src/services/worker-daemon.ts` L128–140、L208–216 | 只借思路（MIT）。评测批量跑时必须有预算和 TTL |

### 坑与注意

- **LLM 判官偏差**：判官和被测系统不能同厂商，或者至少两家各判一次。判官模型和 prompt 版本写进结果文件。
- **额度和合规**：用订阅额度批量跑评测会撞上限，也偏离"ordinary individual usage"（`CLAUDE.md` §3 第 7 条）。大规模评测用 API key 和单独预算，并在论文里说明。
- DeepResearch Bench 的 README 徽章写的是 "Code_License-MIT"，但仓库 `LICENSE` 文件是 Apache-2.0，以 LICENSE 文件为准；HF 数据集 `muset-ai/DeepResearch-Bench-Dataset` 的 license 没有核对 *(unverified)*。
- HCI 实验用回放保证可比性，但会削弱真实感，要另做一轮小规模真实 agent 研究（05 §B.4）。
- 遥测涉及被试数据：只存本地，事先告知，可以导出和删除。

### 必须自研

- M0 对比 harness：同一任务集、等 token 预算、四种条件，输出统一的 RACE / FACT / claim 指标表。
- HCI 埋点（`ui.*` 事件）、SAGAT 冻结问询界面、TTN / TTR / 切换次数的计算脚本。
- 回放器：预录真实 Claude 和 Codex 会话，在受控时间点注入六类事件（05 §B.4）。

---

## C15 打包

### 我们要做什么

继续 web-first：`mas-office serve` 加浏览器面板是主形态，kit 用户双击 `office/index.html` 也能看。S4 再出桌面版：SYNTHESIS §4 写的是"之后 Tauri 桌面"，这个选型这里先列出依据，最终在 T10 决定。桌面壳只负责窗口、托盘徽章、系统通知、自动更新和启动 daemon，不复制面板逻辑。

### 首选参考

**1. pixel-agents-hq/pixel-agents @ `b1bafd0`（MIT）：同一个 web UI，两种宿主**
- 取什么：同一个 `webview-ui/` 既由 VS Code 扩展的 webview 承载（`adapters/vscode/extension.ts`、`PixelAgentsViewProvider.ts`，`package.json` 的 `engines.vscode`、`main: ./dist/extension.js`），也由 `npx pixel-agents` 独立 server 提供（`bin: pixel-agents → ./dist/cli.js`）；server 侧的 PTY 和 hook 对两种宿主共用。
- 模式：**只借思路**（架构）。
- 改造要点：我们的 `panel/` 已经是纯静态文件，加一个 VS Code / Cursor 侧栏 webview 宿主成本很低。KbWen 的 `?mode=panel` 也是同一思路。

**2. stablyai/orca @ `e280eb0`（MIT）：同一个 renderer，打 Electron 包和 web 包**
- 取什么：
  - `vite.web.config.ts`：同一 `src/renderer` 构建出 web 版，`base: './'` 以支持反向代理前缀；
  - `src/renderer/src/web/preload-api/`：在 web 里垫一层 Electron preload API；
  - `config/electron-builder.config.cjs`（924 行）：签名、公证、多平台；
  - `electron-updater` 自动更新。
- 模式：**只借思路**。规模远超我们的需要。
- 改造要点：如果选 Electron，就照这个"preload API 接口 + web 实现"的分层做，面板代码里不出现 `ipcRenderer`。

### 备选参考

| 仓库 | 壳 | 取什么 | 文件 | 模式 / license |
|---|---|---|---|---|
| HarnessMD/munder-difflin @ `80a1dbb` | Electron 32 + electron-vite + node-pty + xterm 5 + Pixi 8 | 和我们最接近的组合（PTY + 办公室） | `electron-builder.yml`、`electron.vite.config.ts`、`src/main/pty.ts` | 只借思路（代码 MIT） |
| W17ant/Claude-Office @ `1a9ba71` | Electron | 托盘徽章、迷你 widget（"需要你"计数在托盘上） | `electron/main.cjs`、`electron/tray.cjs`、`electron/after-pack.cjs` | 改编（MIT）。托盘逻辑很小 |
| eigent-ai/eigent @ `4958c94` | Electron + Python backend | Electron 主进程启动并管理 Python 后端的打包方式；macOS entitlements | `electron/main/`、`electron-builder.json`、`entitlements.mac.plist` | 只借思路（Apache-2.0） |
| stravu/crystal @ `1e18e0b` | Electron（已弃用，转为 Nimbalyst） | 早期 Claude stream-json 加 MCP 权限桥的桌面实现 | `main/src/index.ts`、`main/src/services/panels/claude/claudeCodeManager.ts` | 只借思路（MIT）。项目已停更 |
| winfunc/opcode @ `c24004d` | Tauri | Tauri 应用同时内置一个 web server（`src-tauri/src/web_server.rs`、`web_main.rs`）；`tauri.conf.json` | `src-tauri/` | **只借思路**（AGPL-3.0，我们是 MIT，不能复制代码） |
| bagidea/bagidea-office @ `68e2d04` | Rust `tao` 0.35 + `wry` 0.55 极简 webview 壳 | 不用完整 Tauri，也能给 web overlay 套一个原生窗口 | `shell/Cargo.toml`、`shell/src/` | 只借思路（MIT） |

### 坑与注意

- **Tauri 和 node-pty 的冲突**：我们的 daemon 是 Node（`mas-office serve`），原始终端依赖 node-pty 原生模块。选 Tauri 就要把 Node daemon 作为 sidecar 打包，并为每个平台预编译 node-pty。选 Electron 则要按 Electron ABI 重编 node-pty（munder-difflin 和 Orca 都这样做）。这是 T10 的主要权衡点。
- **签名、公证、自动更新**是桌面版的主要工作量（Orca 的 builder 配置有 924 行）。web-first 可以推迟这部分。
- **不得捆绑或修改 `claude` / `codex` 二进制**（`CLAUDE.md` §3 第 1 条）。opcode 的 `src-tauri/src/claude_binary.rs` 是在找用户本机的二进制，这个思路可以借，但它是 AGPL 代码，不能复制。
- **不复制任何厂商 logo 或图标**：Orca `resources/claude.webp`、`resources/opencode.webp`；Paperclip `ui/public/brands/`。桌面图标、托盘图标用我们自己的。
- 桌面壳不做登录按钮，只引导用户在终端里运行 `claude auth login` / `codex login`（`CLAUDE.md` §3 第 2 条）。

### 必须自研

- daemon 生命周期：桌面版启动和停止 `mas-office serve`，并发上限和用量提示（`CLAUDE.md` §3 第 7 条），以及空闲退出和 TTL（参考 ruflo 的教训）。
- 托盘和 OS 通知与 C9 的通知规则共用一套配置。
- 打包选型（Tauri 还是 Electron）的 spike：node-pty sidecar、包体积、签名流程，各跑通一次再决定。

---

## 附：license 核查（manifest 为 NONE / NOASSERTION、但本文引用了的仓库）

| 仓库 | manifest | 实际条款（读 LICENSE / README 确认） | 对我们的含义 |
|---|---|---|---|
| ringhyacinth/Star-Office-UI | NOASSERTION | `LICENSE`：§1 代码和逻辑 MIT（© 2026 Ring Hyacinth & Simon Lee）；§2 **所有美术仅限非商业**，商用必须全部替换；§3 访客角色是 LimeZu 免费包，需署名 | 代码可以改编（本文没有用到）；美术一律不碰 |
| google-deepmind/long-form-factuality | NOASSERTION | `LICENSE` 是多段文件：`third_party/factscore/*` 为 MIT（© 2023 Sewon Min）；`common/ data_creation/ eval/ longfact/ main/` 为 Apache-2.0；README "License and disclaimer"：软件 Apache-2.0，**其他材料 CC-BY-4.0** | 代码可以改编或依赖（Apache-2.0，带 NOTICE）；LongFact 数据使用时要署名 |
| disler/claude-code-hooks-multi-agent-observability | NONE | 仓库里没有 LICENSE 文件，README 也没有授权说明，默认保留所有权利 | **只借思路**，不复制任何代码或文档 |
| anthropics/claude-agent-sdk-typescript | NONE | `LICENSE.md`："© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"；README L45–47 同样表述 | **只能依赖 npm 包**，不得 vendor 源码 |

**另外两个 license 注意点**
- Ayanami0730/deep_research_bench：README 徽章写 MIT，`LICENSE` 文件是 Apache-2.0。以 LICENSE 文件为准，按 Apache-2.0 处理（带 NOTICE）。
- bagidea/bagidea-office、HarnessMD/munder-difflin、W17ant/Claude-Office：代码是 MIT，但美术另有授权或排除在 MIT 之外，详见 C10 的美术表。
