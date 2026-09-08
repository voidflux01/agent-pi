# 驾驶舱命令 — 真实使用场景分析

> 各命令小节为初判分析；**最终定案见文末「汇总（终版）」**，以终版为准。
> 已执行删除见提交记录：`371c49f`（agents-grid / agents-clear / pipeline-clear / theme）。

判定图例：**留** = 该命令对应真实驾驶动作（按代码接线 / 仓库基建证据成立，且驾驶中会触发）
**删** = 无真实驾驶场景，纯外观/布局/一次性/调试残留
**悬置** = 功能真实存在，但触发频次只有实际驾驶者能定（我无法从代码证明高频）

场景里的角色/团队/流水线均取自本仓真实定义：
- 角色：`scout` `researcher` `ranger` `planner` `builder` `reviewer` `paladin` `warden` `knight` `tester` `herald` `documenter` `red-team` `network-scout` `port-scan-analyst` `security-news-analyst`
- 团队（`agents/teams.yaml`）：`code-review` `docs` `quality` `research-plan-build` `plan-build` `investigate` `refactor` `team-b-builders` `toolkit`
- 流水线（`agents/pipeline-team.yaml`）：`plan-build-review` `research-plan-build-review` `plan-build` `auto-build-report`(D21 自动推进)
- 链式：`agent-chain.yaml`

---

## A. 多 agent 驾驶

### `/sub` — 派一个子代理
**场景**：正在 `code-review` 团队跑审某 PR，`reviewer` 报"这段用 `eval` 解析 YAML 有注入风险"。你想让第二个视角同时核一遍，不等团队收尾：按 `/sub 独立审计 extensions/parse-pipeline-yaml.ts 的 YAML 解析是否有注入面，输出 findings` → 开 SA3 widget 并行跑，你切去改别处。
**真实性**：派活是驾驶主动作，`agents/` 有几十个角色可派 → **留**

### `/subcont` — 续聊某子代理
**场景**：SA3 审完给了 findings，你追问细节但不想重新派："SA3 里第 2 条 eval 调用，给出复现输入和最小修复 diff"。直接 `/subcont 3 展开第 2 条并给修复 diff`，不开新进程、上下文不丢。
**真实性**：追问/迭代是常态 → **留**

### `/subresume` — 续跑持久化子代理
**场景**：跑到一半 `pi` 崩了/你主动 `/cycle` 换 session。重启后 agent journal 还在：`/subresume <journal-id> 继续把调研收尾，输出结论` → 从断点恢复，不重头跑。
**真实性**：session 压缩/崩溃恢复是真实路径，journal 机制已接线（`agent-task-journal.ts`）→ **留**

### `/subrm` — 杀并移除指定子代理
**场景**：`/sub` 派重了，SA4 是个误判——任务是多余的长调研，还在 running 烧 token。你按 `/subrm 4`：进程被 kill、widget 摘掉，立刻止损。
**真实性**：终止误派进程是真实的止损动作（已查实 handler 会 `killGracefully`）→ **留**

### `/subclear` — 全清子代理
**场景**：一批验证性 subagent 全跑完，界面堆了 8 个 widget，下一任务要开干净环境。`/subclear` 一次性杀掉所有仍在 running 的、清屏重来。
**真实性**：收尾/环境复位，真终止动作（会 kill running）→ **留**

### `/agents-team` — 选团队
**场景**：任务性质变了。上一个任务是 docs 文档活，现在要审代码安全：按 `/agents-team code-review` 切到 scout+ranger+warden+knight+paladin+herald 组合，后续 `/sub`/派活都走这组。
**真实性**：`teams.yaml` 十几个真实团队组合，切团队是驾驶动词 → **留**

### `/agents-list` — 列已加载 agent
**场景**：想确认当前 session 到底有哪些角色/模型可用、谁的模型配置可能失效，先 `/agents-list` 扫一眼再决定派谁。
**真实性**：查看在场 agent 是前置判断 → **留**

### `/agents-grid` — 设 widget 网格列数
**场景**：团队 8 个 agent 跑着，你觉得 widget 排一列太长想排 2 列好看点。按 `/agents-grid 2`。
**真实性**：**纯外观偏好**。列数不影响任何驾驶结果，agent/自动化不需要它。真要看状态 `agents-list` 文本就够 → **删**

