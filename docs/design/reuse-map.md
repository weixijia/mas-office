# 复用地图（Reuse map）

动手做任何组件之前，先查这份地图：先确认哪些开源项目已经把这件事做好了，读它们的哪几个文件，能直接依赖、改编代码，还是只能借思路。原则见根目录 [`CLAUDE.md`](../../CLAUDE.md) §2。

- 参考代码在 `references/repos/<owner>__<repo>/`，固定在 [`references/manifest.json`](../../references/manifest.json) 记录的 commit 上。缺失时运行 `node references/fetch.mjs`。
- 地图里引用的文件路径，都对应 manifest 里固定的 commit。
- 依据：调研笔记 [`docs/research/landscape/`](../research/landscape/)，综合结论见 [`SYNTHESIS.md`](../research/landscape/SYNTHESIS.md)。

## 复用方式

| 方式 | 含义 | 前提 |
|---|---|---|
| **依赖** | 作为 npm 或 PyPI 依赖使用，不复制源码 | 给已发布的包加运行时依赖是设计决策，需要先讨论 |
| **改编** | 复制后修改代码 | 只限 MIT、Apache-2.0、BSD、ISC。文件头写明 `Adapted from <repo>@<sha> <path> (<license>)`，并登记到 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)；Apache-2.0 还要带上它的 NOTICE |
| **只借思路** | 按设计重新实现，不复制代码 | 以下情况一律只借思路：没有 license、AGPL/GPL、有排除条款的 license、美术素材另有限制 |

## 组件索引

| ID | 组件 | 文档 |
|---|---|---|
| C1 | Claude 会话 adapter（Agent SDK、权限回调、插话、resume） | [runtime.md](reuse-map/runtime.md) |
| C2 | Codex 会话 adapter（app-server、审批、`turn/steer`、thread resume） | [runtime.md](reuse-map/runtime.md) |
| C3 | 可观看、可接手的终端（PTY、xterm.js、SDK 与 TUI 之间的交接） | [runtime.md](reuse-map/runtime.md) |
| C4 | 卡住检测与待决交互模型 | [runtime.md](reuse-map/runtime.md) |
| C5 | 协议 0.2（`request.*`、`command.*`、ack、inbox 快照） | [runtime.md](reuse-map/runtime.md) |
| C6 | Daemon / server（事件日志、命令路由、SSE、持久化、续跑） | [runtime.md](reuse-map/runtime.md) |
| C7 | CEO / 协调者（事件唤醒、进度账本、停滞检测、代理批准） | [runtime.md](reuse-map/runtime.md) |
| C8 | 组织设计与权限编译器 | [runtime.md](reuse-map/runtime.md) |
| C9 | "需要你"收件箱 | [experience.md](reuse-map/experience.md) |
| C10 | 办公室视图（渲染、交接线、RTS 提醒、编组快捷键、CEO 总览） | [experience.md](reuse-map/experience.md) |
| C11 | Agent 抽屉（结构化记录、聊天框、终端 tab、产出） | [experience.md](reuse-map/experience.md) |
| C12 | 核对与证据（claim / evidence / URL health / verdict） | [experience.md](reuse-map/experience.md) |
| C13 | 研究型角色的工具（搜索、浏览） | [experience.md](reuse-map/experience.md) |
| C14 | 评测（准确率评测与 HCI 实验记录） | [experience.md](reuse-map/experience.md) |
| C15 | 打包与发布（Web 优先，桌面壳的选择） | [experience.md](reuse-map/experience.md) |
| C16 | 远程 / 手机端控制 | [runtime.md](reuse-map/runtime.md) |

## 实现状态（v0.3.0，2026-11-10）

