# MAS Office 开发日志

这份日志记录 MAS Office 从创建到 v0.2.1 的全部改动、原因、验证证据，以及已经讨论过的产品方向和下一步计划。版本细节以 `CHANGELOG.md` 为准，这里补充 changelog 写不下的背景：为什么这样改、怎么验证的、还剩什么风险。

- 项目目录：`~/Documents/mas-office`（GitHub：`weixijia/mas-office`，npm：`mas-office`）
- 网站：https://www.xijiawei.com/mas-office/
- 最后更新：2026-11-07（最新 tag `v0.2.2`，npm `latest` = 0.2.2）

---

## 0. 项目定位与目录

| 项目 | 位置 | 定位 |
|---|---|---|
| **MAS Office**（本仓库） | `~/Documents/mas-office` | 面向所有开发者的开源版：协议 + SDK + CLI + 面板 + no-code kit |
| awesome-mas | `~/Documents/IDE_Tutorial_Personalized_Harness/awesome-mas` | 课堂版，给非程序员学生用，保持简单 |

- 2026-11-07 把 MAS Office 从 `IDE_Tutorial_Personalized_Harness/mas-office` 移到 `~/Documents/mas-office`，两个版本彻底分开。外层 `IDE_Tutorial_Personalized_Harness` 也是 git 仓库，但 mas-office 在里面一直是未跟踪目录，搬走对它没有影响。
- **课堂版不同步新功能**（用户 2026-11-07 确认）：0.2.x 的结果抽屉、追问、浏览器、状态行都只在 MAS Office。

主要目录：

```
spec/            协议 0.1：README、JSON Schemas、conformance cases
packages/node/   npm 包 mas-office：JS SDK + CLI（bin/mas-office.js，src/cli/commands/*）
packages/python/ Python SDK mas_office（含 OpenAI Agents / LangGraph / Claude Agent SDK 集成，PyPI 未发布）
panel/           面板：index.html、app.js（UI）、model.js（纯函数）、office.js（等距办公室绘制）、tests/
kit/             no-code kit：AGENTS.md、SETUP.md、harness/、.claude/、.mcp.json
examples/        3 个完整示例（price-compare、trip-planning、thesis-feasibility）
site/            项目网站（GitHub Pages）
.omc/            本地运维产物（git 忽略）：发布规则、验证脚本、打包产物、截图
```

---

## 1. 版本时间线

| 日期 | Commit | 版本 | 内容 |
|---|---|---|---|
| 2026-11-06 | `b76497b` | 0.1 | 协议、SDK、CLI、实时面板（328 个文件） |
| 2026-11-06 | `a3ad143` | | Python 最低版本改为 3.10（3.9 已 EOL，CI runner 也没了） |
| 2026-11-06 | `d7bf6a9` | | JS SDK 和 CLI 合并成一个 npm 包 `mas-office` |
| 2026-11-06 | `7748805` | | README：demo GIF、logo、各框架代码片段、对比表，新增中文 README |
| 2026-11-06 | `bb4bb88` | | 项目网站上线，嵌入实时办公室示例 |
| 2026-11-06 | `9dca283` | **v0.1.1** | 修复办公室随状态忽大忽小 |
| 2026-11-07 | `57350ac` | **v0.2.0** | 结果抽屉 + kit 追问（follow-up rounds） |
| 2026-11-07 | `ae92c25` | **v0.2.1** | kit：角色浏览器、终端状态行、安全加固 |
| 2026-11-07 | `2696fbf` | | 开发日志、路线图重写 |
| 2026-11-07 | `61d4ab9` | **v0.2.2** | 修复结果抽屉不弹出；README / 网站 / 演示 GIF 更新 |

npm 发布：0.1.0、0.1.1、0.2.0、0.2.1、0.2.2 都已公开，账号 `simonwxj`。PyPI 尚未发布。

---

## 2. v0.1.0 — 第一个公开版本

来源：awesome-mas 火了以后，用户要求开一个面向所有开发者、方便贡献的新仓库。设计取舍：

- **定位**：MAS Office 不是编排框架，而是 **protocol + visualizer**。框架或 coding assistant 负责执行 agent，SDK/kit 写事件或快照，reducer 计算状态，面板画出办公室。
- **协议 0.1**（`spec/`）：工作区目录结构；快照文档（JSON + `.js` 双胞胎文件，以便 `file://` 直接打开）；append-only 的 `events.jsonl`，18 种事件 + `custom.*`，映射到 AG-UI、OpenTelemetry GenAI、A2A；确定性的 reducer；JSON Schemas；8 个 conformance cases，Node 和 Python 两个 reducer 必须输出一致。
- **包**：npm 只用一个名字 `mas-office`（SDK + CLI 合一，不用 scoped 包），由用户决定。Python 包同名，尚未上 PyPI。
- **CLI**：`demo`、`serve`（SSE 实时推送）、`init`（`--kit`）、`validate`、`reduce`、`export --ag-ui`、`hook claude-code`。
- **集成（实验性）**：OpenAI Agents SDK、LangGraph、Claude Agent SDK、Claude Code hooks。
- **Kit**：awesome-mas 的 AGENTS.md no-code 模式。
- **README / 网站**：按热门开源项目的写法重写 README；网站用 design skills 做成与面板一致的"纸和墨水的工程图纸"风格（Archivo + Red Hat Mono），避免 AI 味。