### `/agents-clear` — 收拢团队 widget
**场景**：`code-review` 团队审完，widget 还挂着 6 个 agent 的完成状态。你要开新活，先把它收掉让界面干净。它只复位 done/error 的显示，不杀 running。
**真实性**：收工整理动作，真实但属"要清爽才按"。是否保留取决于你喜不喜欢手动收 — **悬置**

### `/nudge` — 中途 steer 运行中 worker
**场景**：`research-plan-build-review` 跑到 review 阶段，`reviewer` 偏题去重审整个历史提交而不是刚 build 的 diff。你直接 `/nudge reviewer 只看本次 build 的 diff，别审历史` → 已运行的 agent 现场纠偏，不用杀了重派。
**真实性**：对跑偏 agent 中途纠偏是高频驾驶动作 → **留**

### `/asks` — 收 ask_parent 提问
**场景**：某 `builder` 改 API 签名时遇到歧义——"这个枚举要不要留默认值？"，通过 `ask_parent` 挂起等你。你处理完别的事 `/asks` 列出所有挂起问题再逐个答。
**真实性**：`ask_parent` tool 真实注册；agent 主动向你提问再继续是真实协作模式 → **留**

### `/ask-answer` — 回答挂起提问
**场景**：`/asks` 显示 SA7 问"枚举默认值"。按 `/ask-answer <id> 保留 LEGACY 默认，其余删` → 该 agent 拿到答案继续跑。
**真实性**：同上，成对使用 → **留**

### `/pipeline` — 选流水线
**场景**：任务是"查当前外部竞品事实→本地分析→计划→实现→审"，需要联网溯源。按 `/pipeline research-plan-build-review` 拉起五阶段流水线（researcher→scout→planner→builder→reviewer）。
**真实性**：`pipeline-team.yaml` 真实多流水线，选流程是主动作 → **留**

### `/pipeline-status` — 看流水线全状态
**场景**：五阶段跑着，你想知道现在到哪、各 phase 哪个 agent done/error/idle、卡没卡。`/pipeline-status` 一屏看全。
**真实性**：监控进度是仪表主用 → **留**

### `/pipeline-resume` — 续跑持久化流水线快照
**场景**：流水线跑到 build 中途你换 session / 崩了，快照已持久化。回来 `/pipeline-resume` 从上次 phase 续，不重头。
**真实性**：断点恢复真实路径 → **留**

### `/pipeline-reset` — 重置到 phase 1
**场景**：跑错流水线/任务理解错了，build 阶段发现全偏。`/pipeline-reset` 回 phase 1 重新 understand，不重启进程。
**真实性**：犯错回滚真实 → **留**

### `/pipeline-off` — 退出流水线并收 UI
**场景**：任务完成，你要切去干件不用流水线的杂活（比如直接改个 README）。`/pipeline-off` 解除激活、隐藏 UI，回普通模式。
**真实性**：退出编排态是真实动作 → **留**

### `/pipeline-clear` — 只藏 widget、流水线保持
**场景**：流水线还在跑但 widget 挡界面，你想让它隐藏、跑完也不打扰——`/pipeline-clear`（不 deactivate，仅隐藏+显示复位）。
**真实性**：与 `/pipeline-off`（真退出）比，这是**纯显隐**。真不想被打断应直接 `-off` 或让它跑完。保留价值低 → **删**

---

## B. 模式 / 系统 / 会话

### `/mode` — 切运行模式
**场景**：杂活→要开团队协作，`/mode TEAM` 注入对应系统提示与约束；要写 spec 切 `SPEC`，要做长研究切 `RESEARCH`/`CHAIN`。
**真实性**：模式是驾驶主开关（NORMAL/PLAN/SPEC/PIPELINE/TEAM/CHAIN 真定义）→ **留**

### `/system` — 从 discovered agent 选 system prompt
**场景**：当前是默认 coding 提示词，你想用 `pi-orchestrator` 视角来统筹这次派活：`/system` 选 pi-orchestrator → 后续行为按该角色上下文。
**真实性**：换角色视角驾驶真实 → **留**

