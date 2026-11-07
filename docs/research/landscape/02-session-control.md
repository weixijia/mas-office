# 02 · 双向会话控制、后端与远程客户端

- 日期：2026-11-07
- 范围：从一个 Node 进程 + 浏览器 UI 启动 / 驱动 / 恢复真实的 Claude Code 与 Codex 会话；拿结构化事件；检测"卡住 / 等审批 / 等决定"；在 UI 里批准、拒绝、回复；向运行中或已恢复的会话发新任务；同时保留可观看的终端视图；用户始终用自己的官方订阅登录。
- 一手来源：本地克隆在 `references/repos/`，官方文档页已存为 markdown 在 `references/docs/`（`claude__*.md`、`codex__*.md`，每页首行是来源 URL）。无法从源码或官方文档确认的标 *(unverified)*。

## 摘要

1. **两家官方都已经给出了"可编程控制面"，不需要 PTY 抓屏。** Claude 是 Agent SDK（底层是 `claude -p --input-format stream-json --output-format stream-json` + stdin/stdout 上的 `control_request` / `control_response`）；Codex 是 `codex app-server`（JSON-RPC 2.0 over stdio / unix socket / ws，thread → turn → item）。
2. **"卡住"检测两家都有一等信号**：Claude SDK 的 `system/session_state_changed` 的 `requires_action`（需 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`）+ `canUseTool` 回调本身；Codex 的 `thread/status/changed` 的 `activeFlags: ["waitingOnApproval" | "waitingOnUserInput"]` + server-initiated 的 `item/*/requestApproval` 请求。
3. **中途插话两家都原生支持**：Claude `SDKUserMessage.priority`（`now` / `next` / `later`）；Codex `turn/steer`（必须带 `expectedTurnId`），另有实验性的服务端队列 `thread/queue/*`。
4. **Codex 在"可观看终端"上明显更好**：app-server 支持多连接订阅同一 thread，审批请求发给所有订阅者、先答者生效，新连接 resume 一个运行中的 thread 时会**重放未决审批**（`codex-rs/app-server/src/outgoing_message.rs` 的 `replay_requests_to_connection_for_thread`）。所以可以让我们的后端和一个 `codex resume <id> --remote unix://…` 的 TUI 同时挂在同一个 app-server 上，任一侧都能批准。
5. **Claude 的 SDK 会话没有 TUI**。要"可观看 + 可接手"，有三条官方路：(a) 我们自己渲染 transcript；(b) 交互式 TUI 跑在 PTY 里，用 hooks 拿事件、用 **channels 的 permission relay**（研究预览）在 UI 里并行应答、用 channels / 跨会话 inbox socket 插话；(c) Claude Code 新的 **agent view / background sessions**（`claude --bg`、`claude agents --json` 给出 `state: blocked` + `waitingFor`、`claude attach`）。没有一条能同时满足"结构化双向 + 可接手的同一进程"，这是 Claude 侧最大的技术风险。
6. **ACP（Agent Client Protocol）已成熟到 v1 稳定版**，`claude-agent-acp`（包装 Claude Agent SDK）与 `codex-acp`（包装 `codex app-server`）都完整实现权限、resume、排队，插话用的是非标准扩展 `_session/steering`。可以当参考实现和词汇表，但不建议放在关键路径上（多一层翻译、扩展在变）。
7. **合规**：Anthropic 文档明确"第三方开发者不得提供 claude.ai 登录或用订阅额度给自己的产品，包括基于 Agent SDK 构建的 agent"，同时又明确"不阻止终端用户用自己的订阅登录**未修改的** Claude Code 二进制"。MAS Office 在用户本机 spawn 官方 `claude`、不碰凭证，处在允许与禁止的边界上，**需要在产品叙述上非常小心**（详见 §7.4）。OpenAI 则明确邀请"把 Codex 嵌入你的产品"，app-server 自带 ChatGPT 登录端点，风险低得多；但官方同时声明 app-server "experimental，不支持生产负载"。
8. 远程客户端里，**Happy** 是最完整的样板：Claude 走 SDK `canUseTool`、本地 TUI 与远程 SDK 之间靠同一 session id 来回切换；Codex 走 `codex app-server`。**CloudCLI** 的 Claude 路径做了 `priority: 'next'` 插话，但 Codex 路径用 `codex exec`，审批到不了 UI。**opcode** 一律 `--dangerously-skip-permissions`；**agentapi** 抓屏无法区分"等审批"和"已完成"，这两种是反例。
9. 编排器 / harness 里：**dsh** 驱动真实 Claude Code（SDK）和 Codex（app-server），但审批一律 fail closed、子任务不可续，正好留出"举手 + 收件箱 + 追问"的空白；**opencode** 的 HTTP + SSE + 持久 inbox（`delivery: steer|queue`）是最好的多前端 API 样板；**pi** 直接用订阅 OAuth 冒充官方客户端调用厂商 API，是我们绝不能走的登录方式。
10. **建议**：Claude 用 Agent SDK（TypeScript）每个角色一个长驻 `query()` + Pushable 输入流；Codex 用一个共享的 `codex app-server`（unix socket）+ 生成的 TS 类型。终端视图：Codex 直接挂 TUI；Claude 先用自绘 transcript + "接手"按钮（停 SDK 进程 → `claude --resume <id>` 进 PTY），再 spike channels relay。

---

## 1. 我们需要的七个能力

| 代号 | 能力 | 判断标准 |
|---|---|---|
| a | start | 程序化启动，可指定 cwd、模型、工具 / 权限、系统提示 |
| b | stream events | 逐条结构化事件（消息、工具调用、diff、计划、用量），非屏幕文本 |
| c | detect blocked | 机器可读的"等审批 / 等回答"信号，不靠超时猜 |
| d | answer from UI | 批准 / 拒绝 / 带修改批准 / 记住规则 / 回答问题 |
| e | follow-up | 运行中插话（steer）与回合结束后的新任务 |
| f | resume after restart | 我们的 Node 进程或机器重启后，按 id 续上同一会话 |
| g | watchable terminal | 人能看到原生终端，必要时接手 |

---

## 2. Claude 官方控制面

### anthropics/claude-agent-sdk-typescript 与 anthropics/claude-agent-sdk-python

- https://github.com/anthropics/claude-agent-sdk-typescript · ⭐ 1870 · license：无 SPDX，`LICENSE.md` 写"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"（仓库只有 CHANGELOG / examples，源码随 npm 包分发）· 最近提交 2026-11-06 · 本地：`references/repos/anthropics__claude-agent-sdk-typescript` @ 49dd8ef
- https://github.com/anthropics/claude-agent-sdk-python · ⭐ 8454 · MIT · Python · 最近提交 2026-11-06 · 本地：`references/repos/anthropics__claude-agent-sdk-python` @ 2209f2c（**源码公开，是理解线协议的最佳一手来源**）
- 官方文档已存：`claude__agent-sdk_{overview,streaming-vs-single-mode,user-input,permissions,hooks,sessions,session-storage,subagents,typescript,python,hosting,agent-loop,claude-code-features}.md`
- **一句话**：把 Claude Code 当库用；SDK spawn 官方 `claude` CLI 子进程，用 stdio 上的 NDJSON 双向通信。
- **架构要点**：
  - **Transport**：`query()` spawn `claude --output-format stream-json --verbose … --input-format stream-json`（Python：`src/claude_agent_sdk/_internal/transport/subprocess_cli.py:574-793`）。stdin 上既有用户消息也有 `control_request` / `control_response`；SDK 还设置 `CLAUDE_CODE_ENTRYPOINT=sdk-py|sdk-ts`。"One agent session maps to one subprocess"（`claude__agent-sdk_hosting.md` §The subprocess model）。
  - **控制协议**（Python `src/claude_agent_sdk/_internal/query.py`）：
    - 启动时发 `control_request{subtype:"initialize", hooks, agents, …}`（:349-370）。
    - CLI → SDK：`can_use_tool`、`hook_callback`、`mcp_message`（:606-706）。
    - SDK → CLI：`interrupt`、`set_permission_mode`、`set_model`、`rewind_files`、`mcp_reconnect`、`mcp_toggle`、`stop_task`、`get_context_usage`（:815-894）。
    - 传了 `canUseTool` 时，SDK 自动加 `--permission-prompt-tool stdio`（`types.py:2299-2315`），这就是"审批走 stdin/stdout"的开关。
  - **事件 schema**：`SDKMessage` 联合类型约 40 种（`claude__agent-sdk_typescript.md` §SDKMessage），关键的有 `assistant` / `user` / `result` / `system:init` / `stream_event`（需 `includePartialMessages`）/ `task_started|task_progress|task_notification`（子 agent、后台任务）/ `permission_denied` / `rate_limit_event` / `session_state_changed`。
  - **blocked 检测**：`{type:"system", subtype:"session_state_changed", state:"idle"|"running"|"requires_action"}`，需设 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`；"`requires_action`: the session is blocked on an answer to a request it sent your host, such as a permission prompt"（`claude__agent-sdk_typescript.md` §SDKSessionStateChangedMessage）。Python SDK 内部已用它判断回合结束（`query.py:465-530`）。
  - **审批与提问**：
    - `canUseTool(toolName, input, {signal, suggestions, toolUseID, agentID, blockedPath, decisionReason, title, description…})` → `{behavior:"allow", updatedInput, updatedPermissions}` 或 `{behavior:"deny", message, interrupt}`。
    - 回调"can stay pending indefinitely"（`claude__agent-sdk_user-input.md`），正好对应"小人举手等人"。
    - `AskUserQuestion` 也走 `canUseTool`，`input.questions[]`（1–4 题，每题 2–4 选项），用 `updatedInput.answers` 回答；**子 agent 里不可用**。
    - `suggestions` 回显到 `updatedPermissions` 就是"总是允许"；`destination` 可选 `session` / `localSettings` / `projectSettings` / `userSettings`。
    - 进程撑不了那么久时，用 `PreToolUse` hook 返回 `permissionDecision:"defer"`：回合以 `stop_reason:"tool_deferred"` 结束、结果里带 `deferred_tool_use`，之后 `claude -p --resume <id>` 时同一调用再次触发 hook（`claude__hooks.md` §Defer a tool call for later）。限制：只在 `-p`、且本回合只有一个工具调用时生效。
  - **插话**：
    - 流式输入模式下 prompt 是 `AsyncIterable<SDKUserMessage>`，或用 `Query.streamInput()`。
    - `SDKUserMessage.priority`：
      - `next`（默认）：当前工具调用完成后在同一回合读到。
      - `later`：回合结束后作为新回合。
      - `now`：打断；配合 `origin:{kind:"human"}` 时会把 shell / 子 agent / MCP 调用移到后台而不是杀掉。
    - `shouldQuery:false` 只追加上下文、不触发回合（`claude__agent-sdk_typescript.md` §SDKUserMessage）。
    - 另有 `interrupt()`、`setPermissionMode()`、`setModel()`、`reinitialize()`（断线重连后重新拿未决请求）。
  - **resume / fork**：
    - `resume: sessionId`、`continue: true`、`forkSession: true`、`resumeSessionAt`（`subprocess_cli.py:640-712`）。
    - transcript 在 `~/.claude/projects/<proj>/<id>.jsonl`。格式是内部格式，官方说"changes between versions"，不要直接解析（`claude__sessions.md` §Where transcripts are stored）；用 `listSessions()` / `getSessionMessages()`。
    - 可选 `SessionStore` 把 transcript 镜像到外部存储（`claude__agent-sdk_session-storage.md`）。
    - SDK 会话会出现在 `claude --resume` 选择器里（Happy 依赖这点，见 §6）。
  - **子 agent**：
    - `agents` 选项（或文件系统里的 `.claude/agents`）。子 agent 消息带 `parent_tool_use_id`；后台子 agent 有 `task_*` 消息；`forwardSubagentText` 转发子 agent 文本。
    - `canUseTool` 的上下文带 `agent_id`，所以子 agent 的审批也能冒到 UI（Python `query.py:620-633`）。
  - **并发**：每会话一个子进程，受内存约束（`claude__agent-sdk_hosting.md` §Scaling and concurrency）；同一 session 不应被两个进程同时打开 *(unverified：官方没写锁语义，Claude Code 对后台会话会拒绝或转为 attach，见下一条目)*。
  - **登录**：SDK 使用 CLI 已有的凭证。凭证优先级：云厂商 → `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → `/login` 订阅 OAuth（`claude__authentication.md` §Authentication precedence）。合规见 §7.4。
- **和我们 roadmap 的关系**：会话控制（M0 后端、M1 `mas run`）、收件箱（`canUseTool` / `AskUserQuestion` = "需要你"）、办公室交互（`priority` 插话 = 抽屉聊天框）、协议（`session_state_changed` 直接映射到小人举手）。
- **值得借鉴**：`canUseTool` 的六种回应（批准、带修改批准、批准并记住、拒绝、拒绝并建议、整体改向，`claude__agent-sdk_user-input.md`）可以直接作为抽屉审批卡的按钮集；`reinitialize()` 用于 UI 断线重连。
- **不足 / 我们的机会**：没有 TUI；每个会话一个进程，Node 进程重启时所有 `canUseTool` 未决请求都丢失，需要从 transcript 恢复，或预先用 `defer` 设计。
- **复用判断**：作为依赖使用（TS 包受 Anthropic Commercial ToS 约束，不是 OSI license，不能 vendor 源码；Python 包 MIT）。

### Claude Code CLI 本身的控制面（非 SDK）

不是一个仓库，但决定了"可观看终端"能不能做。全部来自官方文档（已存）。

- **`claude -p` stream-json**（`claude__headless.md`、`claude__cli-reference.md`）：
  - `--input-format stream-json --output-format stream-json --verbose [--include-partial-messages] [--replay-user-messages]`，就是 SDK 用的那条线。
  - `--permission-prompt-tool mcp__srv__tool`：用一个 MCP 工具当审批宿主（SDK 之外的另一种审批通道）。
  - `--permission-prompts none`：无人值守时直接拒绝。
  - `--session-id <uuid>`：预先指定 id，方便我们先建档再启动。
- **Hooks**（`claude__hooks.md`，已有 `mas hook claude-code` 在用）：
  - 事件含 `PreToolUse`、`PermissionRequest`、`PermissionDenied`、`Notification`、`Stop`、`SubagentStart` / `SubagentStop`、`TaskCreated` / `TaskCompleted`、`TeammateIdle`、`Elicitation`、`SessionStart` / `SessionEnd` 等。handler 可以是 `command` / `http` / `mcp_tool` / `prompt` / `agent`，`command` / `http` 默认超时 600 s。
  - `PermissionRequest` 在"即将弹审批框"时触发，可 allow（带 `updatedInput` / `updatedPermissions`）或 deny（可 `interrupt`）。有 SDK / prompt-tool 宿主时两者"whichever decides first applies"。
  - 在交互 TUI 里，hook 先跑、无决定才出现对话框（hooks-guide："The transcript shows 'Allowed by PermissionRequest hook' where the dialog would have appeared"）。所以**用一个长轮询的 HTTP hook 把 TUI 审批转到我们 UI，会让 TUI 对话框在等待期间不出现** *(unverified：需 spike 确认 hook 运行期间 TUI 是否显示任何东西)*。
  - `Notification` 的 `permission_prompt` 有约 6 秒延迟，`idle_prompt` 约 60 秒，只适合当提醒，不适合当状态。
- **Channels（研究预览）**（`claude__channels.md`、`claude__channels-reference.md`）：
  - 一个声明 `experimental['claude/channel']` 的 stdio MCP server，可以向**正在运行的交互式会话**推 `notifications/claude/channel` 消息（排队，忙时下一回合合并送达）。
  - 声明 `claude/channel/permission` 后，Claude Code 会把工具审批**并行**转发给它（`notifications/claude/channel/permission_request{request_id, tool_name, description, input_preview}`），用 `notifications/claude/channel/permission{request_id, behavior}` 回答。"Both stay live: you can answer in the terminal or on your phone, and Claude Code applies whichever answer arrives first."
  - **这正是"TUI 可观看 + UI 可审批"的官方机制。** 限制：
    - 只有 allow / deny，没有 `updatedInput`。
    - 项目信任、MCP 同意对话框不转发。
    - 自建 channel 不在 allowlist 上，必须用 `--dangerously-load-development-channels server:<name>`，启动时有一次确认对话框，且 `-p` / SDK 下被忽略。
    - Pro / Max / Ultra 个人用户可用；Team / Enterprise 需管理员开 `channelsEnabled`。
    - 协议"may change"。
- **Agent view / 后台会话（研究预览）**（`claude__agent-view.md`）：
  - `claude --bg "<task>"` 启动由 supervisor 进程托管的后台会话。
  - `claude agents --json [--all]` 输出 `state: working|blocked|done|failed|stopped`、`status: busy|waiting|idle`、`waitingFor: "permission prompt"|"input needed"|…`、`sessionId`，官方称"the supported way to read session state from outside Claude Code"。
  - `claude attach <id>` 进入完整 TUI，`claude logs <id>`、`claude stop <id>`、`claude respawn <id>`。
  - supervisor 在终端关闭后继续跑会话、崩溃自动重启、闲置约 1 小时后停进程（可 `Ctrl+T` 钉住）。
  - **缺口**：没有给脚本用的"发消息 / 答审批"命令。`claude --resume <id> "prompt"` 只在 TTY 下转发给后台会话，管道或任何配置类 flag 都会让它拒绝（`claude__sessions.md` §Resume a running background session）。
- **跨会话消息 inbox socket**（`claude__cross-session-messaging.md` §The session's inbox socket）：
  - 每个会话（含 `-p`，bare 模式除外）绑定一个 UDS（`CLAUDE_CODE_MESSAGING_SOCKET`，token 在 `CLAUDE_CODE_MESSAGING_TOKEN`）。外部脚本可以投递纯文本消息：Claude 在工具调用之间读到，空闲时开新回合。
  - 但这类消息被标记为"来自另一个会话"："It can't approve anything"、"can't change configuration"、斜杠命令不执行。还受 `crossSessionInbound`（accept / hold / refuse）约束。
  - 消息的线格式文档没给全 *(unverified)*。
- **Remote Control**（`claude__remote-control.md`）：官方把本地 TUI 会话同步到 claude.ai / 手机 App，需订阅、不支持 API key。它是 Anthropic 自己的远程客户端，对第三方没有开放 API *(unverified：文档里没有第三方接口)*。它说明了"同一会话多端同时操作"在 Claude Code 内部是支持的，只是没开放给我们。

---

## 3. Codex 官方控制面

### openai/codex（app-server、exec、SDK）

- https://github.com/openai/codex · ⭐ 133552 · Apache-2.0 · Rust · 最近提交 2026-11-07 · 本地：`references/repos/openai__codex` @ 57a808a（仓库 740 MB，sparse checkout 了 `codex-rs/app-server*`、`codex-rs/exec`、`codex-rs/protocol/src`、`codex-rs/hooks`、`codex-rs/cli/src`、`sdk`、`docs`）
- 官方文档已存：`codex__{app-server,non-interactive-mode,codex-sdk,mcp-server,hooks,auth,permission-modes,agent-approvals-security,agent-configuration_subagents,sandboxing_auto-review,remote-connections}.md`
- **一句话**：`codex app-server` 是 Codex 所有富客户端（VS Code 扩展、桌面 App、手机远程）共用的 JSON-RPC 服务端。
- **架构要点**：
  - **Transport**：JSON-RPC 2.0（线上省略 `"jsonrpc"`）。
    - `--listen stdio://`（默认，JSONL）。
    - `unix://[PATH]`（unix socket 上跑 WebSocket）。
    - `ws://IP:PORT`："experimental and unsupported"，非回环地址默认不鉴权，需 `--ws-auth capability-token|signed-bearer-token`。
    - 每个连接先 `initialize`（带 `clientInfo`，可选 `capabilities.experimentalApi`、`optOutNotificationMethods`），再发 `initialized`（`codex__app-server.md` §Protocol / §Initialization）。
  - **协议定义**：
    - 请求、通知、server request 的宏定义在 `codex-rs/app-server-protocol/src/protocol/common.rs`。
    - v2 类型在 `codex-rs/app-server-protocol/src/protocol/v2/*.rs`（`thread.rs`、`turn.rs`、`item.rs`、`permissions.rs`…）。
    - 仓库里有预生成的 `codex-rs/app-server-protocol/schema/{json,typescript}`。
    - 运行时可以 `codex app-server generate-ts --out DIR` 生成与本机版本完全匹配的 TS 类型。
  - **核心模型**：Thread（会话）→ Turn（一次用户请求）→ Item（userMessage、agentMessage、reasoning、commandExecution、fileChange、mcpToolCall、collabToolCall、plan、webSearch、contextCompaction…）。
    - 方法：`thread/start|resume|fork|read|list|loaded/list|unsubscribe|archive|rollback|inject_items`、`turn/start|steer|interrupt`、`review/start`。
  - **事件**：
    - `thread/started|status/changed|closed|tokenUsage/updated`
    - `turn/started|completed|diff/updated|plan/updated`
    - `item/started|completed`
    - 增量：`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/reasoning/*`
    - `hook/started|completed`、`serverRequest/resolved`、`error`（带 `codexErrorInfo`，如 `usageLimitExceeded`）
    - 文档原话："`item/completed` … treat this as the authoritative state"。
  - **blocked 检测**：`thread/status/changed` → `{type:"active", activeFlags:["waitingOnApproval"|"waitingOnUserInput"]}`，其他状态 `idle` / `notLoaded` / `systemError`（`v2/thread.rs:1729-1746`）。
  - **审批**：server → client 的 JSON-RPC **请求**（`common.rs:1892-1941`）：
    - `item/commandExecution/requestApproval`（决定：`accept` / `acceptForSession` / `decline` / `cancel` / `acceptWithExecpolicyAmendment`）
    - `item/fileChange/requestApproval`（同上，无 amendment）
    - `item/permissions/requestApproval`（授予子集、`scope: turn|session`）
    - `item/tool/requestUserInput`（结构化提问，可带 `autoResolutionMs`）
    - `mcpServer/elicitation/request`
    - `item/tool/call`（实验性 dynamic tools）
    - 回答后服务端发 `serverRequest/resolved`，再发 `item/completed`。
  - **多客户端与重放**（关键）：
    - 线程级事件和 server request 发给该 thread 的所有订阅连接（`codex-rs/app-server/src/outgoing_message.rs:388-523`）。
    - 新连接 `thread/resume` 一个已加载的 thread 时，调用 `replay_requests_to_connection_for_thread` 重放未决请求（`request_processors/thread_lifecycle.rs:1283`）。
    - 最后一个订阅者离开后，thread 闲置 60 s 卸载（`thread_unload_delay_secs`）。
    - 例外：`requiredHumanApproval` 类的命令检查点只发给声明了该能力的连接；无此类连接时命令被拒（`codex-rs/app-server/README.md` §Managed human command checkpoints）。
  - **插话 / 后续任务**：
    - `turn/steer {threadId, input, expectedTurnId}`：没有活动回合时失败，不接受模型 / cwd 覆盖。
    - `turn/start`：新回合。
    - `thread/inject_items`：只追加上下文、不开回合。
    - 实验性 `thread/queue/add|list|update|delete|reorder|start`（`common.rs:666-700`）是服务端排队，适合"派下一个任务"。
  - **resume**：
    - `thread/resume {threadId, excludeTurns:true}`，然后用 `thread/turns/list` / `thread/items/list` 分页取历史。rollout 存在 `$CODEX_HOME/sessions`。
    - 模型提供方不一致时报 `modelProviderMismatch`。
    - **审批请求不跨进程持久**：app-server 进程退出后，未决审批随回合结束 *(unverified：未找到持久化未决请求的代码；daemon 模式下由 daemon 存活避免)*。
  - **终端视图**：
    - `codex app-server --listen ws://…|unix://…` 加 `codex --remote <endpoint>` / `codex resume <id> --remote <endpoint>`，让官方 TUI 连到同一个 app-server（`codex__app-server.md` §Connect the CLI terminal UI；`codex-rs/cli/src/main.rs` 的 `ResumeCommand.remote`）。
    - 另有实验性的 `codex app-server daemon start|stop|…`：机器级共享 daemon，TUI 会自动发现并附着（`codex-rs/app-server-daemon/README.md`）。还有 `codex agents` 总览（`main.rs` `AgentsCommand`）。
  - **其他入口**：
    - `codex exec --json`：JSONL 事件 `thread.started` / `turn.*` / `item.*` / `error`，默认 `approval_policy=never`（`codex-rs/exec/src/lib.rs:630`），**没有审批回传**。`codex exec resume <id>` 可以续。
    - TS SDK `@openai/codex-sdk` 就是 spawn `codex exec`（`sdk/typescript/src/exec.ts`），同样没有审批。
    - Python SDK `openai-codex` 走 `app-server --listen stdio://`（`sdk/python/src/openai_codex/client.py:256`）。
    - **`codex mcp-server` 已被移除**，官方让迁移到 app-server（`codex__mcp-server.md`）。
  - **Hooks**：Codex 也有 `PreToolUse` / `PermissionRequest` / `PostToolUse` / `Stop` / `SubagentStart|Stop` / `UserPromptSubmit` 等（`codex__hooks.md`）。`PermissionRequest` 只能 allow / deny / 不决定，`updatedInput` 等字段"fail closed today"。
  - **子 agent**：子 agent 是独立 thread，父 thread 里以 `collabToolCall` item 出现（含 `newThreadId` / `receiverThreadId`）；子 agent 继承父的 sandbox 策略（`codex__agent-configuration_subagents.md`）。子 thread 的审批是否冒到父 thread 的订阅者 *(unverified)*。
  - **登录**：app-server 自带 `account/read`、`account/login/start`（API key、ChatGPT 浏览器流程、device code、外部托管 `chatgptAuthTokens`）、`account/rateLimits/read` 等（`codex__app-server.md` §Auth endpoints）。默认复用 `~/.codex/auth.json`。文档要求集成方用 `clientInfo.name` 标识自己，面向企业的新集成"contact OpenAI to get it added to a known clients list"。
- **和我们 roadmap 的关系**：M0 的 `codex exec` 后端应直接换成 app-server；M3 "可操作的面板"可以直接复用官方 TUI 当终端窗格。
- **值得借鉴**：thread / turn / item 三层 + `item/started` → delta → `item/completed` 的权威态约定，可以作为我们协议 0.2 事件模型的模板；`serverRequest/resolved` 解决多端"谁答了"的问题。
- **不足 / 我们的机会**：
  - 官方明说 app-server "experimental and isn't supported for production workloads"（`codex__mcp-server.md`）。
  - 协议变化快（v1 / v2 并存、大量 `#[experimental]`）。
  - 必须按本机 `codex` 版本生成类型，并做版本探测。
- **复用判断**：作为依赖（spawn 官方二进制 + 用 `generate-ts` 生成类型），Apache-2.0，可以借用协议类型。

---

## 4. 协议层：Agent Client Protocol

### agentclientprotocol/agent-client-protocol（原 zed-industries）

- https://github.com/agentclientprotocol/agent-client-protocol · ⭐ 4593 · Apache-2.0 · Rust（spec + schema + SDK）· 最近提交 2026-11-07 · 本地：`references/repos/agentclientprotocol__agent-client-protocol` @ 7441d10
- **一句话**：编辑器 ↔ agent 的 JSON-RPC 协议（"LSP for agents"），Zed、JetBrains 等在用。
- **架构要点**：
  - **Transport**：stdio JSON-RPC 2.0，一行一条，stdout 不许有别的输出（`docs/protocol/v1/transports.mdx`）。HTTP / WebSocket 只是 RFD（`docs/rfds/streamable-http-websocket-transport.mdx`）。
  - **v1 稳定方法**（`schema/v1/meta.json`）：
    - agent 侧：`initialize`、`authenticate`、`session/new|load|resume|list|delete|close|prompt|cancel|set_mode|set_config_option`。
    - client 侧：`session/request_permission`、`session/update`、`fs/*`、`terminal/*`、`elicitation/*`。
    - 不稳定：`session/fork|status`、`providers/*`、`auth/status` 等（`schema/v1/meta.unstable.json`）。TS SDK 包名 `@agentclientprotocol/sdk`。
  - **事件**：`session/update` 的变体 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`current_mode_update`、`usage_update`、`compaction_update` 等（`schema/v1/schema.json` `$defs.SessionUpdate`）；不稳定版有 `subagent_update`。
  - **审批**：`session/request_permission` 的选项种类 `allow_once|allow_always|reject_once|reject_always`，结果 `selected{optionId}` 或 `cancelled`。`session/cancel` 之后客户端必须用 `cancelled` 回答所有未决请求。
  - **blocked**：v1 没有显式状态，"有未决的 `session/request_permission`"本身就是信号。v2 草案加了 `state_update: running|requires_action|idle`（`docs/protocol/v2/prompt-lifecycle.mdx`），和 Claude SDK 的三态同名。
  - **插话**：v1 未定义回合进行中再发 `session/prompt` 的语义；v2 草案允许任意时刻 prompt，由 agent 决定 steer 还是排队。steering 本身还是提案 *(unverified：PR #1261)*。
  - **resume**：`session/load` 必须重放全部历史，`session/resume` 不重放（`docs/protocol/v1/session-setup.mdx`）。
  - **登录**：`authMethods` 分 agent 处理型和 terminal 型（客户端带登录参数启动 agent 二进制，`docs/protocol/v1/authentication.mdx`）。
- **和我们 roadmap 的关系**：协议（M2 "任意 agent 当 Lead"）、跨 harness 接入。
- **值得借鉴**：`requires_action` 三态、权限选项四分法、load / resume 的区分，可以直接作为 MAS Office 协议 0.2 "控制面"部分的词汇。
- **不足 / 我们的机会**：面向"一个编辑器 ↔ 一个 agent 进程"，没有多订阅者、没有审批重放；插话不标准。
- **复用判断**：可作依赖或参考（Apache-2.0）。建议**内部抽象对齐 ACP 词汇**，但不把 ACP adapter 放进 Claude / Codex 的关键路径。

### agentclientprotocol/claude-agent-acp（原 zed-industries/claude-code-acp）

- https://github.com/agentclientprotocol/claude-agent-acp · ⭐ 2734 · Apache-2.0 · TypeScript · 最近提交 2026-11-06 · 本地 @ 47b64c0 · npm `@agentclientprotocol/claude-agent-acp` 0.101.0，依赖 `@anthropic-ai/claude-agent-sdk` 0.3.318
- **一句话**：把 Claude Agent SDK 包装成 ACP agent；一个进程托管多个会话（`src/acp-agent.ts:2568`）。
- **架构要点**：
  - 每个 ACP session 对应一个 `query({prompt: Pushable<SDKUserMessage>})`（`src/acp-agent.ts:1047, 12453`）。SDK 消息由 `toAcpNotifications` 转成 `session/update`（:14211）。
  - `canUseTool` → `requestPermissionFromClient` → `session/request_permission`（:12276, 10492, 2454）。`allow-with-updates` 映射为 `allow_always` 并写规则；ExitPlanMode 有专门选项（`src/permissions/options/shared.ts`）；`AskUserQuestion` → ACP elicitation（`src/elicitation.ts`）。
  - 回合进行中的第二个 `session/prompt` 进 `turnQueue`（:4109）。扩展 `_session/steering` 用 SDK `priority:"now"`，有未决审批时降为 `later`（:4501-4530）。
  - `session/load` = 读 transcript 重放 + `resume`；`session/resume` = 只 `resume`；fork → `forkSession`。
  - 登录：terminal 型方法 `claude-ai-login`（`--cli auth login --claudeai`）、`console-login`、`/login`，凭证就是 CLI 自己存的（:2960-3045）。
  - **值得注意**：它有 `--hide-claude-auth` 开关，注释写 "this integration must never bill a claude.ai subscription"，会拒绝任何由订阅付费的回合（`src/hide-claude-auth.ts`）。说明部分分发方（推测是 Zed / JetBrains）对"第三方 UI 用订阅"是主动规避的。
- **和我们 roadmap 的关系**：会话控制的参考实现，特别是 SDK → 事件流的映射、插话与审批的交互（审批未决时插话降级）。
- **值得借鉴**：`turnQueue` + steering 的状态机；订阅计费 guard 的实现思路（我们可能需要反向的"只允许用户自己的登录"提示）。
- **不足**：多一层 ACP 翻译会丢掉 SDK 的 `updatedInput` 等细节；扩展多（`docs/air-extensions.md`），变化快。
- **复用判断**：Apache-2.0，可借代码片段；不建议整体依赖。

### agentclientprotocol/codex-acp（原 zed-industries/codex-acp，已归档）

- https://github.com/agentclientprotocol/codex-acp · ⭐ 556（旧仓库 zed-industries/codex-acp ⭐ 872，2026-07 归档）· `LICENSE` 为 Apache-2.0（Copyright JetBrains s.r.o.；GitHub 显示 NOASSERTION）· 本地 @ f9cb470 · npm `@agentclientprotocol/codex-acp` 2.5.0
- **一句话**：当前版本是 TypeScript，spawn `codex app-server` 子进程，把 app-server v2 翻译成 ACP（`src/CodexJsonRpcConnection.ts:37-50`）。早期 Rust 版直接链接 codex-core *(unverified：浅克隆看不到历史)*。
- **架构要点**：
  - 用 `generate-ts` 生成类型（`package.json:39`），带重启恢复的 supervisor（`src/app-server-recovery/`）。
  - 审批：`item/commandExecution|fileChange|permissions/requestApproval` → `session/request_permission`（`src/permissions/CodexApprovalHandler.ts:45-130`）；决定集合不完整时自动答 `cancel`。
  - 插话：`_session/steering` → `turn/steer`，每会话串行（`src/SteeringQueue.ts`）。结果有 `injected` / `startedNewTurn` / `promptRequired` / `failed`（`docs/steering.md`）。
  - resume：`session/load` = `thread/resume` + 重放；`session/resume` = 只 `thread/resume`。
  - 登录：`chat-gpt`、`chat-gpt-device-code`、`api-key`、`gateway`，经 `account/login/start`（`src/CodexAuthMethod.ts`）。
- **值得借鉴**：app-server 客户端的版本探测与崩溃恢复（`src/app-server-recovery/`）、steering 结果四分法。
- **复用判断**：Apache-2.0，**是我们 Codex 适配器最好的参考代码**，可借用片段。

---

## 5. 其他 harness 的 server 模式

（本节由并行调研 agent 汇总，路径已抽查。）

### deepseek-ai/deepseek-harness（`packages/subagent`、`packages/acp`）

- https://github.com/deepseek-ai/deepseek-harness · ⭐ 275532 · MIT · TypeScript · 最近提交 2026-11-04 · 本地（sparse：`packages/subagent`、`packages/acp`、`docs`）@ fcc0ad4
- **一句话**：DSH 的子 agent 系统；`subagent-claude-code` 和 `subagent-codex` 两个 provider 把真实的 Claude Code / Codex 当一次性子任务跑。
- **架构要点**：
  - **Claude 后端**：
    - Agent SDK `query()`（pin `0.3.263`），用 SDK 自带 CLI，`persistSession:false`、`disallowedTools:['AskUserQuestion']`、默认 `permissionMode:'dontAsk'`。
    - `canUseTool` 一律返回 deny，`onElicitation` 回 decline（`packages/subagent/subagent-claude-code/src/run.ts:324-372`）。
    - 只取最终 `result`，父 agent 看不到进度（同目录 `README.md` "Known Limitations"）。
  - **Codex 后端**：
    - spawn `codex app-server --stdio`（pin `@openai/codex` 0.153.4），`thread/start{ephemeral:true}` → 单个 `turn/start` → 等 `turn/completed`（`packages/subagent/subagent-codex/src/run.ts:136`）。
    - 所有 server request 自动 cancel / decline / 空答（`src/wire.ts:574-626`），未知请求让运行失败。
    - 这份 `wire.ts` 是"app-server 会发哪些请求"的一份很好的清单。
  - **跟进与冷恢复**：两个 provider 都"run once and accept no follow-up input or resume"（`packages/subagent/subagent/src/activation.ts:117` 抛 `NOT_CONTINUABLE`）。`queue|steer` 投递与 `agents.resume({resumeSessionId})` 只对 DSH 自己的子会话有效（`subagent/src/control.ts:18`、`manager.ts:649-680, 845`）。
  - **并发**：`maxActiveSubagents` 默认 8（`subagent/src/index.ts:197`）。
  - `packages/acp`：把 DSH agent 暴露为 ACP v1 server，权限走 `session/request_permission`（`packages/acp/acp/src/index.ts:171`）。
  - **登录**：用原生工具已有的登录，启动前剥掉类似凭证的环境变量（READMEs）。
- **和我们 roadmap 的关系**：`mas run` 后端（M0 / M1）。
- **值得借鉴**：
  - Codex 侧 server request 的完整处理表。
  - "fail closed"的默认值：没有 UI 时拒绝，而不是跳过权限。
  - 并发池。
- **不足 / 我们的机会**：
  - 审批从不上报给人，子任务不可续。
  - 正是我们"举手 + 收件箱 + 追问"的空白（`positioning.zh-CN.md` 里担心 dsh 占位，但它只做了"一次性子进程"这一半）。
- **复用判断**：MIT，可借 `wire.ts` 的请求处理代码。

### earendil-works/pi（原 badlogic/pi-mono）

- https://github.com/earendil-works/pi · ⭐ 120600 · MIT · TypeScript · 最近提交 2026-11-07 · 本地 @ 085c84e
- **一句话**：极简 coding agent 工具箱（统一 LLM API、agent loop、TUI、CLI）。它本身是 harness，不驱动 Claude Code / Codex。
- **架构要点**：
  - **RPC 模式**：`pi --mode rpc`，stdin / stdout 严格 JSONL。文档提醒不要用 Node `readline`，因为它会在 U+2028 处断行（`packages/coding-agent/docs/rpc.md`；`src/modes/rpc/{rpc-mode.ts,rpc-client.ts,rpc-types.ts}`）。
  - **命令**：`prompt{streamingBehavior:"steer"|"followUp"}`、`steer`、`follow_up`、`abort`、`clear_queue`、`new_session`、`switch_session`、`fork`、`get_state`、`get_messages`、`set_steering_mode`、`set_follow_up_mode` 等（`rpc-mode.ts:409-701`、`docs/rpc-commands.md`）。
  - **事件**：`agent_start`、`turn_start` / `turn_end`、`message_update`（`text_delta`、`toolcall_*`）、`tool_execution_*`、`queue_update{steering, followUp}`、`agent_settled`（真正的空闲信号）（`docs/json.md`）。
  - **审批**：默认没有（`docs/security.md`）。可选的扩展 hook `pi.on("tool_call")` 可以 block（`docs/extensions.md:973-1004`、`examples/extensions/permission-gate.ts`）。RPC 模式下扩展的 `ctx.ui.confirm/select` 变成 `extension_ui_request` / `extension_ui_response` 往返，超时自动处理（`docs/rpc-extension-ui.md`）。
  - **会话**：`~/.pi/agent/sessions/.../<ts>_<id>.jsonl` 树状结构（`docs/session-format.md`），`--continue`、`--resume`、`--session`、`--fork`。
  - **子 agent 示例**：每个任务 spawn `pi --mode json -p --no-session`，并行上限 8、并发 4（`examples/extensions/subagent/index.ts:38-39`）。
  - **登录（重要）**：pi **直接用订阅 OAuth token 调厂商 API，不运行官方 CLI**。
    - Anthropic：用 Claude Code 的 OAuth client id，scope 含 `user:sessions:claude_code`，请求头冒充 `claude-cli` 并把工具名映射成 Claude Code 的（`packages/ai/src/auth/oauth/anthropic.ts:14-27`；`packages/ai/src/api/anthropic-messages.ts:1288-1308`）。
    - OpenAI：用 Codex CLI 的 client id 调 `chatgpt.com/backend-api/codex/responses`（`packages/ai/src/auth/oauth/openai-codex.ts:22`）。
    - 另有一个自注册 client 的 ChatGPT 流程（`openai-chatgpt.ts`）。
- **和我们 roadmap 的关系**：协议设计参考（命令 / 事件分离、steer 与 followUp 双队列、`agent_settled`）。
- **值得借鉴**：`steer` / `follow_up` 两个独立队列和 `queue_update` 事件，正好对应抽屉里"立刻插话"与"排队下一个任务"两个按钮；`extension_ui_request` 是一个干净的通用"需要你"往返。
- **不足**：
  - 它的 Anthropic 登录路径属于 `claude__legal-and-compliance.md` 明确禁止的类型（第三方应用使用 claude.ai 登录 / 冒充官方客户端）。
  - **我们绝不能照搬**；若把 pi 作为"第三种员工"，只能让用户用 API key。
- **复用判断**：MIT，可借 RPC 协议设计；登录方式不可借。

### anomalyco/opencode（原 sst/opencode）

- https://github.com/anomalyco/opencode · ⭐ 225196 · MIT · TypeScript · 最近提交 2026-11-07 · 本地（sparse：`packages/{sdk,server,protocol,core/src}`；`packages/opencode` 在该提交中不存在）@ fdce636
- **一句话**：开源 coding agent，**一开始就是 client / server 架构**：TUI、桌面、Web 都是同一个 HTTP server 的客户端。
- **架构要点**：
  - **Transport**：HTTP API + SSE。
    - 新的 Effect HttpApi 在 `/api/...` 下，OpenAPI 由 `packages/protocol/script/generate-openapi.ts` 生成（`packages/protocol/openapi.json`，标 Experimental）。
    - Basic auth + 配对 token（`packages/server/src/auth.ts`）。
    - `@opencode/sdk` 可以在进程内跑路由（`packages/sdk/README.md`）。
  - **事件**：`GET /api/event`（SSE，可按 `types` 过滤；"volatile"，断线期间的事件丢失，需用列表接口重同步，`packages/protocol/src/groups/event.ts:61-70`）。类型有：
    - `permission.asked|replied`
    - `form.created|replied|cancelled`
    - `session.status|idle`
    - `session.execution.started|succeeded|failed|interrupted`
    - `session.text.delta`
    - `session.tool.called|progress|success|failed`
    - `session.inbox.enqueued|delivered`
  - **审批**：`GET /api/session/:id/permission`，`POST /api/session/:id/permission/:requestID/reply {decision:"once"|"always"|"reject", message?}`（`packages/protocol/src/groups/permission.ts:142`）；提问工具 `question` 走 Forms 接口（`packages/core/src/tool/plugin/question.ts`）。
  - **插话**：`POST /api/session/:id/prompt {delivery:"steer"|"queue"}`，输入**持久化到会话 inbox**，有 `GET /inbox` 和 PATCH / DELETE（`packages/protocol/src/groups/session.ts`）。
  - **多客户端**：任意多个 SSE 订阅者；PTY 路由（`packages/server/src/handlers/pty-socket.ts`、`persistent-pty.ts`）。
  - **持久化**：SQLite（drizzle，`packages/core/src/database/schema.sql.ts`）。
  - **登录**：
    - Claude 走 `claude-agent` provider 插件，用 Agent SDK 调本机 `claude`，但把 Claude 的内置工具全关掉（`tools: []`、`permissionMode:"dontAsk"`、`allowedTools:["mcp__opencode__*"]`、`settingSources:[]`），只把 Claude 当模型后端用（`packages/core/src/plugin/provider/claude-agent/claude/query-options.ts:53-110`）。
    - ChatGPT 走带动态 client 注册的 token sharing（`packages/core/src/plugin/provider/chatgpt.ts:20-30`）。
    - 旧的 anthropic-auth 插件现状 *(unverified)*。
- **和我们 roadmap 的关系**：协议（M2）、办公室交互、收件箱。它是"给多个前端用的 agent server"最好的 API 样板。
- **值得借鉴**：
  - **持久化 inbox + `delivery: steer|queue`**：这正是 CEO 派活所需的语义，比 SDK 内存队列更抗重启。
  - `permission.asked` / `replied` 成对事件。
  - SSE 断线后"用列表接口重同步"的约定。
- **不足**：
  - 用 Claude Code 只当模型后端，在合规上比"运行完整 Claude Code"更灰 *(unverified)*。
  - API 刚重写、标 Experimental。
- **复用判断**：MIT，可借 API 设计与代码；也可作为未来"第三种员工"的后端（直接用它的 HTTP API）。

---

## 6. 远程 / Web 客户端

### slopus/happy

- https://github.com/slopus/happy · ⭐ 24529 · MIT · TypeScript + Swift（monorepo）· 最近提交 2026-11-07 · 本地（sparse：`packages/happy-cli/src`、`packages/happy-wire`、`docs/competition`、`docs/research`）@ 490c33a
- **一句话**：手机 / Web 端远程操控 Claude Code、Codex（及 Grok）的 App，CLI 端 `happy` 包装本地会话，经端到端加密中继同步。
- **架构要点**：
  - **Claude 双模式切换**（`packages/happy-cli/src/claude/loop.ts:77-110`）：
    - **本地模式**：直接 spawn `claude`，`stdio: inherit`，用户在自己的终端里操作；加 `--session-id` / `--resume` 和一个注入 `SessionStart` hook 的 `--settings` 来拿 session id（`claude/claudeLocal.ts:212-316`、`claude/utils/generateHookSettings.ts`）。transcript 靠 tail JSONL 同步到手机（`claude/claudeLocalLauncher.ts`）。
    - **远程模式**：手机发消息时杀掉本地进程，用 Agent SDK `query()` + `resume: sessionId` 接着跑（`claude/claudeRemote.ts:131-175`）；终端显示 Ink 视图，按两次空格切回本地。
    - 设置 `CLAUDE_CODE_ENTRYPOINT`，让 SDK 会话出现在 `claude --resume` 选择器里（`claude/sdk/query.ts:57-60`）。
  - **审批**：远程模式下 `canUseTool` 写入加密的 `agentState.requests`，手机通过 RPC `permission` 回答（`claude/utils/permissionHandler.ts:260-377`）；`AskUserQuestion` / `ExitPlanMode` 永不自动批准。本地模式下审批留在终端，不转发。
  - **Codex**：只有远程模式，spawn `codex app-server --listen stdio://`，处理 `item/*/requestApproval` 与 `mcpServer/elicitation/request`（`codex/codexAppServerClient.ts:609, 1396-1460`）；没用 `turn/steer`，手机消息排队到下一回合（`codex/runCodex.ts:887`）。
  - **插话**：Claude 远程模式也是等 `result` 后才推下一条（`claude/claudeRemote.ts:365-371`），即只在回合之间。
  - **同步**：socket.io（`/v1/updates`），tweetnacl 端到端加密（`api/encryption.ts`）。线协议事件 `text|service|tool-call-start|tool-call-end|file|turn-start|start|turn-end|stop`（`packages/happy-wire/src/sessionProtocol.ts`）。
  - **登录**：用主机上已登录的 `claude` / `codex`（`claude/utils/providerAuth.ts` 提示 `claude auth login`）。
  - `docs/competition/comparison-matrix.md` 的结论：OpenCode 是 transcript 的最佳参考，Codex app-server 是后端协议的最佳参考，Claude 的状态散在 ACP、hooks、`~/.claude/` 三处。值得一读。
- **和我们 roadmap 的关系**：会话控制、收件箱、"可接手"。
- **值得借鉴**：**同一 session id 在"真 TUI"和"SDK 远程"之间切换**，这是在 Claude 侧实现"可观看 + 可接手 + 结构化审批"最实际的模式（代价是同一时刻只有一边活着）。
- **不足 / 我们的机会**：没有 steer；没有多 agent 组织视图。
- **复用判断**：MIT，可直接借代码（`permissionHandler.ts`、`codexAppServerClient.ts`）。

### siteboon/claudecodeui（CloudCLI）

- https://github.com/siteboon/claudecodeui · ⭐ 14489 · AGPL-3.0 · TypeScript · 最近提交 2026-11-07 · 本地 @ 2053f3d
- **一句话**：Claude Code / Codex / Cursor CLI / OpenCode 的 Web 与移动端 GUI。
- **架构要点**：
  - **Claude**：SDK `query()` + `resume` / `resumeSessionAt`（`server/modules/providers/list/claude/claude-runtime.provider.ts:449-461`）。
    - **真正的中途插话**：`chat.steer` → `pushPromptMessage({..., priority:'next'})`（:1290-1311）。
    - 审批：`canUseTool` → WS `permission_request` → 浏览器 `chat.permission-response {allow, updatedInput, rememberEntry}`（:1392-1431；`server/modules/websocket/services/chat-websocket.service.ts:808-835`）。
  - **Codex**：走 `@openai/codex-sdk`（即 `codex exec`），代码注释承认 "exec cannot grant interactive approval requests"（`providers/list/codex/codex-runtime.provider.ts:235-256`）；app-server 只用于 fork。**审批到不了 UI。**
  - **OpenCode**：`@opencode-ai/sdk/v2`，`permission.asked` 事件 → `client.permission.reply`。
  - **终端标签页**：node-pty + xterm over WS，跑 `claude --resume <id>` / `codex resume <id>`（`server/modules/websocket/services/shell-websocket.service.ts:226-271`）。与 SDK 聊天**不是同一进程**，只靠 JSONL watcher 同步。
  - 历史：chokidar 监视 `~/.claude/projects`、`~/.codex/sessions`。
  - 登录：读 `~/.claude/.credentials.json` 判断登录状态（`claude/claude-auth.provider.ts:119-155`），用户自己的登录。
- **值得借鉴**：WS 事件种类（`server/shared/types.ts:215-249`）可以直接对照我们的 SSE 事件；`permission_resolved` / `permission_cancelled` 两种收尾事件。
- **不足**：Codex 走错了入口；终端与聊天是两个进程，同时操作会冲突。
- **复用判断**：AGPL-3.0，只借思路，不能拷代码。

### winfunc/opcode（原 getAsterisk/opcode、Claudia）

- https://github.com/winfunc/opcode · ⭐ 22431 · AGPL-3.0 · TypeScript + Rust（Tauri）· 最近提交 2026-11-06 · 本地 @ c24004d
- **一句话**：Claude Code 的桌面 GUI 与"后台 agent"工具箱。
- **架构要点**：
  - 每次提示 spawn `claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`，续接时加 `-c` / `--resume`，不用 stdin（`src-tauri/src/commands/claude.rs:1240-1305, 608`）。
  - **完全没有审批 UI**。
  - 不能中途插话（前端排队，`src/components/ClaudeCodeSession.tsx:859`）；同时只允许一个交互进程（`claude.rs:1530`）。
  - 后台 agent 记在 SQLite `agent_runs`（`commands/agents.rs`）。
- **复用判断**：反例。AGPL，只借"解析 `~/.claude/projects` 历史"的思路。

### coder/agentapi（已归档）

- https://github.com/coder/agentapi · ⭐ 1496 · MIT · Go · 2026-09 归档 · 本地 @ 7c468d5
- **一句话**：用内存 VT100 模拟器包住任意 CLI agent，暴露 HTTP + SSE。这是 PTY 抓屏路线的代表。
- **架构要点**：
  - 每 25 ms 截屏，2 s 不变即判定 `stable`（`lib/httpapi/server.go:103, 280`；`lib/screentracker/pty_conversation.go:117-121`）。
  - 发消息用 bracketed paste + 回车重试（`lib/httpapi/claude.go`；`pty_conversation.go:448-527`）。
  - **无法区分"等审批"与"完成"**；回答审批要发 raw 按键，因为 bracketed paste 的 ESC 会取消 Claude 的选择框（`claude.go:8-12`）。
  - 后期加了 `--experimental-acp`（`x/acpio/`）。
- **复用判断**：反例。说明 PTY 抓屏只适合"显示"，不适合"控制"。

### 其他看到但未深入的

| 项目 | 说明 |
|---|---|
| omnara-ai/omnara（⭐ 3365，Apache-2.0） | 已转型为自托管 managed agent 平台，不再是 Claude Code 远程客户端 |
| 21st-dev/1code（⭐ 5572，已归档） | Claude Code / Codex 编排 UI |
| sugyan/claude-code-webui（⭐ 1136，已归档） | — |
| rebornix/Agmente（⭐ 548） | iOS 端，通过 ACP 或 Codex app-server 控制 agent，说明这两条协议已经成了远程客户端的事实标准 |
| lezi-fun/codex-webui（⭐ 44） | Codex app-server 的 Web UI，带审批 |

---

## 7. 推荐的控制方案

### 7.1 Claude Code

| 能力 | 推荐实现 | 已知限制 / 风险 |
|---|---|---|
| (a) start | `@anthropic-ai/claude-agent-sdk` 的 `query()`，**流式输入模式**（prompt 传一个我们持有的 Pushable `AsyncIterable<SDKUserMessage>`）。每个角色一个长驻 query、一个子进程。用 `sessionId`（或 CLI `--session-id`）预先指定 UUID，先写入 MAS 状态再启动。按角色传 `cwd`、`allowedTools` / `disallowedTools`、`permissionMode`、`agents`、`settingSources`；子进程环境加 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`。 | 每会话一个进程，内存是并发上限；SDK 版本必须和本机 `claude` 版本兼容（SDK 自带 CLI，可用 `pathToClaudeCodeExecutable` 指定用户自己的） |
| (b) stream events | 消费 `SDKMessage`：`assistant` / `user` / `result` / `stream_event`（可选）/ `task_*` / `permission_denied` / `rate_limit_event` / `session_state_changed`。由 Node 进程映射成 `events.jsonl`（协议 0.2），reducer 不变。 | 消息联合很大且在增长，映射层要容忍未知 `subtype` |
| (c) detect blocked | 以 `canUseTool` 被调用为准（立即建一条"需要你"条目，带 `toolUseID`、`agentID`、`title`、`description`、`suggestions`）。用 `session_state_changed=requires_action` 交叉确认。`AskUserQuestion` 单独渲染为问题卡。 | 审批只在**父进程活着**时存在，见 (f) |
| (d) answer from UI | UI → SSE 的反向通道（我们需要新增 `POST /sessions/:id/decisions`）→ resolve 对应 Promise：`allow` + `updatedInput` / `updatedPermissions`，`deny` + `message` / `interrupt`。"总是允许"只允许写 `session` 或 `localSettings` 目的地，并在 UI 显示。 | 子 agent 里没有 `AskUserQuestion`；`PermissionRequest` hook 会和 `canUseTool` 竞速，我们自己的 hook 不要返回决定 |
| (e) follow-up | 抽屉聊天框 → push `SDKUserMessage`：回合进行中默认 `priority:"next"`，"立刻改向"用 `priority:"now"` + `origin:{kind:"human"}`；回合结束后直接 push 即开新回合。CEO 派的新任务用 `later`。 | 审批未决时插话的语义要设计（claude-agent-acp 的做法是降为 `later`） |
| (f) resume after restart | 持久化 `sessionId`、cwd、角色配置。重启后 `query({resume: sessionId})` 重建，未完成的工具调用不会重跑（`claude__sessions.md` §What a resumed session restores）。历史用 `getSessionMessages()` 回填。**Node 进程退出时未决的 `canUseTool` 请求会丢**，重启后要把这些条目标成"已失效、请重新派发"。若要求审批能跨重启，用 `PreToolUse` → `defer` + `-p --resume`（只限单工具调用回合）。 | `--mcp-config`、`--settings`、`--add-dir` 等不会随 resume 恢复，必须由我们每次重新传 |
| (g) watchable terminal | **默认**：抽屉里自绘 transcript（基于 SDK 事件）。**接手**：按钮触发 `interrupt()` → 关闭 query → 在 PTY 里跑 `claude --resume <id>`（xterm.js 显示），我们的 `mas hook claude-code` hooks 继续出事件；交还时退出 TUI → 再 `query({resume})`。这就是 Happy 的模式。**进阶（spike）**：TUI 常驻 PTY + 自建 channel MCP server（`claude/channel` + `claude/channel/permission`），UI 并行应答审批、推消息进会话。 | 同一时刻只有 SDK 或 TUI 一边持有会话；channels 是研究预览，自建 channel 需 `--dangerously-load-development-channels`（启动有确认框）；relay 只有 allow / deny |

