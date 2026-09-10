# 覆盖矩阵（Coverage Matrix）— 试驾战役总账

> v1 · 2026-09-08 · 司机战役（M1–M-G + 深水区 1–4）真机命中/未命中总账。判级：**核心保留 / 可选保留 / 修剪候选 / 未命中-需GUI或env / 缺陷已修**。与 `slimming-candidates.md` 配套。

## A. 真机命中且工作正常（组件辩护）

| 组件 | 命中轮次/证据 |
|---|---|
| NORMAL 交互 + 模糊需求 | M-A（自驱重构 + 修真实 bug） |
| PLAN 模式 + 批准门 + show_plan viewer 人批 | M-B（--json，12 tests） |
| SPEC 模式 + show_spec + viewer 批准 | M-C（weekly，18 tests） |
| task 清单/门 + 规划根写规则 | M-B/M-C/D11 修复后 |
| subagent_create / _batch / join | M2a/M-F（batch PASS/PASS） |
| RESULT 契约 + 格式修复 + composeAgentResult | 全委派轮 |
| reviewer 门 fail-closed | M-F（D13 后 decision 行强制） |
| verify_execution + verifier 只读子 + 收据/manifest | M3/M3b/失败侧 FAIL（D15 spawn 重试后） |
| dispatch/journal/receipt/events 轨迹 | 全轮 .pi 落盘证据 |
| herdr 可见子 pane transport | M2a（p3 开→关）、M3b（verifier pane） |
| ask_user | M-C（方向选择） |
| orchestration_run/budget | 委派轮 |
| eval_run + .pi/workflow/evals 落盘 | M-G |
| workflow_advice | M-G |
| orchestration_status / compose_exec / tool_search | 补试轮 |
| security-guard tool_call 门 | 全程隐式 |
| secure-engine runSweep | 真扫自身（143 误报分析） |
| ask_parent/fleet（部分）/herdr-done -e | M2a + 传输 |
| subagent_wait/status/resume（间接） | batch 轮 journal |

## B. 真机未命中 / 命中受限（瘦身输入）

| 组件 | 限制 | 判级 |
|---|---|---|
| CHAIN 模式 | 代码自证 retired；退役 runner 已删（2026-09-10） | 模式仍可选（父 agent 显式驱动 `subagent_create`） |
| PIPELINE 全相位自助驱动 | 4-phase e2e 在固定窗口未完成；交互迷失（D16 指引已加，未再全通） | **可选/expert 档**；e2e 重跑留待更强模型或更长窗口 |
| completion/plan/spec viewer GUI | 需真人浏览器（批准已人批；headless 无 URL 回传） | 可选保留 |
| file/board/research/reports/cleanup viewer GUI | 需 GUI 会话 | 可选保留（登记） |
| fleet-mailbox | env 默认开，但真机 live 需交互多轮父问答 | 可选保留（lib 测试覆盖；live 需交互场景） |
| security_news | 网络 allowlist | 可选保留 |
| network-inspect/toolkit-cli/oauth/sounds/theme/banner/nav/footer/tex/session-replay/debug-capture/memory-cycle/security-report | 专项/GUI/装饰 | 可选保留（不再堆料） |
| safe_port_scan | 系统无 nmap（优雅降级） | 保留（装 nmap 可用） |
| workspace-memory/optional-adapters/execution-run/run 别名 | 死代码 | **已删**（S2/S3） |
| builder-<model> ×8 | 个人偏好；若收敛 1-2 模型可裁 | 观察 |

## C. 缺陷处置总账（试驾发现 → 修复）

| 缺陷 | 处置 |
|---|---|
| D2 缺 herdr skill | 已修（装 v0.9.0） |
| D5 状态源措辞 | 已修（文档） |
| D9 司机 git add -A 误收 .pi | 已修（gitignore） |
| D11 SPEC bash 门无指引 → 死锁误判 | 已修（5d91f93，指引+测试） |
| D12/D6/D8 show_report/批准 viewer 永等 → wedge | 已修（completion d21fff2 / plan+spec 8ef4de3，bounded wait 三件套） |
| D13 reviewer 缺 decision 行 → 门误拦+父误报 | 已修（5cb77d3）→ **D13-real 三连修**（3289abf 代码模板 / a1a3d6a 全块语义扫描 / 5940653 修复轮强制），live journal done |
| D17 headless-bg 受 shell job-control 组杀 | 约束定性（herdr-pane 为耐久载体），记录指引 |
| D15 verifier spawn startup 失败吞 attempt | 已修（9155a3e，spawn 重试） |
| D16 PIPELINE status 无下一步指引 | 已修（771ceef，Next action） |
| D1/D7/D8/D10/D14 观察/外部 | 记录（模型纪律、herdr 状态、provider 环境） |

## D. 信任红线验证（POSITIONING §7 辩护证据）

- 坏代码（3 测试红 + CLI 破坏）→ verify_execution **FAIL**（失败侧真机）✓
- 无行为变化的"假破坏"→ verifier PASS（正确判定，非假放行）✓
- 无人批准/无人点击 viewer → 有界超时优雅收尾（不再 wedge）✓
- batch 并行 2 worker PASS/PASS + journal 双 done ✓
- herdr 子 pane 开→RESULT→自动关 ✓