| ID | 状态 | 我们的文件 | 还没做的 |
|---|---|---|---|
| C1 | 已实现 | `packages/runtime/src/backends/claude.js` | interrupt 未在真实 Claude CLI 上验证 |
| C2 | 已实现 | `packages/runtime/src/backends/codex.js` | 把官方 Codex TUI 接到同一个 thread |
| C3 | 未开始 | （计划：可选包 `mas-office-terminal`） | 全部 |
| C4 | 已实现 | `packages/runtime/src/engine/project.js`（停滞检测）、`broker.js`（待决请求） | — |
| C5 | 已实现 | `spec/rfcs/0001-protocol-0.2.md`，两个 reducer，conformance 09–16 | — |
| C6 | 已实现 | `packages/node/src/cli/server.js`、`packages/runtime/src/index.js` | daemon 重启后重新接上待批准的请求（目前只能过期重问） |
| C7 | 已实现 | `packages/runtime/src/engine/project.js`、`prompts.js`，`packages/node/src/policy/` | 每个角色完成后给 Lead 的事件摘要 |
| C8 | 已实现 | `packages/node/src/team/` | `teamFromMarkdown` |
| C9 | 已实现 | `panel/inbox.js`、`panel/app.js` | — |
| C10 | 部分实现 | `panel/office.js`、`panel/app.js`、`panel/inbox.js`（reviewer 连线、举手和等待计时、`N`、屏幕边缘指针、`1–9` 打开阶段） | CEO / 总控概览（目前只有 Lead 进度账本的一行摘要） |
| C11 | 部分实现 | `panel/app.js`（记录、产出、聊天、Stop） | 终端 tab（依赖 C3） |
| C12 | 已实现 | `packages/node/src/verify/`、`packages/runtime/src/engine/project.js` | — |
| C13 | 沿用 kit | `kit/.mcp.json`（`mas-browser`），词表 `browse the web` 编译到 `packages/node/src/team/compile.js` | — |
| C14 | 框架已实现 | `eval/` | 评测运行、用户研究 |
| C15 | 未开始 | — | 桌面壳；npm 0.3.0 待发布 |
| C16 | 未开始 | — | 全部 |

### 已改编

代码改编自以下来源，文件头都写了 `Adapted from …`，详见 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)：

| 组件 | 来源（固定 commit 见 THIRD_PARTY_NOTICES） | License | 改编到 |
|---|---|---|---|
| C12 | `assafelovic/gpt-researcher` `gpt_researcher/scraper/scraper.py` | Apache-2.0 | `packages/node/src/verify/url-health.js`（`looksBlocked`、`looksLikeWordList`、`looksLikeUnextractedPdf`） |
| C12 | `Alibaba-NLP/DeepResearch` 的写作和搜索提示词 | Apache-2.0 | `packages/node/src/verify/prompts.js`（`leadWriteupRules`、`finderRules`） |
| C12 | `Ayanami0730/deep_research_bench` `utils/validate.py` | Apache-2.0 | `packages/node/src/verify/prompts.js`（`checkerRules`） |
| C12 | `Libr-AI/OpenFactVerification` `factcheck/utils/prompt/chatgpt_prompt.py` | MIT | `packages/node/src/verify/prompts.js`（`checkerRules`） |
| C9 | `AgentSystemLabs/agent-office` `needsyou/logic.ts`、`nextup.ts`、`ui/compass.ts` | MIT | `panel/inbox.js`（`waited`、`waitKey`、`NextUp`、`edgeMarks`） |
| C9 | `paperclipai/paperclip` `ui/src/lib/blockedInbox.ts` | MIT | `panel/inbox.js`（`compareRequests`） |
| C9 | `KbWen/agent-virtual-office` `src/inference/desktopNotifier.js` | MIT | `panel/inbox.js`（`shouldNotify`）、`panel/app.js`（`notifyTick`） |

## 维护规则

- 新增参考项目的步骤：
  1. 写进 `references/manifest.json`（填 `tier`、`components`）；
  2. 运行 `node references/fetch.mjs`；
  3. 在对应组件的章节里写明：读哪些文件、用哪种复用方式、怎么改造。
- 改编了代码后，在对应章节里标注"已改编到 `<我们的文件>`"，并登记 `THIRD_PARTY_NOTICES.md`。
- 升级 pin 的命令是 `node references/fetch.mjs --update`。升级后要复核地图里引用的路径是否还在。