备选路线（不推荐作为主路）：

- **agent view**：`claude --bg` + `claude agents --json` 轮询 `state` / `waitingFor` 当"举手"信号 + `claude attach` 当终端。用于"观察用户自己开的会话"很合适，但没有程序化的回答 / 发消息接口。
- **跨会话 inbox socket**：能推消息但不能批准，且消息被标成"来自另一会话"。

### 7.2 Codex

| 能力 | 推荐实现 | 已知限制 / 风险 |
|---|---|---|
| (a) start | MAS 启动并持有**一个** `codex app-server --listen unix://<mas-state>/codex.sock`（或 stdio 子进程 + 我们自己转发；推荐 unix socket，见 (g)）。`initialize{clientInfo:{name:"mas_office"}, capabilities:{experimentalApi:true}}`。每角色 `thread/start{cwd, model, approvalPolicy:"on-request", sandbox:"workspace-write", serviceName}`。类型用 `codex app-server generate-ts` 在安装时按本机版本生成，并记录版本。 | 官方称 app-server "experimental，不支持生产"；`experimentalApi` 下字段可能变 |
| (b) stream events | `item/started` → delta → `item/completed`（权威态）、`turn/*`、`turn/diff/updated`、`turn/plan/updated`、`thread/tokenUsage/updated`、`error`，映射到 `events.jsonl`。子 agent 用 `collabToolCall.newThreadId` 建立层级，并对子 thread 做 `thread/resume` 订阅。 | 噪声大，可用 `optOutNotificationMethods` 关掉不需要的 delta |
| (c) detect blocked | `thread/status/changed` 的 `activeFlags` 含 `waitingOnApproval` / `waitingOnUserInput`，加上收到的 server request 本身。 | 子 thread 的审批是否会冒到父订阅者需验证 |
| (d) answer from UI | 对 server request 回 JSON-RPC 响应：命令 `accept|acceptForSession|decline|cancel|acceptWithExecpolicyAmendment`，文件改动 `accept|acceptForSession|decline|cancel`，`item/permissions/requestApproval` 返回授予子集，`item/tool/requestUserInput` 返回答案。以 `serverRequest/resolved` 关闭收件箱条目（无论谁答的）。 | 没有 Claude 那样的 `updatedInput`（不能"带修改批准"） |
| (e) follow-up | 回合进行中 `turn/steer{expectedTurnId}`；回合结束后 `turn/start`；CEO 的待办用实验性 `thread/queue/add`，或由我们自己排队。 | `turn/steer` 在回合刚结束时会失败，需要退回到 `turn/start`（codex-acp 的 `startedNewTurn` 分支） |
| (f) resume after restart | 持久化 `threadId`。MAS 重启 → 重启 app-server → `thread/resume{threadId, excludeTurns:true}` + `thread/turns/list` 回填。若改用官方 `codex app-server daemon`（实验性），daemon 在 MAS 重启时仍活着，重新连接后未决审批会被**重放**。 | 非 daemon 模式下，app-server 进程退出即丢失进行中的回合和未决审批 *(unverified)* |
| (g) watchable terminal | 在 PTY 里跑 `codex resume <threadId> --remote unix://<mas-state>/codex.sock`，官方 TUI 挂在同一个 app-server、同一 thread 上。TUI 和 MAS 都是订阅者，任一方可答审批，另一方收到 `serverRequest/resolved`。 | 需 spike：TUI 和我们同时 `turn/start` 的竞争；TUI 退出是否 unsubscribe 导致卸载（有 60 s 宽限，MAS 仍订阅时不会卸载）；`requiredHumanApproval` 检查点只发给声明能力的客户端 |

