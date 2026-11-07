# 05 · 协议标准与 HCI / 管理理论文献

调研日期：2026-11-07。范围：A 部分是"人 ↔ 多 agent 双向控制"的协议（AG-UI、A2A、ACP、MCP、OpenTelemetry GenAI，以及 Codex app-server / Claude Agent SDK 的消息形态）；B 部分是监督多个自主体的 HCI 与管理理论。A 部分在 [`../prior-art.md`](../prior-art.md)（0.1 协议调研）基础上扩展，不重复其中的事件映射。

## 摘要

1. **六个协议在"状态"上已经收敛到三态前台模型**：Claude Agent SDK `session_state_changed` 和 ACP v2 `state_update` 都是 `idle | running | requires_action`；Codex 是 `idle | active{activeFlags: waitingOnApproval, waitingOnUserInput}`。我们的 7 态 `status` 与它一一可映射，**0.2 不需要新增 state 值**（新增反而会被 0.1 reducer 当作非法事件丢弃，见 §A.4）。
2. **"待人决定"在所有协议里都是一个带 id 的对象，答复用这个 id 关联**：AG-UI `Interrupt.id` ↔ `resume[].interruptId`；ACP / Codex 用 JSON-RPC request id；MCP 用 `inputRequests` 的 key。我们 0.1 的 `flag.raised` 没有 id，无法被"答复"，这是 0.2 必须补的。
3. **答复的结果集合也收敛了**：选项（`allow_once/always`、`reject_once/always`，ACP；`accept/acceptForSession/decline/cancel`，Codex）+ 结构化 payload（JSON Schema，AG-UI / MCP）+ 三种"没回答"（decline ≠ cancel ≠ expired）。
4. **给运行中的 agent 发消息不再需要等 turn 结束**：Codex `turn/steer`、Claude `priority: now|next|later`、ACP v2 "随时可发 `session/prompt`，接受 = 插入"。我们的命令需要一个 `delivery` 字段。
5. **取消 ≠ 失败**：AG-UI 1.0 专门加了 cancelled outcome，ACP 要求以"观测到停止"为准，"停止命令被接受"不算停止。0.1 把 cancel 并进 `failed`，需要修正。
6. **层级**：AG-UI `subagentRunId` + `parentSubagentRunId`，ACP 子 session + `subagent_update`，Codex `parentThreadId`，Claude `parent_tool_use_id` / `parent_task_id`。A2A 没有父子结构，OTel 只有 span 父子和 agent-as-tool transfer span。ACP 的经验最有用：取消父级只级联到"父级在等的"子级。
7. **0.2 建议（标题）**：在同一条 `events.jsonl` 里增加 **`request.*`（待决事项，带 id）** 和 **`command.*`（UI / CEO 下达的意图）** 两个命名空间，外加 `command.ack` 回执和 `mas/inbox` 快照；不改 7 个 state，只给 status 增加可选字段。全部是加法，0.1 consumer 照常工作。
8. **HCI 结论（B 部分）**：监督多个 agent 的瓶颈是人的注意力，不是 agent 的能力。fan-out 受 neglect tolerance 和交互时间限制；排队等待人的时间是主要损失；打断要放在任务断点；信任要校准而不是最大化。由此提出 10 条可检验的设计原则（§B.3），以及 tmux/OMC 对比我们界面的 CHI 式实验方案（§B.4）。
9. **最重要的一条设计规则**：界面要把"谁在等我、等了多久、我不回答会发生什么"做成一等公民（收件箱 + 举手 + 等待计时），并支持在不打开终端的情况下直接回答。这一条同时得到协议收敛（第 2 点）和 supervisory control 文献的支持。
10. **最直接的对照研究**是 ParallelPilot（arXiv:2609.33113，2026 preprint）：它的环境式仪表盘提高了吞吐量（+63%），也让人能多管约 1 个 agent，但感知控制没有提升。我们的差异点（就地答复、低成本 steer、CEO 代为监督）正好对着它没解决的部分，可以作为 CHI 实验的核心假设（P10）。
11. 未能从一手来源核实的事实标 *(unverified)*；文献只列出已核实存在的条目。

---

## A. 双向控制协议

### A.1 调研对象与本地克隆

