# agent-pi 系统地图（System Map）

> 状态：v1 · 2026-09-08 · S1 交付物。本文件是仓库的单点架构事实来源，任何变更须同步本文件（design-charter §4）。
> 方法：4 路只读 scout 对 108 个 `extensions/lib/*.ts` 逐一读 imports+职责后按统一 rubric 分类；53 个顶层入口由主线程按归口 lib/模式归类。层/档/底座定义见 `docs/design-charter.md` §2/§7 与 `docs/POSITIONING.md` §5/§7。

## 总览

- **107 lib 模块**（execution-run 死 shim 已于 S2 删）：核心档 53 · 可选档 55 · 待裁 0
- **底座零件(F)** 21 个：见 §4
- **依赖方向审计：无违规。** 四路 scout 各自 grep 全 lib，均未发现 lib→顶层入口、L1→pi/runtime 的向上/跨层 import。仅需留意：个别模块 import-time 副作用（如 `defaults.ts` 在 import 时读 cwd）。

### 图例
- 层：L1 纯领域 · L2 能力执行(fs/net/http/env/viewer) · L3 编排语义 · L0 入口(§3 表)
- 档：core=直接服务 POSITIONING §5 核心负载 · optional=可选能力
- F：§7 底座（context/run 状态与轨迹/协调状态/证据与收据/manifest/worker 生命周期/完整性）
- T：有同名 `__tests__/<name>.test.ts` 直接单测

## 1. lib 主表（107，字母序）