### 7.3 共同的抽象层

- **内部接口**：MAS 内部定义 `AgentBackend { start, send(message, priority), answer(requestId, decision), interrupt, resume, attachTerminal }`。状态机三态直接用 `running | requires_action | idle`（Claude SDK、Codex app-server、ACP v2 三家同名或同义）。
- **协议 0.2 新增**：
  - `request.opened` / `request.resolved` 事件（带 `requestId`、`kind: tool_approval|question|elicitation`、`resolvedBy: ui|terminal|hook|timeout`）。
  - `session.state` 事件。
  - 反向命令通道：`POST /v1/sessions/:id/{messages,decisions,interrupt}`，SSE 继续单向推送。
- **ACP**：不作为内部协议的传输层，但字段命名尽量与 ACP 对齐。以后可以加一个"ACP 后端"去接任意 ACP agent（Gemini CLI、OpenCode 等），这样 M2 的跨 harness 不用重做。

### 7.4 合规与登录（必须写进产品叙述）

- **Claude**：
  - 文档同时有两句话：
    - "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"（`claude__agent-sdk_overview.md`）。
    - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription"（`claude__legal-and-compliance.md`）。
  - 另有 "Advertised usage limits … assume ordinary, individual usage of Claude Code and the Agent SDK"。
  - MAS Office 的安全姿态：
    - 只 spawn 用户本机已安装、未修改的 `claude`。
    - 不读、不存、不转发凭证（不要像 CloudCLI 那样读 `~/.claude/.credentials.json`，改用 `claude auth status`）。
    - 不提供自己的登录按钮，引导用户在终端里 `claude auth login`。
    - 文案说"在你自己的 Claude Code 里运行"，而不是"用你的订阅驱动我们的产品"。
    - 默认提示用户可以选择用 API key（Console）运行。
  - 多 agent 并发会显著放大用量，可能触及"ordinary, individual usage"的边界。**这是法律 / 政策风险，不是技术风险，需要单独决策** *(unverified：Anthropic 未就"本机编排多个 Claude Code 会话的开源工具"给出明确说法；claude-agent-acp 的 `--hide-claude-auth` 说明部分分发方主动规避)*。
