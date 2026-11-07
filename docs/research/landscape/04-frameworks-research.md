# 04 · MAS 框架、公司 / SOP 比喻、研究与核对型 agent

- 调研日期：2026-11-07
- 范围：MetaGPT、ChatDev 2.0、crewAI、CAMEL Workforce、OWL、Eigent、Microsoft Agent Framework、LangGraph（含 langgraph-supervisor）、OpenAI Agents SDK、Agno、GPT Researcher、STORM / Co-STORM、open_deep_research、Tongyi DeepResearch（WebWeaver）、TradingAgents，以及 claim 级核对工具：Loki（OpenFactVerification）、SAFE（long-form-factuality）、DeepResearch Bench FACT、urlhealth（论文）。
- 视角：不是比功能，而是找**已被验证的设计**：团队 / 角色 / SOP 的定义格式、经理式协调、reviewer / 辩论 / 投票、引用与事实核对、人工 checkpoint、持久化与 resume。
- 方法：metadata 来自 `gh api repos/<owner>/<repo>`（2026-11-07 现查）；代码读自本地浅克隆 `references/repos/<owner>__<repo>`（camel、langgraph 超过 400 MB，用 sparse checkout 只取相关目录）。所有引用的文件路径都相对各仓库根目录。只读，没有运行任何下载的代码。

## 摘要

1. **团队定义格式已经收敛为"节点 + 边"的 YAML**：ChatDev 2.0 的 `yaml_instance/*.yaml`（节点 type 有 agent / human / subgraph，边带 `condition`、`carry_data`、`clear_context`、`dynamic: map/tree`）和 Microsoft Agent Framework 的 `declarative-agents/`（`kind: Workflow`，工具带 `approvalMode`、`allowedTools`）是最值得借鉴的两套 schema。crewAI 的 `agents.yaml` / `tasks.yaml` 只有 role / goal / backstory，结构太弱。
2. **"经理"有三种实现**：(a) 经理只会派活、不许持有工具（crewAI `_create_manager_agent` 直接 raise）；(b) 经理维护结构化 progress ledger（MS AF Magentic：`is_request_satisfied` / `is_in_loop` / `is_progress_being_made` / `next_speaker` / `instruction_or_question`，外加 `max_stall_count` 触发 replan）；(c) 经理是一个 tool-calling 循环（open_deep_research 的 `ConductResearch` / `ResearchComplete`，并发上限之外的调用直接回错误）。我们的 Lead 适合 (b) + (c)。
3. **审查环几乎都是"二值判决 + 最大轮数"**：MetaGPT 的 LGTM / LBTM、ChatDev 的 `APPROVE` 关键词边、GPT Researcher 的 accept / revise。CAMEL Workforce 更进一步，审查结果是结构化的 `TaskAnalysisResult`（质量分 + issues + 恢复策略 retry / reassign / replan / decompose）。没有一个框架把"超过轮数"升级给人，GPT Researcher 甚至静默 force-accept。
4. **没有任何 MAS 框架有一等公民的 claim / evidence / verdict 对象**。claim 级结构只出现在**评测和核对工具**里：Loki 的 `ClaimDetail`（含原文 span、checkworthy 理由）+ `Evidence`（url、reasoning、SUPPORTS / REFUTES / IRRELEVANT）；FACT 的 (fact, ref_idx, url) 三元组 + supported / unsupported / unknown（页面无效则 unknown）；SAFE 的多步搜索判 Supported / Not Supported；WebWeaver 让 writer 用 `<qwen:cite id="...">陈述</qwen:cite>` 把每段陈述绑到证据 id。urlhealth 把死链分成 stale 和 hallucinated，但**截至今天没找到公开仓库**。
5. **HITL 已经标准化成"可序列化的暂停点"**：LangGraph `interrupt()` + checkpointer + `Command(resume=...)`；OpenAI Agents SDK 的 `needs_approval` → `interruptions` → `RunState.to_json()` → `approve/reject` → resume；crewAI Flow 的 `@human_feedback(emit=["approved","rejected"], llm=...)` 用 LLM 把人的自由文本归类成路由结果，还支持 `HumanFeedbackPending` 异步等待。LangGraph 的 `HumanInterruptConfig`（allow_accept / edit / respond / ignore）正好是我们"需要你"收件箱每张卡的按钮集合。
6. **最接近我们产品形态的是 Eigent**（15.8k stars，Apache-2.0，Electron 桌面 + CAMEL Workforce）：它有双向 action 协议（`backend/app/service/task.py`：`decompose_progress`、`assign_task`、`ask`、`pause`、`resume`、`add_task`、`skip_task`……），以及仿 Codex 的权限 profile（`read_only` / `request_approval` / `auto_reviewer` / `full_access`，效果 allow / prompt / deny）。它没有证据与核对层。
7. **意外发现**：TradingAgents 已有 121k stars，它的"辩论再决策"是写死轮数的 bull / bear 交替；Agno 新增了 `company` 模块（Products、Routines（cron）、有限额和过期时间的 `auto_accept`、决策日志）；MS Agent Framework 有 `claude` 和 `github_copilot` 包，可以把 Claude Agent SDK 当作一个 agent 接入；MetaGPT（最近 push 2026-01）和 STORM（2025-09）已基本停更，open_deep_research 和 langgraph-supervisor 已 archived。
8. **建议**（详见第 3 节）：团队设计 v2 引入 `stages`、`handsTo.carry`、`backend`、逐工具的 `allow / ask / deny`、`reviewerOf`、`review.maxRounds` + `onExceed: ask-human`、`gates`；证据模型拆成 `claim`（带 span）→ `evidence`（带原文引语和 relationship）→ `urlHealth` → `verdict`（含 unknown），由干净上下文的 checker 按 FACT 式流水线产出。

---

## 1. 逐项目笔记

### FoundationAgents/MetaGPT

- https://github.com/FoundationAgents/MetaGPT · ⭐ 71.2k · MIT · Python · 最近 push 2026-01-21 · 本地克隆：`references/repos/FoundationAgents__MetaGPT` @ 11cdf46
- **一句话**："AI 软件公司"的原型：ProductManager → Architect → ProjectManager → Engineer → QA，靠 SOP 和消息订阅串起来。
- **团队怎么定义**：Python 类。角色 = `name / profile / goal / constraints / tools` + 订阅的 action 类型。`metagpt/roles/architect.py`：
  ```python
  class Architect(RoleZero):
      name: str = "Bob"
      profile: str = "Architect"
      goal: str = "design a concise, usable, complete software system. output the system design."
      tools: list[str] = ["Editor:write,read,similarity_search", "RoleZero", "Terminal:run_command"]
      def __init__(self, **kwargs):
          ...
          self.set_actions([WriteDesign])
          self._watch({WritePRD})      # 订阅 PM 产出的 PRD
  ```
  入口 `metagpt/software_company.py`：`company.hire([TeamLeader(), ProductManager(), Architect(), Engineer2(), DataAnalyst()])`，`company.invest(investment)` 设美元预算，`n_round` 限轮数。
- **协调与合并**：共享 Environment 是 publish / subscribe 消息池（`metagpt/environment/base_env.py:175 publish_message`，按 `member_addrs` 投递）。`Message` 带 `cause_by`（哪个 action 产生）和 `send_to`；角色在 `_observe` 只取 `cause_by ∈ rc.watch` 或点名给自己的消息（`metagpt/roles/role.py:411`）。新版 `TeamLeader`（`metagpt/roles/di/team_leader.py`）用 `publish_team_message(content, send_to)` 点名派活，然后 `_set_state(-1)` 暂停等回复；docstring 强调"你是成员唯一的信息来源，不要省略路径、链接、约束"。
- **核对机制**：`metagpt/actions/write_code_review.py`：reviewer 只能答 `LGTM` / `LBTM`，LBTM 就按 review 重写，循环 `k` 次（`for i in range(k)`，line 171）。QA 角色可选（`run_tests`）。
- **来源与引用**：无（软件场景）。`roles/researcher.py` 只是单角色搜索汇总。
- **HITL**：`Role.is_human = True` 时用 `HumanProvider` 代替 LLM（`role.py:169`），即"让人扮演某个岗位"。没有审批点。
- **状态与 resume**：`Team.serialize()` 把团队和 context 写成 JSON（`metagpt/team.py:59`），`--recover-path` 反序列化继续跑。
- **和我们 roadmap 的关系**：团队设计、CEO。
- **值得借鉴**：①"订阅 action 类型"而不是"订阅角色"，下游不必知道上游是谁；②Lead 派活时必须把上下文写全（它是唯一信息源）——可写进我们 `team/lead.md` 的规则；③美元预算作为团队的一等属性（`invest`）。
- **不足 / 我们的机会**：review 只有二值，没有理由结构；没有人工 gate；项目已放缓（商业重心在 MGX *(unverified)*）。
- **复用判断**：只借鉴思路（MIT 允许复用，但架构是 Python 进程内对象，和我们"真实 CLI 会话"不同）。