```
name | 层 | 档 | F | T | 职责
agent-defs | L2 | core | - | Y | 从磁盘加载 agent 角色/模型定义供委派
agent-pi-config | L2 | core | - | N | 全局配置单例含默认 subagent 模型
agent-result-contract | L2 | core | F | N | 解析/校验/持久化 worker RESULT 契约（§3 canonical）
agent-task-journal | L2 | core | F | N | append-only 任务日志 + 运行事件轨迹（与 evidence-store 重叠）
approval-gate | L2 | core | - | Y | 批准门 + 文件内容指纹绑定（§3 canonical；与 workflow-approval-gate 重叠）
ask-user-details | L1 | optional | - | N | 构造 ask_user 工具结果详情对象
board-viewer-html | L2 | optional | - | N | 自包含任务板 Kanban viewer 页面
capability-registry | L1 | core | - | Y | 能力发现/风险目录，支撑工具门
chain-state | L2 | optional | F | Y | 持久 CHAIN 进度快照供崩溃恢复（与 coordination/run-state 词表重叠）
child-runtime | L2 | core | - | Y | 净化子环境 env + 委派工具意图
cleanup-viewer-html | L2 | optional | - | N | 磁盘清理扫描/删除 viewer 页面
completion-report-html | L2 | core | - | N | 完成报告页：文件 diff + 回滚控制
context-budget | L1 | core | F | Y | context 预算阈值 + subagent 缩放规则
context-gate | L1 | core | F | Y | 压缩 warn/prep/compact 门阈值
coordination-state | L1 | core | F | Y | canonical 内存会话/协调状态（§3 canonical）
defaults | L2 | core | - | N | 从 models.json 读默认 subagent 模型（import 时副作用）
delegation-guard | L1 | core | - | Y | 探测嵌套 headless pi 启动（shadow fleets）
dispatch-gate | L1 | core | - | N | AsyncLocalStorage 委派授权门
dispatch-runtime | L2 | core | - | Y | 生成/传输 worker(headless/herdr) + 记录
duration-format | L1 | optional | - | Y | 格式化耗时 Ns / Nm Ns
eval-engine | L1 | optional | - | N | 版本化 eval 契约；确定性 + judge 检查
eval-scenarios | L2 | optional | - | N | 跑 provider-free 回归 YAML 场景
eval-sets | L2 | optional | - | Y | 跑有界 eval-set 与测试文件
evidence-store | L2 | core | F | N | append-only 证据与执行事件存储（与 agent-task-journal 重叠）
execution-contract | L1 | core | F | Y | acceptance 契约：objective/断言/指纹（§3 canonical）
execution-gate | L1 | core | - | Y | 完成门：需 verifier 收据 + 绑定 eval（与 verifier-runtime 组合）
file-viewer-html | L2 | core | - | N | 本地文件 viewer/editor 独立 HTML 模板
fleet-mailbox | L2 | optional | - | N | Maildir 文件邮箱，跨 agent 提问/转向原子投递
herdr-client | L2 | optional | - | N | 生成/管理 herdr 外部 worker pane + 可见 TUI 传输
isolated-verifier | L2 | core | F | N | canonical 验收验证：确定性+subagent 证据→VerifierReceipt（§3）
local-server-auth | L2 | core | - | Y | loopback viewer capability-token 鉴权（§3 canonical）
memory-cycle-helpers | L2 | optional | - | N | fs 助手 + memory-cycle context/prompt 注入
mode-cycler-logic | L1 | optional | - | Y | 纯模式列表 + next/prev/color/label/matches
mode-prompts | L1 | optional | - | Y | 每模式 prompt 文本常量 + builder（prompt 文本存代码 L1）
model-inheritance | L1 | optional | - | N | 链 worker 模型解析：explicit > launch > fallback
named-pick | L1 | optional | - | Y | 按精确/唯一前缀把命令参数匹配到配置
normal-escalation | L1 | optional | - | Y | 拦重复只读侦察；把卡死循环轻推向有界 SCOUT（启发式非硬门）
orchestration-budget | L2 | core | F | Y | 跨进程 token/成本预算台账 + 预留（dispatch-runtime 用）
orchestration-query | L2 | optional | F | Y | 只读编排运行摘要/拓扑/恢复（自持久事件）
orchestration-run | L2 | core | F | Y | 运行身份 + 有界 step/token 预算 + 会话事件轨迹（worker 生命周期）
output-box | L1 | optional | - | Y | 输出行 + TOOLBOX 摘要格式化（outputLine/outputBox 为 no-op stub）
panel-backdrop | L1 | optional | - | Y | 深色底上居中面板，限高截断
parse-chain-yaml | L1 | optional | - | N | 手写 YAML 解析→chain step/def 结构（与 parse-pipeline-yaml 重复）
parse-pipeline-yaml | L1 | optional | - | N | 手写 YAML 解析→pipeline 配置/阶段/agent（同上，未共享 yaml 库）
path-safety | L1 | core | - | N | isWithinDirectory 路径包含守卫（§3 canonical）
persist-model | L2 | optional | - | N | 持久默认模型到 settings.json（与 persist-theme 同文件分锁写）
persist-theme | L2 | optional | - | N | 持久主题名到 settings.json（同上，合并候选）
pinned-tools | L2 | core | - | Y | 首轮/scout 保持编排工具可见（env 门控，pi 注入）
pipeline-render | L1 | optional | - | N | pipeline 阶段/agent 纵向时间线 TUI 渲染
pipeline-state | L2 | optional | F | Y | 原子持久 PIPELINE 阶段快照（重启恢复）
plan-viewer-editor | L1 | core | - | N | 解析/编辑/序列化 markdown plan 文档
plan-viewer-html | L2 | core | - | N | Plan Viewer GUI 独立 HTML（markdown+编辑+批准/拒绝）
plan-viewer-render | L2 | core | - | N | Plan Viewer TUI 渲染（与 plan-viewer-html GUI 近平行）
report-index | L2 | optional | - | Y | plan/spec/completion 报告的 SQLite 持久化可搜索引
reports-viewer-html | L2 | optional | - | N | HTML /reports 浏览器：搜索、分类、表格
request-body | L2 | optional | - | Y | 有界 HTTP body 读取，排空被拒 viewer 请求
research-protocol | L1 | optional | - | Y | 外部 research 的路由 + researcher prompt 协议
research-session | L2 | optional | - | Y | research 会话 JSON+SQLite 持久 + 生命周期状态
research-viewer-html | L2 | optional | - | Y | research 会话 HTML 浏览器
resource-scheduler | L1 | core | - | Y | 确定性资源感知并行波（batch）
reviewer-decision | L1 | core | - | Y | reviewer APPROVED/NEEDS-CHANGES 门，fail-closed（§7）
rewrite-system-prompt | L1 | optional | - | Y | set_mode 后重写 provider payload system prompt
run-state | L1 | core | F | Y | canonical RunStatus 规范化/终止/可恢复（§3 canonical）
safe-markdown-runtime | L1 | optional | - | Y | 无依赖安全浏览器 markdown runtime 字符串
secure-engine | L2 | optional | - | Y | 扫项目 AI 安全漏洞 + 凭据暴露（探索性 security-roster）
secure-installer | L2 | optional | - | Y | 给项目生成便携 AI 安全守卫文件（同上）
security-engine | L2 | core | - | Y | canonical 安全策略解析 + 威胁/外泄检测（§3，security-guard 执行器）
security-report-html | L2 | optional | - | N | 安全分析报告 HTML 渲染
sensitive-data | L1 | optional | - | N | 文本中 secret/token/凭据 pattern 脱敏
session-replay-helpers | L1 | optional | - | N | 从会话分支提取展示内容/历史
sounds-config | L2 | optional | - | N | 声音到 hook 的分配配置持久
sounds-player | L2 | optional | - | N | afplay/aplay/mpv 解码播放缓存声音
sounds-viewer-html | L2 | optional | - | N | 声音配置/分配 HTML GUI
spec-viewer-html | L2 | core | - | N | 多页 spec 审阅/批准 HTML 向导
subagent-cleanup | L2 | optional | - | Y | 删除超 maxDays 的过期 worker 会话文件
subagent-recovery | L1 | core | - | Y | 向 argv 插入 session-resume 续跑标志
subagent-render | L1 | optional | - | N | 纯 subagent-widget 渲染：标题/摘要/状态行
subagent-scope | L1 | core | - | Y | 同 scope 委派去重（拦运行中/重复 PASS）
subagent-type-gate | L1 | core | - | Y | 每类型并发门：拦重复运行类型（§7 canonical）
task-gate | L1 | core | - | N | 工具执行需 active-task；只读/recon 旁路集
task-list-render | L1 | optional | - | N | task-list TUI 滚动/高度/键盘导航 + 渲染
tasks-confirm | L1 | optional | - | N | 判定清空任务列表前是否需要用户确认
team-batch-recovery | L1 | core | - | Y | TEAM journal 行→安全有界可恢复候选
team-session-cleanup | L1 | core | - | Y | 启动时保留未完成 TEAM 角色会话的策略
themeMap | L2 | optional | - | N | 扩展→主题/标题映射；会话启动应用 UI 主题
tool-classification | L1 | optional | - | Y | 工具名意图/readOnly 单一来源分类 + recon 集
tool-executor-registry | L2 | optional | - | Y | 发布注册工具执行器供进程内 call_tool 组合
tool-invocation | L1 | core | - | N | 参数感知只读/recon bash + shell 风险分类
toolkit-cli | L2 | core | - | N | 外部 CLI worker 元数据/argv/model/进程生成
ui-helpers | L1 | optional | - | N | TUI 文本布局助手：pad/换行/并排
verification-policy | L1 | core | - | N | 有界 verifier 重试/升级/完成决策策略
verifier-quality | L1 | core | - | Y | 可解释性检查：拒空/不可审计 Objective
verifier-runtime | L1 | core | F | N | 构造 VerifierReceipt；canComplete 完成谓词
verifier-subagent | L2 | core | - | N | 生成/解析/复验独立只读 verifier subagent
viewer-session | L2 | optional | - | N | 跟踪/关闭单个活动本地 viewer HTTP server 会话
viewer-standalone-export | L2 | optional | - | N | 写净化独立 plan/report/spec HTML 到 Desktop
worker-budget | L1 | core | - | Y | 每角色 worker 工具上限/thinking/超时启动策略
worker-lifecycle | L1 | core | F | Y | 编排 worker 的 epoch/timer/进程失效 + 释放
workflow-approval-gate | L2 | core | F | Y | 提案指纹人工批准存储；fail-closed（与 approval-gate 重叠）
workflow-artifacts | L2 | core | F | Y | .pi/workflow 不可变证据库：digest/脱敏/path-safe
workflow-context | L2 | optional | - | Y | 证据标注 standing-context 草稿 + 漂移检测
workflow-direction | L1 | optional | - | N | 基于证据的下一步/模式建议决策
workflow-dispatch | L3 | core | F | Y | 模式 dispatch hooks + 持久 dispatch 收据（subagent_create）
workflow-memory | L2 | optional | - | N | retrospective/insight 存储；生命周期迁移
workflow-monitor | L2 | optional | - | Y | 有界 log-tail 分诊 + fail-closed 咨询性部署门
workspace-manifest | L2 | core | F | Y | 哈希全 workspace(tracked/staged/untracked) 绑定契约
```