- **Codex**：
  - OpenAI 文档主动邀请"Embed Codex into your product with the app-server protocol"，并提供 ChatGPT 登录端点。
  - 要求用 `clientInfo.name` 标识集成方；面向企业需申请进 known clients 列表。
  - 风险低 *(unverified：未检索 OpenAI 消费者条款对第三方 UI 的具体条文)*。

### 7.5 需要动手 spike 才能确认的事项

1. **Claude SDK 审批的端到端延迟与断线**：浏览器断开 → 重连后，用 `reinitialize()` 是否能拿回未决的 `can_use_tool`？
2. **Claude 交互 TUI 下 `PermissionRequest` HTTP hook 长轮询**：等待期间 TUI 显示什么？超时（默认 600 s）后是否回落到对话框？
3. **Channels permission relay**：
   - 在 Pro / Max 个人账号上，自建 channel + `--dangerously-load-development-channels server:mas` 在 PTY 中能否稳定工作？
   - 启动确认框能否由我们在 PTY 里自动应答（以及这样做是否合适）？
   - relay 是否覆盖子 agent 的审批？
4. **SDK ↔ TUI 交接**：
   - SDK 会话 `interrupt` 后用 `claude --resume <id>` 打开，系统提示和 agent 是否保持（`--system-prompt-snapshot` 语义）？
   - 反向交接后 hooks 是否仍触发？
   - 会话被两个进程同时打开时的行为。
