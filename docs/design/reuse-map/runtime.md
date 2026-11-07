# 复用地图 · Runtime 侧（C1–C8、C16）

- 日期：2026-11-07。规则与复用方式定义见 [`../reuse-map.md`](../reuse-map.md) 和根目录 `CLAUDE.md` §2–§3。
- 路径约定：文件路径都相对 `references/repos/<owner>__<repo>/`，行号对应 `references/manifest.json` 里固定的 commit。`references/docs/*.md` 是官方文档快照。
- 本文引用的每个路径都在固定 commit 上用 `ls` / `grep` 核对过。Orca、Paperclip、Gas City、ruflo 四个新克隆仓库由并行的只读调研 agent 逐文件阅读，我又抽查了其中的关键路径和行号。没能核对的内容标 *(unverified)*。
- 复用方式：**依赖**（加包或 spawn 官方二进制）、**改编**（复制修改，保留来源头注释并登记 `THIRD_PARTY_NOTICES.md`）、**只借思路**。

## 总览

| 组件 | 首选参考 | 复用方式 | 预计节省 |
|---|---|---|---|
| C1 Claude 会话 adapter | `@anthropic-ai/claude-agent-sdk`；`claude-agent-acp` 的 steer / 权限代码；Orca `claude-prompt-registry.ts` | 依赖 SDK + 改编（Apache-2.0 / MIT） | 高：线协议、重投递、插话与审批的交互都已有人踩过坑 |
| C2 Codex 会话 adapter | `codex app-server` + `generate-ts`；`codex-acp` 的连接、审批、steer、崩溃恢复 | 依赖二进制 + 改编（Apache-2.0） | 高：几乎可以照搬 codex-acp 的客户端骨架 |
| C3 可观看 / 可接手终端 | agent-office `ptyhost.ts`（独立 PTY 宿主 + headless xterm）；Happy 的 SDK↔TUI 切换 | 依赖 node-pty / xterm + 改编（MIT） | 中高：PTY 宿主约 600 行可直接改编；交接状态机要自写 |
| C4 卡住检测与待决交互 | Gas City `PendingInteraction` / `pendingwatch`；OpenRig 证据阶梯；Paperclip "一次回答只续跑一次"；W17ant `permissions.js` | 改编（MIT / Apache-2.0） | 中：数据形状与幂等机制可直接用；四类请求统一模型要自研 |
| C5 协议 0.2 | 05 §A.4 草案；AG-UI `Interrupt`；ACP 权限选项；Codex v2 类型 | 只借词汇（不绑字段名） | 低：词汇省事，schema / reducer / conformance 都是自研 |
| C6 Daemon / server | Gas City `internal/events`（JSONL + seq + SSE 续传）；Orkas `persist.ts`；Paperclip 并发与预算；ruflo 预算账本教训 | 改编少量 + 只借思路 | 中：日志与 SSE 续传模式现成；命令路由与重启对账自写 |
| C7 CEO / 协调者 | Orca orchestration（Run / Task / Dispatch / Gate、邮箱指针唤醒）；MS AF Magentic ledger；Paperclip 唤醒合并 | 改编数据结构（MIT） + 只借思路 | 中：对象模型和防循环规则可抄；"读语义事件流 + 代理批准"是护城河 |
| C8 组织设计与权限编译器 | OpenRig RigSpec 的逐成员 `claude_permissions` / `codex_permissions`；Claude / Codex 官方权限参数；Paperclip `agentcompanies/v1` | 改编（Apache-2.0 / MIT） + 只借思路 | 中：编译目标和陷阱都已摸清；schema 与锁定自研 |
| C16 远程 / 手机控制 | Orca 的配对 + X25519 E2EE + 手机方法白名单；Happy 的加密与线协议；agent-office 的 Tailscale / SSH 隧道 | 改编（MIT） + 只借思路 | 中：先用隧道免做中继；做中继时 E2EE 代码可改编 |

## License 核对（manifest 为 NONE / NOASSERTION，或有附加条款）

| 仓库 | manifest | 实际条款（已读原文） | 本文用法 |
|---|---|---|---|
| anthropics/claude-agent-sdk-typescript | NONE | `LICENSE.md` 全文只有一句："© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"。仓库只有 CHANGELOG / examples，源码随 npm 包分发 | 只作 npm 依赖，不 vendor、不复制 |
| agentclientprotocol/codex-acp | NOASSERTION | `LICENSE` 是标准 Apache-2.0 全文，开头写 "Copyright 2025 JetBrains s.r.o."；`package.json` 声明 `"license": "Apache-2.0"`；仓库根没有 NOTICE 文件 | 可改编，头注释写 JetBrains 版权 |
| modelcontextprotocol/modelcontextprotocol | NOASSERTION | 正在从 MIT 迁到 Apache-2.0：新贡献是 Apache-2.0；没同意重新授权的旧贡献仍是 MIT；非规范类文档是 CC-BY-4.0 | 只借词汇（elicitation 三动作），不复制 |
| ruvnet/ruflo | MIT | 根目录 MIT；但 `ruflo/src/ruvocal/` 是 **Apache-2.0（© Hugging Face，vendored chat-ui）** | 只借教训，不复制；如果复制，避开 `ruvocal` |
| sipyourdrink-ltd/bernstein | Apache-2.0 | 有 `NOTICE`：Apache-2.0 授权**不含项目名称的权利**（见 TRADEMARKS.md） | 改编时带上 NOTICE，不用它的名字 |
| mvschwarz/openrig | Apache-2.0 | 根目录没有 NOTICE 文件 | 改编时保留 Apache 头注释即可 |
| HarnessMD/munder-difflin、W17ant/Claude-Office | MIT | 代码是 MIT；LimeZu 美术（`LICENSE-ASSETS`）和 Dunder Mifflin 皮肤（`NOTICE.md`）**不在 MIT 授权内** | 只引用代码 |
| siteboon/claudecodeui | AGPL-3.0 | — | 只借思路 |

Orca、Paperclip、Gas City 的子目录 license 都查过：Orca 全部 MIT（`cloud/` 也是根目录的 MIT）；Paperclip 另有 6 个子目录 LICENSE，全是 MIT，只是版权人不同；Gas City 只有根目录的 MIT。

---

## C1 · Claude 会话 adapter

### 我们要做什么

daemon 给每个 Claude 角色开一个长驻的 `query()`。输入是我们持有的 Pushable `AsyncIterable<SDKUserMessage>`。adapter 要做这几件事：
- 把 `SDKMessage` 映射成 `events.jsonl` 里的 0.2 事件；
- `canUseTool` / `AskUserQuestion` 进来时写 `request.opened`；
- `command.message` 映射到 `priority: next | later | now`；
- 用 `session_state_changed` 交叉确认 `requires_action`；
- 重启后 `resume`。

对用户自己在终端里开的会话，沿用 hooks（已有 `mas hook claude-code`），只用来观测，审批作为可选功能。

### 首选参考

**`@anthropic-ai/claude-agent-sdk`（TS）· 依赖 · Anthropic Commercial ToS**
- 读：`references/docs/claude__agent-sdk_typescript.md`
  - `SDKUserMessage.priority` / `shouldQuery`：L1741–1780
  - `reinitialize()`：L625、L672
  - `initialize` 响应里的 `pending_permission_requests`（需 Claude Code ≥ 2.1.268）：L886–892
  - `spawnClaudeCodeProcess`：L558、L5439–5480
  - `pathToClaudeCodeExecutable`：L539
