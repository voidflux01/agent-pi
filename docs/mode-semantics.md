# 模式语义（Mode Semantics）

> 状态：v1 · 2026-09-08 · S4 交付物。记录六个模式**实际由代码强制什么**，而非由提示词宣称什么。
> 依据：system-map + 编排/治理/安全侦察。任何模式行为变更须同步本文与对应 gate 测试。

## 0. 总纲：所有模式叠在同一套运行面上

仓库没有六个独立 runtime。TEAM/CHAIN/PIPELINE 不是各自 spawn worker 的引擎——它们退化/收敛为 **prompt 构建器 + mode hook（顺序门）+ widget + 恢复工具**，统一委托给唯一 dispatcher `extensions/subagent-widget.ts`（`subagent_create`/`subagent_create_batch`）。真实强制点只有六类（详见 design-charter §7 门清单）：

1. **dispatch 权门** — `lib/dispatch-gate.ts`（AsyncLocalStorage；timers/lifecycle 不能 spawn）
2. **模式顺序 hook** — `lib/workflow-dispatch.ts`（`workflowDispatchBefore/After`；CHAIN/PIPELINE 注册）
3. **RESULT 契约** — `lib/agent-result-contract.ts`（## RESULT，格式修复循环）
4. **reviewer 门** — `lib/reviewer-decision.ts`（仅 APPROVED 放行）
5. **相位/完成门** — `advance_phase`（PIPELINE `phaseDispatchReady`）、`execution-gate`+`verifier-runtime`
6. **类型并发门** — `lib/subagent-type-gate.ts`（同类型 worker 并发 ≤1）

会话协调状态单一来源 = `lib/coordination-state.ts`；运行身份/预算/轨迹 = `lib/orchestration-run.ts`。

## 1. NORMAL

- **身份**：无专用 `normal.ts`。是基准面，其余模式叠于其上。
- **强制**：无任务清单硬性要求（新任务不强制建列表）；PLAN/SPEC 的 task 门与批准门在 NORMAL 不生效。
- **底座**：coordination-state + orchestration-run/budget（跨 run 记账始终在）。
- **适用**：低仪式任务。

## 2. PLAN（计划→批准→实现→报告）

- **入口/面**：`extensions/plan-viewer.ts` + `lib/plan-viewer-html.ts` / `plan-viewer-editor.ts` / `plan-viewer-render.ts`。
- **强制**（代码，非提示词）：
  - **批准门** `lib/approval-gate.ts`：写工具/bash/委派在计划批准前被拦（`decideApprovalGate`）；批准由**计划文件内容指纹绑定**，字节漂移即撤批（approval-gate.ts:118-127, 159-198）。执行点 mode-cycler tool_call + tool-caller 嵌套门。
  - **task 门** `lib/task-gate.ts`：PLAN 属 TASK_REQUIRED_MODES，委派/bash 需 active task。
- **完成面**：plan 经 viewer 批准；`show_report` 走 completion 门。

## 3. SPEC（想法→需求→任务→实现工作流）

- **入口/面**：`extensions/tasks.ts`（任务/SPEC 引擎）+ `lib/spec-viewer-html.ts` 多页批准向导。
- **强制**：同上 approval 门（spec 目录内容指纹绑定）+ task 门。
- **与 PLAN 差异**：SPEC 把需求固化为任务清单（task-list）再进实现；产物多为任务化规格而非单计划文件。

## 4. TEAM（向专家委派）

- **入口**：`extensions/agent-team.ts`（1719 行 monolith）。
- **形态**：父 agent 是**纯调度者**（提示词明言 "you have NO codebase tools"），经 subagent-widget 委派给 specialist；grid widget + 状态/恢复工具。
- **强制**：mode hook + dispatch 权门 + RESULT/reviewer 门 + task 门。
- **已知死代码**（S2/S4 候选）：`__removed_dispatch_*` handlers（L891/999）与 `dispatchAgent`(L490)/`dispatch_team_batch`——tool-executor-registry 拒注册，唯一入口已收敛到 `subagent_create_batch`。**父进程仍保留自建 spawn 路径**，与 canonical dispatcher 职责重叠，待本 S4 第二项收敛。

## 5. CHAIN（顺序链）

- **入口**：`extensions/agent-chain.ts`（1150 行）。
- **形态**：**已退役**——文件自注 "Chain execution is retired"（L1065）；`runAgent`(L303)/`runChain`(L554) 为不可达死代码。`subagent_create` 为唯一入口，顺序由父 agent 显式驱动。
- **强制**：CHAIN mode hook（L146 前后）——必须 dispatch 配置好的下一步；无 `$INPUT` 自动接力（父 agent 手动串联）。
- **遗留**：死 `runAgent`/`runChain` 及父自建 spawn（L467 createSubagentRuntime），待本 S4 第二项移除。

## 6. PIPELINE（分阶段工作流）

- **入口**：`extensions/pipeline-team.ts`（1564 行）。
- **形态**：UNDERSTAND→PLAN→BUILD→REVIEW 等具名相位；`advance_phase` 工具（L937）带真实 `phaseDispatchReady` 门（L954）。phase hook（L190 before/after）驱动相位状态。
- **强制**：相位推进需满足前置（dispatch receipt 消费，见 PI_FABRIC_ADOPTION:340-343）；worker 经 canonical dispatcher（`pipeline_dispatch` 不暴露为公共工具）。
- **已知死代码**：`spawnAgent`(L490)/`dispatchPhaseAgents`(L723, scheduleResourceWaves fan-out) 无活调用者——waves 并行已在 subagent-widget batch 层实现，PIPELINE 内重复。

## 7. 完成与验证（跨模式）

- 完成唯一出口 = verifier 收据：`verify_execution`（extensions/execution-verifier.ts）→ `lib/isolated-verifier.ts` `runAcceptanceVerifier`（确定性 + 独立只读 verifier subagent）→ `VerifierReceipt`；`completeDecision`/`canComplete`（execution-gate + verifier-runtime）判定 PASS/FAIL/BLOCKED。用户 `/report` 永不 gate。
- 这是 PLAN/PIPELINE/SPEC 等"验收面"的地基，也是唯一不依赖提示词的收尾闸。

## 8. 模式语义 → 演进含意

1. TEAM/CHAIN/PIPELINE 已不是独立引擎；**它们的维护负担应集中在：hook 顺序门正确性 + 提示词质量 + 死代码清理**，而非并行调度（那是 dispatcher 的事）。
2. **父进程残留的自建 spawn**（agent-team dispatchAgent、agent-chain runAgent/runChain、pipeline spawnAgent/dispatchPhaseAgents）是 S4 的清理目标——全部收敛/删除，只留 canonical dispatcher 一条 spawn 路径。
   - **拆除决策（2026-09-08，风险门控）**：这些死函数嵌在 46–82KB monolith 中段，与活 helper 交错，且源文本守卫测试（workflow-walk-fixes 等）钉着 agent-team 内部符号。盲删整段会误删共享 helper。**惰性死代码清理收益低、风险高 → 延到下次功能性触碰该文件时顺带删**（tsc 会兜底捕获悬空引用；届时同步删钉死已删实现的守卫断言）。不单独为美容开膛 load-bearing monolith。
3. 源文本守卫测试（workflow-walk-fixes 等）钉着上述内部符号，清理时必须同步（删钉死已删实现的断言，保留真正 wire/transport 不变量断言，如 herdr-visible-tui）。