## 2. 顶层入口（51，L0；workspace-memory/optional-adapters no-op 壳已删）

入口 = 注册壳，逻辑在 lib（§2 规则）。核心入口直接挂 §5 核心负载；模式 monolith 与 viewer/UX 多为可选或收敛对象。

**核心（直接服务 §5）**
```
mode-cycler | 模式路由/门注入 | 委托 mode-cycler-logic | 无直测(逻辑已测)
subagent-widget | 唯一 dispatcher | 委派/批量/恢复/RESULT/reviewer | 经 lib/subagent-render 测
execution-verifier | verify_execution 入口 | 绑契约+收据+驱动验证 | 无直测(核心，S5 补)
security-guard | 安全门 hook(3层) | 委托 security-engine | 无直测(核心，S1 后补)
tool-caller | call_tool 元工具 | 嵌套重门 + 有界 executor | tool-caller-boundaries.test
message-integrity-guard | 会话结构修复 | 防孤儿 tool_result 卡死 | 无直测
completion-report | 完成报告/回滚 viewer | 委托 completion-report-html | 无直测
plan-viewer | PLAN approve 面 | 委托 plan-viewer-html/editor | 无直测
spec-viewer | SPEC approve 面 | 委托 spec-viewer-html | 无直测
tasks | 任务/SPEC 引擎 | 委托 task-* | tasks-*.test 族
workflow-support | 工作流工具集 | 委托 workflow-* | workflow-support.test
tool-registry | 工具注册 | 委托 tool-executor-registry | tool-registration-audit.test
execution-command-recorder | 命令记录 | 微壳 | execution-command-recorder.test
```