- 还要读：`claude__agent-sdk_user-input.md`（`canUseTool` 的回应集合、`AskUserQuestion` 格式），`claude__agent-sdk_permissions.md`（L71、L84、L113–124），`claude__agent-sdk_sessions.md`，`claude__hooks.md`（`PermissionRequest`、`defer`）。
- 改造要点：
  - 子进程环境加 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`。
  - 用 `sessionId` 预先指定 UUID，先写入日志再启动。
  - 可执行文件用 SDK 自带的，或用 `pathToClaudeCodeExecutable` 指向用户本机的 `claude`。两种都算未修改的官方二进制。

**agentclientprotocol/claude-agent-acp · 改编 · Apache-2.0（无 NOTICE 文件）**
- 拿什么：SDK 外面一层成熟的会话状态机，包括回合队列、插话、审批选项、提问表单。
- 文件：
  - `src/acp-agent.ts`。共 15153 行，只按符号读：
    - `turnQueue`：L1066、L4109
    - `STEER_METHOD = "_session/steering"`：L698–701
    - steer 投递与 priority 设置：L4507–4620。这里有"有未决审批时把 `now` 降为 `later`"的逻辑，见 L4584 附近和 L969 的注释。
    - `requestPermission`：L2423–2512
  - `src/permissions/options/shared.ts`：allow-once / always / reject 选项集
  - `src/permissions/{response,normalization,presentation}.ts`
  - `src/elicitation.ts`：`AskUserQuestion` → 表单
  - `src/exit-plan.ts`：计划确认
  - `src/hide-claude-auth.ts`：订阅计费 guard
- 改造要点：
  - 去掉 ACP 翻译层，直接产出我们的 `request.opened` 和 `command.ack`。
  - `updatedInput`（带修改批准）要保留，ACP 映射会丢掉它。
  - 头注释写 `Adapted from agentclientprotocol/claude-agent-acp@47b64c0 <path> (Apache-2.0)`。

**stablyai/orca · 改编 · MIT**
- 拿什么：生产里在用的 `canUseTool` 注册表，以及计划审批的处理。Orca 的"structured chat"模式就是用 Agent SDK（pin 0.3.284）驱动 Claude。
- 文件（都在 `src/main/claude/` 下）：
  - `claude-prompt-registry.ts`：179 行，`ClaudePromptRegistry` 把 `canUseTool` 转成待答条目，返回 `PermissionResult`
  - `claude-plan-approval-mode.ts`
  - `claude-permission-presentation.ts`
  - `claude-stream-json-connection.ts`：`loadClaudeAgentSdk` 在 L37
- 改造要点：把注册表落到我们的事件日志（`requestId` ↔ SDK request id），不要放在内存 Map 里。

### 备选参考

- **slopus/happy · 改编 · MIT**（本地 sparse 只有 `packages/happy-cli/src`、`packages/happy-wire`、`docs`）
  - `packages/happy-cli/src/claude/utils/permissionHandler.ts`（457 行）：
    - L159–190：`AskUserQuestion` 和 `ExitPlanMode` 永不自动批准
    - L344–367：会话取消时把未决请求统一标为 canceled
  - `claude/sdk/query.ts` L57–67：设置 `CLAUDE_CODE_ENTRYPOINT`，让 SDK 会话出现在 `claude --resume` 选择器里
  - `claude/claudeRemote.ts` L131：`resume`
- **Orkas-AI/Orkas · 只借思路（MIT，可改编）**
  - `src/main/features/local_agents/backends/claude.ts`：不经过 SDK，直接说 stream-json control protocol。
    - L374–411、L536–540：`control_request` / `can_use_tool` 分流
    - L772–774：`--permission-prompt-tool stdio`
  - `cli_permissions.ts`：fail-closed 审批桥。
    - L37：超时
    - L102–212：没有 renderer 时 deny，超时 deny，授权只存在内存
  - 如果将来不想依赖 TS SDK，这是自己实现线协议的对照。
- **anthropics/claude-agent-sdk-python · 只读线协议 · MIT**
  - `src/claude_agent_sdk/_internal/query.py`：
    - L351：`initialize`
    - L615–669：`can_use_tool`、`hook_callback`
    - L823–894：`interrupt`、`set_permission_mode`、`stop_task`
  - `_internal/transport/subprocess_cli.py`：CLI 参数拼装
- **W17ant/Claude-Office · 改编 · MIT**（用户自开会话的 hook 审批通道）
  - `hooks/agent-tracker.sh`（1694 行）：`PermissionRequest` hook 长轮询 office；L95 附近注释说 token 不放在 curl 的 argv 里
  - `hooks/install-hooks.sh`
  - 服务端见 C4 的 `server/permissions.js`
- **simple10/agents-observe · 只借思路 · MIT**：`hooks/hooks.json`，以插件形式安装 hooks，不改用户全局 settings。
- **imbue-ai/sculptor · 只借思路 · MIT**：`docs/help/integrated_harnesses.md`。用同名替代工具接管 `AskUserQuestion` / `ExitPlanMode`，待答问题在重启后保留。
- **deepseek-ai/deepseek-harness · 反例 · MIT**：`packages/subagent/subagent-claude-code/src/run.ts` L324–372，`canUseTool` 一律 deny，子任务不可续。

### 坑与注意

1. **`allowedTools` 里只写工具名的条目不会触发 `canUseTool`**（`claude__agent-sdk_permissions.md` L71）。被编译成 allow 的工具永远进不了收件箱。C8 要知道这一点。
2. **我们自己的 `PermissionRequest` hook 不要返回决定。** 它会和 `canUseTool` 竞速，"whichever decides first"。
3. **daemon 进程退出时 CLI 子进程也会退出，未决的 `canUseTool` 随之丢失。** `reinitialize()` / `pending_permission_requests` 只能在**同一个 CLI 进程**里重投递。所以回调必须按 request id 幂等（文档 L672、L888 明确要求）。
4. `--mcp-config`、`--settings`、`--add-dir` 不会随 resume 恢复，每次都要重新传。子 agent 里没有 `AskUserQuestion`。
5. **合规反例，绝不照抄：**
   - Orca 的 `src/main/rate-limits/claude-oauth-credentials.ts` L111–125 读 Keychain 和 `~/.claude/.credentials.json`，再拿 OAuth token 请求 `api.anthropic.com/api/oauth/usage`（`claude-oauth-usage-request.ts` L19）。
   - Paperclip 的 `packages/adapters/claude-local/src/server/claude-config.ts` L268–271 把 `.credentials.json` 拷进远程 config 目录。
   - ruflo 的 `plugins/ruflo-console/scripts/e2e-lib.sh` L38–40 也会复制 `.credentials.json`。
   - 我们查登录状态只用 `claude auth status`；用量只看 SDK 的 `rate_limit_event`。
6. ruflo 设置 `CLAUDE_ENTRYPOINT=worker` 并删掉 `CLAUDE_SESSION_ID`，用来绕过嵌套会话检查（`v3/@claude-flow/cli/src/services/headless-worker-executor.ts` L1413–1421），还把整个 `process.env` 传给子进程。**不要这样做。**
7. Happy 改写 `CLAUDE_CODE_ENTRYPOINT` 是为了让会话出现在 resume 选择器里，不是冒充官方客户端。但要确认取值在官方允许的集合内 *(unverified：文档没列出合法值)*。
8. Orca 把 hooks 写进用户全局的 `~/.claude/settings.json`（`src/main/claude/hook-settings.ts` L54）。我们自己启动的会话用 `--settings` / SDK `hooks` 选项。用户自开的会话要显式安装，并能卸载。

### 必须自研

- `SDKMessage` 到协议 0.2 的映射。`agentId` / `parentId` 用 SDK 的 `agent_id` 和 `parent_tool_use_id`。
- 一个跨重投递保持不变的 `requestId`：重投递时复用已有的收件箱条目，不新建。
- 有未决审批时怎么处理 `delivery: steer`。参考 claude-agent-acp 的降级逻辑，但要在 `command.ack.reason` 里如实说明实际行为。
- **跨 daemon 重启保住会话（需要 spike）**：
  - 用 `spawnClaudeCodeProcess` 把未修改的 `claude` 跑在一个独立的会话宿主里，宿主做法类似 C3 的 agent-office `ptyhost.ts`，只是托管的是 stdio。
  - daemon 重启后重新接上，再 `reinitialize()`，拿回 `pending_permission_requests`。
  - 没有参考实现 *(unverified：SDK 是否支持向已运行的 CLI 重新挂 stdio)*。

---

## C2 · Codex 会话 adapter

### 我们要做什么

daemon 持有一个共享的 `codex app-server --listen unix://<state>/codex.sock`：
- 每个角色对应一个 thread。
- server request（审批、提问、elicitation）变成 `request.opened`；`serverRequest/resolved` 关闭这个条目，不管是谁答的。
- `command.message` 映射到 `turn/steer`、`turn/start` 或 `turn/interrupt`。
- 重启后 `thread/resume`。
- 官方 TUI 可以用 `--remote` 挂到同一个 thread 上。
- 类型在安装时用用户本机版本的 `generate-ts` 生成。

### 首选参考