---

## 3. v0.1.1 — 办公室忽大忽小的 bug

**现象**：`npx mas-office demo` 时，办公室随着小人活动一会大一会小。

**根因**（不是小人位置影响取景，`office.js` 的取景只依赖静态的工位布局）：
1. 顶部状态 headline 换行时 `.status` 高度变化，flex 布局里绘图区高度跟着变，`ResizeObserver` 触发重新 fit。
2. 结果出现时自动给 body 加 `wide-side`，右侧栏变宽，绘图区变窄，再次重新 fit。

**修复**：
- `panel/style.css`：给 `.status` 一个固定的响应式高度（`overflow-y: auto`，长名字在框内滚动而不是放大缩小图）；窄屏单独一档。
- 删除 `body.wide-side` 及 `app.js` 里三处自动切换。结果显示、手动开关侧栏都保留。
- 运行中新增角色（demo 里的 `fee-scout`）引起的一次合法重新布局保留。

**验证**：
- 无头 Chrome（CDP，独立 profile）在 1440/1024/768/390 四个宽度采样：固定阵容下每个宽度 51 个样本，办公室多边形和宿主尺寸完全一致；真实 CLI demo 下 5 人和 6 人阵容各自稳定。
- 新增 source-contract 测试 `panel/tests/model.test.js`（不是浏览器测试，浏览器证据见 `.omc/office-motion-check.mjs`）。
- 独立 review 无实质问题；CI、Pages 通过；从 tarball 全新安装验证。

---

## 4. v0.2.0 — 结果抽屉 + 追问

用户反馈：结果都挤在右侧栏里；希望能基于结果继续问，由 Lead 理解后把活派回给相关角色，而不是跑完一次就结束。

用户选择：文件续接（不依赖 Claude Code 特有的续聊）、按轮叠加显示、每个新结果自动滑出一次。

### 4.1 面板：结果抽屉
- `index.html` 新增 `#drawer`：从右侧滑出、半透明（`color-mix` + `backdrop-filter`）、侧边视图 / 全屏切换、Esc 关闭、轮次标签跳转。
- 抽屉是浮层（`.sheet { position: relative; overflow-x: clip }` + `.drawer { position: absolute }`），**打开、全屏、关闭都不改变办公室尺寸**。
- 右侧栏保留一张短卡片 + "Open result" 按钮。
- 自动弹出规则 `M.drawerDue`：页面打开着时新到的结果或新一轮才自动滑出一次；打开页面时已存在的结果只显示卡片（网站 iframe 嵌入不被盖住）；`?demo=1` 的演示不自动弹出，保留派对动画。
- 抽屉 key = run + round；办公室（派对动画）仍按 run 计，一个 run 只开一次派对。追问结束后派对装饰恢复（`office.js`）。
- `M.resultRounds`：解析多轮结果，轮次号单调递增，坏数据跳过。

### 4.2 Kit：follow-up 操作（`kit/harness/operations.md`）
- 有结果后，学生用自然语言提问。Lead 重读任务、结果、各角色产出，判断：已有产出能答（不派人）/ 需要现有角色继续做（只派最少的角色，若该角色交给 checker 就连 checker 一起派）/ 现有角色做不了（建议 `unlock`）/ 另一个任务（建议 `new`）。
- 派人前问一次 "Send them back to work?"。
- 被派回的角色仍是干净上下文的新 subagent，用一份完整的 follow-up brief：先读自己的 `outputs/work/<role>.md`，只把本轮新内容写到 `outputs/work/<role>-round<K>.md`，原文件不动。
- 旧一轮的答案存档到 `outputs/rounds/run<N>-round<K>.md`；`result.js` 写入 `round`、`question`、`previous`。

### 4.3 协议
- `result` 新增可选字段 `round`、`question`、`previous`（schema 已更新）。**reducer 暂不生成这些字段，也还没有 conformance case**——以后 SDK 支持追问时，两个 reducer 要一起改并补 case。