**传输/worker 标记入口（core，运行时经 -e 加载，非注册壳）**
```
herdr-done | herdr 完成标记扩展 | -e 注入，首 agent_end 写完成 marker | herdr-visible-tui 测
```

**模式 monolith（收敛对象）**
```
agent-team | TEAM | 委托 dispatcher; 含 __removed_dispatch_* 死 handler | 经 lib 测
pipeline-team | PIPELINE | 含死 spawnAgent/dispatchPhaseAgents | pipeline-state/team 测
agent-chain | CHAIN | "retired"；runAgent/runChain 不可达 | chain-* 测
```

**安全/门禁扩展（core/optional 混合）**
```
secure | /secure sweep+install | 委托 secure-engine/installer | 无直测(可选)
security-news | security_news 工具 | allowlist 源 | security-news.test
security-report | 安全报告 viewer | 委托 security-report-html | security-report.test
safe-port-scan | 端口扫描包装 | 仅 loopback/private | safe-port-scan.test
network-inspect | 网络检查包装 | iface 白名单 | network-inspect.test
delegation-guard | 嵌套 pi 探测入口 | 委托 lib | delegation-guard.test
```

**Viewer / UX（optional）**
```
board-viewer · cleanup-viewer · file-viewer · research-viewer · reports-viewer · sounds · theme-cycler · footer · agent-banner · agent-nav · system-select · escape-cancel · user-question · session-replay · debug-capture · ask-parent · compose-exec · lean-tools · nudge-listener · inbox-notify · oauth-provider · tool-search · toolkit-commands · mode-persist · model-persist · orchestration-status · orchestration-tool-audit · orchestration-budget · memory-cycle
```

## 3. 底座零件（§7 substrate，21 个 F）

按"渲染已算的，不新采集"原则，这些模块已算出状态但未聚合成一块可读 run 仪表：

- **context**：context-budget、context-gate
- **run 身份/轨迹/预算**：orchestration-run、orchestration-budget、orchestration-query、execution-run
- **协调/运行状态**：coordination-state、run-state、chain-state、pipeline-state
- **证据/收据/契约/manifest**：agent-result-contract、agent-task-journal、evidence-store、execution-contract、isolated-verifier、verifier-runtime、workspace-manifest、workflow-artifacts
- **worker 生命周期/完整性**：worker-lifecycle、workflow-dispatch、workflow-approval-gate

## 4. S2 关注清单（第二实现 / 别名 / 待人工审）