**openai/codex（app-server）· 依赖二进制 + 生成类型 · Apache-2.0**
- `codex-rs/app-server-protocol/src/protocol/common.rs`：
  - L666：`thread/queue/add`（实验性）
  - L1119：`turn/steer`
  - L1430：`account/rateLimits/read`
  - L1570：`account/read`
  - L1892–1917：server request（`item/commandExecution|fileChange|permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`）
  - L2047：`thread/status/changed`
  - L2108：`serverRequest/resolved`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`：
  - `ThreadStartParams` L62–121：`approvalPolicy`、`approvalsReviewer`、`sandbox`、实验性 `permissions`、`config`、`baseInstructions`、`developerInstructions`、`serviceName`、`ephemeral`
  - `ThreadStatus::Active.activeFlags`：L1729–1746
- 多订阅者与重放：
  - `codex-rs/app-server/src/outgoing_message.rs` L525：`replay_requests_to_connection_for_thread`
  - `codex-rs/app-server/src/request_processors/thread_lifecycle.rs` L1284：调用处
- 文档：`codex-rs/app-server/README.md`（含 managed human command checkpoints）、`codex-rs/app-server-daemon/README.md`、`references/docs/codex__app-server.md`
- 预生成类型：`codex-rs/app-server-protocol/schema/typescript/`（v2 下 685 个文件）。只作阅读对照，运行时用本机生成的。
- 改造要点：
  - `initialize` 时带 `clientInfo.name: "mas_office"` 和 `capabilities.experimentalApi`。
  - 用 `optOutNotificationMethods` 关掉不需要的 delta。
  - 子 agent 的 thread 用 `collabToolCall.newThreadId` 建立层级，并主动 `thread/resume` 订阅。

**agentclientprotocol/codex-acp · 改编 · Apache-2.0（© JetBrains；manifest 写的是 NOASSERTION，原文见上）**
- 拿什么：TypeScript 的 app-server 客户端骨架、审批映射、插话队列、崩溃恢复。
- 文件（都在 `src/` 下）：
  - `CodexJsonRpcConnection.ts`（103 行）、`CodexAppServerClient.ts`
  - `permissions/CodexApprovalHandler.ts`（179 行；L45–130 是决定映射，决定集合不完整时答 `cancel`）
  - `SteeringQueue.ts`（56 行；每会话串行）+ `docs/steering.md`：四种结果 `injected / startedNewTurn / promptRequired / failed`
  - `app-server-recovery/{CodexAppServerSupervisor,CrashLoopGuard,LossAwareConnection,AppServerRecovery,ConnectionLoss,AppServerExit}.ts`
  - `CodexHookConfig.ts`、`CodexEventHandler.ts`
- 类型生成脚本：`package.json` L39 `"generate-types": "… codex app-server generate-ts --out src/app-server"`。
- 改造要点：
  - 删掉 ACP 层。
  - steer 的四种结果直接写成 `command.ack{status, reason}`。
  - supervisor 改为"共享 server + 多 thread"，codex-acp 是一会话一连接。
  - **不要搬** `CodexAuthMethod.ts` / `CodexAccountLogin.ts` 的登录流程：我们只用 `account/read` 查状态，让用户自己运行 `codex login`。

### 备选参考

- **slopus/happy · 改编 · MIT**：`packages/happy-cli/src/codex/codexAppServerClient.ts`（1584 行）。
  - L848：`thread/resume`
  - L1129–1153：`turn/start`，以及"不要中止错误回合"的注释
  - L1396–1460：elicitation / 两类审批，含旧方法名 `execCommandApproval`、`applyPatchApproval` 的兼容
- **stablyai/orca · 改编 · MIT**：
  - `src/main/codex/app-server/codex-app-server-client.ts`（186 行），以及同目录的 `-connection.ts`、`-handshake.ts`
  - `src/main/codex/structured/prompts/codex-prompt-registry.ts`（313 行；L23–26 列出四类 server request）
  - `codex-server-request-disposition.ts`：补充 `item/permissions/requestApproval`
- **deepseek-ai/deepseek-harness · 改编清单 · MIT**：`packages/subagent/subagent-codex/src/wire.ts` L574–626。这是 app-server 会发的所有 server request 的完整处理表，适合当"未知请求不得静默丢弃"的检查清单。
- **Orkas-AI/Orkas · 只借思路**：`backends/codex.ts` L1–27 是最小流程说明；`thread/resume` 失败时回退到 `thread/start`；同一条 stdio 上复用多个 thread，要按 `threadId` 过滤。

### 坑与注意

1. 官方说 app-server "experimental，不支持生产负载"，`experimentalApi` 下的字段随版本变。必须做版本探测，生成类型。
2. `turn/steer` 必须带 `expectedTurnId`；没有活动回合时会失败，这时要回退到 `turn/start`（codex-acp 的 `startedNewTurn` 分支）。
3. 最后一个订阅者离开后，thread 闲置 60 s 卸载（`thread_unload_delay_secs`）。`requiredHumanApproval` 检查点只发给声明了该能力的连接。
4. app-server 进程退出后，未决审批和进行中的回合能否恢复 *(unverified)*。官方 `app-server daemon` 能跨我们重启存活，但 `daemon update` 会中断运行中的回合（daemon README）。
5. **`codex exec` / `@openai/codex-sdk` 没有审批回传。** Paperclip（`packages/adapters/codex-local/src/server/codex-args.ts` L47–73，默认 `--dangerously-bypass-approvals-and-sandbox`，见 `packages/adapters/codex-local/src/index.ts` L20）和 ruflo（`codex exec --sandbox workspace-write`）都走了这条路。我们不走。
6. **不要读 `~/.codex/auth.json`：**
   - Gas City：`internal/api/handler_provider_readiness.go` L425–445 读它来判断登录状态。
   - Orca：`src/main/rate-limits/codex-backend-auth.ts` L73 读它。
   - Paperclip：把 `CODEX_HOME` 的 auth 拷进沙箱，再把刷新后的 token 拷回来。
   - 我们用 `account/read` 和 `account/rateLimits/read`。
7. `ws://` 监听在非回环地址时默认不鉴权，只能用 unix socket 或回环地址加 capability token。

### 必须自研

- 安装时的版本探测和类型生成流程，以及不兼容时的降级提示。
- 一个共享 server 对多个角色 thread 的路由，以及子 thread 的自动订阅。
- server request 到协议 0.2 `request.opened` 的映射，`options` 对齐 ACP 的四种 kind。
- 与 C3 配合：TUI 和 MAS 同时 `turn/start` 时的竞争处理（需 spike）。

---

## C3 · 可观看 / 可接手终端

### 我们要做什么

抽屉里的"原始终端"tab：
- **Codex**：在 PTY 里跑 `codex resume <threadId> --remote unix://…`，和 daemon 共享同一个 thread。
- **Claude**：先展示自绘 transcript。点"接手"后：`interrupt()` → 关闭 query → 在 PTY 里跑 `claude --resume <id>`；交还时退出 TUI，再 `query({resume})`。
- PTY 由一个独立宿主持有，daemon 重启不杀终端，并能恢复 scrollback。

### 首选参考

**AgentSystemLabs/agent-office · 改编 · MIT**
- 拿什么：**独立的 PTY 宿主进程**。office 重启时 Claude 不掉线；宿主保存每个屏幕的 headless 副本，下一个 office 连上来时拿回 scrollback；没人连接时自动退出。
- 文件（都在 `src/server/` 下）：
  - `ptyhost.ts`（252 行）：用 `@lydell/node-pty`、`@xterm/headless`、`@xterm/addon-serialize`；`ORPHAN_MS` 30 分钟，`UNCLAIMED_MS` 30 秒；unix socket 加 token
  - `ptys.ts`（365 行）：宿主协议 `PTY_PROTOCOL`、`SCROLLBACK`
  - `screen.ts`：`screenSnapshot`
  - `history.ts`
  - `workers/terminal.ts`
- 前端：`src/client/ui/terminal.ts`（509 行）。
- 改造要点：
  - 宿主协议加 `sessionId` ↔ agent 的绑定。
  - attach / detach 写进事件日志（`session.attached{by: ui|tui}`）。
  - token 文件权限设为 0600。
- 依赖：`node-pty`（MIT）、`@xterm/xterm` / `@xterm/headless` / `@xterm/addon-serialize`（MIT）。`@lydell/node-pty` 是带预编译二进制的 fork，license 未逐项核对 *(unverified)*。

**slopus/happy · 改编 · MIT**（SDK ↔ TUI 交接）
- 文件（都在 `packages/happy-cli/src/claude/` 下）：
  - `loop.ts`（117 行）：local / remote 两种模式的主循环
  - `claudeLocal.ts`（431 行）：`stdio: inherit` 跑 `claude`，带 `--session-id` / `--resume`，再注入一个带 `SessionStart` hook 的 `--settings` 拿到 session id
  - `utils/generateHookSettings.ts`（69 行）
  - `claudeLocalLauncher.ts`：tail JSONL，把 transcript 同步出去
  - `claudeRemote.ts`：远程模式用 SDK `resume`