### 4.4 验证
- 无头 Chrome 四个宽度：抽屉打开 / 全屏 / Esc 时办公室多边形和宿主尺寸不变；实时到达自动滑出、同一结果不重复弹出、追问进行中收起、新一轮到达时跳到新答案、失败且没有新结果时旧结果不会被当成新的弹出、窄屏关闭后焦点回到 Title block 按钮、demo 不自动弹出。脚本在 `.omc/drawer-check/`。
- 独立 code review 的 4 个中等问题和若干小问题全部修复（已打开时新轮次定位、窄屏焦点、无派人路径的步骤跳转、follow-up brief 输出文件冲突、peek 里的链接可聚焦、轮次号重复等）。
- npm 83、面板 53、Python 93 全过；tarball 全新安装、registry 安装验证。

---

## 5. v0.2.1 — 角色浏览器、终端状态行、安全加固

### 5.1 诊断：subagent "权限不够" 的真实原因
用户在 `~/Documents/masoffice_test`（flight-helper，机票助手）实测后反馈 subagent 权限不够。分析会话记录后的结论：
- 三个干活的 subagent 共 400+ 次工具调用，**没有一次权限拒绝**，只有 3 次网络错误。
- 它们只用了 `WebSearch` 和 `WebFetch`。kit 的工具词表只有 `web search`，所以每个角色只加载这两个。
- `WebFetch` 抓不了反爬或 JS 页面，抓取结果里合计 25 次 403：日本外务省、驻爱丁堡领馆、爱尔兰签证页、Skiplagged、airportia 等。
- 当时会话里有 chrome-devtools、browsermcp 等浏览器 MCP，但没人告诉角色可以用。
- 另外发现：`masoffice_test` **从未被信任**，kit 的 allow 规则当时其实没生效（用户应该开着 bypass 一类的模式）。

### 5.2 角色浏览器 `mas-browser`
- `kit/.mcp.json`：项目级 MCP server，`npx -y chrome-devtools-mcp@1.12.0`（精确版本）。参数：`--isolated`（临时 profile，不带用户登录）、`--fileNavigations=false`、`--javascriptEvaluation=false`、关闭 performance/emulation/memory/network 类工具和使用统计。
- **必须有界面（headed）**：实测无头 Chrome 打开日本外务省是 "Access Denied"，Skiplagged 是 "Just a moment..."；有界面的 Chrome 都能正常读到。所以运行时会弹出一个 Chrome 窗口。
- `kit/.claude/settings.json`：`enabledMcpjsonServers: ["mas-browser"]`，allow `mcp__mas-browser__*`，deny `upload_file`、`screencast_*`、`lighthouse_audit`。
- 工具词表新增 `browse the web`（`harness/formats.md`），`roles.md` / `operations.md` 告诉 Lead 何时分配；setup 实测浏览器并写 `canBrowse` 到 `home/env.js`（`env.schema.json` 已加字段）。
- 面板为新工具加了图标。

### 5.3 终端状态行（解决"只看终端、忘了看网页"）
- `kit/.claude/mas-statusline.mjs`，配置在 `statusLine`（`refreshInterval: 2`）和 `subagentStatusLine`。
- 主状态行两行：MAS 名 · 标题 · 阶段 · 完成数 · 旗标数 · 可点击的 "office ▸ / result ready ▸ open office" 链接；第二行是 Lead 和按组排列的每个角色（状态符号、进度）。
- subagent 行：按名字或描述匹配到角色，显示状态、进度条、当前动作或旗标、token 数。
- 只读 kit 的数据文件，**不执行**：线性切片 + `JSON.parse`，不用 eval。

### 5.4 安全加固（来自独立安全审查，7 项全部修复）
1. **嵌套 `CLAUDE.md` 持久注入（高）**：角色写 `outputs/CLAUDE.md` 会变成 Lead 的指令。现在 deny `Edit(**/CLAUDE.md)`、`**/CLAUDE.local.md`、`**/AGENTS.md`、`**/GEMINI.md`、`**/SETUP.md`、`**/.claude/**`、`**/.mcp.json`、`~/.claude/**`、`~/.claude.json`。
2. **浏览器绕过文件权限写盘（中）**：`take_snapshot`/`take_screenshot` 的 `filePath` 由 MCP server 进程写盘，不经过 Claude Code 权限。新增 PreToolUse hook `kit/.claude/mas-guard.mjs`，带 `filePath` 就 exit 2 拦截。
3. **能访问本机和局域网（中）**：`--blockedUrlPattern` 只能精确匹配主机名，拦不住网段。最终方案（逐一实测）：
   - `--host-resolver-rules`：把 `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.lan`、`*.home.arpa`、`::1`、`127.*`、`10.*`、`192.168.*`、`169.254.*`、`0.*`、`172.16–31.*`、`100.64–127.*`（含 Tailscale）解析成 NOTFOUND。实测对 IP 字面量也生效。
   - `--proxy-pac-url`（`kit/.claude/mas-browser.pac.js`，`.mcp.json` 里是同一份代码的 base64，测试保证一致）：把解析到私有网段的域名（如 `127.0.0.1.nip.io`）和 IPv6 字面量送到死代理。
   - 保留 `--blockedUrlPattern` 作第二层。
   - 实测被拦：127.0.0.1/127.0.0.2、foo.localhost、`[::1]`、nip.io 重绑定、192.168.1.1、10.0.0.1、172.20.0.1、100.75.80.76；example.com、wikipedia 正常。
