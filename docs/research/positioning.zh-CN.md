# MAS Office 定位与差异化（讨论稿）

- 日期：2026-11-07
- 状态：讨论稿，待用户决定（见第 7 节）
- 方法：5 路并行调研，分别覆盖可视化竞品、coding agent harness 的多 agent 能力、MAS 框架与并行编排器、Deep Research 与 super agent、多 agent 何时有效的证据。star 数用 GitHub API 现查；未从一手来源确认的标 *(unverified)*。

---

## 1. 结论先行

1. **"功能最全的 MAS"不是差异化。** 编排、并行、subagent、跨厂商、用订阅跑 CLI，这几项都已经有成熟的免费实现：Claude Code workflows / agent teams、oh-my-claudecode、Conductor、dsh。在"功能更多"这条路上，我们拼不过 Anthropic 和 OpenAI 的原生能力。
2. **"可视化是我们独有的"这个说法不成立。** 像素或等距办公室已经有十几个项目：pixel-agents 有 10k stars，最近几天仍在提交，roadmap 写着 handoff 和 orchestrator；W17ant/Claude-Office 也是等距办公室，带 inspector 和权限审批。单靠视觉层，护城河很弱。
3. **真正没人占的位置是"可审计"。** 一个用户自己设计、锁定的研究团队：并行的 finder 加上下文干净的独立 checker，每一条结论都挂到一张分级证据卡和 checker 的核对结果上，整个过程看得见，可以重跑、可以对比。Deep Research 类产品只做到给结论挂引用（attribution），不做独立核对；论文测得被引来源真正支持结论的只有 39–77%。
4. **建议定位**：从"给多 agent 系统做可视化"或"满血 MAS"，转为 **"一支看得见、会互相核对的研究团队：每个结论都告诉你凭什么"**。可视化是这件事的窗口，不是产品本身。

---

## 2. 竞品全景：用户今天会拿什么替代我们

| 类别 | 代表 | 它们已经做到的 | 它们缺的（对我们而言） |
|---|---|---|---|
| **A. coding agent harness 自带的多 agent** | Claude Code（subagents、agent teams、**dynamic workflows + `/deep-research`**）、Codex（custom agents、app-server）、Gemini CLI、OpenCode、Kiro、Cursor | 并行 fan out、adversarial verify、claim 投票、带引用的报告、存成命令复用、`/workflows` 进度视图；每个 subagent 可单独设 tools、model、permissions | 只有单一厂商（Claude 官方原话："the workers are Claude sessions"）；运行中不能插入人工确认；没有由人设计并锁定的团队；没有用户可见的分级证据对象；没有跨 harness 的视图 |
| **B. 并行编排器** | oh-my-claudecode（40.7k）、Conductor（据称被 Meta 收购 *(unverified)*）、Claude Squad、Vibe Kanban（公司已关停）、**dsh**（以真实 Claude Code / Codex 作为子进程）、**Orkas**（9.1k，面向终端用户的桌面 app） | 跨厂商、用用户自己的订阅调 CLI，这已是标配 | 几乎都是"N 个独立的编码任务各占一个 worktree"，不是分工协作、互相审查的团队；不做研究和决策任务（Orkas 部分例外） |
| **C. MAS 框架** | CrewAI（60k）、LangGraph（44k）、OpenAI Agents SDK、MS Agent Framework、Agno、ADK、MetaGPT、ChatDev、CAMEL | 用代码定义团队，自带 tracing 和调试 UI | 只面向开发者；需要 API key；没有一等公民的 checker 和证据分级；UI 只给工程师看 |
| **D. Deep Research 与 super agent** | ChatGPT / Gemini / Claude Research、Perplexity Computer、Manus Wide Research、Genspark、Kimi Swarm、GPT Researcher、STORM | 一句话出报告，便宜、快、能在手机上用；**都已经支持定时任务**；Manus 和 Kimi 能跑几百个 sub-agent | 只做 attribution、不做核对；agent 拓扑是黑箱，每次都可能不同；用户不能设计角色；来源不分级；追问基本从头来过 |
| **E. 可视化** | pixel-agents（10k）、Star-Office-UI（7.5k）、Claw3D、claude-office、W17ant/Claude-Office、disler 的 observability、LangGraph Studio、Langfuse agent graphs；协议层有 AG-UI（17k） | 每个 agent 一个角色、实时动画、subagent 单独出现、卡住和失败的视觉提示、回放 | 几乎都只接 coding CLI；不表达角色语义（handoff、checker 举旗、证据）；不面向非工程师 |