- 改造要点：把"按两次空格切换"换成抽屉里的"接手 / 交还"按钮。同一时刻只有一方持有会话，这个约束要在 UI 上写明。

### 备选参考

- **stablyai/orca · 改编 · MIT**（规模大，挑着读）：
  - 独立 PTY daemon：`src/main/daemon/` 下的 `daemon-entry.ts`、`pty-subprocess/native-pty-spawn.ts`（用原版 node-pty）、`emulation/headless-emulator.ts`（362 行）
  - scrollback：`src/main/pty/scrollback/terminal-scrollback-snapshots.ts`
  - 前端重连：`src/renderer/src/components/terminal-pane/pty-connection/reattach/`
  - `src/shared/agent-launch/startup/agent-resume-argv.ts` L93–100：`claude --resume <id> --fork-session` / `codex fork <id>`。注释写着 "chat and terminal cannot write the same one"，**fork 是另一种安全的"旁观"做法**。
  - `src/main/native-chat/structured-agent-session-history-adoption.ts`：结构化聊天接管终端会话的历史
- **HarnessMD/munder-difflin · 改编 · MIT（美术除外）**：`src/main/pty.ts`（844 行）。重点是 Windows 下 `.cmd` shim 的处理（L110–200、L450）和 `ptyEnv.ts`。
- **johannesjo/parallel-code · 改编 · MIT**：
  - `electron/ipc/pty.ts`
  - `src/lib/terminalFitManager.ts`
  - `src/lib/terminalQueries.ts` + `electron/ipc/terminal-query-responder.ts`：应答终端查询序列，headless 时 TUI 不会卡住
- **anomalyco/opencode · 只借思路 · MIT**：`packages/server/src/handlers/persistent-pty.ts`（276 行），持久 PTY 加一次性 ticket 鉴权的 WebSocket。
- **openai/codex · 依赖**：`codex-rs/cli/src/main.rs` 的 `ResumeCommand.remote`；官方 TUI 直接挂到共享 app-server 上。
- **siteboon/claudecodeui · 只借思路 · AGPL-3.0**：`server/modules/websocket/services/shell-websocket.service.ts`。它的终端和 SDK 聊天是两个进程，同时操作会冲突，这是要避免的做法。
- **coder/agentapi · 反例 · MIT**：`lib/httpapi/claude.go` L8–12。bracketed paste 的 ESC 会取消 Claude 的选择框；PTY 抓屏只适合显示，不适合控制。

### 坑与注意

1. 同一个 Claude session 被 SDK 和 TUI 同时打开时会怎样，官方没写 *(unverified)*。只用"严格交替"（Happy）或"fork 旁观"（Orca）两种方式。
2. 往 TUI 里自动打字要用 OpenRig 的 typing guard（见 C4）：**永远不在用户的草稿上打字**。
3. resume 不恢复 `--settings` / `--mcp-config`。交还给 SDK 时要按角色配置重新传入，否则权限编译（C8）会失效。
4. TUI 在 headless 宿主里会发终端查询序列（DA、光标位置），没人应答时可能卡住。参考 parallel-code 的 responder。
5. node-pty 是 native 模块，安装可能失败。agent-office 用预编译 fork，Orca 用原版。需要做安装期检测。

### 必须自研

- 交接状态机：`sdk → interrupting → tui → handing-back → sdk`，以及每一步对应的事件和失败回滚。
- TUI 期间的事件来源切换：从 SDK 切到 hooks，再在 reducer 里合并成同一个 agent。
- channels permission relay 的 spike：TUI 常驻 PTY，审批在 UI 里并行应答。这条路没有参考实现。

---

## C4 · 卡住检测与待决交互模型

### 我们要做什么

- 把"需要人"建模成 `{count, reason}` 加一组带 id 的 `PendingInteraction`，和 working / idle 正交。
- 证据按优先级仲裁：结构化通道（`canUseTool`、server request）> 官方状态（`requires_action`、`activeFlags`）> hooks > 屏幕解析 / 窗口活动。
- 每个请求只能被回答一次。在别处（TUI、手机、CEO）回答时，收件箱收到 `resolved_elsewhere`。

### 首选参考

**gastownhall/gascity · 改编 · MIT**
- 数据形状：
  - `internal/runtime/runtime.go` L632–661：`PendingInteraction{request_id, kind, prompt, options, metadata}`、`InteractionResponse{request_id, action, text, metadata}`、`InteractionProvider{Pending, Respond}`
  - 错误值在 L32–65；过期请求的错误 `ErrInteractionGone` 在 `internal/runtime/interaction_fence.go` L11
- 结构化 provider 模板：`internal/runtime/acp/permission.go`
  - L211：`holdPermission` 先挂起请求，不立即回复
  - L79–92：id 格式为 `acp-<连接 nonce>-<原始 JSON-RPC id>`，防止旧答案落到重启后的新请求上
  - L39–44：`approve→allow_once`、`approve_always→allow_always`、`deny→reject_once`
  - L474：`Pending`
- 边沿触发事件：`internal/pendingwatch/pendingwatch.go`
  - L328–356：`apply`，状态变化时才发 `session.pending` / `session.pending_cleared`；request id 变了就发 "replaced"
  - L358–382：发布失败时不改内存状态，下一轮重试
  - L394–420、L459：`Rebuild` / `RebuildFrom`，按 seq 回放日志重建
- API：`internal/api/handler_session_interaction.go`
  - L32–76：发消息，带 `Idempotency-Key`
  - L125–216：列出待决、按 `request_id` 回答
  - 不匹配时返回 409 `invalid_interaction`（`internal/worker/runtime_handle.go` L599–605）
- 自报状态需和截屏交叉验证：`internal/runtime/program_status.go` L14–30（OSC 7501 `blocked{permission|question|auth}`，有 off / shadow / on 三种模式）、`program_status_pending.go`
- 屏幕解析兜底，只在用户自开的 TUI 上用：`internal/runtime/tmux/interaction.go`
  - L116–127：正则
  - L560–612：按**选项文字**匹配，不按位置
  - L627：读不准时只允许 deny
  - L691：hash id
  - L993–1085：回答前先重读屏幕
  - 同目录 `testdata/` 有 Claude Code 2.1.287–289 的 27 份真实截屏和 Codex 0.162.1 的 2 份
- "需要你"的排序：`internal/api/dashboardspa/web/shared/src/agents/needsYou.ts`，`selectAgentsNeedingYou` 在 L58
- 改造要点：
  - Go → TS 基本可以一一对应移植。
  - `kind` 扩成我们的四类：`approval | input | choice | confirmation`，再加 checker 举旗和阶段 gate。
  - `request.opened` / `request.resolved` 写进 `events.jsonl`。

**mvschwarz/openrig · 改编 · Apache-2.0（无 NOTICE 文件）**
- 证据阶梯：`packages/daemon/src/domain/activity-taxonomy.ts`（265 行）
  - L52：`NeedsInput`
  - L65：`deriveDisplayActivity`，needs-input 的证据压过 working
  - L82–88：`EVIDENCE_RUNG_RANK`
  - L94：`RungTrust`，取值 authoritative / trial / identity-only / positive-only / absent
  - L163–176：`ArbitratedSeatState`，"由哪一级证据决定的"直接可见
  - L184–210：各运行时的证据级别清单
- 仲裁：`domain/node-inventory.ts` L1278，`arbitratedNeedsInputSignal`
- typing guard：`domain/seat-delivery-guard.ts`（609 行）
  - L51–56：模式
  - L116：`SeatDeliveryGuard`
  - L416–492：检测到人正在输入就停止自动输入
- 设计文档：`docs/reference/agent-state-taxonomy.md`、`docs/reference/seat-delivery.md`
- 改造要点：
  - 我们的证据级别是 `structured-channel > official-state > hooks > screen`。结构化通道是我们自己持有的，可信度最高。
  - 保留"unknown 是一等值"和"新证据源先 trial 再升级为权威"。

**paperclipai/paperclip · 改编机制 · MIT**（"一次回答只续跑一次"）
- 数据表：
  - `packages/db/src/schema/issue_thread_interactions.ts` L16–82，其中 L75–77 是 `(companyId, issueId, idempotencyKey)` 唯一索引
  - `packages/db/src/schema/issue_question_response_deliveries.ts` L23–65：outbox 表，`interactionId` / `correlationId` 唯一，带 `payloadSha256`，`attemptCount` 当 claim 代数
