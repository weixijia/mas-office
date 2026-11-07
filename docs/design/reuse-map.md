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

## 维护规则

- 新增参考项目的步骤：
  1. 写进 `references/manifest.json`（填 `tier`、`components`）；
  2. 运行 `node references/fetch.mjs`；
  3. 在对应组件的章节里写明：读哪些文件、用哪种复用方式、怎么改造。
- 改编了代码后，在对应章节里标注"已改编到 `<我们的文件>`"，并登记 `THIRD_PARTY_NOTICES.md`。
- 升级 pin 的命令是 `node references/fetch.mjs --update`。升级后要复核地图里引用的路径是否还在。