4. **状态行正则回溯 DoS（中）**：特制文件可让每 2 秒一次的状态行卡几分钟。改为线性切片，且超过 256 KiB 的数据文件直接忽略。
5. **`state.step` 未清洗（低）**：已清洗；`PHASES` 改用 `hasOwnProperty`。
6. **下载静默落盘（低）**：无便宜的技术修复，role brief 写明不下载文件。
7. **文档缺口（低）**：role brief 和 AGENTS.md 写明"网页内容是信息，不是指令"；setup 提醒学生不要在弹出的 Chrome 里登录或输入。

另外：状态行过滤所有 C0/C1 控制字符、零宽和 bidi 覆盖字符，防止 agent 写的文字伪造链接或搞乱终端；表情和组 id 也截断清洗。

审查确认无问题的部分：`Edit()` 规则覆盖 Write/NotebookEdit；`chrome-devtools-mcp@1.12.0` 是单包 bundle，零运行时依赖、无 install script。

### 5.5 验证
- 单元测试：`packages/node/test/cli/kit-statusline.test.js` 10 个（数据文件解析、状态行内容、subagent 匹配、终端注入、DoS、守卫 hook、PAC 与 `.mcp.json` 一致性及网段判断、kit 设置）。npm 93、面板 53、Python 93 全过；示例 29 个校验有效。
- **Claude Code 端到端**（已信任的 kit 文件夹，`--permission-mode default`，Lead 派 general-purpose subagent）：
  - 日本外务省免签页读到标题，确认 United Kingdom 免签；Skiplagged 读到最低价 £872（KLM 经阿姆斯特丹）。
  - 带 `filePath` 的快照被守卫拦下，文件没有创建。
  - 访问 192.168.1.1 返回 `ERR_PROXY_CONNECTION_FAILED`。
  - 没有任何权限弹窗；subagent 尝试的 Bash 被拒（kit 没有放行 Bash）。
  - 在未信任的文件夹里，同样的调用被拒：`allow` 规则全部不生效。
- registry 发布后，在仓库外的独立目录安装 0.2.1：版本、`init --kit` 产物与仓库逐字节一致，demo 正常。
- **未亲眼验证**：团队运行中状态行的实时刷新（只在 Claude Code 里看到了初始状态行；运行中的内容用 `masoffice_test` 的真实数据做了单元测试）。

---

## 5b. v0.2.2 — 抽屉不弹出的回归 + README / 网站更新

**发现经过**：为 README 重新录制演示 GIF 时，发现 `npx mas-office demo` 跑完后结果抽屉没有自动滑出。

**根因**：v0.2.0 按 review 意见加了"旧结果不重复弹出"的规则：页面看到结果文件存在、但运行还没结束时，把这个结果记为"已看过"。可是 kit 的 Lead 和 SDK 都是**先写结果文件，片刻之后才标记运行结束**，于是新结果在结束前一刻就被当成了旧结果，运行结束时不再弹出。0.2.0 的浏览器测试把两个文件在同一刻写入，所以没测出来。

**修复**（`panel/app.js`）：
- 只有"页面第一次看到时就已存在、且尚未就绪"的结果才算旧结果（`S.seenKeys`），其余按 key 判断是否新。失败且没写新结果时，旧结果仍不会被当成新的弹出。
- 结果就绪约 2.5 秒后才滑出（`DRAWER_DELAY`），让团队收工的小派对先露个脸；期间用户手动操作、切换项目或结果变化都会取消。
- 只有一轮结果时不再显示 "ROUND 01" 标签。
- 浏览器检查脚本改为按真实顺序写入：先写结果、3 秒后再标记完成，并验证完成前不弹出、完成后弹出、旧结果不弹出、窄屏焦点、demo 不自动弹出。

**文档与网站**：
- README 中英文：介绍里结果改为"滑出、浮在办公室上方"；无代码模式加上追问；路线图一节改为新方向（M0–M4）；中文 README 新增路线图一节；引用版本号更新。
- 演示 GIF 重新录制（1440×900 采集、缩放到 960×600、7fps、约 23 秒）：团队工作 → 小派对 → 结果抽屉滑出。
- 网站：示例说明、代码注释、no-code 一节（加入追问、状态行、浏览器）、FAQ（npm 已发布、新增"接下来做什么"）、结果截图换成抽屉打开的样子；修正 no-code 一节命令框上方没有间距的问题。1440 与 390 宽度截图检查，无横向滚动。

## 6. 发布流程与注意事项