- 回答流程：`server/src/services/issue-thread-interactions.ts`
  - `answerQuestions` L5520 起：事务内 `FOR UPDATE`，条件更新 `status='pending'`，没更新到就报已解决（`interactionAlreadyResolvedError` 在 L840）
  - `resolveInteractionPolicy` 约 L430–470：audience 取值 `anyone | not_creator | human_only`
- 投递：`server/src/services/question-response-delivery.ts` L763，结果分 `steered | coalesced | wake_fallback`
- 路由：`server/src/routes/issues.ts` L18222–18304
- 类型：`packages/shared/src/constants.ts` L273–280 是交互类型，L702–716 是治理审批类型和状态
- 改造要点：没有 Postgres 时，在事件日志里用"首个 `request.resolved` 生效，后到的写 `command.ack{status: rejected, reason: already_resolved}`"实现同样的语义。audience 规则对应 `routeTo` 和 CEO 白名单。

**W17ant/Claude-Office · 改编 · MIT**
- `server/permissions.js`（360 行）：
  - L81：状态 `pending | allowed | denied | resolved_elsewhere | expired`
  - L141：`createPermissionStore`
  - L226–230：重复决定返回 409
  - L239–244：`resolveSession`，在终端里答了就标 `resolved_elsewhere`
  - L254：`markInteractive`，看到 Notification 就延长等待
  - L274：`waitFor`，长轮询
  - L131：`redactPermission`，没权限的人看不到细节
- 改造要点：存储从内存改为事件日志；长轮询只用于 hook 通道。

### 备选参考

- **johannesjo/parallel-code · 只借思路 · MIT**：`electron/agent-hooks/status.ts` L6–40。线上状态只有 `working | waiting | done` 三种，`waiting` 带 `prompt: permission|question`；idle 只从 done 或证据过期推出。
- **Orkas-AI/Orkas**：`cli_permissions.ts` 的 fail-closed 超时（10 分钟后 deny）。
- **langchain-ai/langgraph · 只借思路 · MIT**：`libs/prebuilt/langgraph/prebuilt/interrupt.py` L11，`HumanInterruptConfig`（accept / edit / respond / ignore）。
- **imbue-ai/sculptor**：待答问题在重启后保留（见 C1）。
- **coder/agentapi · 反例**：靠"屏幕 2 s 不变"判断，分不清"等审批"和"已完成"。

### 坑与注意

1. hook 的 `Notification` 有延迟：`permission_prompt` 约 6 s，`idle_prompt` 约 60 s。只能当提醒，不能当状态（02 笔记）。
2. 屏幕解析和版本绑定。Gas City 为每个 CLI 版本维护截屏 testdata；我们只在用户自开的 TUI 上用它兜底。
3. 用 hash 生成的 id 在"同一个对话框出现两次"时会重复。回答时必须带 `request_id` 并重新校验（Gas City `respond` 的做法）。
4. Gas City 在有待决交互时拒绝 nudge（`ErrNudgeRefusedPendingInteraction`）。我们的设计允许"一边审批一边追问"，但这只适用于结构化通道；**对 TUI 仍然不能打字**。
5. 超时策略要显式。Orkas 10 分钟后 deny；W17ant 跟随 hook 默认的 600 s。这些超时值要进入请求的 `expiresAt`，界面上显示"不回答会怎样"。

### 必须自研

- 四类请求（工具审批、决策、checker 举旗、阶段 gate）的统一模型，加上等待计时和"不回答的后果"。
- `routeTo: lead` 的 CEO 代答白名单和审计（见 C7）。
- 跨 daemon 重启的处理：已失效的请求标为 `expired`，并提示可以重新派发。

---

## C5 · 协议 0.2

### 我们要做什么

全部是加法：
- 在同一条 `events.jsonl` 里新增 `request.*`、`command.*`、`command.ack`、`agent.stopped`、`task.*`；
- 新增 `mas/inbox` 快照；
- 不新增 state 值。

JSON Schema、JS 和 Python 两套 reducer、conformance case 都要更新；迁移期双发 0.1 的 `flag.*`。设计草案见 `docs/research/landscape/05-protocols-hci.md` §A.4。

### 首选参考（只借词汇，不绑字段名）

- **ag-ui-protocol/ag-ui · MIT**
  - `docs/spec/1.0/basic/patterns/interrupt-resume.mdx`：resume 幂等，cancelled ≠ failed
  - `docs/spec/1.0/events/lifecycle.mdx`
  - `docs/concepts/interrupts.mdx`
  - 类型定义：`sdks/typescript/packages/core/src/generated/types.ts`，`Interrupt` 在 L1718，`interruptId` 在 L1554
  - 用途：`request.opened` 的字段集合（`reason`、`toolCallId`、`responseSchema`、`expiresAt`），以及 AG-UI 导出映射
- **agentclientprotocol/agent-client-protocol · Apache-2.0**
  - `schema/v1/schema.json`：`$defs` 里的 `PermissionOption`、`SessionUpdate`
  - `schema/v1/meta.json`
  - `docs/protocol/v1/{tool-calls,cancellation,elicitation,prompt-turn,session-setup}.mdx`
  - `docs/protocol/v2/prompt-lifecycle.mdx`：`running | requires_action | idle`
  - `docs/rfds/v2/permission-requests.mdx`：`subject.type` 遇到未知值要原样保存
  - `docs/rfds/v2/background-work.mdx`、`docs/rfds/subagents.mdx`：取消父级只级联到它在等的子级
  - 用途：`options[].kind` 词表，以及"接受停止命令 ≠ 已停止"的规则
- **openai/codex · Apache-2.0**：v2 的 thread / turn / item 三层，加上 `item/completed` 是权威态、`serverRequest/resolved` 标明谁答了（见 C2 的文件）。

### 备选参考

- **anomalyco/opencode · MIT**：
  - `packages/protocol/src/groups/permission.ts` L142：`reply{decision: once|always|reject}`
  - `packages/protocol/src/groups/session.ts` L325–570：持久化 inbox，`delivery: steer|queue`
  - `packages/protocol/src/groups/event.ts` L55–75：SSE 被明确声明为 "volatile"，断线后用列表接口重同步。这是反面参照：我们要用 seq 续传。
- **a2aproject/A2A · Apache-2.0**：`specification/a2a.proto`，`TaskState` 约在 L187–219，含 `INPUT_REQUIRED` / `AUTH_REQUIRED` 和逐级上抛。
- **modelcontextprotocol/modelcontextprotocol · MIT / Apache-2.0 混合（见 License 核对）**：`references/docs/mcp__2026-07-28-elicitation.md`、`mcp__2026-07-28-mrtr.md`，elicitation 的 accept / decline / cancel 三动作。
- **earendil-works/pi · MIT**：`packages/coding-agent/docs/rpc.md`、`docs/json.md`、`src/modes/rpc/rpc-types.ts`。`steer` / `follow_up` 双队列，`queue_update`、`agent_settled` 事件。
- **gastownhall/gascity**：`internal/events/events.go` L358–359，`session.pending` / `session.pending_cleared` 的命名。
- **open-telemetry/semantic-conventions-genai · Apache-2.0**：只作导出目标（`gen_ai.execute_tool.transfer`）。

### 坑与注意

1. 0.1 reducer 会丢弃 state 不在 7 个值内的 `agent.status`，所以 0.2 不能新增 state 值。
2. 不要照搬 AG-UI 的两条规则："run 以 interrupt 结束"，以及"有未决 interrupt 时阻塞新输入"。前者不适合长活会话，后者和"一边审批一边追问"冲突。
3. ACP v2 和 subagents RFD 还是 Draft / Active，只借语义。
4. `origin.kind: "human"` 只能由 `serve` 根据 UI 会话 token 写入，防止 agent（包括 CEO）冒充人批准自己的请求。
5. 新的终态必须配合 0.1 能识别的 `agent.status` 一起发，否则老 consumer 会当成成功（AG-UI 的教训）。

### 必须自研

全部：0.2 JSON Schema（`spec/schemas/`）、RFC（`spec/rfcs/`）、JS reducer（`packages/node/src/sdk/reducer.js`）和 Python reducer、conformance case（`spec/conformance/`）、`mas/inbox` 快照、AG-UI / A2A / ACP / OTel 导出映射。

---

## C6 · Daemon / server

### 我们要做什么