### OpenBMB/ChatDev（2.0 "DevAll"）

- https://github.com/OpenBMB/ChatDev · ⭐ 34.7k · Apache-2.0 · Python + Vue · 最近 push 2026-11-06 · 本地克隆 @ 464a681
- **一句话**：2026-01 发布的 2.0 把经典 ChatDev 改成"零代码多 agent 平台"：用 YAML 描述图，Web UI 启动和观察（README.md:22–26）。
- **团队怎么定义**：YAML 图，`version / vars / graph{start, nodes, edges}`。节点 type：`agent`、`human`、`subgraph`、`python`、`literal`、`passthrough`、`loop_counter`、`loop_timer`（`docs/user_guide/en/nodes/`）。`yaml_instance/demo_human.yaml`：
  ```yaml
  graph:
    id: paper_gen
    start: [A]
    nodes:
    - id: A
      type: agent
      config: {provider: openai, name: gpt-4o, role: 'You are a writer ...'}
    - id: B
      type: human
      config: {description: 'Please provide revision suggestions for the article.'}
    - id: C
      type: agent
      config: {role: 'You are an editor ...'}
    edges:
    - {from: A, to: B}
    - {from: B, to: C}
    - {from: A, to: C}
  ```
  每条边可以设 `trigger`、`condition`（`type: keyword, any: [APPROVE]` 或 `type: function`）、`carry_data`、`keep_message`、`clear_context`、`clear_kept_context`、`dynamic`（`yaml_instance/GameDev_with_manager.yaml:743-830`）。每个 agent 节点单独设 `provider / name(model)` 和 `tooling`（`function` / `mcp_remote` / `mcp_local`，`docs/user_guide/en/nodes/agent.md:85-124`）。
- **协调与合并**：拓扑本身就是 SOP；"manager"只是一个普通 agent 节点。并行用边级 `dynamic: {type: map | tree}`：map = 按 split 结果把目标节点扇出成 N 个实例，tree = 扇出后再归约（`docs/user_guide/en/dynamic_execution.md`）。投票用图级开关 `is_majority_voting: true`，此时没有边，所有节点并行、多数票为结果（`yaml_instance/demo_majority_voting.yaml`，`workflow/graph_manager.py:120`）。
- **核对机制**：靠拓扑：QA 节点输出末行必须是 `APPROVE` 或 `NEEDS_REFINEMENT`，由 keyword 边路由（`GameDev_with_manager.yaml:540`）。`deep_research_v1.yaml:249` 的 "Quality Reviewer" 做增量审查：先调用 `report_read`，再查结构、"每个事实陈述是否都有 `[n]` 引用"、References 章节是否唯一。
- **来源与引用**：只在 prompt 里要求 `[n]` + References 章节（`deep_research_v1.yaml:178-231`），没有结构化来源。
- **HITL**：`type: human` 节点阻塞执行，Web UI 里显示上下文和说明，用户回复（可带附件）后传给下游（`docs/user_guide/en/nodes/human.md`）。文档推荐"满意就输入 ACCEPT，否则写修改意见"，再用 keyword 边路由。
- **状态与 resume**：只有 WebSocket 断线重连时发 `session_resumed` 快照（`server/services/websocket_manager.py:118`）；没找到 run 级 checkpoint。
- **和我们 roadmap 的关系**：团队设计（格式）、人工 gate、checker 返工。
- **值得借鉴**：①边上的 `carry_data` / `clear_context`——直接对应"checker 用干净上下文"；②`human` 是图里的普通节点，人工 gate 不用特殊机制；③`dynamic: map/tree` 是"finder 并行扇出 + Lead 归约"的声明式写法；④keyword 路由让"审查结论决定下一步"变成可视的边。
- **不足 / 我们的机会**：需要 API key；节点是一次 LLM 调用而不是持久会话；YAML 冗长（每条边重复十个字段）；无 claim 结构。
- **复用判断**：Apache-2.0，schema 可直接借鉴，代码不适合依赖。

### crewAIInc/crewAI

- https://github.com/crewAIInc/crewAI · ⭐ 60.6k · MIT · Python · 最近 push 2026-11-07 · 本地克隆 @ 73f4832
- **一句话**：最流行的"角色扮演团队"框架：Agent（role / goal / backstory）+ Task + Crew（sequential / hierarchical）+ Flow（事件驱动的编排层）。
- **团队怎么定义**：YAML + Python 装饰器。模板 `lib/cli/src/crewai_cli/templates/crew/config/agents.yaml`：
  ```yaml
  researcher:
    role: >
      {topic} Senior Data Researcher
    goal: >
      Uncover cutting-edge developments in {topic}
    backstory: >
      You're a seasoned researcher with a knack for uncovering the latest ...
  ```
  `tasks.yaml` 每个任务有 `description / expected_output / agent`。
- **协调与合并**：`Process` 只有 `sequential` 和 `hierarchical`（`consensual` 还是 TODO，`lib/crewai/src/crewai/process.py`）。hierarchical 时 `_create_manager_agent`（`crew.py:1533`）：用户可以给 `manager_agent`，但**它不许带非委派工具**，否则直接 raise "Manager agent should not have tools"；否则自动生成 "Crew Manager"，工具只有 `AgentTools`（`tools/agent_tools/delegate_work_tool.py`、`ask_question_tool.py`）。
- **核对机制**：Task 级 `guardrail` / `guardrails`：可以是函数，也可以是一句自然语言描述（由 LLM 判定），失败就带反馈重试，`guardrail_max_retries=3`（`task.py:262-290`）。
- **来源与引用**：无结构化来源。
- **HITL**：①Task 级 `human_input: bool`（`task.py:243`）；②Flow 的 `@human_feedback(message=..., emit=["approved","rejected"], llm=...)`（`flow/human_feedback.py` 文档串）：人写自由文本，LLM 把它归类到 `emit` 里的某个结果，再由 `@listen("approved")` 路由；③异步 provider 抛 `HumanFeedbackPending`，流程挂起持久化，之后 `Flow.from_pending(...)` + `resume(feedback)` 继续（`flow/runtime/__init__.py:1260, 1348`）。
- **状态与 resume**：Crew 的 `checkpoint` 配置（`crew.py:402`，`state/checkpoint_config.py`，JSON / SQLite provider）；Flow 的 `@persist`（`flow/persistence/sqlite.py`）。`FlowDefinition` 可序列化为 YAML（`flow/flow_definition.py`）。
- **和我们 roadmap 的关系**：CEO、人工 gate、收件箱。
- **值得借鉴**：①"经理不持有工具"——强制 Lead 只做分派和汇总，避免 Lead 自己下场搜索；②自然语言 guardrail（"每个价格必须带来源链接"）作为角色输出的验收条件；③`emit` + LLM 归类：用户在收件箱里随便打字，系统仍能路由到 approve / revise；④`HumanFeedbackPending` 就是我们"需要你"的后端语义。
- **不足 / 我们的机会**：role / goal / backstory 是人设，不是职责；没有 reviewer 对象；hierarchical 经理的派活不可审计（只是工具调用）。
- **复用判断**：只借鉴思路。

### camel-ai/camel（Workforce）

- https://github.com/camel-ai/camel · ⭐ 18.0k · Apache-2.0 · Python · 最近 push 2026-11-02 · 本地 sparse 克隆（`camel/societies`、`camel/tasks`、`examples/workforce`）@ 123f0c6（仓库约 507 MB）
- **一句话**：CAMEL 的多 agent 调度器：coordinator 拆任务、task agent 分派、worker 执行、失败时按策略恢复。Eigent 的底座。
- **团队怎么定义**：Python 链式调用，worker 只有一句自然语言描述。`examples/workforce/hackathon_judges.py:220`：
  ```python
  workforce = Workforce('Hackathon Judges')
  workforce.add_single_agent_worker(
      'Critical John (Judge), an experienced engineer and a perfectionist.', worker=eng_agent,
  ).add_single_agent_worker(
      'Researcher Rachel (Helper), a researcher who does online searches ...', worker=researcher_agent)
  workforce.process_task(task)
  ```
  模式 `WorkforceMode.AUTO_DECOMPOSE | PIPELINE`（`camel/societies/workforce/workforce.py:142`）。