规则缓存在 `.omc/RELEASE_RULE.md`（git 忽略），要点：
1. 四处版本同步：`packages/node/package.json`、`package-lock.json` 的 `packages["packages/node"].version`、`packages/python/pyproject.toml`、`packages/python/src/mas_office/__init__.py`。协议版本 `SPEC_VERSION = "0.1"` 不随包版本变。
2. 门禁：`npm test`（SDK/CLI + 面板）、`PYTHONPATH=packages/python/src python -m pytest packages/python`、`node packages/node/bin/mas-office.js validate examples`、`git diff --check`。
3. `npm pack ./packages/node --pack-destination .omc`，在**仓库外**的目录安装 tarball 验证（仓库内安装会被 workspace 解析到本地包，验证无效——0.2.1 发布时踩过这个坑）。
4. commit 用 `git commit -s`（DCO），带 `Co-Authored-By`；打 annotated tag `vX.Y.Z`。
5. push 用 weixijia 账号且不切换全局 gh 账号：
   `GH_TOKEN=$(gh auth token -u weixijia) git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --atomic origin main vX.Y.Z`
6. 等 CI（Node 18/20/22，Python 3.10/3.12/3.13）和 Pages 通过。
7. `npm publish .omc/mas-office-X.Y.Z.tgz --access public --tag latest`，发布**同一个**验证过的 tarball。
   - 需要用户在浏览器完成 npm 2FA；认证会话约两分钟过期，过期会报 `404 GET /-/v1/done?authId=…`。
   - npm 登录过期时 `npm publish` 报 `E404 PUT`，`npm whoami` 也会失败；用 `npm login --auth-type=web` 重新登录。
   - 不要索要、记录或使用验证码和 recovery codes。
8. 发布后用 `npm view mas-office@X.Y.Z dist.shasum --prefer-online` 和 `dist-tags` 核对，再做仓库外的 registry 安装验证。

其他坑：
- 搬目录后 Python 旧 `__pycache__` 记着旧路径，导致 `test_invalid_emits_warn_once_per_problem_and_never_raise` 失败（比较 warning 的文件名）。清掉 `packages/python` 下的 `__pycache__`（已被 git 忽略）即可。
- `.omc/` 下的验证脚本（`office-motion-check.mjs`、`drawer-check/check.mjs`、`mcp-probe/*.mjs`）和临时 kit 目录 `.omc/kit-e2e/` 都不入库。

---

## 7. 测试环境

- `~/Documents/masoffice_test`：用户的 kit 测试文件夹，有一个 MAS `flight-helper`（机票助手，3 个角色，已跑过 1 次）。已更新到 0.2.1，并于 2026-11-07 被信任；`mas-browser` 状态为 Connected。
- `~/Desktop/mas-office-openai-test`：用 Codex（ChatGPT 订阅登录）测试 kit 的文件夹；旧的 OpenAI API 测试归档在 `.previous-openai-api-test/`。其 README 的面板命令已改为 `npx mas-office@latest serve …`。
- `~/Documents/mas-office/.omc/kit-e2e`：用于 Claude Code 端到端测试的 kit 目录。注意：为测试接受信任时，Claude Code 把信任记在 git 根目录上，所以整个 `~/Documents/mas-office` 处于已信任状态。

---

## 8. 产品方向（2026-11-07 讨论结论）

用户目标：把 MAS Office 从"可视化"升级为**真正能驱动多 agent 的工具**。经过三轮调研（各系统怎么给 lead/subagent 分配工具权限；agent harness 架构与订阅条款；多 agent 编排器与终端/桌面 UI），结论如下。

### 8.1 不再造一个完整的单 agent harness（如 pi）
- 单 agent harness（pi、Claude Code、Codex、OpenCode）这一类我们拼不过，也没必要拼。
- **订阅条款**：Anthropic 明文禁止第三方产品使用或代转用户的 Claude 订阅凭证（2026 年封堵过伪装 Claude Code 的工具，OpenCode 被要求移除 Claude 订阅支持）。pi 的 Claude 登录用的是伪装 Claude Code 的方式，所以不能 fork pi 当引擎。用户用自己的订阅登录原版 `claude` 是明确允许的；由我们的产品去调用它，条款未明文禁止也未明文允许，属灰区，商用前需向 Anthropic 确认。OpenAI 已官方开放开源/本地应用通过 Sign in with ChatGPT 使用订阅额度。
- 参考：deepseek-ai/deepseek-harness（`dsh`，MIT）已有 Claude Code / Codex 两种 subagent 后端和带依赖的共享任务图，做 M0 前要读它的源码。

### 8.2 差异化
**一支你自己设计、看得见、会互相审查的研究团队，用的是你已经有的 AI 订阅。**