在现有 `mas-office serve`（`packages/node/src/cli/server.js`，346 行，L282 已有 SSE）基础上扩展：
- `events.jsonl` 是唯一事实来源，命令也写进日志；
- `POST /v0/commands` → 命令路由 → adapter → `command.ack`；
- SSE 按 seq 续传；
- 重启后对账：resume 会话，标记失效的请求；
- 默认小并发上限，显示用量。

### 首选参考

**gastownhall/gascity · 改编 · MIT**
- `internal/events/`：
  - `recorder.go` L41、L276：`O_APPEND` 加文件锁，追加写 JSONL
  - `rotation.go`：按大小滚动
  - `events.go` L758–772：`Event{seq, type, ts, actor, subject, payload, session_id}`
  - `events.go` L780：`RecordAck`，告诉调用方是否已落盘
  - `events.go` L801：`Provider{List, LatestSeq, Watch(afterSeq)}`。Watch 是 at-least-once，调用方按 seq 去重
  - `stream_cursor.go`
- SSE：`internal/api/sse.go` L175 支持 `Last-Event-ID`；路由在 `supervisor_city_routes.go` L548（`GET /events/stream`）。
- 改造要点：我们是单进程 Node，用同步 `appendFileSync` 加进程内 seq 就够了。保留"写盘成功才广播"和 `Last-Event-ID` 续传。

**Orkas-AI/Orkas · 改编 · MIT**
- `src/main/features/local_agents/persist.ts`：L84 是 `events.jsonl` 路径；L99 起是追加写，注释说明为什么故意用同步 fs。
- `runner.ts` L12：所有后端事件都先过持久化层。
- 改造要点：和我们 0.1 的思路一致，直接对照。

### 备选参考

- **paperclipai/paperclip · 只借思路 · MIT**（Postgres 方案，不能直接用）：
  - 抢任务防重：`server/src/services/issues.ts` 约 L12324 的 `checkout` compare-and-set；字段在 `packages/db/src/schema/issues.ts` L56–59
  - 并发上限：`packages/shared/src/constants.ts` L78（`maxConcurrentRuns`，默认 20），执行在 `server/src/services/heartbeat/queue.ts` L1984–1989
  - 预算：`server/src/services/budgets.ts`，L97 超限 `hard_stop`，L595 生成 `budget_override_required` 审批
- **ruvnet/ruflo · 只借教训 · MIT（`ruflo/src/ruvocal` 是 Apache-2.0）**：
  - `v3/@claude-flow/cli/src/services/worker-daemon.ts` L210–221：后台 daemon "leaked tens of thousands of headless `claude --print` sweeps over many days"。之后加了默认 12 h TTL 和 30 min 空闲自停。
  - `services/global-ai-budget.ts` L20–47：用户级启动预算账本，排他锁，默认全局并发 1、每小时 2 次、每天 12 次，遇到 429 熔断 60 min。
  - `worker-daemon.ts` L241 的 `readUserAiWorkersOptIn`（L367 调用）：只读用户级配置，项目配置不能打开自动启动。
- **mvschwarz/openrig · 只借思路 · Apache-2.0**：`ARCHITECTURE.md`（Hono + SQLite daemon）、`packages/daemon/src/routes/activity.ts` L893（SSE 推送）、`packages/daemon/src/db/migrations/`。
- **AgentSystemLabs/agent-office · 改编 · MIT**：`src/server/limits.ts`（166 行）、`queue.ts`（428 行）；PTY 宿主见 C3。
- **anomalyco/opencode**：持久化 session inbox（`session.ts` L540–570）。
- **worktree（代码任务阶段才需要）**：
  - Orca（MIT）：`src/main/git/worktrees/removal/worktree-removal-preflight.ts`，脏工作区拒绝删除；`worktree-branch-removal.ts` L18，用 `-d` 不强删分支；`worktree-delete-limit.ts`、`worktree-prune-guard.ts`
  - OMC（MIT）：`docs/TEAM-WORKTREE-MODE.md`、`src/team/merge-coordinator.ts`，合并失败一律 abort

### 坑与注意

1. SSE 断线期间丢事件（opencode 明说 volatile）。用 seq 加 `Last-Event-ID` 续传，消费端按 seq 去重。
2. 命令必须**先写日志再路由**；reducer 只根据 adapter 回报的事实改状态。
3. 并发上限按进程算会被 worktree 数放大（ruflo #2661）。上限要放在用户级，并用原子锁保护。
4. 被忘掉的 daemon 会无限烧额度。需要 TTL、空闲自停、"没有 UI 连接时不自动启动新回合"。
5. 本地 HTTP 只绑回环地址，并带 token（agent-office 的 socket token、opencode 的 ticket）。

### 必须自研

- 命令路由和 `command.ack` 状态机。
- 重启对账：重新挂上 Codex 共享 server，`thread/resume`；重开 Claude `query({resume})`；未决请求标 `expired`。
- 用户级并发和预算闸门（默认小值，参照 ruflo 账本重新实现）。
- `mas/inbox` 快照的增量维护。

---

## C7 · CEO / 协调者

### 我们要做什么

- CEO 本身是一个 Claude 或 Codex 会话，不轮询：daemon 在"worker 完成 / 举手 / 停滞 / checker 举旗"时唤醒它，并给它一份**过滤后的规范化事件**（`agent.status`、`request.*`、`task.*`、`result`，不给 `tool.*` 正文）。
- CEO 每轮写 `lead.ledger`；停滞时重新规划。
- 在 allow-list 内代为批准，其余上报给人。
- 消息有 hop 上限；派活对象用 Run / Task / Dispatch / Gate。

### 首选参考

**stablyai/orca（orchestration）· 改编数据结构 · MIT**
- 对象与状态（都在 `src/main/runtime/orchestration/db/` 下）：
  - `orchestration-records.ts` L3–42：`MESSAGE_TYPES`（status / dispatch / worker_done / merge_ready / escalation / handoff / decision_gate / question / heartbeat）、`TaskStatus`、`DispatchStatus`（含 `circuit_broken`）、`GateStatus`、`CoordinatorStatus`；行类型到 L350
  - `lifecycle-transition.ts` L67：`LEGAL_TRANSITIONS`
  - `tasks/task-status-transition.ts`：supervised worker 还活着时不能把任务标为完成或失败
  - schema：`schema/create-core-tables-sql.ts`、`schema/create-graph-tables-sql.ts`
- 防循环：
  - `db/dispatch-context/dispatch-circuit-breaker.ts`：`DISPATCH_CIRCUIT_BREAK_FAILURES = 3`
  - `src/shared/nested-worker-depth.ts`：嵌套深度上限 4
- `worker_done` 准入：`src/main/runtime/rpc/methods/orchestration/messaging/send-point-to-point.ts` L113–175，拒绝原因有 `sender_not_assignee`、`task_dispatch_mismatch`、`dispatch_inactive`。
- heartbeat 写入时就标为已处理，不会唤醒任何人：`db/messages/message-insert.ts`。
- 唤醒：
  - 对终端里的 agent，`mailbox/terminal-pointer/mailbox-pointer-delivery.ts` 只往 PTY 打一行短指针（文案见 `mailbox/formatting/message-formatting.ts` L126 的 `formatMessagePointer`），并且只在 `mailbox/routing/mailbox-owner.ts` L20 的 `isMailboxTerminalTakingInput` 为真时才打。
  - 对结构化会话，用 `mailbox/structured-pointer/structured-mailbox-pointer-delivery.ts`（347 行）。
- Decision gate：`coordinator/decision-gates/coordinator-decision-gates.ts`、`db/decision-gates/decision-gate-store.ts`。
- 规范文档：`docs/site/content/docs/cli/orchestration.mdx`。
- 改造要点：
  - 表结构改成我们的 `task.*` 事件加 reducer 快照。
  - 唤醒走 C1 / C2 的结构化 `command.message{delivery: queue}`，不往 PTY 打字。
  - **Orca 自己的 coordinator 是 2 s 轮询循环**（`coordinator/coordinator.ts` L34 `DEFAULT_POLL_MS`），我们不照搬这部分。

**microsoft/agent-framework（Magentic）· 只借 schema · MIT**
- `python/packages/orchestrations/agent_framework_orchestrations/_magentic.py`：
  - L223–290：ledger prompt
  - L292–335：`MagenticProgressLedger`，五个字段（`is_request_satisfied`、`is_in_loop`、`is_progress_being_made`、`next_speaker`、`instruction_or_question`），每个都是 reason + answer
  - L492：`max_stall_count=3`
  - L1153–1158：停滞计数超限就 replan
  - L1171：`next_speaker` 不在成员名单里就拒绝
  - L822–824：事件 `plan_created` / `replanned` / `progress_ledger_updated`
  - L1568：`with_plan_review`