- **协调与合并**：`_decompose_task`（`workforce.py:1549`）→ `_find_assignee`（:4042）输出结构化 `TaskAssignResult{assignments:[{task_id, assignee_id, dependencies}]}`（`utils.py:169-208`）→ `_post_task` 通过 `TaskChannel` 发给 worker。依赖关系是一等字段。
- **核对机制**：每个完成或失败的任务由 coordinator 产出 `TaskAnalysisResult`（`utils.py:351`；旧版 `QualityEvaluation`：`quality_sufficient / quality_score 0-100 / issues[] / recovery_strategy / modified_task_content`）。`RecoveryStrategy = retry | replan | decompose | create_worker | reassign`（`utils.py:211`），`FailureHandlingConfig` 配置允许的策略。
- **来源与引用**：无。
- **HITL**：`WorkforceState = idle | running | paused | stopped`；`pause()` / `resume()`（:2040, :2073），暂停时人可以查看、增删改 pending 任务（`get_pending_tasks`、`add_task`、`resume_from_task`，:2272-2502）。
- **状态与 resume**：`WorkforceSnapshot`（pending / completed / dependencies / assignees，:149）+ `save_snapshot()`；只在进程内存里。
- **和我们 roadmap 的关系**：CEO、checker 返工。
- **值得借鉴**：①分派结果是结构化的（任务 → 负责人 → 依赖），可直接画成办公室里的交接线；②**恢复策略枚举**：checker 举旗之后，Lead 的处理方式应该从固定集合里选（重试 / 换人 / 重新规划 / 拆小），并写进事件流；③暂停时允许人改任务队列。
- **不足 / 我们的机会**：worker 定义太弱（一句描述）；质量评估由 coordinator 自己做，不是独立 checker；snapshot 不落盘。
- **复用判断**：Apache-2.0，可借鉴 schema（`TaskAssignment`、`RecoveryStrategy`）。

### camel-ai/owl

- https://github.com/camel-ai/owl · ⭐ 20.2k · Apache-2.0（`pyproject.toml`、`licenses/LICENSE`；GitHub API 识别不到 license）· Python · 最近 push 2026-11-02 · 本地克隆 @ 2df367e
- **一句话**：基于 CAMEL RolePlaying 的通用任务 agent（GAIA 榜单），一个 "user" agent 指挥一个带工具的 "assistant" agent。
- **团队怎么定义**：`owl/utils/enhanced_role_playing.py:31 OwlRolePlaying(RolePlaying)`，两个角色名加 system prompt。
- **协调与合并**：user agent 一步一步下指令，直到回复 `<TASK_DONE>`（:209, :272）。
- **核对机制**：仅 prompt 层："Always verify the accuracy of your final answers! Try cross-checking the answers by other ways"，"工具失败时不要假设它返回了正确结果"（:197, :235, :238）。
- **来源与引用 / HITL / resume**：无。
- **和我们 roadmap 的关系**：评测基线。
- **值得借鉴**：prompt 里那条"搜索结果通常不直接给答案，搜索是为了找来源，再用其他工具读原页面"（:199）——适合写进我们 finder 的规则。
- **不足**：两人对话，不是团队；自检是 intrinsic self-correction，证据显示无效。
- **复用判断**：只借鉴 prompt。

### eigent-ai/eigent

- https://github.com/eigent-ai/eigent · ⭐ 15.8k · Apache-2.0 · TypeScript（Electron）+ Python 后端 · 最近 push 2026-11-05 · 本地克隆 @ 4958c94
- **一句话**："Open Source Cowork Desktop"：给终端用户的桌面 app，单 agent 或 Workforce 多 agent 协作，支持定时自动化、本地优先（README.md:165-183）。
- **团队怎么定义**：用户不直接定义团队；后端按任务动态生成 worker（`backend/app/agent/factory/`：`browser.py`、`developer.py`、`document.py`、`multi_modal.py`、`social_media.py`、`mcp.py`……），底层用 `camel-ai[eigent]==0.2.91a7`（`backend/pyproject.toml:9`）。
- **协调与合并**：CAMEL Workforce 拆任务 → SSE `to_sub_tasks` 推给前端（`backend/app/service/chat_service.py:2322`）→ 用户确认或修改 → `start`。
- **双向协议**（`backend/app/service/task.py:49`，最值得看）：
  - backend → user：`decompose_progress`、`decompose_text`、`create_agent`、`activate_agent`、`assign_task{assignee_id, task_id, content, state, failure_count}`、`activate_toolkit`、`write_file`、`ask`、`notice`、`terminal`、`todo_state`、`budget_not_enough`、`timeout`、`end`
  - user → backend：`improve`、`update_task`、`start`、`stop`、`supplement`、`pause`、`resume`、`new_agent`、`add_task`、`remove_task`、`skip_task`
- **核对机制**：沿用 CAMEL 的质量评估和恢复；没有独立 checker 角色。
- **来源与引用**：无结构化来源。
- **HITL**：①拆解后的任务清单由用户确认和编辑；②`ask` 事件 + `human_toolkit.py`；③权限策略（`backend/app/permission_policy/models.py`）：profile `read_only | request_approval | auto_reviewer | full_access`，每个 profile 是 `sandbox_mode` × `approval_mode` × `reviewer_mode`（:790-830，明显仿 Codex）；规则效果 `allow | prompt | deny`；操作分类 `filesystem.read/write/delete`、`terminal.execute`、`browser.read/interact`、`git.remote_write`、`permission.profile.modify` 等（:620-650）；审批卡上的参数会去掉凭据。
- **状态与 resume**：`backend/app/run_journal/`（SQLite store、semantic events、OTel projection）；`remote_sub_agent/` 能把远端 agent 会话当子 agent（事件：`session_updated / output_delta / thought_delta / tool_event / completed / failed`）。
- **和我们 roadmap 的关系**：收件箱、双向协议、权限、桌面 app（M4），是最直接的竞品形态。
- **值得借鉴**：①action 协议几乎可以直接映射到我们的协议 0.2（`assign_task`、`ask`、`skip_task`、`supplement`）；②权限 profile 的三维设计（沙箱 × 审批 × 谁来审），其中 `auto_reviewer` 就是"让 checker 代替人审批"；③`failure_count` 放在派活事件里，界面能显示"这活第几次返工"。
- **不足 / 我们的机会**：团队是黑箱动态生成，用户不能设计和锁定；没有证据与核对；用 API key 跑自家 agent，不驱动 Claude Code / Codex 会话。
- **复用判断**：Apache-2.0，协议和权限模型可借鉴甚至局部移植。

### microsoft/agent-framework

- https://github.com/microsoft/agent-framework · ⭐ 14.6k · MIT · Python / .NET / Go · 最近 push 2026-11-06 · 本地克隆 @ 924a6e5
- **一句话**：AutoGen + Semantic Kernel 的继任者：图式 Workflow、预置编排（sequential / concurrent / handoff / group chat / Magentic）、声明式 YAML、checkpoint、DevUI。
- **团队怎么定义**：代码 builder 或声明式 YAML。agent（`declarative-agents/agent-samples/foundry/MicrosoftLearnAgent.yaml`）：
  ```yaml
  kind: Prompt
  name: MicrosoftLearnAgent
  instructions: You answer questions by searching the Microsoft Learn content only.
  tools:
    - kind: mcp
      name: microsoft_learn
      url: https://learn.microsoft.com/api/mcp
      approvalMode:
        kind: never
      allowedTools:
        - microsoft_docs_search
  ```
  workflow（`declarative-agents/workflow-samples/Marketing.yaml`）是 `kind: Workflow` + `trigger.actions` 列表（`InvokeAzureAgent`、`SetVariable`、`GotoAction`、`SendActivity`……）；`DeepResearch.yaml` 用这套动作把 Magentic 的 ledger 循环写成了 YAML。
