# 瘦身候选清单（Slimming Candidates）

> 状态：v1 · 2026-09-08 · M-H 交付物。基于真实驾驶战役（M1–M-G）+ S1 分类。规则：**真机未命中 ≠ 必删**，但必须登记并按 POSITIONING §5/§8 收敛口径定级（核心保留 / 可选保留 / 修剪候选）。

## 0. 真机命中记录（本战役为组件辩护的证据）

以下组件在真实驾驶中被实际命中并工作正常，**不进入瘦身候选**：六模式路由（NORMAL/PLAN/SPEC/TEAM/PIPELINE）、task 清单/门、PLAN/SPEC viewer 人工批准、subagent_create/_batch + join、RESULT 契约、reviewer 门（fail-closed，D13 后）、verify_execution + verifier 只读子 + 收据/manifest、ask_user、approval 门（PLAN/SPEC + 指纹）、dispatch/journal/receipts 轨迹、herdr 可见子 pane、security-guard（每轮 tool_call 隐式全命中）、eval_run + 报告落盘、workflow_advice、规划根写规则（D11 后）。

## 1. 已证冗余 / 退役（删或已删，git 考古可查）

| 组件 | 证据 | 处置 |
|---|---|---|
| execution-run shim | 零生产引用 | 已删（S2） |
| workspace-memory / optional-adapters no-op 壳 | 纯 no-op + 无价值测试 | 已删（S3） |
| dispatch-runtime `run` 别名 | @deprecated 兼容 shim | 已删（S3） |
| CHAIN 模式（agent-chain runAgent/runChain + 父自建 spawn） | 文件自注 retired，dead 函数 | 已删（2026-09-10：runner + snapshot 写入 + 失效导入） |
| agent-team / pipeline-team 死 spawn 路径 | __removed handler + 无活调用者 | 已删（2026-09-10：注册体 + dispatchAgent + spawnAgent/dispatchPhaseAgents + 拒注册过滤） |
| `[cmd]` 完成路径确定性执行 | legacy runIsolatedVerifier 零生产调用 | 已删（2026-09-10：解析、执行器、legacy API、提示词证据管道全清） |

## 2. 真机全程未命中（GUI/装饰/专项，推荐保留但停止继续堆料）

| 组件 | 类型 | 判定 |
|---|---|---|
| sounds / theme-cycler / themes / agent-banner / agent-nav / footer / inbox-notify | 纯 UI/装饰 | 保留（个人偏好项），**不再新增同类** |
| oauth-provider / session-replay / debug-capture / memory-cycle | 专项工具 | 保留（有真实用途的专项），无新投入 |
| board-viewer / research-viewer / reports-viewer / cleanup-viewer / file-viewer / security-report | 本地浏览器 viewer | 真机未用（需 GUI 会话）；**试用一次再定**：无感则降级可选 |
| security_news | 网络 allowlist 抓取 | 未驱动（需外网/策略）；低风险保留 |
| network-inspect / tool-search / compose-exec / toolkit-cli / toolkit-commands / orchestration-tool-audit | 专项工具 | 未命中；**登记观察**，等真实任务出现再验证 |
| orchestration-status / orchestration_recover（`/orchestration-status`） | 专项工具 | **已于 2026-09-10 随 composition 账本一并移除** |
| tex 应用 | 独立文本工具 | 无关驾驶舱核心，未测；维持现状 |

## 3. 环境受限（非冗余，降级已工作）

| 组件 | 证据 | 判定 |
|---|---|---|
| safe_port_scan | 真机调用：nmap 未装 → ENOENT 优雅报错（不崩溃） | 保留；环境装 nmap 即可用 |
| security-guard / delegation-guard / fleet-mailbox / herdr | env 门控 | 条件触发，未全程；herdr 传输已多次命中 |

## 4. 缺陷待修（先于瘦身，D 族）

| 缺陷 | 状态 |
|---|---|
| D6/D8/D12：交互长 turn 后 herdr 状态 wedged 族（verify/TEAM 完成报告步） | 观察中；复现做代码级隔离（可能涉 completion-report viewer 打开路径） |
| D7：模糊任务 stop-short（不提交/不收尾） | 观察：任务清单 + nudge 未强制续跑；建议后续评估 agent_end 续跑策略 |

## 5. 设计级降级（呼应 roadmap descope，非删除）

- **PIPELINE 全相位仪式**（逐相位强制 subagent 委派）：小任务 overkill（M-E 实机自判）→ 保持"手动/大任务触发"，不默认。
- **eval/judge 平台化**（orchestration-eval + LLM judge）：无真实定性任务杠杆 → descope（POSITIONING §4）。
- **monitor/deploy adapter**：未建 → descope。
- **builder-<model> 8 份冗余 agent**：个人 cockpit 每模型一份属偏好；若长期只用 1-2 模型 → 修剪其余。

## 6. 下一步（给后续轮次）
1. D6/D12 wedged 族代码级复现与隔离（优先，用户可感知）。
2. viewer 试用轮（file/board/reports 等挑 1-2 个真用一次）。
3. /secure + security roster 一次真机（含 install 到测试项目）再定去留。
4. 每新增能力前查本表：同类已登记未命中 → 先不写。