- 改造要点：ledger 是 CEO 每轮必须输出的结构化结果（Claude 用 SDK 的结构化输出，Codex 用 `outputSchema` *(unverified：字段名)*），写成 `lead.ledger` 事件。停滞计数由 daemon 根据事件计算，不信任 CEO 的自评。

### 备选参考

- **paperclipai/paperclip · 只借思路 · MIT**：
  - 唤醒合并：`server/src/modules/wake-queue/domain/policy.ts`，`decideWakeAdmission` L44 / `decidePreDrain` L94 / `decideWakeOutcome` L185
  - 入队：`server/src/services/heartbeat/queue.ts` L2154 `enqueueWakeup`；合并计数 `coalescedCount` 在 `execution-wait.ts` L40
  - 静默检测：`server/src/modules/active-run-watchdog/domain/policy.ts`，阈值在 `recovery/service.ts` L209–210（5 / 15 min）
  - 唤醒原因注入环境变量：`packages/adapters/claude-local/src/server/execute.ts` L226–317（`PAPERCLIP_WAKE_REASON` 等）
- **HarnessMD/munder-difflin · 改编 · MIT**：
  - `HIVE.md` L100–120：FIPA-lite 消息，`hops` 上限、`requires_reply`、`needs_human`；L202–203 是风险表
  - `src/main/hooks.ts` L494–577：撤掉 Stop-hook 自动续跑的原因（"bypassed … HITL safety and could spend credits"），以及用 `additionalContext` 引导
  - `src/main/workerWake.ts`：只在空闲时投递
  - `src/main/breaker.ts` L1–44：steer → constrain → stop 的熔断阶梯
- **gastownhall/gascity · 改编 · MIT**：持久化 nudge 队列 `internal/nudgequeue/state.go` L40（lease / attempts / dead-letter），由 `UserPromptSubmit` hook 投递（`internal/hooks/config/claude.json`、`cmd/gc/cmd_nudge.go` L765–1004）。
- **gastownhall/gastown · 只借思路 · MIT**：`docs/design/escalation.md`（按严重度逐级上报，4 h 无人处理自动再上报）、`docs/design/mail-protocol.md`。
- **agno-agi/agno · 只借 schema · Apache-2.0**：`libs/agno/agno/company/declarations.py` L24–46，`AutoAccept{required_checks, limits{max_acceptances, expires_at}, work_scope}`。这是"有限额、会过期的代理批准"的现成形状。
- **Orkas-AI/Orkas**：`src/main/features/group_chat/bus.ts`，`dispatch_to` 派活契约（L681 附近，`message` 要写执行契约，`resume` 写追问后接着做什么）；`ConversationScheduler`（文件头 L14–20）。文件约 1.2 万行，只读这些片段。
- **crewAIInc/crewAI · 只借思路 · MIT**：`lib/crewai/src/crewai/crew.py` L1533–1548，"Manager agent should not have tools"。
- **langchain-ai/open_deep_research · 只借思路 · MIT**：`src/open_deep_research/deep_researcher.py` L291–292，超出并发上限的派活调用直接回错误。
- **camel-ai/camel · 只借 schema · Apache-2.0**：`camel/societies/workforce/utils.py`，L211 `RecoveryStrategy`、L351 `TaskAnalysisResult`。
- **asheshgoplani/agent-deck · 只借思路 · MIT**：`README.md` L613 的 Conductor（"有把握就回复，没把握就上报"）、`internal/session/conductor_recovery.go`。
- **ruvnet/ruflo · 反例**：hive-mind / queen / Raft 代码（`v3/@claude-flow/swarm/src/consensus/`）**没有被 CLI 引用**，实际协调是 LLM 调 MCP 工具（`cli/mcp-tools/hive-mind-tools.ts`）。成本泄漏的教训见 C6。

### 坑与注意

1. Stop-hook 自动续跑会绕过 HITL，还会在人回答问题时继续花钱（munder-difflin 已撤掉）。CEO 唤醒只走"回合边界投递"。
2. heartbeat 当作消息会不停唤醒 CEO。写入时就标为已处理（Orca 的做法）。
3. agent 之间来回对话会形成循环。需要 hop 上限（munder-difflin）、派活失败 3 次熔断、嵌套深度上限（Orca）。
4. Magentic 的 `is_request_satisfied` 是经理自评，我们不当真。完成与否由 checker 和 gate 决定。
5. CEO 代为批准必须带 `origin: agent(lead)`，写进收件箱历史，并受 allow-list（kind × subject.type × 角色）约束。代批权限不能跨角色继承（OpenAI Agents SDK 文档警告过 sticky approve 会串）。

### 必须自研

- 给 CEO 的过滤事件流和摘要（`say` 一行）。没有任何参考项目这么做。
- 代理批准的策略引擎：allow-list、限额、过期、审计、上报给人。
- daemon 侧的停滞检测：基于事件的"无进展计数"，加上 Paperclip 式的静默阈值。
- CEO 唤醒合并：同一回合内多个事件合并成一次唤醒。

---

## C8 · 组织设计与权限编译器

### 我们要做什么

把用户设计并锁定的 team design v2（角色、阶段、`backend`、逐工具 allow / ask / deny、`reviewerOf`、`gates`、结构签名）编译成：
- **Claude**：SDK `query()` 的 `tools` / `allowedTools` / `disallowedTools` / `permissionMode` / `agents` / `systemPrompt` / `settingSources`，或等价的 `--settings`；
- **Codex**：`thread/start` 的 `approvalPolicy` / `sandbox` / `permissions` / `config` / `developerInstructions`。

`ask` 规则落到 C4 的收件箱。之后要能导入 / 导出 Paperclip 等格式。

### 首选参考

**官方权限参数（编译目标）· 依赖**
- Claude：
  - `references/docs/claude__cli-reference.md`：L68 `--allowedTools` 是"免询问"，不是限制；L88 `--disallowedTools` 的裸工具名会把工具从上下文移除；L139 `--tools` 才是限制可用工具；L126 `--restricted`
  - `claude__agent-sdk_permissions.md` L84–124：锁定型 agent 用 `allowedTools` + `permissionMode: "dontAsk"`
  - `claude__agent-sdk_subagents.md`（`agents` 选项与 `.claude/agents`）、`claude__permission-modes.md`
- Codex：
  - `ThreadStartParams`（`v2/thread.rs` L62–121，见 C2）
  - `references/docs/codex__permission-modes.md`、`codex__agent-configuration_subagents.md`（子 agent 继承 sandbox）、`codex__agent-approvals-security.md`

**mvschwarz/openrig · 改编 · Apache-2.0**
- `docs/reference/rig-spec.md`：
  - L172–237：`permission_policy` 内置档（`builtin:locked|standard|open|yolo|auto`）和自定义策略文件
  - L239–291：逐成员 `claude_permissions{allow, deny}`。这些规则合进**一个** `--settings`，**从不写共享项目的 Claude settings**；无效记录直接拒绝启动
  - L293–332：逐成员 `codex_permissions{sandbox, approval, network_access, writable_roots}`，每次启动和 resume 都显式输出为 `-s` / `-a` 加 `sandbox_workspace_write.*`
- 源码：
  - `packages/daemon/src/domain/rigspec-schema.ts`
  - `domain/permission-policy/{policy-spec,policy-ref}.ts`
  - `domain/native-permission-store.ts`
  - `adapters/claude-code-adapter.ts`：L411–434 拼启动参数；L1124–1127 的注释说明旧版写 `~/.claude/settings.json` 已被移除
- 改造要点：
  - 我们走 SDK / app-server，不是 CLI 参数。所以编译产物是 `query()` options 和 `thread/start` params。
  - 保留几条原则：每次 resume 都重新下发、无效即拒绝启动、不碰共享 settings。

**paperclipai/paperclip（`agentcompanies/v1`）· 改编解析器 / 只借格式 · MIT**
- 规范：`docs/companies/companies-spec.md`。
- 解析：`packages/teams-catalog/src/{frontmatter,catalog-builder,types}.ts`。
- 示例：`packages/teams-catalog/catalog/bundled/software-development/product-engineering/TEAM.md`。
  - TEAM.md 的 frontmatter：`schema: agentcompanies/v1`、`manager`、`includes`、`requiredSkills`
  - AGENTS.md 的 frontmatter：`role`、`reportsTo`、`skills`