- **协调与合并**：Magentic manager（`python/packages/orchestrations/agent_framework_orchestrations/_magentic.py`）：先建 task ledger（事实 + 计划），每轮产出 `MagenticProgressLedger`，五个字段各带 `reason` + `answer`：`is_request_satisfied`、`is_in_loop`、`is_progress_being_made`、`next_speaker`、`instruction_or_question`（:223-335）；停滞计数超过 `max_stall_count=3` 就 reset 并 replan（:492）；事件类型 `plan_created / replanned / progress_ledger_updated`（:819）。`next_speaker` 不在成员名单里会被拒（:749-759）。
- **核对机制**：没有专门 reviewer；group chat 可以放 critic。Magentic 的 `is_request_satisfied` 是经理的自评。
- **HITL**：①`with_plan_review()`（:1568）：计划出来后发 `MagenticPlanReviewRequest`，人回 `approve()` 或 `revise(feedback)`（:839-887）；②sequential / concurrent / group chat 的 `with_request_info(agents=[...])`：指定 agent 输出后暂停等人（`_orchestration_request_info.py`）；③工具级 `approvalMode`。
- **状态与 resume**：`CheckpointStorage` 协议，有 InMemory 和 `FileCheckpointStorage`（`python/packages/core/agent_framework/_workflows/_checkpoint.py:134, 557`）；每个编排 builder 都有 `with_checkpointing`。
- **其他**：`python/packages/claude`（"Claude Agent enables integration with Claude Agent SDK"）和 `github_copilot` 包——把 CLI 型 agent 当成框架里的一个 agent；`devui` 是官方声明"不用于生产"的 sample UI（`python/packages/devui/README.md`）；`ag-ui`、`a2a` 包。
- **和我们 roadmap 的关系**：CEO（ledger）、人工 gate、团队格式、resume。
- **值得借鉴**：①**progress ledger 的五个字段**可以直接作为 Lead 每轮的结构化事件（`lead.ledger`），面板据此显示"是否在原地打转"；②`max_stall_count` → replan，让"卡住"可检测；③plan review 的 approve / revise 二元响应；④YAML 里工具级 `approvalMode` + `allowedTools`。
- **不足 / 我们的机会**：面向开发者；DevUI 只是调试器；Magentic 的"满足"由经理自评，没有独立核对。
- **复用判断**：MIT。ledger schema、checkpoint 接口可借鉴；如需 Python 侧编排，可作依赖。

### langchain-ai/langgraph（+ langgraph-supervisor-py）

- https://github.com/langchain-ai/langgraph · ⭐ 44.6k · MIT · Python · 最近 push 2026-11-06 · 本地 sparse 克隆（`libs/langgraph/langgraph`、`libs/checkpoint/langgraph`、`libs/prebuilt/langgraph`）@ e5e37b5（仓库约 532 MB）
- https://github.com/langchain-ai/langgraph-supervisor-py · ⭐ 1.7k · MIT · **archived**（最近 push 2026-07-15）· 本地克隆 @ 88859b3
- **一句话**：状态图运行时；HITL 和 checkpoint 是它的核心卖点。supervisor 库已归档，官方改推"直接用 tool-calling 写 supervisor"（supervisor README 顶部 Note）。
- **团队怎么定义**：代码（`StateGraph.add_node / add_edge / add_conditional_edges`）。
- **协调与合并**：`Send`（map 扇出）和 `Command(goto=..., update=...)`（`libs/langgraph/langgraph/types.py:748, 843`）。supervisor 库给每个 worker 生成 `transfer_to_<name>` 工具，worker 完成后 `transfer_back_to_<supervisor>`（`langgraph_supervisor/handoff.py:83, 137`）；`output_mode = full_history | last_message` 决定把 worker 的多少历史并回 supervisor（`supervisor.py:68-81`）；`create_forward_message_tool`（:155）让 supervisor 原样转发 worker 的回答，不重新转述。
- **核对机制**：无内置。
- **HITL**：`interrupt(value, response_schema=...)`（`types.py:906-990`）：节点里第一次调用抛 `GraphInterrupt`，值发给客户端；客户端用 `Command(resume=...)` 继续，**节点从头重新执行**，按调用顺序匹配 resume 值；必须有 checkpointer。编译期 `interrupt_before_nodes / interrupt_after_nodes`（`pregel/main.py:727-729`）。`libs/prebuilt/langgraph/prebuilt/interrupt.py` 定义 Agent Inbox 用的 `HumanInterruptConfig{allow_ignore, allow_respond, allow_edit, allow_accept}` + `ActionRequest` + `HumanResponse`。
- **状态与 resume**：`BaseCheckpointSaver`（`libs/checkpoint/langgraph/checkpoint/base/__init__.py:199`）按 `thread_id` 存每个 super-step；`get_state_history` / `update_state`（`libs/langgraph/langgraph/pregel/protocol.py:58, 92`）支持 time travel 和分叉。
- **和我们 roadmap 的关系**：收件箱、resume、协议映射（我们已有 LangGraph 集成）。
- **值得借鉴**：①`HumanInterruptConfig` 四个开关 = 收件箱卡片的按钮配置（接受 / 编辑后接受 / 回复 / 忽略）；②`response_schema`：gate 声明期望的回复结构；③"resume 时节点重跑"这一语义提醒我们：会话型 agent 无法重跑，gate 必须放在阶段**之间**；④`output_mode` / forward message：Lead 合并时可以选"只要结论"或"原文转发"，checker 的判定应原样转发，不让 Lead 转述。
- **不足 / 我们的机会**：纯开发者工具；LangGraph Studio 是调试视图。
- **复用判断**：MIT；已集成，只借鉴 HITL schema。

### openai/openai-agents-python

- https://github.com/openai/openai-agents-python · ⭐ 30.5k · MIT · Python · 最近 push 2026-11-07 · 本地克隆 @ 27c75c5
- **一句话**：OpenAI 的轻量 agent SDK：Agent、handoffs、agents-as-tools、guardrails、HITL、sessions、sandbox agents。
- **团队怎么定义**：代码。`docs/multi_agent.md` 明确两种模式：**agents as tools**（经理保持控制，适合"一个 agent 拥有最终答案、合并多个专家输出"）和 **handoffs**（控制权转移给专家）。
- **协调与合并**：`handoff(..., input_filter=..., nest_handoff_history=..., is_enabled=...)`（`src/agents/handoffs/__init__.py:159-250`）：`input_filter` 决定交接时下游能看到什么历史。
- **核对机制**：guardrails（`src/agents/guardrail.py`）：input / output guardrail 返回 `GuardrailFunctionOutput{tripwire_triggered}`，触发就抛异常；input guardrail 默认 `run_in_parallel=True`；另有 tool input / output guardrail。是阻断式检查，不是返工。
- **HITL**（`docs/human_in_the_loop.md`）：工具声明 `needs_approval=True` 或一个按参数判断的 async 函数（参数无法解析时 fail closed，强制人工审批）；run 暂停后 `result.interruptions` 列出 `ToolApprovalItem`（agent 名、工具名、参数），包括 handoff 之后和嵌套 `Agent.as_tool()` 里的审批；`result.to_state()` → `state.approve(item, always_approve=?)` / `state.reject(item)` → `Runner.run(agent, state)` 续跑；可以只处理部分审批。文档专门警告：shell / apply_patch 的 sticky "always approve" **不区分 agent**，权限不同的 agent 之间会串。
- **状态与 resume**：`RunState`（`src/agents/run_state.py:842`）可 `to_json / from_json / to_string / from_string`，带 schema 版本，保存 pending interruptions 和 sticky 决策。
- **和我们 roadmap 的关系**：收件箱、权限、resume。
- **值得借鉴**：①"agents as tools = 一个 agent 拥有最终答案"正好是我们的 Lead 单写者原则；②`needs_approval` 可以是谓词（只有 refund 才审批）→ 我们的 `ask` 规则也应能带条件；③审批决定的作用域要按"角色 + 工具"，sticky approve 不能跨角色继承；④可序列化的 paused state，能"关掉电脑明天再批"。
- **不足 / 我们的机会**：没有团队设计、没有 reviewer 角色、guardrail 只能阻断。
- **复用判断**：MIT；只借鉴语义。

### agno-agi/agno（Teams + Company）