| 项目 | 版本 / 状态 | 本地克隆 / 文档 |
|---|---|---|
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) · ⭐ 17.1k · MIT | spec 1.0；`@ag-ui/core` 1.0.4 | `references/repos/ag-ui-protocol__ag-ui` @ 37b4da9（2026-11-06） |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) · ⭐ 26.4k · Apache-2.0 | 最新发布 1.0.0；`specification/a2a.proto` 为规范 | `references/repos/a2aproject__A2A` @ 9fff3e0（2026-11-05） |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)（`zed-industries/agent-client-protocol` 现重定向到这里）· ⭐ 4.6k | v1 稳定；v2 在 docs 导航中标 **Draft**；subagents RFD 处于 Active 阶段 | `references/repos/agentclientprotocol__agent-client-protocol` @ 7441d10（2026-11-07） |
| [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) · ⭐ 9.6k | 2026-07-28（docs 标 latest）；Tasks 已移出核心，成为扩展 `io.modelcontextprotocol/tasks` | `references/repos/modelcontextprotocol__modelcontextprotocol` @ cf59bb0（2026-11-07） |
| [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) · Apache-2.0 | agent spans 全部 **Development** | `references/repos/open-telemetry__semantic-conventions-genai` @ e6658f1（2026-11-06） |
| Codex app-server | 文档已由会话控制调研者保存 | `references/docs/codex__app-server.md`；源码 `references/repos/openai__codex` @ 57a808a |
| Claude Agent SDK | 同上 | `references/docs/claude__agent-sdk_typescript.md` 等 |
| [microsoft/magentic-ui](https://github.com/microsoft/magentic-ui) · ⭐ 10.1k · MIT | 仓库现已改为 MagenticLite（下一代） | `references/repos/microsoft__magentic-ui` @ d3c9d13（2026-07-23） |

本轮保存到 `references/docs/` 的页面（文件顶部有来源 URL）：`ag-ui__*`（interrupts、subagents、1.0 lifecycle、interrupt-resume、tool-calls、run-input、draft meta-events）、`a2a__*`（specification、life-of-a-task、a2a.proto）、`acp__*`（rfd-subagents、rfd-v2-prompt、rfd-v2-background-work、rfd-v2-permission-requests、v2-prompt-lifecycle、v1-tool-calls、v1-cancellation、v1-elicitation、v1-prompt-turn）、`mcp__*`（2026-07-28 mrtr、elicitation、changelog、cancellation、ext-tasks-overview）、`otel-genai__*`（gen-ai-agent-spans、execute-tool）、`magentic-ui__*`（transparency-note、configuration）。

### A.2 六个维度的对照

#### (1) Agent 状态

| 协议 | 状态模型 | 来源 |
|---|---|---|
| AG-UI 1.0 | 没有持续的 agent 状态，只有 run 生命周期：`RUN_STARTED` → `RUN_FINISHED{outcome: success \| interrupt \| cancelled}` / `RUN_ERROR`。子 agent 用 `SUBAGENT_FINISHED.outcome: success \| suspended` 区分"完成"和"挂起等人"。`ACTIVITY_SNAPSHOT/DELTA` 承载结构化进度（`activityType` 如 `PLAN`） | `docs/spec/1.0/events/lifecycle.mdx`、`docs/concepts/subagents.mdx`、`docs/concepts/events.mdx` |
| A2A 1.0 | `TaskState`：`SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, REJECTED`（终态）+ `INPUT_REQUIRED, AUTH_REQUIRED`（"interrupted" 态）。`TaskStatus{state, message, timestamp}` | `specification/a2a.proto` L187–219 |
| ACP v1 | 无 session 状态，只有 prompt turn 的 `stopReason`（`end_turn, max_tokens, max_turn_requests, refusal, cancelled`）和 tool call 状态（`pending, in_progress, completed, failed`） | `docs/protocol/v1/prompt-turn.mdx`、`tool-calls.mdx` |
| ACP v2（Draft） | `state_update`: **`running \| requires_action \| idle`**（idle 带 `stopReason`），可附 `background` 列表；background-work RFD 给 tool call 加 `paused` | `docs/protocol/v2/prompt-lifecycle.mdx`、`docs/rfds/v2/background-work.mdx` |
| MCP Tasks 扩展 | `working, input_required, completed, failed, cancelled`；轮询 `tasks/get` 或 `notifications/tasks` | `docs/extensions/tasks/overview.mdx` |
| OTel GenAI | **没有"当前状态"**：span 打开即在运行，结束时 span status OK / ERROR + `error.type`；`gen_ai.response.finish_reasons` 可以是 `interrupted`。只能事后分析，不能表示"等人" | `docs/gen-ai/gen-ai-agent-spans.md` L300–320 |
| Codex app-server | `ThreadStatus`: `notLoaded, idle, systemError, active{activeFlags: [waitingOnApproval, waitingOnUserInput]}`；通知 `thread/status/changed`；turn 状态 `inProgress, completed, interrupted, failed` | `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` L1729–1746；`codex__app-server.md` |
| Claude Agent SDK | `SDKSessionStateChangedMessage.state: "idle" \| "running" \| "requires_action"`；后台任务 `task_started / task_updated{status: pending, running, completed, failed, killed} / task_notification{status: completed, failed, stopped}` | `claude__agent-sdk_typescript.md` L5716、L5798、L5883 |

**结论**：前台三态（idle / running / requires_action）是事实标准；"后台还有活在跑"是正交的第二维（ACP `background`、Claude `background_tasks_changed`、Codex background terminals）。我们的 `working` = running，`flagged` + `needs_*` = requires_action，`idle/done` = idle。

#### (2) 待人决定（pending human decision）

| 协议 | 形态 | 关键字段 |
|---|---|---|
| AG-UI | run 以 `RUN_FINISHED{outcome:{type:"interrupt", interrupts:[...]}}` **结束**；同一 run 可带多个并行 interrupt | `Interrupt{id, reason: tool_call \| input_required \| confirmation \| <ns>:<custom>, message, toolCallId, responseSchema, expiresAt, metadata, subagentRunId}` |
| A2A | task 进入 `INPUT_REQUIRED` / `AUTH_REQUIRED`，`status.message` 写明要什么 | 没有结构化 schema；AUTH_REQUIRED 可以沿 client-agent 链逐级上抛（"chain of tasks"，spec §7.6） |
| ACP v1 | agent → client 的 JSON-RPC **请求** `session/request_permission{sessionId, toolCall, options[]}`；elicitation 走 MCP 风格的 form / url | `PermissionOption{optionId, name, kind: allow_once \| allow_always \| reject_once \| reject_always}`；"remembered decision 归 agent 所有" |
| ACP v2（Draft RFD） | 权限请求不再绑死 tool call：`{title, description?, subject?: {type: tool_call \| command \| ...}, options}` | 未知 `subject.type` 要原样保存、转发 |
| MCP 2026-07-28 | **MRTR**：server 不再主动发请求，而是返回 `resultType: "input_required"` + `inputRequests`（key → elicitation / sampling 请求），client 收集后**重发原请求**带 `inputResponses`；Tasks 扩展里则是 `tasks/get` 返回 `inputRequests`，`tasks/update` 答复 | elicitation 两种模式：form（受限 JSON Schema）、url（敏感信息走带外） |
| Codex | server → client 请求：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`tool/requestUserInput`；同时 thread 进入 `activeFlags: [waitingOnApproval]` | `{itemId, threadId, turnId, reason?, command?, cwd?, availableDecisions?}`；`serverRequest/resolved` 通知"已答复或已清除" |
| Claude Agent SDK | 回调 `canUseTool(toolName, input, {signal, suggestions, decisionReason, toolUseID, agentID, requestId})`；hooks 的 `PermissionRequest`；断线后 `reinitialize()` 会重新投递未决请求，要求回调按 `requestId` 幂等 | 会话进入 `requires_action` |
| OTel | 无 | — |

**结论**：一个"待决事项"至少要有 `id`、类型（工具审批 / 输入 / 确认）、给人看的标题、绑定对象（tool call、命令、文件改动）、选项或 schema、过期时间、发起者（哪个子 agent）。AG-UI 的 `Interrupt` 是字段最全的参照；ACP 的 `options[].kind` 是最好的审批选项词表。

#### (3) 人的答复

| 协议 | 形态 |
|---|---|
| AG-UI | 新 run 的 `RunAgentInput.resume[{interruptId, status: resolved \| cancelled, payload?, metadata?}]`；**必须一次答复所有未决 interrupt**；**有未决 interrupt 时线程不接受新输入**；同 `(threadId, interruptId, status, payload)` 重放必须安全；"拒绝"写在 payload 里（`{approved:false}`），approve-with-edits 用 `editedArgs` 整体替换 |
| A2A | 同 `taskId` 再发一条 `Message`（`role: ROLE_USER`） |
| ACP | JSON-RPC 响应 `{outcome: {outcome: "selected", optionId} \| {outcome: "cancelled"}}`；elicitation 答复 `action: accept \| decline \| cancel` |
| MCP | `inputResponses` map（key 与 `inputRequests` 对应），elicitation 同为 `accept / decline / cancel` 三动作 |
| Codex | JSON-RPC 响应 `decision: accept \| acceptForSession \| decline \| cancel \| {acceptWithExecpolicyAmendment}` |
| Claude SDK | `PermissionResult = {behavior:"allow", updatedInput?, updatedPermissions?} \| {behavior:"deny", message, interrupt?}` |

**结论**：要区分 **decline（明确拒绝，agent 继续但不做）**、**cancel（没给答案，放弃）**、**expired（超时）**；要支持 approve-with-edits（`updatedInput` / `editedArgs`）和"记住这个决定"（`allow_always` / `acceptForSession` / `updatedPermissions`）。AG-UI 的"未决时阻塞新输入"规则对单 agent 合理，但对我们的 office 不合适：人应该可以一边有未决审批，一边给同一 agent 发补充说明（ACP v2、Codex 都允许）。

#### (4) 给运行中的 agent 发新消息

| 协议 | 能否在运行中插话 | 形态 |
|---|---|---|
| AG-UI | **不能**："The protocol has no mid-run channel from the consumer"（`spec/1.0/events/tool-calls.mdx` L157–160）。只能等 run 结束后发新 `RunAgentInput` | — |
| A2A | 非终态 task 可以收后续消息（`taskId` 引用）；终态 task 拒绝（`UnsupportedOperationError`） | `SendMessage` |
| ACP v1 | 一次一个 prompt turn | `session/prompt` |
| ACP v2（Draft） | **可以**，任何状态都能发；"acceptance means insertion"，响应带 agent 分配的 `messageId`；"插入运行中的 turn 意味着 steer 还是排队，由 agent 决定" | `session/prompt` → `{messageId}` |
| Codex | **可以**：`turn/steer` 追加到当前 turn（不发新的 `turn/started`，不接受 model/cwd 覆盖）；`turn/start` 开新 turn | — |
| Claude SDK | **可以**（streaming input 模式）：`SDKUserMessage.priority: "now" \| "next" \| "later"`，`now` + `origin:{kind:"human"}` 会把可后台化的工作挪到后台再读消息；`shouldQuery:false` 只追加上下文不触发 turn | `streamInput()` |

**结论**：命令需要 `delivery: steer | queue | interrupt` 三档，适配器分别映射到 Claude `next / later / now`、Codex `turn/steer / turn/start / turn/interrupt + turn/start`。消息"送达"以 agent 回报"已插入"（ACP 的 `messageId`、Claude 的 user message replay）为准，而不是以命令被接收为准。

#### (5) 取消 / 中断

| 协议 | 形态 | 值得抄的规则 |
|---|---|---|
| AG-UI 1.0 | `RUN_FINISHED{outcome:{type:"cancelled"}}` | consumer **既不能把取消显示成成功，也不能显示成失败**；客户端断开连接只算 truncated，不能伪造 cancelled；新的终态必须在 1.0 就命名，否则老 consumer 会当成 success |
| A2A | `CancelTask` → `CANCELED`；幂等；不保证成功（`TaskNotCancelableError`） | — |
| ACP | `session/cancel`（通知）；client 必须把未决权限请求答为 `cancelled`；子 session 可单独取消（`capabilities.cancel`） | "**接受停止命令不等于工作已停止**，以实际状态为准，观测不到就报 `unknown`" |
| MCP | `notifications/cancelled`；Tasks 的 `tasks/cancel` 是协作式，server 可不执行 | — |
| Codex | `turn/interrupt` → turn 以 `status: "interrupted"` 结束；后台终端单独 `thread/backgroundTerminals/terminate` | — |
| Claude SDK | `interrupt()`（返回 interrupt receipt，列出当时未处理的消息）；`stopTask(taskId)` 停后台任务；`deny` 时 `interrupt: true` | — |

#### (6) 层级 / 父子

| 协议 | 形态 |
|---|---|
| AG-UI | `subagentRunId`（**一次调用**，不是定义）、`name`（类型）、`parentSubagentRunId`、`parentToolCallId`；归属是"出处"而非"所有权"；挂起的子 agent 恢复时可复用 id |
| A2A | **没有父子**；只有 `contextId`（会话）和 `referenceTaskIds`（相关任务）。层级靠"agent 同时是上游的 server 和下游的 client"隐式形成 |
| ACP（subagents RFD，Active） | 每个子 agent 是一个受限 session；父 session 上发 `subagent_update{sessionId, title, description, capabilities:{cancel}, state, cwd}`；会话间消息 `session_message{senderSessionId, recipientSessionId}`；**取消父级只级联到父级正在等的子级**，后台子级继续；子级的未决请求不能挪给父级 |
| MCP | 无 |
| OTel | span 父子 + `gen_ai.execute_tool.transfer`（agent-as-tool 转交，`gen_ai.transfer.mode: return_to_caller \| pass_control`，`gen_ai.transfer.target.name`）——prior-art 写"OTel 没有 handoff span"，现已过时 |
| Codex | `thread/list` 可按 `parentThreadId` / `ancestorThreadId` 过滤；thread 来源 `subAgent, subAgentReview, subAgentThreadSpawn…`；item `collabToolCall{senderThreadId, receiverThreadId, newThreadId, agentStatus}` |
| Claude SDK | 消息带 `parent_tool_use_id`；`task_started{task_id, parent_task_id, spawn_depth, is_backgrounded}`；文档提示应按 `agent_id` 而不是 `parent_tool_use_id` 匹配 |

### A.3 对 MAS Office 的含义

- **我们的位置**：上述协议都是"一个 client ↔ 一个 agent（含其子 agent）"。我们要做的是"一个人 + 一个 CEO agent ↔ N 个独立官方会话"，相当于多个 ACP / Codex / Claude 会话的**多路复用与汇总层**。所以 0.2 不该照搬某一个协议，而是定义一个能被各适配器映射进来的中间层，并保持 AG-UI / A2A / ACP 导出。
- **借用**：AG-UI 的 `Interrupt` 字段和 resume 幂等规则；ACP 的权限选项词表、子 session 取消语义、"接受 ≠ 停止"；Claude / Codex 的三档送达；MCP 的 accept / decline / cancel 三动作；OTel transfer span 作为 handoff 导出目标。
- **现状的缺口**：`packages/python/src/mas_office/integrations/claude_agent_sdk.py` L116 目前靠 `Notification` 的 `notification_type` 是否含 "permission" 来猜 `needs_approval`，而且 flag 挂在 lead 上。这个 flag 没有 id、没有选项，人看到举手也无法在面板里回答。0.2 的 `request.opened` 应改由 `canUseTool` / `PermissionRequest`（Claude）和 `*/requestApproval`（Codex）直接产生，并挂在真正发起请求的 agent 上。
- **不借用**：AG-UI "run 以 interrupt 结束、下个 run resume" 的终止式模型（我们的会话是长活的）；AG-UI "未决时阻塞新输入"（与"一边审批一边追问"冲突）；MCP MRTR 的"重发原请求"（适合无状态 server，不适合长会话）。

### A.4 MAS Office 协议 0.2 建议

**兼容性约束（来自 0.1 spec）**：
- 0.1 reducer 会**丢弃** `state` 不在 7 个值之内的 `agent.status`（§4.1 第 2 条）。因此 **0.2 不新增 state 值**，只加可选字段和新事件类型。
- consumer 必须接受、可以忽略未知类型（§3.2 conformance），所以新增 `request.*` / `command.*` / `task.*` 对 0.1 consumer 无害。
- 0.1 status 快照"恰好"有 7 个字段（§4.2）。0.2 增加字段属于 reducer 输出变化，按 `spec/rfcs/README.md` 走 RFC（加法 → minor bump），并补 conformance case。
- 迁移期内，0.2 producer 在 `request.opened` 之外**同时**发一条 0.1 的 `flag.raised{kind: needs_approval | needs_input}`，在 `request.resolved` 之外同时发 `flag.resolved`，这样 0.1 面板仍能举手。一个 minor 版本后停止双发。

#### 设计原则

1. **事实与意图分开，但在同一条日志里**。`command.*` 是 UI / CEO 下达的意图，`command.ack` 和随后的 agent 事件才是事实。reducer **只根据事实改状态**：中断命令不会让 agent 变 idle，只有适配器回报的 `agent.status` / `agent.stopped` 才会（ACP 规则）。同一条 `events.jsonl` 保证可回放、可审计（AG-UI 的 tool-bound interrupt 审计链：提议 → 人的决定 → 执行结果）。
2. **每个待决事项有 id，答复引用 id**，可并行、可乱序、幂等。
3. **每个 agent 声明自己接受哪些命令**（ACP per-child `capabilities`），界面只为能用的操作显示按钮。

#### 新增 / 修改的事件（agent → 面板）

```jsonc
// 待决事项：取代 0.1 中没有 id 的 flag.raised(needs_*)
{"v":"0.2","seq":41,"ts":"…","type":"request.opened","agentId":"coder","parentId":"lead",
 "data":{
   "requestId":"req_7f3",                     // 必填，日志内唯一
   "kind":"approval",                         // 必填：approval | input | choice | confirmation | <ns>:<custom>
   "title":"Run `pnpm test`?",                // 必填，给人看的一句话
   "description":"Touches packages/node only", // 可选
   "subject":{"type":"command","command":"pnpm test","cwd":"/repo"}, // 可选：tool_call | command | file_change | plan | handoff | …（未知类型原样保存）
   "toolCallId":"call_12",                    // 可选，绑定 tool.started.callId
   "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
              {"optionId":"allow-session","name":"Allow `pnpm test` for this session","kind":"allow_always"},
              {"optionId":"reject","name":"Reject","kind":"reject_once"}],
   "responseSchema":null,                     // kind=input 时给 JSON Schema（MCP form 子集）
   "blocking":true,                           // agent 是否停在这里
   "routeTo":"lead",                          // human | lead | <agentId>：先给谁处理（见下）
   "urgency":"normal",                        // low | normal | high
   "expiresAt":null,
   "source":{"backend":"codex","raw":"item/commandExecution/requestApproval"} }}

{"type":"request.resolved","agentId":"coder",
 "data":{"requestId":"req_7f3",
   "outcome":"selected",                      // selected | submitted | declined | cancelled | expired | superseded
   "optionId":"allow-once", "payload":null,   // submitted 时为表单内容；approve-with-edits 用 payload.editedArgs
   "by":{"kind":"human"},                     // human | agent(id) | policy —— 谁做的决定
   "cmdId":"cmd_91"}}                         // 若由命令触发，关联它

// 命令回执：由适配器写
{"type":"command.ack","agentId":"coder",
 "data":{"cmdId":"cmd_91","status":"applied","reason":null}}  // accepted | applied | rejected | unsupported | expired

// 停止：区别于失败
{"type":"agent.stopped","agentId":"coder",
 "data":{"reason":"Stopped by you","by":{"kind":"human"},"scope":"turn"}}  // turn | agent

// 任务：CEO 派活后的事实（映射 A2A Task / MCP Task / Claude task_*）
{"type":"task.assigned","agentId":"coder","data":{"taskId":"t_3","title":"Fix flaky test","from":"lead","brief":"…"}}
{"type":"task.updated","agentId":"coder","data":{"taskId":"t_3","state":"working","say":"Reproduced locally"}}
{"type":"task.finished","agentId":"coder","data":{"taskId":"t_3","outcome":"success","summary":"…"}}   // success | failed | cancelled
```

`agent.registered.data` 增加：
- `session`：`{"backend":"claude-code" | "codex" | "sdk" | …, "id":"…", "resumable":true, "attach":"tmux:%3"}`，用于"可观看、可接手"的原始终端视图；
- `accepts`：`["message","respond","interrupt","assign"]`，即这个 agent 支持的命令；
- `instanceOf`：角色 id（实例 ≠ 定义，见 AG-UI `subagentRunId` vs `name`）。

`agent.status.data` 增加可选的 `waitingOn: ["req_7f3"]`、`stopReason: "end_turn" | "cancelled" | "error" | "max_turns"`、`background: <int>`（后台仍在跑的任务数）。

#### 新增命令（面板 / CEO → agent）

信封与事件相同（`v, seq, ts, type, agentId`），另加 `cmdId`（调用方生成，幂等键）和 `origin`：

| `type` | `data` | 适配器映射 |
|---|---|---|
| `command.message` | **`text`**, `delivery: steer \| queue \| interrupt`（默认 `steer`）, `attachments?` | Claude `streamInput` + `priority: next \| later \| now`；Codex `turn/steer` / `turn/start` / `turn/interrupt`→`turn/start`；ACP v2 `session/prompt`；A2A `SendMessage(taskId)` |
| `command.respond` | **`requestId`**, `outcome`, `optionId?`, `payload?`, `note?` | ACP permission 响应 / elicitation `accept\|decline\|cancel`；Codex `decision`；Claude `PermissionResult`；AG-UI `resume[]`；MCP `inputResponses` |
| `command.assign` | **`title`**, `brief`, `taskId?`, `inputs?`, `handsTo?` | 对 agent 来说就是一条带结构的 `command.message`；适配器回写 `task.assigned` |
| `command.interrupt` | `scope: turn \| agent \| subtree`, `reason?` | Claude `interrupt()` / `stopTask`；Codex `turn/interrupt`；ACP `session/cancel`（子 session 需 `capabilities.cancel`）；A2A `CancelTask`；AG-UI → 期待 `RUN_FINISHED{cancelled}` |
| `command.*`（预留） | `pause` / `resume` / `spawn` / `run.start` / `run.cancel` | 后续 minor 版本 |

`origin`：`{"kind":"human"}` 或 `{"kind":"agent","id":"lead"}`。**只有 `serve` 根据 UI 会话 token 可以写 `kind:"human"`**；agent（包括 CEO）通过 MCP 工具发出的命令一律标 `agent`，防止 agent 冒充人批准自己的请求（Claude SDK 的 `origin` 和 AG-UI `resume.metadata` 签名思路相同）。

#### Reducer 规则（增量）

| 事件 | 效果 |
|---|---|
| `request.opened` | 记入 `inbox`。若 `blocking`：status → `flagged`，`flagKind` ← `kind` 映射（approval → `needs_approval`，其他 → `needs_input`），`flag` ← `title`，`waitingOn` 追加 id |
| `request.resolved` | 从 `inbox` 移除，记入 `inboxHistory`；`waitingOn` 移除 id；若清空且当前为 `flagged`：→ `working` |
| `command.*` | **不改 agent 状态**；记入 `pendingCommands` |
| `command.ack` | 更新/移除 `pendingCommands`；`rejected` / `unsupported` 在 inbox 里生成一条系统提示 |
| `agent.stopped` | `scope: turn` → `idle`，`say` ← reason ?? "Stopped"，`stopReason: "cancelled"`；`scope: agent` → `done` 加 `stopReason: "cancelled"`（**不是** `failed`）；清理该 agent 未决请求为 `cancelled` |
| `task.*` | 更新 `tasks` 快照；`task.updated.say` 同时更新 status `say` |

新快照 `mas/inbox.json`（+ `.js`，`window.MAS_INBOX`）：`{"pending":[{requestId, agentId, kind, title, urgency, routeTo, openedAt, blocking, options, responseSchema}], "recent":[…最近 N 条已解决]}`，按 `urgency`，再按 `openedAt` 排序。面板的"需要你"收件箱和小人举手都从这里读。

#### 传输

- `POST /v0/commands?project=<folder>`：校验 schema 和 `accepts`，写入 `origin`、分配 `seq`，追加到 `events.jsonl`，返回 `{"accepted":true,"seq":n,"cmdId":…}`。
- `GET /v0/stream?project=…&types=command.*&agent=<id>`：适配器订阅发给自己的命令（SSE，沿用 0.1 的 `id: <seq>` 续传）。
- kit 模式（只能写文件的 assistant）：`serve` 把命令另外写一份到 `mas/commands/<agentId>.jsonl`，assistant 按 AGENTS.md 指示轮询并写 `command.ack`。
- **CEO 的结构化事件流**（M2 的 MCP server）：工具 `mas_events_since(seq, types?, agents?)`、`mas_inbox()`、`mas_command(...)`。默认只给 CEO `agent.status`、`request.*`、`task.*`、`handoff`、`result`、`agent.stopped`，不给 `tool.*` 和 `message` 正文，并让 `say` 承担一行摘要。**`routeTo: "lead"` 的请求先交 CEO 处理，CEO 只能 `respond` 被允许的 `kind`**（例如只读工具审批），其余自动上抛给人（A2A AUTH_REQUIRED 逐级上抛 + management by exception，见 B 部分）。

#### 导出映射（0.2 增量）

| MAS Office 0.2 | AG-UI 1.0 | A2A 1.0 | ACP | OTel GenAI |
|---|---|---|---|---|
| `request.opened` | `Interrupt`（在 `RUN_FINISHED.outcome.interrupts[]`；`reason` ← `tool_call` / `input_required` / `confirmation`） | `TaskStatusUpdateEvent{state: INPUT_REQUIRED}`，`status.message` ← title | `session/request_permission` / `elicitation/create` | span event（自定义 `mas.request.opened`） |
| `request.resolved` | `RunAgentInput.resume[]{interruptId, status, payload}` | 带 `taskId` 的 `Message` | permission / elicitation 响应 | span event |
| `command.message` | 新 `RunAgentInput.messages` | `SendMessage` | `session/prompt` | — |
| `command.interrupt` / `agent.stopped` | `RUN_FINISHED{outcome: cancelled}` | `CancelTask` / `CANCELED` | `session/cancel` / `idle + stopReason: cancelled` | span end，`finish_reasons: interrupted` |
| `task.*` | `ACTIVITY_SNAPSHOT{activityType: "TASK"}` | `Task` | 子 session `subagent_update` | `invoke_agent` span |
| `handoff`（0.1） | `CUSTOM` | `referenceTaskIds` | `session_message` | `gen_ai.execute_tool.transfer`（`transfer.mode: pass_control`） |

#### 风险与未决问题

- ACP v2 和 subagents RFD 仍是 Draft / Active，字段可能变；我们只借语义，不绑定字段名。
- Codex 与 Claude 对"运行中插话"的语义不同（steer 是否打断当前工具调用），`delivery` 在不同后端上只能做到近似；适配器应在 `command.ack.reason` 里说明实际行为。
- `routeTo: lead` 让 CEO agent 替人批准，有越权风险：需要岗位级白名单（只允许 CEO 批准哪些 `kind` / `subject.type`），并且所有 CEO 决定都进收件箱历史，供人事后审查。
- AG-UI 的教训：0.1 consumer 看不懂新的终态时会默认当成功能。所以 `agent.stopped` 必须配合 0.1 可识别的 `agent.status`（`idle`）一起发，不能只靠新类型。

---

## B. 监督多个 agent 的 HCI 与管理理论

方法：书目信息由文献核实子任务通过 Crossref、arXiv API、DTIC、NTIS 和图书馆目录确认存在。2026 年的预印本我又用 arXiv API 抽查了标题、作者和摘要（`references/docs` 里没有保存论文全文）。经典文献的"发现"一栏是对广泛引用的摘要的概括，没有逐篇重读全文，数值类结论注明了来源。找不到的条目已删除，见 §B.5。

### B.1 经典理论 → 发现 → 对我们的设计规则

| # | 文献 | 发现 | 对办公室 / 收件箱 / CEO 的设计规则 |
|---|---|---|---|
| 1 | Sheridan (1992) *Telerobotics, Automation, and Human Supervisory Control*，MIT Press（无 DOI；书评 [10.1017/s0263574700016209](https://doi.org/10.1017/s0263574700016209)）；Sheridan & Verplank (1978) MIT tech report，NTIS ADA057655 | supervisory control 中，人负责 plan、teach、monitor、intervene、learn 五项职能，执行交给下层自动化；1978 年的报告给出 10 级 levels of automation | 界面要覆盖全部五项职能，而不只是 monitor：plan 对应 Lead 设计团队，teach 对应岗位 SOP 和权限，monitor 对应办公室视图，intervene 对应抽屉聊天、审批和中断，learn 对应把"总是允许"的决定沉淀为岗位规则。tmux 只覆盖 monitor 和 intervene |
| 2 | Parasuraman, Sheridan & Wickens (2000), IEEE SMC-A 30(3), [10.1109/3468.844354](https://doi.org/10.1109/3468.844354) | 自动化分为信息获取、信息分析、决策选择、动作执行四类功能，每类单独设定 level | **自动化程度按功能和岗位分别配置**：例如 CEO 可以自动"分析"（汇总），但"决策选择"（批准写操作）默认交给人。协议上对应 `request.routeTo` 和岗位级白名单（§A.4） |
| 3 | Olsen & Goodrich (2003) PerMIS, [scholarsarchive.byu.edu/facpub/1052](https://scholarsarchive.byu.edu/facpub/1052)（作者顺序在各来源中不一致）；Olsen & Wood (2004) CHI, [10.1145/985692.985722](https://doi.org/10.1145/985692.985722) | 提出 neglect time、interaction time、robot attention demand、free time 等指标。**fan-out ≈ activity time / interaction time**，即一个人能有效操控的机器人数 | 要想提高 fan-out，只有两条路：延长 agent 无人照看时能干的时间（任务切分、岗位 SOP、checker 自动核对），或缩短每次交互的时间（收件箱一键答复、上下文就地展示）。界面要**度量并显示**每个 agent 的 neglect time，以及每次交互花了多久 |
| 4 | Crandall, Goodrich, Olsen & Nielsen (2005), IEEE SMC-A 35(4), [10.1109/tsmca.2005.850587](https://doi.org/10.1109/tsmca.2005.850587) | 用 neglect tolerance 和 interaction time 可以预测多机器人团队的整体绩效，实验验证了这一点 | agent 的 neglect tolerance 是有限的：长时间没人看，产出质量会下滑或偏离方向。对长时间无人查看、产出又持续增长的 agent，CEO 要主动生成一次"检查点"摘要，而不是等它举手 |
| 5 | Cummings & Guerlain (2007), Human Factors 49(1), [10.1518/001872007779598109](https://doi.org/10.1518/001872007779598109) | 操作员能同时管理的自主载具数量有上限；utilization（忙碌时间占比）约 **70%** 以上时绩效下降（数值来自文献核实子任务对摘要的概括） | 界面应**估计并显示人的 utilization**，例如过去 10 分钟里处理收件箱和看抽屉所占的时间。接近饱和时，CEO 停止加派并行任务，或把低优先级请求合并 |
| 6 | Cummings & Mitchell (2008), IEEE SMC-A 38(2), [10.1109/tsmca.2007.914757](https://doi.org/10.1109/tsmca.2007.914757) | fan-out 模型必须计入 **wait times**：载具排队等操作员处理的时间、操作员察觉之前的时间等，否则容量会被高估 | **"等待人的时间"是一等指标**：收件箱的每一项显示已等多久；小人举手后，计时以视觉方式递增。CEO 汇报里统计"今天 agent 总共等了你多少分钟" |
| 7 | Donmez, Nehme & Cummings (2010), IEEE SMC-A 40(6), [10.1109/tsmca.2010.2046731](https://doi.org/10.1109/tsmca.2010.2046731) | 用排队 / 离散事件模型把 workload 对服务时间的影响建进去，可以预测多载具监督的绩效 | 收件箱本质上是一个服务队列，排序策略（紧急度、阻塞了几个下游、等待时长）可以借排队论设计和仿真。评测时也可以用同类模型预测最佳团队规模 |
| 8 | Endsley (1995), Human Factors 37(1), [10.1518/001872095779049543](https://doi.org/10.1518/001872095779049543)；Endsley (1988) SAGAT, NAECON, [10.1109/naecon.1988.195097](https://doi.org/10.1109/naecon.1988.195097) | situation awareness 分三层：L1 perception、L2 comprehension、L3 projection。SAGAT 的做法是冻结场景，当场问询 | 办公室视图要同时支持三层：L1，谁在干什么（小人、`say`）；L2，这对目标意味着什么（阶段进度、谁阻塞了谁）；L3，接下来会怎样（预计完成时间、"不回答的话 3 个 agent 会停"）。现在的面板只有 L1 |
| 9 | Endsley & Kiris (1995), Human Factors 37(2), [10.1518/001872095779064555](https://doi.org/10.1518/001872095779064555)；Kaber & Endsley (2004), TIES 5(2), [10.1080/1463922021000054335](https://doi.org/10.1080/1463922021000054335) | 完全自动化会降低 SA，人接管时变慢（out-of-the-loop）；中间级别的 LOA（自动化负责执行、人保留决策）在绩效和 SA 上最好 | 默认不把人完全移出回路：关键决策（合并、发布、删除、花钱）保留给人，但由 agent 准备好选项。"接手终端"必须一键可达，并在接手前给出一屏上下文摘要 |
| 10 | Bainbridge (1983) "Ironies of automation", Automatica 19(6), [10.1016/0005-1098(83)90046-8](https://doi.org/10.1016/0005-1098(83)90046-8) | 自动化把人留在最难的角色上：监控罕见故障并在出错时接管，而人的技能和 SA 恰恰因自动化而退化 | 不能只在出错时才把人拉进来。要有低成本的日常"在场感"：环境式的办公室视图、定期的 CEO 摘要。接管时界面要提供证据（diff、日志、来源），而不只是一句结论 |
| 11 | McFarlane (2002), HCI 17(1), [10.1207/s15327051hci1701_2](https://doi.org/10.1207/s15327051hci1701_2)；McFarlane & Latorella (2002), [10.1207/s15327051hci1701_1](https://doi.org/10.1207/s15327051hci1701_1) | 比较 immediate、negotiated、mediated、scheduled 四种打断协调方式。**negotiated（由人决定何时处理）总体最好**，代价是响应变慢 | 默认采用 negotiated：举手和收件箱提示，但不弹窗、不抢焦点。只有 `urgency: high`，且等待会造成不可逆损失时，才升级为 immediate。CEO 可以充当 mediated 的中间层，先过滤再打断 |
| 12 | Iqbal & Bailey: CHI '05 EA [10.1145/1056808.1056948](https://doi.org/10.1145/1056808.1056948)；CHI 2006 [10.1145/1124772.1124882](https://doi.org/10.1145/1124772.1124882)；CHI 2008 [10.1145/1357054.1357070](https://doi.org/10.1145/1357054.1357070) | 在任务断点，尤其是粗粒度断点投递通知，resumption cost 和挫败感都更低；断点可以从任务结构推断 | **人这边**：在人刚提交一个答复、刚关闭抽屉时，批量推送下一个待办；人正在某个抽屉里打字时，不打断。**agent 这边**：agent 的断点（turn 结束、tool 返回）是插入消息的时机，对应协议里的 `delivery: steer` |
| 13 | Mark, Gudith & Klocke (2008) CHI, [10.1145/1357054.1357072](https://doi.org/10.1145/1357054.1357072) | 被打断的人完成得更快（用速度补偿），但压力、挫败感和 workload 更高 | 不能只看完成时间，评测必须同时测 NASA-TLX 和压力。"更快"可能是被打断逼出来的 |
| 14 | Parasuraman & Riley (1997), Human Factors 39(2), [10.1518/001872097778543886](https://doi.org/10.1518/001872097778543886) | 对自动化的使用有 misuse（过度依赖）、disuse（忽视）、abuse（设计者不顾人的后果强行自动化）三种失败 | "总是允许"和 CEO 代批是 misuse 风险，太多误报的举手会导致 disuse（人开始无视举手）。要监控两个比率：人对审批"不看就点允许"的比例，以及举手后被直接忽略的比例 |
| 15 | Lee & See (2004), Human Factors 46(1), [10.1518/hfes.46.1.50.30392](https://doi.org/10.1518/hfes.46.1.50.30392) | 信任应该和自动化的真实能力校准；设计上要让 performance、process、purpose 三方面可见 | 每个岗位的抽屉显示**历史可靠性**（checker 驳回率、返工次数）、**过程**（计划和工具调用）、**意图**（岗位 job 和当前任务）。证据卡 A–D 分级就是把 performance 可见化 |
| 16 | Parasuraman & Manzey (2010), Human Factors 52(3), [10.1177/0018720810376055](https://doi.org/10.1177/0018720810376055) | complacency 和 automation bias 有共同的注意力机制，专家同样会出现，训练也难以消除 | 不能指望"用户会仔细看"。高风险审批要用**强制性的结构**：显示完整命令和路径（ACP 安全条款），对不可逆操作要求二次确认或第二个 agent 独立核对，而不是只给一个"允许"按钮 |
| 17 | Miller & Parasuraman (2007), Human Factors 49(1), [10.1518/001872007779598037](https://doi.org/10.1518/001872007779598037) | Playbook 式的委派接口让人可以在任意抽象层级下达 play 或约束，兼顾灵活性和 workload | 给 CEO 派活提供"打法"（play）：预设的团队流程（finder 并行 → checker 核对 → lead 汇总），人只填参数，也可以展开某一步细调。对应 kit 的团队模板和 `command.assign` |
| 18 | Shneiderman (1983) IEEE Computer 16(8), [10.1109/mc.1983.1654471](https://doi.org/10.1109/mc.1983.1654471)；Shneiderman (2020) IJHCI 36(6), [10.1080/10447318.2020.1741118](https://doi.org/10.1080/10447318.2020.1741118) | direct manipulation：对象持续可见、操作是增量且可逆的、有即时反馈。HCAI：高自动化和高人类控制可以兼得 | 所有命令都应该能**直接作用在对象上**：拖一张任务卡到某个小人身上就是派活，点小人身上的旗就是答复，按住小人就是中断。每个命令要有即时、可见的回执（`command.ack`），可撤销的操作要给撤销入口 |
| 19 | Horvitz (1999) CHI, [10.1145/302979.303030](https://doi.org/10.1145/302979.303030) | mixed-initiative 原则：按 expected utility 决定是否行动；不确定时与用户对话；考虑注意力成本；让用户能低成本地 dismiss 或纠正 | CEO 主动发起的打扰（建议改派、提醒）要附上"不理会也没关系"的默认动作，并能一键关掉同类提醒 |
| 20 | Amershi et al. (2019) CHI, [10.1145/3290605.3300233](https://doi.org/10.1145/3290605.3300233) | 18 条经过验证的 human-AI interaction guidelines，覆盖初始、交互中、出错时、长期四个阶段 | 用作启发式评估清单，尤其是 G1/G2（说明系统能做什么、做得多好）和 "when wrong" 组（易于纠正、解释原因）。M3 界面上线前做一轮 heuristic evaluation |
| 21 | Chen et al. (2014) SAT 模型，ARL-TR-6905，[DTIC ADA600351](https://apps.dtic.mil/sti/pdfs/ADA600351.pdf)；Chen et al. (2018) TIES 19(3), [10.1080/1463922x.2017.1315750](https://doi.org/10.1080/1463922x.2017.1315750) | agent transparency 分三层，与 SA 三层对应：目标和动作、推理、预测（含不确定性） | 抽屉分三栏：在做什么（`say` 和当前工具）、为什么（计划、引用的证据）、接下来和把握（下一步、预计时间、置信度或证据等级）。第三层不要省略：仅有前两层时，人只能事后判断 |
| 22 | Wickens (2008), Human Factors 50(3), [10.1518/001872008x288394](https://doi.org/10.1518/001872008x288394) | multiple resource theory：争用同一资源维度（感觉通道、编码、加工阶段）的任务互相干扰更大 | 人在读一个 agent 的文字产出时，其他 agent 的状态变化应该走**另一种通道**：空间位置、颜色、动画，必要时用声音，而不是更多文字通知。这是"等距办公室 + 举手"相对于"多个文字终端"的理论依据 |
| 23 | Graicunas (1937) "Relationship in organization", in Gulick & Urwick (eds.) *Papers on the Science of Administration*, pp. 183–187（无 DOI）；Urwick (1956) "The manager's span of control", HBR 34(3)（无 DOI） | Graicunas：下属每增加一人，上级需要处理的关系数（直接、交叉、群体）近似指数增长。Urwick：工作相互交织的下属，一个上级直接管理不宜超过 5–6 人 *(unverified：页码和 5–6 人的说法来自二手来源)* | **span of control 是组织设计的硬约束**：每个 Lead 或组长直接下属的默认上限设为 5–6 个；超过时建议加一层组长。要减少 agent 之间的交叉关系：handsTo 尽量是树状结构，避免网状 |
| 24 | Bittel (1964) *Management by Exception*, McGraw-Hill（无 DOI，图书馆目录可查） | 管理者只处理偏离标准的例外，常规事务交给系统和下属 | 默认视图只显示例外：举手、失败、超时、checker 驳回、偏离计划。正常工作的小人视觉上安静。CEO 摘要以"例外清单"开头 |

### B.2 2023–2026 年关于监督 LLM agent / 多 agent 系统的研究

| 文献 | 发现 | 设计规则 |
|---|---|---|
| Mozannar et al. (2025) **Magentic-UI**, [arXiv:2507.22358](https://arxiv.org/abs/2507.22358) | 六种 human-in-the-loop 机制：co-planning（执行前人和 agent 共同编辑计划）、co-tasking（执行中可以接管和交还）、action approval / action guards（有副作用的动作先请示）、answer verification、plan learning（保存成功计划以便复用）、multi-tasking（多个会话并行，状态标出哪个需要输入）。用 simulated user 时 GAIA 完成率从 30.3% 升到 51.9%；12 人可用性研究的 SUS 为 74.6（abstract 只列了五种机制，第六种 multi-tasking 由文献核实子任务从正文确认） | 这六种机制几乎就是我们功能清单的子集。我们的增量在于**多会话并行时的汇总层和 CEO**。值得照搬的有两点：计划可编辑后再执行；"哪个会话需要输入"的显式状态。仓库现已改为 MagenticLite，审批用 `auto_approve / require_approval_untrusted / require_approval_all` 三档策略加 allow / require_approval / deny 分类表（`docs/configuration.md`、`docs/TRANSPARENCY_NOTE.md`） |
| Fourney et al. (2024) **Magentic-One**, [arXiv:2411.04468](https://arxiv.org/abs/2411.04468) | Orchestrator 维护计划和进度账本，失败时 re-plan，指挥专职 agent | CEO 应维护一份显式的**任务账本**（我们的 `task.*` 快照），并把 re-plan 作为可见事件，不让它悄悄发生 |
| Dibia et al. (2024) **AutoGen Studio**, EMNLP Demo, [10.18653/v1/2024.emnlp-demo.8](https://doi.org/10.18653/v1/2024.emnlp-demo.8) | 无代码的多 agent 构建和调试工具：声明式规格、拖拽式编排、交互式调试 | 团队定义采用声明式、可视化编辑，与我们的 kit "设计并锁定团队"一致。它侧重调试，不侧重长期运行时的监督，这是我们的差异点 |
| Bansal et al. (2024) Challenges in human-agent communication, [arXiv:2412.10380](https://arxiv.org/abs/2412.10380) | 从 common ground 视角归纳 12 个挑战，分为 agent → user（能力、计划、进展、副作用）、user → agent（目标、偏好、纠正）和双向通用三类 | 抽屉和 CEO 摘要的字段清单可以直接对照这 12 条逐项检查，例如"副作用是否已告知" |
| Feng, McDonald & Zhang (2025) Levels of autonomy for AI agents, [arXiv:2506.12469](https://arxiv.org/abs/2506.12469) | 按**用户角色**定义五级自主度：operator、collaborator、consultant、approver、observer。主张自主度是独立于能力的设计决策 | 每个岗位标注人对它的角色：例如 coder 设为 approver（人只批），researcher 设为 observer（人只看），CEO 设为 consultant。界面上的控件随角色变化 |
| Feng et al. (2026) **Cocoa**, CHI 2026, [10.1145/3772318.3791673](https://doi.org/10.1145/3772318.3791673) | notebook 式协同计划：每一步可指派给人或 agent，计划与执行交错进行。n=16 的实验室研究中，可操控性提升，易用性没有下降 | 任务卡上的步骤可以标注"人做 / agent 做"，人做的步骤就是一种 `request.opened{kind: input}` |
| He, Demartini & Gadiraju (2025) **Plan-then-execute**, CHI 2025, [10.1145/3706598.3713218](https://doi.org/10.1145/3706598.3713218) | N=248，六类不同风险的日常任务。用户参与计划和逐步执行对信任与团队绩效有影响，摘要的结论是利弊兼有（具体数值未摘录） | 参与计划不一定提高结果质量，需要在我们的场景里实测，见 §B.4 的 H5 |
| Pan et al. (2025) **AgentCoord**, Computers & Graphics, [10.1016/j.cag.2025.104338](https://doi.org/10.1016/j.cag.2025.104338) | 结构化表示加可视化，帮助人理解多 agent 的协作策略和任务依赖，减轻从大量文本中提取关系的负担 | 依赖关系和交接应该画出来（我们的 handsTo 连线和观测到的边），而不是让人从日志里推断 |
| Simkute et al. (2024) Ironies of generative AI, IJHCI, [10.1080/10447318.2024.2405782](https://doi.org/10.1080/10447318.2024.2405782) | 把 Bainbridge 的讽刺套用到 GenAI：人的角色从生产转向评估，工作流被重构，频繁打断，易的更易、难的更难 | 我们的产品把人变成了"评估者"，所以评估工具（diff、证据卡、checker 意见）的质量决定成败 |
| Long, Shi, Mozannar, Murad & Hosn (2026) **ParallelPilot**, preprint, [arXiv:2609.33113](https://arxiv.org/abs/2609.33113) | 形成性研究（N=14）归纳出 PILOT 五项实践：Planning、Isolating、Logging、Observing、Triaging。被试内研究（N=16）中，短编码任务的吞吐量提高 63%，峰值时多监督约 1 个并发 agent，追踪成本和上下文切换都下降；但**感知控制和重新引导 agent 的感知成功率没有显著提高**。作者建议"高层感知加上低成本回到实现证据的路径" | **与我们最直接相关的对照研究**，评测设计可以参照（§B.4）。它的空白正是我们的机会：让"重新引导"变得便宜（抽屉直接发消息、`delivery: steer`），并检验能否提高感知控制 |
| Park, Arvi, Lee, Lim, Ma & Kim (2026) The work behind delegation, preprint (under review), [arXiv:2609.24234](https://arxiv.org/abs/2609.24234) | 观察 19 名开发者后，把 Sheridan 的 supervisory control 重构为监督 coding agent 的七个阶段及其回路。开发者的应对方式：把精力集中在计划阶段、**把监督工作再委派给其他 agent**、把反复给出的指导沉淀为可复用资产 | 直接支持"CEO agent 帮人监督"和"checker 岗位"的设计，也支持把人的纠正一键转成岗位 SOP（Sheridan 的 learn 职能） |
| Chen et al. (2026) Comparing human oversight strategies for computer-use agents, preprint, [arXiv:2604.04918](https://arxiv.org/abs/2604.04918)（是否发表于 CHI '26 *(unverified)*） | 48 名被试、192 个真实 web 会话，比较四种监督策略。策略影响的是人**暴露于问题动作**的程度，不影响干预能力。原因是控制权交回得太早或太晚；人判断的是"做得对不对"，而不是"安不安全"；事前批准计划反而抑制了运行时的审查 | 审批提示要明确问**安全问题**（"会影响哪些文件或外部系统"），而不只是展示动作。批准计划之后，仍要对计划外的动作单独举手，不能视为已批准 |
| Grunde-McLaughlin et al. (2026) Overseeing agents without constant oversight, preprint, [arXiv:2602.16844](https://arxiv.org/abs/2602.16844) | 三项研究：新的 trace 界面缩短了找错时间、提高了信心，但最终准确率没有显著提高 | 信心上升而准确率不变，正是信任失准。评测必须同时测信心和准确率（§B.4 的 trust calibration） |
| Dhanorkar, Passi & Vorvoreanu (2026) Human oversight of agentic systems in practice, preprint, [arXiv:2606.05391](https://arxiv.org/abs/2606.05391) | 访谈 17 名开发者，归纳出四种监督方式：事前控制、协同计划、实时监控、事后审查 | 四种都要支持：岗位权限、计划审阅、办公室视图、结果抽屉和回放 |
| Zhang et al. (2026) Ask less, ask better, preprint, [arXiv:2610.24411](https://arxiv.org/abs/2610.24411) | 给澄清问题设置 1–3 个的预算后，用户注意力成本降低 36–73%，任务奖励保留 86–94% | 每个 agent（或每个 run）设一个**提问预算**，超出时先交给 CEO 合并或自行决定，再上报给人 |
| Zou et al. (2026) InterruptBench, preprint, [arXiv:2604.00892](https://arxiv.org/abs/2604.00892) | 把用户中途打断分为三类：追加、修改、撤回，并评测 agent 的适应能力 | `command.message` 可以带一个可选的 `intent: add \| revise \| retract`，帮助适配器和 agent 选择处理方式 |

### B.3 可检验的设计原则（10 条）

每条写成"设计规则 → 可证伪的假设 → 指标"，以便在 §B.4 的实验中逐条检验。

| # | 原则 | 依据 | 假设（相对 tmux/OMC 基线） | 指标 |
|---|---|---|---|---|
| P1 | **等待人的时间是一等公民**：每个阻塞项显示已等待时长和影响面（阻塞了几个下游） | Cummings & Mitchell 2008；Donmez et al. 2010 | 发现阻塞 agent 的时间（time-to-notice）缩短，agent 累计等待时间下降 | 从 `request.opened` 到人第一次查看该项的时间（TTN）；到答复的时间（TTR）；Σ 阻塞时间 |
| P2 | **例外驱动的默认视图**：正常工作保持视觉安静，只有举手、失败、超时、驳回、偏离计划才吸引注意 | Bittel 1964；Wickens 2008 | 在同等漏报率下，视线和注意力切换次数减少 | 上下文切换次数（窗口、窗格、抽屉切换）；漏掉的例外数 |
| P3 | **协商式打断，并在断点投递**：不抢焦点；人提交答复或关闭抽屉后再推送下一项；只有高紧急度才立即打断 | McFarlane 2002；Iqbal & Bailey 2006/2008；Mark et al. 2008 | 主任务的恢复时间缩短、主观压力降低，TTR 不显著变差 | 恢复延迟；NASA-TLX；压力自评；TTR |
| P4 | **就地答复**：审批和输入在收件箱或抽屉里一步完成，自动附上必要上下文（完整命令、路径、diff） | Olsen & Wood 2004 的 interaction time；ACP 安全条款 | 单次交互时间下降，fan-out 上升 | 每项交互时间；同时有效管理的 agent 数（被试能维持 SLA 的最大 N） |
| P5 | **三层透明**：抽屉提供"在做什么 / 为什么 / 接下来与把握"三层信息 | Endsley 1995；Chen et al. 2014/2018 | SA 的 L2 和 L3 得分提高 | SAGAT 冻结问询的正确率，按 L1/L2/L3 分开统计 |
| P6 | **校准而不是最大化信任**：显示岗位历史可靠性和证据等级；不可逆操作使用强制结构 | Lee & See 2004；Parasuraman & Manzey 2010；Grunde-McLaughlin et al. 2026 | 对注入错误的发现率提高；信心和准确率的相关性提高 | 被试对每个 agent 产出的信任评分与真实正确性的相关（calibration）；未看就批准的比例；注入错误检出率 |
| P7 | **把监督工作委派给 CEO，再按例外上报**：CEO 先处理白名单内的请求，其余上报；所有代批进入可审查历史 | Park et al. 2026；Parasuraman et al. 2000；A2A 逐级上抛 | 人收到的请求数量下降，错误代批数量不增加 | 每小时到达人的请求数；CEO 代批中事后被人推翻的比例 |
| P8 | **直接操作对象发出命令，每个命令都有可见回执**：拖卡派活、点旗答复、按住中断；回执以 agent 的事实回报为准 | Shneiderman 1983；ACP"接受 ≠ 停止" | 命令出错率和重复发送下降 | 命令被拒或重发的次数；人在中断命令发出后误以为 agent 已停的次数 |
| P9 | **span of control 默认上限**：每个 Lead 或组长直接下属不超过 5–6 个，超出时建议加组长；handsTo 尽量树状 | Graicunas 1937；Urwick 1956 *(unverified)*；Wickens 2008 | 在固定总 agent 数下，加一层组长比扁平结构的 SA 更高、TTR 更短 | 对比 1×12 扁平结构与 1×3×4 层级结构下的 SAGAT 得分和 TTR |
| P10 | **低成本重新引导**：在任何小人上都能直接发送补充说明（steer / queue / interrupt），并看到送达确认 | ParallelPilot 2026 未改善感知控制；Magentic-UI 的 co-tasking；Claude、Codex 的三档送达 | 感知控制和重新引导的成功率提高（ParallelPilot 在这项上没有改善） | 感知控制量表；重新引导后 agent 是否按新指示调整（由专家标注） |

可选两条：P11，**问题预算**，每个 agent 每个 run 最多直接向人提 k 个问题，超出时由 CEO 合并（Zhang et al. 2026）；P12，**计划批准不等于全部批准**，计划外的副作用动作仍需单独举手（Chen et al. 2026）。

### B.4 评测方案草图（CHI 式被试内实验：tmux/OMC vs MAS Office）

- **被试**：16–24 名有 Claude Code 或 Codex 使用经验的开发者。N=16 与 ParallelPilot、Cocoa 相当，24 可以把 6 种条件顺序完整平衡。
- **条件**：(A) tmux + OMC（现状基线：多个窗格，HUD 状态行）；(B) MAS Office 不含 CEO（办公室、收件箱、抽屉）；(C) MAS Office 含 CEO 代批和摘要。用拉丁方平衡顺序，每种条件配一组同构但内容不同的任务。
- **任务**：每个 session 30–40 分钟，同时运行 4 / 8 / 12 个 agent（fan-out 作为第二个因素）。agent 由**脚本化回放**驱动：预录真实 Claude 和 Codex 会话的事件，在受控时间点注入事件，保证各条件刺激相同。只在操作有效性检查中使用真实 agent。注入的事件包括：
  1. 阻塞审批（读或写、可逆或不可逆）；
  2. 输入请求（需要人提供信息）；
  3. 静默卡住（agent 无事件超过 N 分钟，neglect tolerance 失效）；
  4. 质量问题（checker 驳回，或产出中埋入一个事实性错误）；
  5. 需要改派的任务（某个 agent 失败，需要转给另一个）；
  6. 计划外的副作用动作（检验 P12）。
- **主要指标**：
  - TTN、TTR（P1）；agent 累计等待人的时间；
  - 上下文切换次数，以界面日志为主，可选眼动（P2）；
  - 单次交互时间和有效 fan-out（P4）；
  - 注入错误检出率、未看就批准率（P6）；
  - SAGAT：每个 session 冻结 3 次，问 L1"agent X 现在在做什么"、L2"哪个阶段被阻塞、原因是什么"、L3"如果不处理，5 分钟后哪些 agent 会停"（P5）。
- **次要指标**：NASA-TLX；信任量表（例如 Jian et al. 的 trust in automation 量表 *(unverified：本轮未核实文献)*）及其与实际可靠性的校准；感知控制；SUS；偏好访谈。
- **假设**：B 和 C 的 TTN、TTR、切换次数低于 A；SA 的 L2 和 L3 高于 A；C 中到达人的请求数低于 B，错误代批率低于预设阈值；在 12 个 agent 的条件下 A 和 B、C 的差距最大（fan-out 交互效应）。
- **分析**：线性混合模型，条件 × fan-out 为固定效应，被试和任务集为随机效应。对 TTN 等时间变量取对数，或使用生存分析，以处理到实验结束都没被发现的删失数据。
- **伦理与效度**：回放保证可比性，但会削弱真实感。另做一轮小规模（n≈6）真实 agent 现场研究来检验生态效度。界面日志本身就是 `events.jsonl` 加 `command.*`，这也是让协议承载完整审计链的另一个理由。

### B.5 未能核实或已删除的条目

- 删除："Schömbs et al. 2026"（ParallelPilot 引用的一篇关于监控和打断的论文），检索未找到。
- 未找到 Cummings & Mitchell 单独讨论 wait times 的论文，相关内容并入 2008 SMC-A。另有 Cummings & Mitchell (2007) "Operator scheduling strategies in supervisory control of multiple UAVs", *Aerospace Science and Technology*, [10.1016/j.ast.2006.10.007](https://doi.org/10.1016/j.ast.2006.10.007)，已确认存在，但未读摘要，本文没有引用其结论。
- Urwick 1956 的"5–6 人"和页码来自二手来源 *(unverified)*。
- Iqbal & Bailey 2005 是 CHI Extended Abstract，不是 full paper；2008 年的 TOCHI 论文是另一篇（Bailey & Iqbal，[10.1145/1314683.1314689](https://doi.org/10.1145/1314683.1314689)）。
- Chen et al. (2026) 是否发表于 CHI '26 *(unverified)*。
- B.4 提到的 Jian et al. 信任量表本轮未核实，仅作为候选。

## 来源索引

- 协议规范：见 §A.1 的克隆表，以及 `references/docs/` 下的 `ag-ui__*`、`a2a__*`、`acp__*`、`mcp__*`、`otel-genai__*`、`magentic-ui__*`。Codex 和 Claude 的消息形态引自 `references/docs/codex__app-server.md`、`claude__agent-sdk_typescript.md`（由会话控制调研者保存），以及 `openai__codex` 源码 `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`。
- 文献：见 §B.1、§B.2 各行的 DOI 或 arXiv 链接。