5. **Codex 多客户端**：
   - TUI（`--remote`）与 MAS 同时订阅一个 thread 时，审批是否两边都弹、先答者生效、另一边收到 `serverRequest/resolved`？
   - TUI 里用户自己发起的 `turn/start` 能否被 MAS 完整观察到？
   - 子 agent thread 的审批路由。
6. **Codex app-server 崩溃 / 重启**：未决审批和进行中的回合是否可恢复；daemon 模式的生命周期和"自动更新导致重启"对运行中回合的影响（daemon README 说 update 会中断）。
7. **版本漂移**：本机 `claude` / `codex` 升级后，SDK 和生成类型的兼容性检测方式。
8. **并发上限**：8–12 个角色同时运行时的内存（Claude 每会话一个 Node 子进程）与速率限制（订阅额度）。

### 7.6 最大的风险

1. **Claude 订阅合规**（§7.4），可能影响"用户用自己订阅"这个前提本身。
2. **Claude 没有"一个进程同时被 SDK 控制并显示 TUI"的官方方案**。接手模式会打断会话，channels 仍是研究预览。
3. **Codex app-server 官方标为 experimental**，协议变化快（本月就有 `mcp-server` 被移除、`--full-auto` 被移除）。
4. **两家都在快速吃掉这一层**：Claude 的 agent view（`claude agents --json`，带 `blocked` / `waitingFor`）、Codex 的 `codex agents` 与 daemon，都是官方的"多会话总览"。MAS Office 的价值必须落在组织、核对和证据层，而不是会话管理本身（与 `positioning.zh-CN.md` 的结论一致）。