- https://github.com/agno-agi/agno · ⭐ 43.1k · Apache-2.0 · Python · 最近 push 2026-11-06 · 本地克隆 @ f45ccee
- **一句话**：agent 框架 + AgentOS 运行时；Team 有四种模式，2026 年新增面向"运营一家公司"的 `company` 模块。
- **团队怎么定义**：代码。`cookbook/03_teams/02_modes/tasks_stream.py:75-95`：
  ```python
  researcher = Agent(name="Researcher", role="Research specialist", instructions="You research topics ...")
  writer = Agent(name="Writer", role="Content writer", instructions="You write content based on research.")
  team = Team(name="Content Team", mode=TeamMode.tasks, members=[researcher, writer], instructions=[...])
  ```
- **协调与合并**：`TeamMode`（`libs/agno/agno/team/mode.py`）：`coordinate`（leader 选成员、写任务、汇总，默认）、`route`（直接返回专家答案）、`broadcast`（同一任务发给所有成员，异步并发）、`tasks`（leader 把目标拆成共享任务清单，用 `create_task / update_task_status / mark_all_complete` 工具循环到完成，`team/_task_tools.py:182-305`）。
- **核对机制**：`agno/guardrails`、`agno/eval`；没有团队内 reviewer 角色。
- **HITL**：`@approval` 装饰器，`ApprovalType.required`（阻塞，直到通过 approvals API 处理）和 `audit`（不阻塞，只留审计记录）（`libs/agno/agno/approval/types.py`）。
- **Company 模块**（`libs/agno/agno/company/`，约 5.1k 行）：`Product`、`Source(type: git | markdown | website)`、`Routine`（cron + 执行者 agent / team / workflow + 模板 refresh / intake / summary）、`AutoAccept`（"人写的边界"：`required_checks`、`limits.max_acceptances`、`limits.expires_at`、`work_scope`）、团队共享的决策日志（`decisions.py`：召回时不隐藏人和其他 agent 的决策）。声明可来自代码、YAML 或空白部署（`declarations.py` 文档串）。
- **状态与 resume**：所有 session、run 存 DB（`agno/db`）。
- **和我们 roadmap 的关系**：团队设计、定期重跑、审批。
- **值得借鉴**：①四种模式就是我们 stage 的 `mode` 候选；②`required` vs `audit` 两级审批：不是每件事都要阻塞，可以"先做、留痕、事后看"（management by exception）；③`AutoAccept` 的有限额、会过期的自动批准：对重复运行的团队很实用（"本月内，checker 全部通过的结果自动接受，最多 4 次"）；④共享决策日志：人的决定对所有 agent 可见。
- **不足 / 我们的机会**：开发者框架，没有面向非工程师的界面；company 模块偏运营自动化，不涉及证据。
- **复用判断**：Apache-2.0；只借鉴思路。

### assafelovic/gpt-researcher（multi_agents）

- https://github.com/assafelovic/gpt-researcher · ⭐ 30.5k · Apache-2.0 · Python · 最近 push 2026-10-10 · 本地克隆 @ 3582a68
- **一句话**：开源 deep research 代表；`multi_agents/` 是一个 LangGraph 编辑部：browser → editor（planner）→ human → 并行 researcher（每节内含 reviewer / reviser 环）→ writer → fact_checker → visualizer → publisher。
- **团队怎么定义**：代码 + `multi_agents/task.json`：
  ```json
  {"query": "Is AI in a hype cycle?", "max_sections": 3, "max_plan_revisions": 3,
   "include_human_feedback": false, "follow_guidelines": false,
   "guidelines": ["Each sub section MUST include supporting sources using hyperlinks. If none exist, erase the sub section ..."]}
  ```
- **协调与合并**：`multi_agents/agents/orchestrator.py:69-104`；editor 的 `run_parallel_research` 每个章节跑一个子图 researcher → reviewer → reviser（`editor.py:136-141`）。
- **核对机制**：①reviewer 只按 `guidelines` 审（`reviewer.py`），无意见返回 None 即通过；②`fact_checker.py`：把 intro + research_data + conclusion 拼成一段文本，让模型"列出关键错误，否则只返回字符串 None"；`fact_review.py` 的 `route_fact_check` 返回 accept / revise，超过 `max_fact_check_revisions=3` 抛异常——但 `orchestrator.py:107-121` 对计划审查的同类异常**直接当 accept 处理**，注释说是为了避免撞到 LangGraph 的 recursion_limit。
- **来源与引用**：`GPTResearcher.visited_urls`、`research_sources`（`gpt_researcher/agent.py:151-161`）；引用格式靠 guidelines。
- **HITL**：`include_human_feedback` 时 planner 之后的 `human` 节点让人改提纲（`agents/human.py`）。
- **状态与 resume**：无 checkpointer。
- **和我们 roadmap 的关系**：核对、checker 返工、人工 gate。
- **值得借鉴**：①"计划后、开工前"放一个人工 gate；②每章节独立 review 环，适合并行 finder；③guidelines 作为 reviewer 的明文检查单。
- **不足 / 我们的机会**：fact checker 是整稿二值判断，没有 claim、没有来源对照，也不抓网页；超过轮数**静默放行**正是我们要避免的失败模式——我们应改为升级给人。
- **复用判断**：只借鉴流程。

### stanford-oval/storm（STORM / Co-STORM）

- https://github.com/stanford-oval/storm · ⭐ 31.8k · MIT · Python · 最近 push 2025-09-30（基本停更）· 本地克隆 @ fb951af
- **一句话**：从多视角提问生成 Wikipedia 式长文；Co-STORM 是人可以随时插话的圆桌讨论（arXiv 2408.15232）。
- **团队怎么定义**：代码。Co-STORM 角色：`CoStormExpert`、`SimulatedUser`、`Moderator`、`PureRAGAgent`（`knowledge_storm/collaborative_storm/modules/co_storm_agents.py`）。
- **协调与合并**：`get_next_turn_policy`（`collaborative_storm/engine.py:461`）按规则决定下一个发言者，并可同时触发 `should_reorganize_knowledge_base` / `should_update_experts_list`。Moderator 专门挑"**已检索但还没被引用**"的片段，按与话题相关、与原问题不相似重排后生成新问题，防止讨论停滞（docstring :159-168）。共享产物是层级 `KnowledgeBase` / `KnowledgeNode`（mind map，`knowledge_storm/dataclass.py:86, 291`）。
- **核对机制**：无独立核对；靠 grounded QA（回答只能基于检索到的片段）。
- **来源与引用**：`Information{url, title, description, snippets[], citation_uuid}`，以 url 为唯一键（`knowledge_storm/interface.py:41`）；文章里的 `[n]` 映射回 `Information`。
- **HITL**：`engine.step(user_utterance=...)`：人可在任意一轮插话（:661）。
- **状态与 resume**：`CoStormRunner.to_dict / from_dict`（:540, :555）。
- **和我们 roadmap 的关系**：证据模型、追问。
- **值得借鉴**：①来源对象带原文 snippets，引用编号只是视图；②"未被引用的证据"本身是信号：Lead 汇总后，checker 可以列出"找到了但结论没用上"的来源（漏掉的反例）；③人随时插话、系统更新知识图。
- **不足**：已停更；无 claim 判定。
- **复用判断**：MIT；数据结构可借鉴。

### langchain-ai/open_deep_research

- https://github.com/langchain-ai/open_deep_research · ⭐ 12.7k · MIT · Python · **archived**（最近 push 2026-08-10）· 本地克隆 @ 1b7d2e8
- **一句话**：LangGraph 写的 deep research：clarify → research brief → supervisor 并行 sub-researcher → compress → final report；曾列 DeepResearch Bench 第 6（README.md）。
- **团队怎么定义**：代码 + `configuration.py`（`allow_clarification`、`max_concurrent_research_units`、`max_researcher_iterations` 等）。
- **协调与合并**：supervisor 的工具只有 `ConductResearch{research_topic}`、`ResearchComplete`、`think_tool`（`src/open_deep_research/deep_researcher.py:202`；`state.py:15`）；超过并发上限的 `ConductResearch` 调用不执行，直接回 ToolMessage 报错（:291-319）。每个 sub-researcher 结束前做 compress：清理发现但"保留所有相关陈述"，并为每个唯一 URL 分配一个引用编号（`prompts.py:186-219`）。
- **核对机制**：无。
- **HITL**：仅开头的澄清问题（`allow_clarification`）。
- **状态与 resume**：依赖 LangGraph checkpointer（部署时）。
- **和我们 roadmap 的关系**：Lead 协调。
- **值得借鉴**：①派活工具要求 `research_topic` "至少一段话"，强迫 Lead 写清任务；②并发上限在工具层强制，而不是靠 prompt；③compress 阶段"只清理不删减陈述"，引用编号按 URL 去重。
- **不足**：已归档；无核对。
- **复用判断**：只借鉴。