**最大的两个威胁**

1. **Claude Code 的 `/deep-research` 和 dynamic workflows。** 我们 kit 的核心流程是"并行 finder → 独立 checker → Lead 写出带来源的结果"，用户在 Claude Code 里一条命令就能拿到其中 60–70%。我们的 kit 本身也跑在 Claude Code 上。
2. **dsh 和 Orkas。** dsh 已经占住 roadmap 里 `mas run` 的位置，即用真实的 Claude Code 和 Codex 作为子进程。Orkas 是最接近我们愿景的终端用户产品。

---

## 3. 什么时候才真的需要多 agent（决定目标用户）

**证据支持的不是"多 agent 更强"，而是一种特定的模式**：

- 广度任务可以拆成独立子问题时，Anthropic 内部评测 +90%；Google 在可并行任务上测得 +81%。
- 独立 checker 必须是干净上下文。Cognition 2026 修正了之前"不要多 agent"的立场，现在的说法是"单一写入者 + 干净上下文的审查者有效"；intrinsic self-correction 无效。
- 最终产物只能由一个 agent 写，也就是我们的 Lead。

**反面证据**：

- 收益的 80% variance 可以用 token 用量解释。
- token 预算相同时，单 agent 在 multi-hop 推理上持平甚至更好（Tran & Kiela 2026）。
- 顺序依赖强的任务，多 agent 会掉 39–70%。
- 没有 orchestrator 的独立 agent 会把错误放大 17 倍。
- 跨厂商的 checker 也不完全独立：两个模型都答错时，约 60% 选的是同一个错误答案。

**"值得用 MAS"的任务清单**（满足越多越值得）：

- [ ] 广度型，能拆成互相独立的子问题（多个实体、多个来源、多个假设）
- [ ] 一个 context 装不下
- [ ] 出错代价高，需要独立核对
- [ ] 最后由一个人或一个 agent 拍板写结论
- [ ] 任务的价值能覆盖大约 15 倍的 token 成本
- [ ] 会定期重跑、需要前后对比

**目标用户（按证据强度排序）**

| # | 用户 | 典型任务 | 他们拿来对比的 | 我们必须赢在 |
|---|---|---|---|---|
| 1 | **学术研究者和 PhD** | 文献扫描、related work、课题可行性、方法对比 | Elicit、Consensus、Undermind、Deep Research | 引用真实且确实支持结论；来源分级；可复现 |
| 2 | **做尽调和分析的知识工作者** | 供应商、竞品、市场扫描、政策研究 | Deep Research、Perplexity、Manus | 逐条可审计；团队可复用；每周 diff |
| 3 | **高代价的个人决策** | 签证与政策核查、大额选品、留学和租房 | ChatGPT 或 Gemini 加搜索 | checker 抓出价格过时、二手翻新、条款冲突，并给出证据等级 |
| 4 | **构建 MAS 的开发者**（次要） | 用 LangGraph、Agents SDK 写的 pipeline 做演示或调试 | Langfuse、LangGraph Studio、pixel-agents | 给非工程师看的语义视图；不绑定框架 |

**明确不做的**：多 agent 一起写代码（红海，证据也不支持）；几百个 agent 的规模；单步推理类任务。

---

## 4. 差异化假设逐条"替代测试"

替代测试问的是：用户换用别的工具，再加一段 prompt，能不能拿到 80% 的效果？能，就不算护城河。