- **权限不在 AGENTS.md 里**，在旁边的 `.paperclip.yaml`（`schema: paperclip/v1`，有 `permissions`、`permissionGrants`、`budgetMonthlyCents`；键列表在 `server/src/services/company-portability.ts` L2425–2440）。
- 导入 / 导出：同一文件 L3879 `exportBundle`、L5249 `previewImport`、L5257 `importBundle`。
- 改造要点：作为"导入格式"之一，映射到我们的 Markdown 结构，权限字段单独处理。

### 备选参考

- **sipyourdrink-ltd/bernstein · 改编 · Apache-2.0（带 NOTICE）**：
  - `src/bernstein/core/security/claude_permission_profiles.py`（236 行）：L32 `PermissionProfile{allowed_tools, disallowed_tools, deny_patterns, allow_patterns}`，内置 deny 模式 `*.env`、`*.pem`、`**/secrets/**`；L136 `PermissionProfileManager`
  - `src/bernstein/adapters/claude.py`：L312–317 角色到工具的表；L478–525 拼命令行（`--allowedTools`、`--json-schema`、`--max-budget-usd`）
  - `templates/roles/*/config.yaml`
- **OpenBMB/ChatDev · 只借 schema · Apache-2.0**：
  - `yaml_instance/demo_human.yaml`
  - `yaml_instance/GameDev_with_manager.yaml` L743–830：边上的 `carry_data` / `clear_context` / `condition`
  - `docs/user_guide/en/nodes/agent.md`、`docs/user_guide/en/config_schema_contract.md`
- **microsoft/agent-framework · 只借 schema · MIT**：`declarative-agents/agent-samples/foundry/MicrosoftLearnAgent.yaml`（L18 起是 `approvalMode` + `allowedTools`）、`declarative-agents/workflow-samples/DeepResearch.yaml`。
- **eigent-ai/eigent · 只借思路 · Apache-2.0**：`backend/app/permission_policy/models.py`（L613 profile、L616 `PolicyEffect`）、`engine.py`，四档 profile 和 allow / prompt / deny 三种效果。
- **gastownhall/gascity · 改编 · MIT**：`internal/reviewquorum/types.go`（L20–28 verdict，L32–36 `LaneConfig{id, provider, model}`）、`finalize.go`。`reviewerOf` 加跨厂商 lane 的数据结构。注意：Gas City **没有**逐 agent 的工具白名单；`internal/config/provider.go` L153–159 的 `PermissionModes` 注释写明运行时还没读取它。

### 坑与注意

1. **`--allowedTools` / `allowedTools` 不限制工具，只是免询问。** 限制要用 `tools`（或 `--tools`）加 `disallowedTools`，锁定型角色再加 `permissionMode: "dontAsk"`。Bernstein 把 `bypassPermissions` 和 `--allowedTools` 一起用（`adapters/claude.py` L485–501）。在 bypass 模式下 allow 不约束任何东西，**它的"角色限权"实际上不起作用**；OpenRig 文档 L276–277 也写了这一点。
2. 只写工具名的 allow 条目会让 `canUseTool` 不被调用。编译器要区分"免询问"（不进收件箱）和"要问"（必须不进 allow）。
3. allow 规则撤不回更宽的 user / project 授权（OpenRig L276）。要控制 `settingSources`，或者显式写 deny；托管策略（managed settings）可能覆盖我们的配置。
4. **编译了参数不等于真的生效**：OpenRig 的测试只证明了启动参数，没有证明原生行为，降级后记录的规则会被忽略。我们要有一条"权限冒烟测试"：对每个角色真的发起一次被禁止的调用，确认被拒。
5. Codex 子 agent 继承父级 sandbox。`permissions` 字段是实验性的；具名 config profile 可能覆盖单个字段。
6. 默认值反例：Paperclip 的 Claude 默认 `dangerouslySkipPermissions: true`（`execute.ts` L446），Codex 默认绕过审批和沙箱。我们默认 `ask`。

### 必须自研

- team design v2 的 schema、Markdown 视图、锁定和结构签名（`hash(stages, roles, backends, tools)`）。
- 编译器：v2 → Claude `query()` options / Codex `thread/start` params / `.claude/agents`（子 agent），以及每次 resume 都重新下发。
- `reviewerOf` / `gates` / `review.maxRounds` → C4 请求和 C7 派活规则。
- 权限冒烟测试和"生效证明"事件（`role.permissions.verified`）。

---

## C16 · 远程 / 手机控制

### 我们要做什么

让手机能看"需要你"收件箱，能回答请求、给 agent 发消息。第一步不做自己的中继：用 Tailscale / SSH 隧道把本机 daemon 暴露给自己的设备，加上设备配对 token 和方法白名单。之后需要公网时再做端到端加密的中继。

### 首选参考

**stablyai/orca · 改编 · MIT**
- 文件（都在 `src/main/runtime/` 下）：
  - WebSocket RPC：`rpc/server/runtime-rpc.ts`（端口 6768）
  - 配对：`rpc/server/runtime-rpc-pairing.ts`、`runtime-rpc-pairing-ticket-exchange.ts`、`runtime-rpc-mobile-pairing.ts`，以及 `rpc/server/pairing/`
  - E2EE（X25519 / tweetnacl，二维码交换公钥）：`e2ee-keypair.ts`（78 行）、`rpc/e2ee-channel.ts`、`rpc/mobile-e2ee-v2-desktop-session.ts`
  - 手机方法白名单：`rpc/server/runtime-rpc-mobile-method-routing.ts` + `runtime-rpc-mobile-method-allowlist.ts` L4（`MOBILE_RPC_METHOD_ALLOWLIST`）
- 中继：`cloud/apps/relay/`（两端都主动连出，由中继拼接），桌面侧是 `src/main/runtime/mobile-cloud-relay/`；推送在 `cloud/apps/push/`。
- 改造要点：白名单只放 `inbox.list`、`command.respond`、`command.message`、`events.stream`。

**slopus/happy · 改编 · MIT**（本地只有 CLI 侧，服务端和 App 没克隆）
- `packages/happy-cli/src/api/encryption.ts`（247 行）：tweetnacl 的 box / secretbox，兼容 libsodium 公钥派生。
- 同目录：`webAuth.ts`（配对）、`apiSession.ts`、`rpc/`。
- `packages/happy-wire/src/{sessionProtocol,controlMessages,messages}.ts`。
- 文档：`docs/encryption.md`、`docs/protocol.md`、`docs/realtime-sync-and-rpc.md`、`docs/permission-resolution.md`。
- 服务端实现 *(unverified：未克隆)*。

### 备选参考

- **AgentSystemLabs/agent-office · 改编 · MIT**：`src/server/tailnet.ts`（74 行，Tailscale Serve）、`src/server/relay.ts`（147 行；用 `x-agent-office-relay` 头防止回环）、`src/server/tunnel/`（`ssh -L` 转发）、`src/server/auth.ts`。不用自建中继的最省事路线。
- **johannesjo/parallel-code · 只借思路 · MIT**：`src/remote/`（`index.tsx`、`AgentDetail.tsx`），手机端只读视图加简单操作。
- **官方通道**：
  - Claude 的 Remote Control（`references/docs/claude__remote-control.md`）没有给第三方的接口。
  - Codex 的 `app-server daemon enable-remote-control`（`codex-rs/app-server-daemon/README.md`）和 `references/docs/codex__remote-connections.md` 是 OpenAI 自己 App 的远程通道。
  - 两者都可以和我们并存，但不能替代我们的收件箱。

### 坑与注意

1. agent-office 的 `src/server/signins.ts` 由 office 代跑 `claude auth login`，从输出里抓 OAuth URL，还允许粘贴 `claude setup-token` 的 token。这违反我们的规则 2 和规则 3。**远程端绝不提供登录，也不传任何凭证。**
2. 中继不能看到明文。如果中继由我们托管，也不能代转订阅用量（规则 4）；E2EE 是前提。
3. 手机端必须用方法白名单。默认不允许"总是允许"类决定，以及修改权限、启动新角色等高风险操作。
4. Codex app-server 的 ws 监听不能直接暴露到公网（见 C2）。

### 必须自研

- 设备配对和吊销。
- 手机端的收件箱视图：复用 C4 / C5 的 `mas/inbox` 快照，不新开数据模型。
- 推送：先用系统通知或 Tailscale 内的网页通知，后期再考虑 APNs / FCM。