### Alibaba-NLP/DeepResearch（Tongyi DeepResearch + WebAgent 家族）

- https://github.com/Alibaba-NLP/DeepResearch · ⭐ 20.1k · Apache-2.0 · Python · 最近 push 2026-02-27 · 本地克隆 @ f72f75d
- **一句话**：通义的 deep research 模型与推理框架（ReAct 模式和 IterResearch "Heavy" 模式，README.md:47），以及 WebAgent 系列研究代码（WebSailor、WebWeaver、WebResearcher、ParallelMuse 等）。
- **团队怎么定义**：代码；WebWeaver 是 planner + writer 双 agent（`WebAgent/WebWeaver/README.md`）。
- **协调与合并**：planner 交替搜索和修改提纲，提纲是"活文档"，每个小节后必须附 `<citation> id_1, id_2 </citation>`，缺引用的小节下一轮继续搜（`WebAgent/WebWeaver/prompt/search_user_prompt_id_3.py:11-14`）；writer 逐节从 memory bank 按 id 取证据写作。
- **核对机制**：无独立 checker，但结构上保证"先有证据 id 再写"。
- **来源与引用**：writer 必须用 `<qwen:cite id="id_x,id_y">陈述</qwen:cite>` 包住每条事实陈述（`WebAgent/WebWeaver/prompt/write_prompt_multi_hop_2.py:90-105`）——这是本次调研里唯一在**生成时**就产出 claim span 与证据 id 对应关系的系统。
- **HITL / resume**：无。
- **和我们 roadmap 的关系**：证据模型、评测（DeepResearch Bench 引用准确率 / 有效引用数）。
- **值得借鉴**：①让 Lead 写结果时用内联标签把陈述包起来、指向 source card id，claim 抽取就不必再靠 LLM 猜；②"缺引用的小节继续搜"作为 finder 的循环条件。
- **不足**：需要自部署大模型（4×80G）；研究代码。
- **复用判断**：Apache-2.0；标签格式直接借鉴。

### TauricResearch/TradingAgents

- https://github.com/TauricResearch/TradingAgents · ⭐ 121.1k · Apache-2.0 · Python · 最近 push 2026-11-04 · 本地克隆 @ 9fa1196
- **一句话**：模拟交易公司：分析师（market / news / sentiment / fundamentals）→ bull / bear 研究员辩论 → research manager 裁决 → trader → aggressive / conservative / neutral 风控三方辩论 → portfolio manager 拍板。
- **团队怎么定义**：代码，按目录分部门（`tradingagents/agents/analysts|researchers|managers|trader|risk_mgmt`）；配置 `max_debate_rounds`、`max_risk_discuss_rounds`（`default_config.py:133`）。
- **协调与合并**：`graph/conditional_logic.py:12-26`：bull / bear 交替发言，`count >= 2 * max_debate_rounds` 后交给 Research Manager；风控三方 `3 * max_risk_discuss_rounds`。每个决策者输出结构化 schema（`agents/schemas.py`：`ResearchPlan{recommendation, rationale, strategic_actions}`、`TraderProposal{action, entry_price, stop_loss, ...}`、`PortfolioDecision{rating, executive_summary, investment_thesis, ...}`、带 `confidence` 的 `SentimentReport`）。
- **核对机制**：对抗式辩论 + 第三方裁决；`memory/reflection.py` 在真实收益结算后反思并写入记忆。
- **来源与引用**：数据来自 `dataflows/` 的 API，无 claim 级引用。
- **HITL**：无。
- **状态与 resume**：`graph/checkpointer.py`：每个 ticker 一个 SQLite（LangGraph `SqliteSaver`），`thread_id = ticker:date[:signature]`，**signature 折入影响图形状的运行选项，图变了就不能沿用旧 checkpoint**（docstring，issue #1089）。
- **和我们 roadmap 的关系**：核对（辩论模式）、resume。
- **值得借鉴**：①"正反方 + 裁判"适合决策类任务（选品、签证）；②裁判输出结构化决定 + rationale；③**checkpoint 的 key 要包含团队结构版本**，锁定团队改版后旧 run 不可 resume；④结果事后对照真实结局再反思（我们的"每周 diff"）。
- **不足**：辩论轮数写死；辩论双方同模型，独立性有限（定位稿已引用约 60% 同错率）。
- **复用判断**：只借鉴。

### 核对工具：Libr-AI/OpenFactVerification（Loki）

- https://github.com/Libr-AI/OpenFactVerification · ⭐ 1.2k · MIT · Python · 最近 push 2024-10-03（停更）· 本地克隆 @ 6e1ee9e
- **一句话**：开源事实核对流水线：分解 claim → 判断是否值得核对 → 生成查询 → 检索证据 → 逐条判定。
- **流水线**：`factcheck/__init__.py:82-146`：①`Decompose.getclaims` + `restore_claims`（把 claim 映射回原文位置）；②`CheckWorthy.identify_checkworthiness`（带理由）；③`QueryGenerator`（"验证这个 claim 最少需要问哪些问题"）；④`Retriever` 抓证据；⑤`ClaimVerify` 对每条证据判 stance。
- **数据结构**（`factcheck/utils/data_class.py`）：`Evidence{claim, text, url, reasoning, relationship}`；`ClaimDetail{id, claim, checkworthy, checkworthy_reason, origin_text, start, end, queries, evidences, factuality}`。`relationship ∈ {SUPPORTS, REFUTES, IRRELEVANT}`（`factcheck/utils/prompt/chatgpt_prompt.py:101-129`）。claim 的 factuality = SUPPORTS /（SUPPORTS + REFUTES），无证据时为 "No evidence found."，不值得核对时为 "Nothing to check."（`__init__.py:155-197`）；汇总报告统计 checkworthy / supported / refuted 数。
- **值得借鉴**：几乎可以照搬成我们的 claim schema（见第 3 节）；"不值得核对"是独立状态，避免 checker 在主观句上浪费 token。
- **复用判断**：MIT，可直接借用 schema 和 prompt；停更，不作依赖。

### 核对工具：google-deepmind/long-form-factuality（SAFE）

- https://github.com/google-deepmind/long-form-factuality · ⭐ 0.7k · Apache-2.0（主体）+ MIT（`third_party/factscore`）· Python · 最近 push 2026-06-18 · 本地克隆 @ 9d27158
- **一句话**：SAFE：把长回答拆成 atomic facts，判断与问题是否相关，再让 LLM 多步 Google 搜索，判 Supported / Not Supported（`eval/safe/rate_atomic_fact.py:28-65`，`max_steps=5`、每次 3 条结果，`eval/safe/config.py`）；F1@K 指标。
- **值得借鉴**：checker 的"多步搜索后判定"循环和步数上限；先过滤与问题无关的 fact。
- **复用判断**：可作评测依赖。

### 核对工具：Ayanami0730/deep_research_bench（FACT）

- https://github.com/Ayanami0730/deep_research_bench · ⭐ 0.8k · Apache-2.0 · Python · 最近 push 2026-09-29 · 本地克隆 @ f2735b5
- **一句话**：DeepResearch Bench（100 个博士级任务）；其中 FACT 评测引用准确率和有效引用数。
- **流水线**（`run_benchmark.sh:72-93`）：`utils.extract`（从报告抽 (fact, ref_idx, url) 三元组，一条 fact 引了多篇就拆成多条，`utils/extract.py:18-58`）→ `deduplicate` → `scrape`（抓网页）→ `validate`（`utils/validate.py:12-51`：先看参考页是否有有效内容，"page not found" 之类则所有 statement 判 **unknown**；否则部分或全部能找到判 supported（数字允许四舍五入），否则 unsupported）→ `stat`。
- **值得借鉴**：这条流水线就是我们 checker harness 的骨架，而且天然可做 M0 评测；"页面无效 → unknown 而不是 unsupported"这一区分很关键。
- **复用判断**：Apache-2.0，可直接作 M0 评测依赖。

### 论文工具：urlhealth（arXiv 2604.03173）