### `/theme` — 换主题
**场景**：觉得当前配色刺眼想换。ctrl+q 已能循环主题。
**真实性**：**审美**。快捷键已覆盖；命令只多开个浏览器 picker → **删**

### `/model-save` — 当前模型存为默认
**场景**：试到 `grok-4.5` 顺手好用，存成以后默认。
**真实性**：一次性偏好持久化，设完就不再按。非驾驶动作 → **删**

### `/cycle` — 压缩→新 session→恢复记忆
**场景**：一个超长流水线把上下文顶到上限，`replay` 显示 session 已 1.2M token。你 `/cycle`：压缩当前、开新 session、把关键状态/记忆带过去继续。
**真实性**：长活上下文管理真实；但靠 session 长度和你的习惯触发。你常跑长流水线就高频 → **悬置**

---

## C. 治理 / 运行

### `/auth-status` — 看鉴权方式
**场景**：模型开始报 401，先 `/auth-status` 看是 env var 还是 auth.json、token 过没过期，再决定补 env 还是 `/auth-logout` 重登。
**真实性**：排障起点 → **留**

### `/auth-logout` — 清内置凭据
**场景**：auth-status 显示内置 OAuth 过期且 env var 想接管，清掉旧凭据。确认弹窗防误删。
**真实性**：凭据轮换真实 → **留**

### `/budget` — 编排 token/花费预算
**场景**：这次要跑 `team-b-builders` 8 个 builder 并行的重批，怕烧穿额度。先 `/budget 500000 5.0` 设 token 与美元上限，跑超自动停。
**真实性**：只有真跑 compose/编排重批才用；功能接线真实。你批量跑模型对比就高频 → **悬置**

### `/orchestration-status` — compose 运行状态
**场景**：`compose_exec` 编排跑 12 步，你想看每步 complete/failed/blocked 明细和 run 记录。查 run id 或 events。
**真实性**：compose 批处理的仪表。你用 compose_exec 编排就留，只用 pipeline 就不碰 → **悬置**

### `/execution-status` — acceptance contract / verifier 状态
**场景**：开发验收机制：看当前 acceptance contract 绑没绑、verifier 收没收据。这是**验收链路调试**——驾驶时验收由 agent/自动化跑，人不看契约内部。
**真实性**：开发/验收框架的自检面，非驾驶者仪表 → **删**

### `/lean-tools` — 精简工具模式开关
**场景**：默认几十个工具喂给 agent 太臃肿、误导选错。开 lean：agent 先 `tool_search` 查再 `call_tool` 精确调，上下文更干净。
**真实性**：lean 是驾驶常态配置（`lean-tools.ts` 真实现 tool_search+call_tool 精简）→ **留**

### `/tool-search` — 查可用工具
**场景**：lean 模式下你或 agent 想确认有没有"关 viewer/读邮件/扫端口"这类工具，按 `/tool-search viewer` 列出可调工具，再让 agent 用。
**真实性**：lean 配套发现面 → **留**

### `/secure` — 仓库漏洞扫描 / 装保护
**场景**：接手一个不熟的仓库，先 `/secure sweep` 让 red-team/network-scout 扫攻击面；发现风险后 `/secure install` 上守卫，再 `/secure report` 出报告归档。
**真实性**：安全治理真实功能（red-team/network-scout/port-scan-analyst/security-news-analyst 角色在）→ **留**

### `/security` — 运行时守卫状态/策略
**场景**：某个 tool 调用被守卫拦了，agent 困惑。你 `/security status` 看拦了啥、`/security log` 查记录，必要时 `/security reload` 更新策略，或 `/security policy` 放行某条。
**真实性**：运行时守卫的运维仪表 → **留**

---

## D. 仪表 / 产物 viewer

### `/board` — 浏览器 kanban 任务板
**场景**：`team-b-builders` 8 个 builder 并行跑，你想看整体进度，不是盯单个 widget——开 `/board` 浏览器 kanban（Pending→Working→Completed→Failed），点 agent chip 过滤，看谁卡在哪个任务组。
**真实性**：多 agent 进度总览仪表（真实服务器 + 3s 刷新）→ **留**