现有工具分三类，都不覆盖这一点：单 agent harness；并行编排器（Claude Squad、Conductor、Vibe Kanban、Codex app——多个独立任务 + worktree）；可视化（pixel-agents，只画已有会话）。MAS 的独有能力：团队设计并锁定、分组分阶段、checker 干净上下文独立审查（可用另一家模型）、证据卡片与 A–D 证据等级、Lead 汇总、按需派人的多轮追问、过程可视化与回放、不绑定单一厂商。

**首要场景：研究与决策类任务**（比价、规划、文献可行性、选型、政策/签证核查）。对标对象因此是各家 Deep Research 产品与 GPT Researcher、STORM，而不是并行编排器。

### 8.3 目标架构
- **自研 MAS 编排内核**：团队设计 v2（每个角色：后端 + harness）、按组和依赖调度、checker 返工、追问轮次、预算与超时、每个角色只能写自己的文件、事件日志（即现有协议）支持回放和断点续跑。
- **每个角色一个独立进程**，调用户本机的官方 agent：`claude -p --output-format stream-json`、`codex exec --json` / Codex app-server、gemini CLI stream-json、ACP 适配器；API key 场景可把 pi-ai 只当库用并关掉它的 Claude 登录。
- **Lead 由用户选的 coding agent 担任**，通过 mas MCP server 的工具（`design_team`、`lock_team`、`run_group`、`dispatch_role`、`followup`、`read_artifact`…）来编排；现有 kit 可平滑迁移过去。
- **技术栈：TypeScript**（Claude Code、Gemini CLI、pi、OpenCode、dsh 都是 TS；网页、桌面、VS Code 扩展都顺）。Python 保留给 SDK 集成和评测。
- **交互原则：对话和办公室永远在同一个窗口里。** 终端版 `mas`（对话 + 半字符块像素小办公室）、桌面版（对话 + 等距办公室 + 结果抽屉）、留在 Claude Code 的用户用状态行（0.2.1 已做）。共用一个事件模型（由 `model.js` 抽出）。桌面版倾向 Tauri 包现有网页面板，放后面。

### 8.4 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | kit：角色浏览器、终端状态行、权限与信任说明 | ✅ v0.2.1 |
| M0 | 评测框架（同一批研究任务：单 agent vs MAS 团队 vs Deep Research 参照；准确率、来源等级、checker 抓错数、成本）；`claude -p` 和 `codex exec` 两个后端适配器验证；对话+办公室同屏的终端界面原型；读 dsh 源码 | 下一步 |
| M1 | `mas run`：团队设计 v2、调度器、每角色 harness、checker 返工、追问、断点续跑；混用两种订阅端到端跑通 | 待评测数据后定 |
| M2 | mas MCP server，Claude Code / Codex 当 Lead，kit 迁移 | |
| M3 | `mas` 终端完整界面、网页面板可操作（审批、追问、停止、重跑） | |
| M4 | Tauri 桌面版、跨厂商 checker 默认化、评测集可复现 | |

`ROADMAP.md` 已于 2026-11-07 按这个方向重写（英文，对外）：定位与原则、已发布内容、M0–M4、以及仍然欢迎贡献的 producer/协议条目。

### 8.5 按角色强制工具权限（P1，方案已出、待确认）
- 现状：`tools` 只是写进角色说明的文字，运行时角色都是 general-purpose subagent，没有强制。
- 方案：团队设计加 `harness` 字段（固定词表：`web search`、`browse the web`、`read my files`、`mcp:<server>`、`cli:<命令前缀>`、`skill:<name>`），由 CLI 确定性地编译成各工具的 agent 定义（Claude Code 的 `.claude/agents/*.md`：`tools`/`disallowedTools`/`mcpServers`/`hooks`/`permissionMode`），按 `subagent_type` 调用；不让 LLM 自己写 agent 文件，防注入。
- 已知限制：Claude Code 会话中途新建的 agent 文件要重启才加载；Codex 自定义 agent 改不了 sandbox，只能继承 parent；所有系统都只有 session 级规则，没有"启动时为某个 subagent 预批准"。
- 待用户定：`cli:` / `mcp:` 是自由填写还是只能从白名单里选。

### 8.6 决策记录（按时间）

下面记录讨论中每个关键问题：当时有哪些选项、最后怎么定的、为什么。"用户"指项目负责人。