| 假设 | 替代工具 | 能否替代 | 结论 |
|---|---|---|---|
| H1 直观的实时可视化 | pixel-agents、Claude-Office、`/workflows` 视图 | **能**（视觉层） | 不能当主卖点。语义化的那部分（handoff、checker 举旗、证据）仍然少见 |
| H2 用已有订阅、跨厂商 | OMC、Conductor、dsh、Claude Squad | **能** | 是前提，不是卖点 |
| H3 多 agent 编排（并行、分阶段） | Claude workflows、agent teams、Kiro | **能** | 不是卖点，应该站在它们之上 |
| H4 **独立 checker 加逐条核对加 A–D 证据分级** | `/deep-research` 有投票和 unverified 标记，但没有分级证据对象；DR 产品只做 attribution | **部分** | **核心差异化**，但要做深，并且有数据证明 |
| H5 **由人设计并锁定的团队，中间有人工 gate，可复用、可重跑对比** | workflows 运行中不能输入；teams 由 lead 自由发挥；DR 拓扑是黑箱 | **不能** | **核心差异化** |
| H6 **追问只派回需要的角色** | 只有 Manus 能"重研第 20–30 项" | **基本不能** | 差异化，体验上的亮点 |
| H7 跨厂商 checker（Codex 审 Claude） | 原生 harness 都没有；dsh 有底座但没有方法论 | **暂时不能** | 有价值，但要实测：错误相关性约 60%，必须配合对原始来源的 grounding |
| H8 开放协议、中立面板，能接 Claude workflows、Codex、LangGraph | AG-UI 是更大的标准 | **部分** | 定位为"审计层和视图层"，映射到 AG-UI，而不是另起一个标准 |

**护城河是这几项的组合**：H4 + H5 + H6 打底，H7 增强，H1 和 H8 负责呈现。单拿出任何一项，都能被复制。

---

## 5. 我们现在做到了哪一步

| 差异化 | 现状 | 缺口 |
|---|---|---|
| H4 核对与证据 | kit 已有 source cards、A–D 分级、checker 举旗（`flag.raised`）、结果里的 sources、flags 和 work | **还没有 claim 层面的结构**：结论 → 来源 → checker 判定（supported / contradicted / unverified）的对应关系目前只写在 markdown 里，没有结构化；没有 URL 存活检查；分级是 agent 自己报的，没人复核 |
| H5 锁定的团队 | kit 的 describe → design → refine → lock 已完成 | 角色的 tools 只写在说明文字里，没有强制执行（日志 8.5）；阶段之间没有人工 gate；团队设计还不能导出、分享、复用成模板 |
| H6 追问 | kit 0.2.0 已完成，结果按轮次叠加显示 | 协议和 reducer 还不生成轮次字段，也没有 conformance case |
| H7 跨厂商 | 无 | 需要 M0 的后端适配器 |
| H1 + H8 可视化与协议 | 面板、协议 0.1、4 个框架集成、Claude Code hooks、状态行都已完成 | 还不能接 Claude workflows 或 agent teams、Codex app-server；没有 AG-UI ingest |
| 证明 | **无** | 没有任何评测数据能证明"团队比单 agent 或 DR 更准" |
| 影响力 | 13 stars | pixel-agents 10k，Orkas 9k |

一句话总结：**H5 和 H6 已经领先；最关键的 H4 只做了一半；还完全没有证明。**

---

## 6. 建议

### 6.1 定位与对外表述

- 一句话：**"A research team you design, can watch, and that checks every claim."** 每个结论都告诉你凭什么、谁核过、可信到什么程度。
- 对外表述改成可以证伪的说法。不说"唯一能看到 agent 在干什么的工具"，改说"唯一把 checker 的核对和证据等级画在团队视图里、并能逐条审计的工具"。
- 重新排列 README 和网站的叙事：先讲"它为什么可信"（核对、分级、可复现），再讲"看得见"。

### 6.2 产品优先级（建议调整 M0 和 M1）