---

## 8. 对比表

| 项目 | 角色 | Transport | 结构化事件 | blocked 信号 | UI 应答审批 | 中途插话 | resume | 可观看终端 | 登录 | License |
|---|---|---|---|---|---|---|---|---|---|---|
| Claude Agent SDK | 官方库 | spawn `claude`，stdio NDJSON + control_request | ✅ `SDKMessage` 约 40 种 | ✅ `requires_action` + `canUseTool` | ✅ allow / deny / 改参 / 记住 / 问答 | ✅ `priority` now / next / later | ✅ resume / fork / continue | ❌（需交接或自绘） | 用户本机 CLI 凭证；第三方产品用订阅受限 | TS：Commercial ToS；Py：MIT |
| `claude -p` stream-json | 官方 CLI | 同上 | ✅ | ✅ | ✅ 经 stdio 或 `--permission-prompt-tool` | ✅ | ✅ + `defer` | ❌ | 同上 | — |
| Claude hooks | 官方 | 子进程 / HTTP 回调 | ◐ 事件级 | ✅ `PermissionRequest`（`Notification` 有延迟） | ◐ hook 可决定，TUI 对话框在 hook 之后 | ❌ | — | ✅ TUI | 同上 | — |
| Claude channels（预览） | 官方 | MCP stdio 扩展通知 | ❌ | ✅ relay 请求 | ✅ 仅 allow / deny，与 TUI 并行 | ✅ 推消息 | — | ✅ TUI | Pro / Max 可用，自建需 dev flag | — |
| Claude agent view（预览） | 官方 | `claude agents --json` 轮询 | ❌ | ✅ `blocked` + `waitingFor` | ❌ | ❌（仅 TTY） | ✅ supervisor | ✅ `claude attach` | 同上 | — |
| Codex app-server | 官方服务 | JSON-RPC：stdio / unix / ws | ✅ thread / turn / item | ✅ `activeFlags` + server request | ✅ 多种决定，多订阅者先答者生效 | ✅ `turn/steer`、`thread/queue/*` | ✅ `thread/resume`，重放未决审批 | ✅ `codex resume --remote` 共享 | ChatGPT / API key，官方鼓励嵌入 | Apache-2.0 |
| `codex exec --json` / TS SDK | 官方 CLI | spawn，JSONL | ✅ | ❌ | ❌（approval=never） | ❌ | ✅ `exec resume` | ❌ | 同上 | Apache-2.0 |
| ACP spec | 协议 | JSON-RPC stdio | ✅ `session/update` | ◐ 未决请求；v2 有三态 | ✅ 四种选项 | ◐ 扩展 / v2 草案 | ✅ load / resume | ❌ | terminal / agent 型 | Apache-2.0 |
| claude-agent-acp | 适配器 | ACP ↔ Agent SDK | ✅ | ✅ | ✅ | ✅ 队列 + `_session/steering` | ✅ | ❌ | CLI 凭证；有 `--hide-claude-auth` | Apache-2.0 |
| codex-acp | 适配器 | ACP ↔ app-server | ✅ | ✅ | ✅ | ✅ `_session/steering` → `turn/steer` | ✅ | ❌ | ChatGPT / API key | Apache-2.0 |
| dsh `packages/subagent` | 编排器后端 | SDK（Claude）/ app-server stdio（Codex） | ◐ 只取最终结果 | ❌ | ❌ 一律拒绝（fail closed） | ❌ 不可续 | ❌ | ❌ | 原生 CLI 登录 | MIT |
| pi | 独立 harness | `--mode rpc` JSONL | ✅ | ◐ `extension_ui_request` | ◐ 需自写 gate 扩展 | ✅ `steer` / `follow_up` 队列 | ✅ 会话文件 | ✅ 自身 TUI | **直连订阅 OAuth，冒充官方客户端（高风险）** | MIT |
| opencode | 独立 harness（C/S） | HTTP + SSE（OpenAPI） | ✅ | ✅ `permission.asked`、`session.status` | ✅ once / always / reject | ✅ 持久 inbox steer / queue | ✅ SQLite | ✅ TUI 是客户端之一 | Claude 当模型后端 / ChatGPT token sharing | MIT |
| Happy | 远程客户端 | SDK + app-server + E2E 中继 | ✅ | ✅ | ✅（Claude 远程模式、Codex） | ◐ 仅回合间 | ✅ 同 id 在 TUI 与 SDK 间切换 | ✅ 本地模式 | 主机 CLI 凭证 | MIT |
| CloudCLI | Web GUI | SDK / codex-sdk / PTY | ✅ | ✅（Claude） | ✅ Claude；❌ Codex | ✅ Claude `priority:'next'` | ✅ | ◐ 独立 PTY | 读 credentials 文件 | AGPL-3.0 |
| opcode | 桌面 GUI | `claude -p` stream-json | ✅ | ❌ | ❌ 跳过权限 | ❌ | ✅ | ❌ | 本机 CLI | AGPL-3.0 |
| agentapi | HTTP 包装 | PTY 抓屏 + SSE | ❌ 屏幕 diff | ❌ 只能判断"稳定" | ◐ raw 按键 | ◐ bracketed paste | ◐ | ✅ 抓屏 | 本机 CLI | MIT（已归档） |