| # | 时间 | 问题 | 考虑过的选项 | 最终决定 | 理由 / 用户原话 |
|---|---|---|---|---|---|
| 1 | 11-06 | 课堂版之外要不要开新仓库 | 在 awesome-mas 上扩展 / 新开开发者版 | 新开 **MAS Office**（公开仓库 `weixijia/mas-office`），awesome-mas 保留为课堂版 | 用户："面向所有开发者的，所有功能更全，且充分考虑大家的贡献" |
| 2 | 11-06 | 产品形态 | 编排框架 / 协议 + 可视化 | 协议 + JSON Schema、Python/JS SDK、CLI、本地实时服务、no-code kit | 当时定位为"任何框架都能接的那扇窗" |
| 3 | 11-06 | npm 包名 | scoped 包 / 拆分 SDK 与 CLI / 一个名字 | 只用 `mas-office` 一个名字 | 用户："npm 用 mas-office 吧" |
| 4 | 11-07 | 结果信息挤在右栏 | 加宽右栏 / 浮层抽屉 | 浮在办公室上方、略透明、可全屏的结果抽屉（0.2.0） | 用户："从右边展开…稍微一点点 transparent 浮动于办公室上方" |
| 5 | 11-07 | 追问时怎么把活派回去 | **文件续接**（新的干净 subagent 读自己上一轮产出）/ Claude Code 的 SendMessage 续聊 | 文件续接 | 任何工具都能用、关掉会话也能续、checker 保持独立 |
| 6 | 11-07 | 追问答案怎么呈现 | **按轮叠加** / 每次当新 run 替换 | 按轮叠加（`round`、`question`、`previous`） | 能前后对照 |
| 7 | 11-07 | 结果何时弹出 | **自动滑出一次** / 只给按钮 | 自动滑出一次；0.2.2 起延迟约 2.5 秒，先让小派对露脸 | 打开页面时已有的结果只显示卡片 |
| 8 | 11-07 | 0.2.0 怎么发布 | 发 0.2.0 / 只 push / 先不提交 | commit + push + 发 npm 0.2.0 | 新功能 + 协议新增可选字段，按 semver 升 minor |
| 9 | 11-07 | 课堂版要不要同步新功能 | 同步 / 不同步 | **不同步** | 用户："课堂版不用更新"；同时把 MAS Office 移到 `~/Documents/mas-office`，两个版本彻底分离 |
| 10 | 11-07 | 角色级 harness（每个角色能用哪些 MCP、CLI、插件、hooks） | 只写在说明里（现状）/ 编译成各工具的 agent 定义并强制 | 方案已出（见 8.5），细节待定 | 用户追问"subagent 好像权限不太够"，调研后发现主因不是权限而是工具太弱（见 5.1） |
| 11 | 11-07 | 项目目标 | 继续做可视化 / 做成真正能驱动多 agent 的工具 | **升级为能驱动多 agent 的工具** | 用户："不是一个单纯的可视化，而是一个真正能驱动多 agent 的一个更有实力的工具" |
| 12 | 11-07 | 执行核心怎么做 | 两种都做（kit 托管 + 独立运行时）/ 只做独立运行时 / 只增强 kit | 用户提出更大的设想：做"我们自己的 MAS agent"，能调用用户手上多个 coding agent 订阅；终端里有 RPG 风格的小人（类似 Claude Code pet），也能打开网页；或像 Claude / ChatGPT 桌面版那样的应用；参考 pi、deepseek harness，但不能丢掉 MAS 的核心优势 | 由此展开第二、三轮调研（harness 架构与订阅条款；多 agent 编排器与终端/桌面 UI） |
| 13 | 11-07 | 要不要再造一个完整版的 pi | 再造完整单 agent harness / fork pi / 做成 dsh 插件 / 自研编排层、角色调官方 agent | **不再造 pi；自研 MAS 编排层，每个角色调用户本机的官方 agent** | 用户："我们应该先明白产品差异化"。单 agent 拼不过；fork pi 会继承伪装 Claude Code 的登录方式（ToS 风险最高）；做 dsh 插件会被它的架构限制 |
| 14 | 11-07 | 首先服务哪类任务 | **研究与决策类** / 软件工程类 / 两类都要 | 研究与决策类 | 证据和独立审查是单 agent 与并行编排器最弱的地方，也延续 awesome-mas 的优势；软件工程类会和 Claude Code agent teams、Conductor 正面竞争 |
| 15 | 11-07 | 对话和可视化分在两个窗口 | — | **对话和办公室永远在同一个窗口** | 用户："有的用户说，他就看 terminal 了，根本忘了看 web"。短期在 Claude Code 状态行显示团队（0.2.1），长期做同屏的终端版和桌面版 |
| 16 | 11-07 | 编排内核和界面用什么语言 | TypeScript / Python / Rust / Go | **TypeScript**（Python 保留给 SDK 集成和评测） | 用户："哪种语言最主流，被 Claude、Codex、pi 用得多，还得考虑后期封装成 webapp、mac app"。Claude Code、Gemini CLI、pi、OpenCode、dsh 都是 TS；网页、桌面、VS Code 扩展都顺 |
| 17 | 11-07 | 先做什么 | **先做 P0**（浏览器 + 状态行）/ 先把方案写进仓库 / 直接做评测 | 先做 P0，再进 M0 | 马上改善实测里遇到的 403 和"忘了看网页"两个问题 |
| 18 | 11-07 | 角色浏览器用无头还是有界面 Chrome | 无头 / 有界面 | **有界面** | 实测无头 Chrome 被日本外务省、Skiplagged 等网站拦截，有界面的能读到 |
| 19 | 11-07 | 产品形态与差异化 | 满血 MAS / 单纯可视化 / 可审计研究团队 / 可交互的 AI 公司 | **一家看得见、管得住、会互相把关的 AI 公司**：每个员工是一个真实的 Claude Code 或 Codex 会话；像《模拟人生》加 RTS 那样点小人聊天、批准；CEO 读结构化事件流。护城河是统一的"需要你"收件箱、CEO 事件流、锁定的组织和逐角色权限、claim 级核对与证据分级、低成本引导 | 用户："像玩《模拟人生》一样点击每一个 NPC……取所有项目的最优解，做出最易用、最符合 HCI 的产品"。调研证伪了"只有我们能可视化"（pixel-agents 10k⭐、munder-difflin 9.4k⭐），见 `docs/research/positioning.zh-CN.md`、`docs/research/landscape/SYNTHESIS.md` |
| 20 | 11-07 | Claude 订阅合规 | 风险高需另走 API key / 按条款走用户自己的登录 | **低风险，守住 7 条规则**（根目录 `CLAUDE.md` §3） | 用户追问"为什么会有合规风险，看看 pi、dsh、Orca"。条款明文允许平台运行未修改的 Claude Code、由用户自己登录；禁止的是提取 OAuth、冒充官方客户端（pi 的做法） |
| 21 | 11-07 | 自研还是复用 | 自己实现 / 复用开源代码 | **复用优先**：参考代码放 `references/`（74 个仓库，固定 commit，`fetch.mjs` 可复现），复用地图 `docs/design/reuse-map.md` 逐组件写明读哪些文件、怎么复用、license 依据 | 用户："完全可以复用已经开源的优质项目的代码，把精力花在整合和提高竞争力上" |
| 22 | 11-07 | 原始终端（xterm.js + node-pty）放哪 | 放进 `mas-office` / 单独的可选包 | **单独的可选包**，`mas-office` 保持零依赖 | 用户："只要学生下载下来能复用就行" |
| 23 | 11-07 | 根目录 `CLAUDE.md` 是否会影响 kit | — | 不影响学生：`init --kit` 只复制 `kit/`。仓库内的 `.omc/kit-e2e` 会继承开发者指令，以后 kit 端到端测试改在仓库外的目录进行 | 同上 |