1. **把 H4 做深（最优先）**：
   - 协议 0.2 增加 `claim` 对象，包含 id、text、sources、grade、checker、verdict；
   - checker 必须逐条给出判定；
   - URL 存活和内容支持检查（论文显示这一步能把坏链从 5–18% 降到 1% 以下）；
   - 结果抽屉按 claim 展示，可以点开看来源和核对记录。
2. **M0 评测直接测差异化指标**：
   - 对比组：单 agent（**token 预算相同**）、MAS 团队、Claude `/deep-research`、ChatGPT / Gemini DR；
   - 指标：claim 被来源支持的比例、编造或失效的 URL 比例、checker 抓到的错误数、成本和时间；
   - 这份数据既是产品决策的依据，也是最有力的宣传材料。
3. **产品里内置"单 agent 对照"模式**：让用户在自己的任务上亲眼看到团队多抓出了哪些错。
4. **H5 做实**：
   - 团队设计可以导出成模板、分享（比如"文献可行性团队""签证核查团队"），这也是传播渠道；
   - 阶段之间加人工 gate；
   - 角色权限编译后强制执行（日志 8.5）。
5. **执行层不自己造，站在别人肩上**（见第 7 节问题 2）。

### 6.3 不做清单

- 不比功能数量，不追求"满血"。
- 不做编码类多 agent。
- 不比规模（几百个 agent），不比速度和便利性（DR 一句话就出结果）。
- 不在像素美术上跟可视化项目比拼。
- 不把"跨厂商"或"用订阅"当主卖点。

---

## 7. 需要你决定的问题

1. **是否接受重新定位**：从"满血 MAS 加可视化"转向"可审计的研究团队"，把可视化降为呈现层？
2. **执行层自己造还是借用**：
   - (a) 按现有 roadmap 自建 `mas run` 调度器；
   - (b) 把锁定的团队设计**编译**成 Claude Code workflow 脚本、Codex app-server 调用或 dsh 插件，我们只做团队设计、核对、证据和视图这一层；
   - 我倾向 (b)，或者先 (b) 后 (a)：Claude workflows 已经能并行和 resume，自己造很难超过它，而且也在灰区里。
3. **首要用户**：建议是学术研究者和做尽调的知识工作者（第 3 节的 #1 和 #2）。这个群体和你自己的背景重合，最容易拿到真实反馈和评测任务。

---

## 附：主要来源

- Anthropic multi-agent research system：https://www.anthropic.com/engineering/multi-agent-research-system
- Google, Towards a science of scaling agent systems：https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ ；arXiv 2512.08296
- Tran & Kiela, single vs multi-agent under equal thinking budget：arXiv 2604.02460
- Cognition, Don't build multi-agents / multi-agents working：https://cognition.com/blog/dont-build-multi-agents ；https://cognition.com/blog/multi-agents-working
- MAST failure taxonomy：arXiv 2503.13657
- 跨模型错误相关性：arXiv 2506.07962、2505.17656
- 引用支持率 39–77%：arXiv 2605.06635；编造 URL 和 URL 检查工具：arXiv 2604.03173
- Claude Code workflows / agent teams / sub-agents：https://code.claude.com/docs/en/workflows ，/agent-teams ，/sub-agents
- Anthropic 订阅条款：https://code.claude.com/docs/en/legal-and-compliance
- Codex subagents / app-server：https://learn.chatgpt.com/docs/agent-configuration/subagents ；https://openai.com/index/unlocking-the-codex-harness
- dsh subagent backends：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.md
- pixel-agents：https://github.com/pixel-agents-hq/pixel-agents ；W17ant/Claude-Office：https://github.com/W17ant/Claude-Office
- Orkas：https://github.com/Orkas-AI/Orkas ；oh-my-claudecode：https://github.com/Yeachan-Heo/oh-my-claudecode
- GPT Researcher multi-agents：https://docs.gptr.dev/docs/gpt-researcher/multi_agents/langgraph ；STORM / Co-STORM：arXiv 2408.15232