### `/tasks` — 当前分支任务文本快查
**场景**：不开浏览器，终端里快速确认这个分支还有几个 task 没做完、状态如何。轻量文本。
**真实性**：与 `/board` 同源数据，但这是**无浏览器轻量版**，反而更贴终端驾驶 → **留**

### `/report` — 当前 git 变更完成报告
**场景**：流水线 `auto-build-report` 跑完，你 `/report` 看这次 git 变更的完成说明，核对改了什么再决定 commit 还是让 review 再跑一轮。
**真实性**：人查产出是驾驶收尾 → **留**

### `/reports` — 历史报告索引
**场景**：想回看上周某次重构的完成报告做对比，`/reports` 开历史索引挑那篇。
**真实性**：复盘/追溯真实 → **留**

### `/replay` — 会话时间线
**场景**：跑偏了/想复盘"刚才到底哪步开始错的"，`/replay` 滚动看整条会话时间线定位转折点。
**真实性**：复盘仪表，排障会用 → **留**

### `/plan` — 看 todo.md 计划
**场景**：`/sub` 派活前你想让 agent 照 `.context/todo.md` 的既定步骤走，先 `/plan` 打开核对当前进度再派。
**真实性**：人审计划真实 → **留**

### `/spec` — 开 spec 文档
**场景**：你在 `SPEC` 模式写功能规格，想开某 spec 目录确认结构对齐。驾驶态（跑实现/调研）不碰，只在写 spec 的开发态用。
**真实性**：开发产物 viewer，仅 spec 写作场景 → **删**（你常写 spec 则留）

### `/show-file` — 开本地文件看
**场景**：`reviewer` 报"pipeline-team.ts L878 有 bug"，你想亲自开那个文件对一眼，不开编辑器。`/show-file extensions/pipeline-team.ts`。
**真实性**：人查报错点/产物真实，但属偶尔介入 → **悬置**

### `/close-viewer` — 关当前 viewer
**场景**：`/show-file` 看完，`/plan`/`/board` 的浏览器 viewer 还挂着，`/close-viewer` 关掉当前那个。
**真实性**：成对于 show-file/plan；你常开 viewer 才按 → **悬置**

### `/cleanup` — 磁盘清理 viewer
**场景**：磁盘满报警，开 cleanup 扫描，把大文件/缓存分级（自动清/人工判/谨慎清）处置。
**真实性**：真人维护，低频但真实 → **悬置**

### `/research` — 研究任务 / 研究浏览器
**场景**：任务要"查当前各模型 API 定价变化"，先 `/research` 起 researcher 联网溯源拿带 URL/日期的结论，再进 `research-plan-build-review` 流水线落地。或开研究浏览器回看历史研究。
**真实性**：`researcher` 角色 + 研究流水线都在，研究是驾驶前置 → **留**

### `/workflow` — workflow 能力展示 / 存 review 草稿
**场景**：`/workflow` 列当前可用 workflow 能力；`/workflow context` 把当前 context 存成 review-only 草稿供后续审。
**真实性**：能力清单 + 草稿存档是 aux 面。真按它的人少，功能真实性取决于你是否用它管理 draft → **悬置**

---

## 汇总（终版 — 保守定案 2026-09-08）

**原则**：删的是 `/` 入口按钮，不删功能。保留全部仪表/介入/viewer；只去纯外观/收拢/一次性且无真实驾驶场景的入口。

**已删（4，纯入口，功能底层保留）**
`agents-grid`（布局；gridCols 自动尺寸逻辑仍在）· `agents-clear`（收 widget；复位 helper 仍在）· `pipeline-clear`（纯显隐；clearPipelineUI 仍在）· `theme`（按名挑主题入口删；ctrl+q 循环 + persistTheme/showSwatch/getThemeList 全在）

**留（44 − 4 = 40）**
- 原判"删/候选/悬置"中保留：`execution-status` · `spec` · `agents-clear`(已删) …
- `model-save` **待定**：`persistModel` 无其他调用者，删 = 丢唯一"存默认模型"入口（功能损失，非仅入口），保守建议**留**。
- viewer/仪表（board/tasks/report/reports/replay/plan/show-file/close-viewer/cleanup/research/…）全留。
- 凡会终止 agent、显示运行状态、读产物、治理控制的动作一律不删。