- Rao, Wong, Callison-Burch，"Detecting and Correcting Reference Hallucinations in Commercial LLMs and Deep Research Agents"，2026-04。
- 方法：检查引用 URL 是否可访问；不可访问的再查 Wayback Machine，**从未归档 = hallucinated，曾归档 = stale（link rot）**；给 agent 配上这个工具后，不可解析的引用 URL 降到 1% 以下（效果取决于模型的工具使用能力）。论文称工具开源，但 arXiv 页面没有给出仓库链接，GitHub 和网页搜索也没找到 *(unverified：是否已公开)*。
- 相关：DeepFact（arXiv 2603.05912，Duke + Amazon）指出只对照被引来源会漏掉"来源本身过时或有争议"的情况 *(unverified：未读代码)*；DeepCitation/skills（0 stars，MIT）是调用其商业验证 API 的 Claude Code skill，不算开源核对实现。
- **值得借鉴**：URL 健康检查是确定性代码，应由我们的 harness 做，不交给 LLM；三态 `live / stale / hallucinated` 直接进 evidence 对象。

---

## 2. 横向观察

1. **团队格式**：ChatDev 2.0 与 MS AF 声明式 YAML 证明了"非程序员也能读的团队文件"可行，但两者都是**图**；我们的 kit 是**组织**（Lead → 角色，组内并行）。我们应保留组织视角作为主格式，再编译成图（stage → 边），而不是让用户画图。
2. **经理**：好的经理设计有三个共同点：只派活不干活（crewAI）、每轮输出结构化自检（Magentic ledger）、派活受硬约束（open_deep_research 并发上限、MetaGPT "唯一信息源"）。
3. **审查**：所有框架的审查都在"产出者的上游上下文"里进行（同一 state、同一消息池），没有一个强调 clean context；独立性只在 ChatDev 的 `clear_context` 边上偶然出现。
4. **证据**：MAS 框架里的引用全是 prompt 约定（`[n]` + References）；claim 结构只存在于核对工具和评测里。这印证了定位稿：**H4 是空位**。
5. **HITL**：已有成熟的统一语义："暂停点 = 可序列化状态 + 带类型的请求 + 有限的响应选项"。我们的收件箱只需选定一种 schema（建议对齐 LangGraph `HumanInterrupt` 和 OpenAI `ToolApprovalItem` 的并集）。
6. **resume**：框架的 checkpoint 都是"进程内图状态"。我们的 agent 是外部会话，resume 粒度只能是"角色产出文件 + 会话 id"。TradingAgents 的"结构签名"值得照抄。

---

## 3. 可借鉴到我们团队设计 v2 与核对机制的要点

### 3.1 团队设计 v2：概念清单

在现有 `mas/structure.js`（`lead / groups / roles{serves, job, tools, group, handsTo, why}`）上增量扩展，保持 Markdown 可读。

| 概念 | 建议字段 | 含义 | 来源 |
|---|---|---|---|
| **role** | 保留 `id, name, emoji, job, serves, why`；新增 `output`（产出格式 / 验收句） | 一个岗位 = 一个职责 + 一份可检验的输出约定 | crewAI `expected_output`、自然语言 `guardrail`（`task.py:262`）；MetaGPT `goal / constraints` |
| **stage**（替代 group） | `stages: [{id, label, after, mode}]`，`mode ∈ parallel / sequential / map / debate` | 组内怎么跑：并行、顺序、按列表扇出（每个子项一个实例）、正反辩论 | ChatDev `dynamic: map/tree`；Agno `TeamMode.broadcast/tasks`；TradingAgents bull / bear |
| **handsTo + carry** | `handsTo: "<role>"`，`carry: full / summary / files-only` | 交接时下游看到多少上下文；checker 默认 `files-only` | ChatDev 边上的 `carry_data / keep_message / clear_context`；OpenAI `input_filter`；supervisor `output_mode` |
| **backend** | `backend: claude-code / codex / claude-p / codex-exec`，`model` 可选 | 每个角色由哪种会话执行；跨厂商 checker 由此表达 | ChatDev 每节点 `provider / name`；MS AF `packages/claude`；Eigent `remote_sub_agent` |
| **tools / permissions** | `tools: [{name, allow / ask / deny, when?}]`，外加角色 `profile: read-only / ask / auto-review / full` | 工具白名单，加逐工具的审批模式；`when` 是条件（例如只有下单动作才问） | MS AF `approvalMode` + `allowedTools`；Eigent `PolicyEffect` 与四个 profile；OpenAI `needs_approval` 谓词 |
| **lead 约束** | `lead.tools: []`（默认不持有搜索工具）、`lead.maxParallel`、`lead.ledger: true` | Lead 只派活和写结果；并发硬上限；每轮写 progress ledger | crewAI "Manager agent should not have tools"；open_deep_research 并发上限；MS AF Magentic ledger 与 `max_stall_count` |
| **reviewerOf** | 在 checker 上写 `reviewerOf: [role ids]`、`cleanContext: true` | 显式的"谁审谁"，面板画审查线；checker 不继承被审者的上下文 | ChatDev `clear_context`；定位稿 Cognition 结论；MetaGPT `_watch` 订阅上游产出 |
| **review loop** | `review: {verdicts: [accept, revise, escalate], maxRounds: 2, onExceed: ask-human}` | 返工轮数有上限，超过就进"需要你"，**不静默放行** | MetaGPT LGTM / LBTM ×k；GPT Researcher accept / revise（以及它 force-accept 的反例）；ChatDev keyword 边 |
| **recovery** | Lead 处理举旗时只能从 `retry / reassign / replan / split / ask-human` 中选，并写入事件 | 让"返工"可枚举、可视化、可统计 | CAMEL `RecoveryStrategy` 与 `TaskAnalysisResult` |
| **gates** | `gates: [{after: "<stage>", kind: plan / stage / final / tool, options: [accept, edit, respond, skip], blocking: required / audit}]` | 阶段之间的人工检查点；`audit` = 不阻塞只留痕 | MS AF `with_plan_review`；GPT Researcher planner 后的 human 节点；ChatDev `type: human`；LangGraph `HumanInterruptConfig`；Agno `required / audit` |
| **gate 回复解析** | gate 接受自由文本，由 Lead 归类成 `options` 之一 | 用户在抽屉里随便说，系统仍能确定性路由 | crewAI `@human_feedback(emit=[...], llm=...)` |
| **自动接受** | `autoAccept: {when: "all claims supported", maxRuns: 4, expires: "2026-12-31"}` | 定期重跑的团队，有边界地免审 | Agno `AutoAccept{required_checks, limits}` |
| **版本签名** | `structure.signature = hash(stages, roles, backends, tools)`，写进 run 与 checkpoint | 团队改版后旧 run 不可 resume，只能对比 | TradingAgents `thread_id(..., signature)` |
| **pending 状态** | 每个 gate 和审批都是可序列化的 pending 对象（谁、什么、选项、上下文），关机后可继续 | 收件箱的持久后端 | OpenAI `RunState.to_json` + `interruptions`；crewAI `HumanFeedbackPending` / `from_pending`；LangGraph checkpointer |

Markdown 视图示例（`mas/structure.md` v2 片段）：

```markdown
## 🛡️ Catch checker
- serves: R2
- job: Check every offer the finders return
- reviewer of: New-price finder, Marketplace finder
- clean context: yes (sees only work files and source cards)
- backend: codex
- tools: web search (allow) · browse the web (allow)
- stage: B · hands to: Lead
- review: up to 2 rounds, then ask me
## Gates
- after A: show me the offers before checking (accept / edit / skip)
- final: approve the shortlist
```

### 3.2 claim / evidence / verdict 模型

```text
claim    {id, text, span{start,end} in result.md, serves: R?, author: role,
          checkworthy: bool, checkworthyReason, sources: [evidenceId]}
evidence {id, sourceCard, url, quote (verbatim), relationship: supports|refutes|irrelevant,
          reasoning, grade: A–D, gradedBy, urlHealth: live|stale|hallucinated|blocked, fetchedAt}
verdict  {claimId, checker, backend, status: supported|partial|contradicted|unknown|not-checkworthy,
          method: fetched-page|search|file, steps, note}
```