明确放弃的方向与原因：
- **Fork pi 当引擎**：它的 Claude 订阅登录伪装成 Claude Code，正是 Anthropic 条款明文禁止的做法；而且多 agent 要从头补。
- **以 Claude Code 自带的 agent teams 为底座**：`claude -p` 非交互模式下不生成队员，只支持 Claude，没有"锁定的团队设计"。
- **Lead 也自己写 agent 循环**：Lead 就需要 API key 或 Sign in with ChatGPT，工作量最大，换来的控制力用不上。
- **先做软件工程场景**：与现有工具正面竞争，体现不出独立审查和证据的优势。
- **完全自研模型接入层**：订阅只能走官方程序，自研 provider 层在订阅上没有优势。

### 8.7 尚未决定的问题

- 独立运行时先接哪些后端：推荐 `claude -p` + `codex exec`（直接用订阅，不需要 API key），pi 和各家 SDK 放后面。
- 面板要不要变成可操作的控制台：推荐只在 `mas-office serve` 加本地 token 时开放审批、追问、停止、重跑，`file://` 和网站嵌入保持只读。
- 角色权限词表里 `cli:` / `mcp:` 是自由填写，还是只能从已配置的 MCP server 和预审过的命令白名单里选（推荐后者）。
- 是否把部分能力做成 deepseek-harness 插件：先读源码再定。
- 评测集具体选哪 8–10 个任务、怎么做人工抽查。
- ~~由我们的产品调用用户本机的 `claude -p`，在 Anthropic 条款里属于灰区~~ → 已澄清，见决策 20。
- 终端小人用哪套视角和美术风格（建议俯视或侧视的半字符块像素风），以及桌面版用 Tauri 还是 Electron（倾向 Tauri）。

---

## 9. 已知问题与待办

- PyPI 尚未发布。
- 协议里 `round`/`question`/`previous` 没有 conformance case，reducer 不生成。
- 浏览器会弹出可见的 Chrome 窗口；下载无法技术拦截，只靠 brief 约束；DNS 解析到私有 IPv6 的域名未覆盖。
- 状态行运行中的实时刷新尚未在真实运行中亲眼确认。
- Codex / Antigravity 下没有状态行和 `mas-browser`（目前只在 Claude Code 生效），是否有对应机制未核实。
- `render()` 里抽屉"何时弹出"的状态机只有浏览器脚本测过，没进单元测试。