design-charter §3 规定"发现第二实现=合并或删"。S2 review 结论（2026-09-08）：

- **已清理**：`execution-run.ts`（死 shim，零引用）及其 test 已删（commit 6376b40）。
- **monolith 内部 dead path 延后到 S4**：agent-team/agent-chain/pipeline-team 的 retired spawn 路径与活结构交织，且 `workflow-walk-fixes`、`herdr-visible-tui` 等源文本守卫测试钉着这些内部符号——盲删会炸 build。真实清理属 S4 编排重构（逐 monolith 溯源 + 同步守卫测试）。
- **保留**：`output-box` outputLine/outputBox 虽为 no-op identity，但被全部 viewer + monolith 调用（几十处），是稳定格式缝；删需触所有调用点，零行为收益 → 保留。

剩余候选（何时执行由重构时机定）：

| # | 项 | 问题 | 建议 |
|---|---|---|---|
| 1 | approval-gate vs workflow-approval-gate | 两个指纹绑定批准门 | 合并到一 canonical |
| 2 | evidence-store vs agent-task-journal | 两个 append-only 事件/轨迹存储 | 合并或明确分工 |
| 4 | chain-state vs coordination-state/run-state | 词表重叠 | 收敛到 coordination/run-state |
| 5 | subagent-scope vs subagent-type-gate | 两个 gate 同 dispatcher | 明确分工或合并 |
| 6 | plan-viewer-render vs plan-viewer-html | TUI 渲染与 GUI 平行 | 按实际使用保留 |
| 7 | persist-model vs persist-theme | 同 settings.json 分锁并行写 | 合并单写者 |
| 8 | parse-chain-yaml vs parse-pipeline-yaml | 重复手写 YAML | 共享解析或用 yaml 依赖 |
| 10 | secure-engine/installer + security-roster | 探索性项目加固（POSITIONING §8 S2 候选） | 无真实任务用→删 |

## 5. 无直接单测的 lib（回归风险带）

以下 lib 无同名直接测试，靠集成 smoke：agent-pi-config, agent-result-contract, agent-task-journal, ask-user-details, board-viewer-html, cleanup-viewer-html, completion-report-html, defaults, dispatch-gate, eval-engine, eval-scenarios, evidence-store, file-viewer-html, fleet-mailbox, herdr-client, isolated-verifier, memory-cycle-helpers, model-inheritance, parse-chain-yaml, parse-pipeline-yaml, path-safety, persist-model, persist-theme, pipeline-render, plan-viewer-editor, plan-viewer-html, plan-viewer-render, reports-viewer-html, security-report-html, sensitive-data, session-replay-helpers, sounds-config, sounds-player, sounds-viewer-html, spec-viewer-html, subagent-render, task-gate, task-list-render, tasks-confirm, themeMap, tool-invocation, toolkit-cli, ui-helpers, verification-policy, verifier-runtime, verifier-subagent, viewer-session, viewer-standalone-export, workflow-direction, workflow-memory

（注：部分如 path-safety/local-server-auth 边界经 security-boundaries.test 间接覆盖；高价值补测在 S5/验收阶段择要。）

## 6. 词汇表（一词一物，canonical）

| canonical 概念 | canonical 实现 | 待清理别名/第二词 |
|---|---|---|
| 会话协调状态 | coordination-state | chain-state/pipeline-state（投影快照，非 canonical） |
| 运行状态 | run-state | 各 monolith 内联 alias |
| 委派结果契约 | agent-result-contract (## RESULT) | 旧直接 spawn 路径 |
| 完成判定 | execution-gate + verifier-runtime | — |
| 验证收据 | verifier-runtime (VerifierReceipt) | — |
| 批准门 | approval-gate | workflow-approval-gate |
| 运行轨迹/证据 | evidence-store（与 agent-task-journal 二选一后定） | agent-task-journal |
| viewer 鉴权 | local-server-auth | — |
| 路径包含 | path-safety | 各 viewer 内联 realpath |
| 单写 settings | （persist-model/persist-theme 合并后定） | persist-model / persist-theme |

## 7. 依赖违规登记

S1 审计结论：**无 lib→顶层入口、无 L1→pi/runtime 向上/跨层 import**（4 scout 各自 grep 全 lib 确认）。登记为零；后续变更若引入新依赖方向，按 charter §4 检查并更新本行。