| 设计点 | 理由 | 来源 |
|---|---|---|
| Lead 写结果时用内联标签包住陈述：`<claim id="c3" src="currys-xm6">…</claim>`，渲染时去掉 | claim 在生成时就有 span 和来源，不靠事后 LLM 抽取；抽屉可以逐句高亮 | WebWeaver `<qwen:cite id=…>`（`write_prompt_multi_hop_2.py:96`）；Loki `ClaimDetail.start/end` |
| checker 流水线：抽取 (claim, source, url) → 去重 → 抓页面 → 逐条判定 → 汇总 | 与 M0 评测共用同一套代码 | FACT `run_benchmark.sh:72-93` |
| 判定前先判 checkworthy | 主观句、建议句不核对，节省 token | Loki `CheckWorthy` |
| evidence 必须带原文引语（verbatim quote） | 我们的 source card 已有 `> "…"`，把它变成判定的依据 | STORM `Information.snippets`；Loki `Evidence.text` |
| relationship 三值 + reasoning | 可以展示"这条来源为什么支持 / 反驳" | Loki `SUPPORTS / REFUTES / IRRELEVANT` |
| 页面无效时判 `unknown`，不判 contradicted | 区分"来源坏了"和"来源反对" | FACT `validate.py:13, 40` |
| URL 健康由 harness 确定性检查，并区分 stale / hallucinated | 编造链接是可以低成本根除的错误 | urlhealth（arXiv 2604.03173） |
| checker 允许多步搜索，但有步数上限 | 既能找反例，又不失控 | SAFE `max_steps=5` |
| 汇总指标：supported 比例、contradicted 数、unknown 数、坏链率、"找到但没用上的来源"数 | 结果抽屉顶部的"可信度条"；也是 M0 的评测指标 | Loki 汇总；FACT 引用准确率 / 有效引用；Co-STORM Moderator 的"未引用片段" |
| 决策类任务可选 `debate` stage：正反两方各自举证，裁判输出结构化 decision + rationale，并引用 claim id | 决策不是事实，靠对抗暴露盲点 | TradingAgents `schemas.py`、`conditional_logic.py` |
| checker 的 verdict 由 Lead 原样转发进结果（不转述） | 避免 Lead 改写 checker 的结论 | langgraph-supervisor `create_forward_message_tool` |
| contradicted 或 unknown 超过阈值时自动进入"需要你" | management by exception | Agno `audit / required`；OpenAI interruptions |

### 3.3 协议 0.2 可直接映射的事件

参考 Eigent 的 action 枚举和 Magentic 事件，建议新增：`task.assigned{role, task, attempt}`、`lead.ledger{satisfied, looping, progressing, next, instruction}`、`review.verdict{reviewer, target, verdict, round}`、`recovery.chosen{strategy}`、`gate.pending{gate, options, context}` / `gate.resolved{choice, text}`、`claim.added`、`evidence.checked{urlHealth}`、`verdict.recorded`；面板 → agent 方向：`gate.respond`、`task.add / skip / supplement`、`run.pause / resume`。

---

## 4. 对比表

| 项目 | ⭐ | License | 活跃度 | 团队定义格式 | 协调者 | 审查 / 核对 | 来源与引用 | HITL | 持久化 / resume | 对我们最有用的一点 |
|---|---|---|---|---|---|---|---|---|---|---|
| MetaGPT | 71.2k | MIT | 放缓（2026-01） | Python 类 + `_watch` 订阅 | TeamLeader 点名派活 | LGTM / LBTM ×k | 无 | `is_human` 角色 | `Team.serialize` / `--recover-path` | Lead 是唯一信息源；订阅 action 类型 |
| ChatDev 2.0 | 34.7k | Apache-2.0 | 活跃 | **YAML 图**（节点 + 边） | 拓扑；manager 只是节点 | keyword 边（APPROVE）；多数投票 | prompt `[n]` | `type: human` 节点 | 仅 WS 重连快照 | 边上的 `carry_data / clear_context`、`dynamic: map/tree` |
| crewAI | 60.6k | MIT | 活跃 | YAML（role / goal / backstory）+ Python | hierarchical manager（禁止持有工具） | Task guardrail（函数或自然语言），重试 3 次 | 无 | `human_input`；`@human_feedback(emit, llm)`；异步 pending | checkpoint、Flow `@persist` | 经理不持有工具；自由文本 → 路由 |
| CAMEL Workforce | 18.0k | Apache-2.0 | 活跃 | Python，worker 一句描述 | coordinator 拆解 + 结构化分派（含依赖） | `TaskAnalysisResult` + 恢复策略 | 无 | pause / resume、改任务队列 | 内存 snapshot | `RecoveryStrategy` 枚举 |
| OWL | 20.2k | Apache-2.0 | 活跃 | 两角色 RolePlaying | user agent 指挥 | prompt 自检 | 无 | 无 | 无 | finder prompt 规则 |
| Eigent | 15.8k | Apache-2.0 | 活跃 | 动态生成（不可设计） | CAMEL Workforce | 继承 CAMEL | 无 | 任务确认、`ask`、权限 profile | run journal（SQLite） | 双向 action 协议；allow / prompt / deny |
| MS Agent Framework | 14.6k | MIT | 活跃 | 代码 + 声明式 YAML | Magentic progress ledger | 经理自评 | 无 | plan review、`with_request_info`、`approvalMode` | `FileCheckpointStorage` | ledger 五字段 + stall → replan |
| LangGraph (+supervisor) | 44.6k / 1.7k | MIT | 活跃 / 归档 | 代码 | `transfer_to_*` 工具；`Send` | 无 | 无 | `interrupt()` + `Command(resume)`；`HumanInterruptConfig` | checkpointer、time travel | 收件箱按钮 schema；原样转发 |
| OpenAI Agents SDK | 30.5k | MIT | 活跃 | 代码 | agents-as-tools / handoffs | input / output / tool guardrail（阻断） | 无 | `needs_approval` 谓词 → interruptions | `RunState.to_json` | 可序列化的审批；sticky 作用域 |
| Agno | 43.1k | Apache-2.0 | 活跃 | 代码；company 支持 YAML | `TeamMode` coordinate / route / broadcast / tasks | eval / guardrails | 无 | `@approval` required / audit | DB | audit 级审批；有限额的 AutoAccept |
| GPT Researcher | 30.5k | Apache-2.0 | 活跃 | 代码 + `task.json` | editor 并行章节 | 章节 reviewer / reviser；整稿 fact checker | visited_urls | planner 后 human | 无 | 计划 gate；反例：超限静默放行 |
| STORM / Co-STORM | 31.8k | MIT | 停更 | 代码 | turn policy；Moderator | grounded QA | `Information{url, snippets}` | 人随时插话 | `to_dict / from_dict` | 未引用证据 → 新问题 |
| open_deep_research | 12.7k | MIT | 归档 | 代码 + config | `ConductResearch` 工具、并发上限 | 无 | compress 时按 URL 编号 | 澄清问题 | LangGraph | 派活工具硬约束 |
| Tongyi DeepResearch / WebWeaver | 20.1k | Apache-2.0 | 放缓（2026-02） | 代码 | planner ↔ writer | 无 | **`<qwen:cite id>` 包住陈述** | 无 | 无 | 生成时就带 claim span |
| TradingAgents | 121.1k | Apache-2.0 | 活跃 | 代码，按部门目录 | 辩论 → manager 裁决 | bull / bear 与三方风控辩论；事后反思 | API 数据 | 无 | SQLite + 结构签名 | 辩论 stage；checkpoint 带结构签名 |
| Loki | 1.2k | MIT | 停更 | — | — | 分解 → checkworthy → 检索 → stance | `Evidence{url, text, relationship}` | — | — | **claim / evidence schema** |
| SAFE | 0.7k | Apache-2.0 | 低频 | — | — | atomic fact 多步搜索 | 搜索结果 | — | — | 步数上限的 checker 循环 |
| DeepResearch Bench FACT | 0.8k | Apache-2.0 | 活跃 | — | — | extract → scrape → validate（supported / unsupported / unknown） | (fact, ref, url) | — | — | checker harness 与 M0 评测骨架 |
| urlhealth（论文） | — | 未找到仓库 | — | — | — | URL 存活 + Wayback | stale vs hallucinated | — | — | 确定性坏链检查 |

## 附：主要来源

- 各仓库路径见正文；metadata：`gh api repos/<owner>/<repo>`（2026-11-07）。
- urlhealth：https://arxiv.org/abs/2604.03173
- Cited but Not Verified（引用支持率 39–77%）：https://arxiv.org/abs/2605.06635
- DeepFact：https://arxiv.org/abs/2603.05912
- Co-STORM：https://arxiv.org/abs/2408.15232
- SAFE：https://arxiv.org/abs/2403.18802
