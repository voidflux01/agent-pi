# Merge Prep — refactor/charter-sweeps → main

> 2026-09-08 · 战役分支（64 commits，main..HEAD）并入主线的 review 清单。
> 全部本地，未 push。public 仓守则：push 需用户明示；本清单供 review 用。

## 认证
- `verify:release` GREEN ×4（doctor:strict 13/13 · tsc · vitest 1002/bun 284 · audit · package-smoke）
- 工作树干净；两测试项目仓（jd/ssg）独立，不入主线

## 主题分组（按 review 顺序）

### 1. 治理基座（docs 12 份，含新 6 份）
- POSITIONING / design-charter / system-map / mode-semantics / verification-design / GOVERNANCE_CHECKLIST
- iteration-roadmap 状态对账（P1/P4 descope 声明）、CHANGELOG Unreleased 补丁节

### 2. 代码修复（11 fix commits，全部真机驱动 + 回归）
| 缺陷 | commit | 行为影响 |
|---|---|---|
| D11 SPEC/PLAN bash 门指引 | 5d91f93 | 拒绝理由带规划根路径（提示文本） |
| D12 族 completion-report bounded wait | d21fff2 | show_report 无人操作 5min 超时收尾（env 可调） |
| D12 族 plan/spec viewer bounded wait | 8ef4de3 | show_plan/show_spec 同上 |
| D13 contract decision 行 | 3289abf | reviewer worker 提示含 decision（提示文本） |
| D13 语义扫描 | a1a3d6a | reviewerDecision 全块扫描（行为） |
| D13 修复轮强制 | 5940653 | reviewer UNKNOWN 才进修复轮（行为） |
| D15 verifier spawn 重试 | 9155a3e | 启动失败重试 ≤2（行为） |
| D16 pipeline_status Next action | 771ceef | 输出加指引行（文本） |
| D19 TEAM task-inprogress 先行 | 5998ec6 | coordinator 提示（文本） |
| D20 NEEDS CHANGES usable | 9b1bfc5 | 仅 UNKNOWN 触发 failure/修复轮（行为） |

### 3. 清理（refactor 2）
- execution-run 死 shim、no-op 壳、`run` 别名删除（S2/S3）
- 伴随：入口数 53→51、lib 107 模块

### 4. 工具/技能
- tools: pipeline e2e 窗口 env 参数化
- skills: herdr v0.9.0 SKILL 安装

### 5. 驾驶总账（docs 44 条，记录用不入产品路径）
- dogfood-2026-09-08 / campaign-summary / coverage-matrix / slimming-candidates
- validation-log 增补（真机冒烟 + 修复验证）

## Review 关注点（改动有行为影响处）
1. reviewer/verify 门行为收紧（D13/D20/D15）：fail-closed 更严格 + NEEDS CHANGES 语义修正 —— 建议跑一次真机 TEAM 流确认（campaign 已验）
2. viewer bounded-wait 默认 5min：交互审阅超时即收尾 —— 超时文案仍显 "User closed"（已知措辞瑕疵，未修；如需一并处理）
3. D19 提示为文本级约束（模型遵循度非 100%）

## 合并建议
- 单 commit squash 或按 5 组 5 commits 均可（组内原子、无相互依赖冲突）
- 合并后跑一次 `npm run verify:release` 收官
