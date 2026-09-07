# Orchestration Integrity Audit

## Goal

验证当前庞大生态中的 orchestration 与 workflow 是否完整、真实生效、职责清晰且无运行时冲突。瘦身仅作为证据驱动的后续动作，不是预设结果。

## User Stories

- 作为项目维护者，我希望知道编排核心是否真的控制执行，而不是只生成展示数据。
- 作为 workflow 使用者，我希望知道模式策略、执行编排、验收验证之间是否有重复或互相覆盖。
- 作为维护者，我希望在删除任何扩展前看到明确的消费者、测试和行为影响。

## Requirements

- 覆盖 NORMAL、PLAN、SPEC、TEAM、CHAIN、PIPELINE 六种模式。
- 区分四层：模式/Workflow 策略、Orchestration 执行、Evidence/状态查询、UI 展示。
- 追踪 `createOrchestrationRun`、预算、scheduler、dispatch bridge、query/status、recovery、verifier 的消费者。
- 验证共享状态源和 canonical dispatcher，识别重复注册与旁路执行。
- 验证 Activity 仅为展示层，不能把它误判为编排核心。
- 只在发现可复现冲突、重复实现、无消费者代码或明确维护负担时提出删除/合并。
- 审计阶段不删除代码；任何后续修改必须另行绑定明确范围。

## Visual Design

无新增视觉设计。Activity 当前属于只读 TUI widget；本审计只验证其边界，不修改 UI。

## Existing Code to Leverage

- `extensions/lib/orchestration-run.ts`
- `extensions/lib/orchestration-budget.ts`
- `extensions/lib/orchestration-query.ts`
- `extensions/lib/evidence-store.ts`
- `extensions/lib/resource-scheduler.ts`
- `extensions/lib/workflow-dispatch.ts`
- `extensions/lib/workflow-direction.ts`
- `extensions/lib/coordination-state.ts`
- `extensions/agent-team.ts`
- `extensions/agent-chain.ts`
- `extensions/pipeline-team.ts`
- `extensions/subagent-widget.ts`
- `extensions/execution-verifier.ts`
- `extensions/workflow-support.ts`
- `extensions/orchestration-dashboard.ts`

## Out of Scope

- 不预设删除 Activity、workflow-support、任何模式或外围扩展。
- 不改变用户权限、安全策略、验收门或 worker 行为。
- 不用 synthetic eval 代替 provider-backed 用户价值结论。
- 不删除历史数据、用户 workspace 状态或受保护凭据。

## Contract

### Objective

完成 orchestration/workflow 完整性与冲突审计；给出证据驱动的“保留”或“条件性瘦身”结论。当前默认结果为不改代码。

### Scope

只读检查源码、注册入口、依赖关系、测试和运行评估。若审计发现问题，只记录候选及影响，不在本合同内执行删除。

### Acceptance Criteria

- 六种模式、共享状态、核心执行路径和可选辅助路径均有文件级证据。
- 明确说明 orchestration 与 workflow 的分层关系，并证明没有重复状态源或重复执行器造成冲突；若发现冲突，列出复现证据。
- 编排核心的真实执行能力由测试/评估证明，不把 Activity 面板通过误当作核心生效。
- `typecheck`、完整测试、provider-free orchestration eval 结果明确记录。
- 未发现证据时不删除代码；任何删除建议必须列出消费者、测试影响和回滚边界。

### Evidence Requirements

- 文件路径、关键符号和消费者引用。
- 确定性命令完整输出或 PASS/FAIL 摘要。
- 明确区分 provider-free synthetic 限制与真实 provider 行为。
- Worker 报告只能作为线索；最终结论以命令和审计结果为准。

### Constraints

- 审计阶段不改动 `extensions/`、测试或运行配置。
- 不删除文件，不弱化断言，不跳过测试。
- 保留安全守卫、验证门和运行时事件证据。

### Verification Commands

- [cmd] npm run typecheck
- [cmd] npm test
- [cmd] npm run eval:orchestration
- [cmd] node -e "const fs=require('fs'); const must=['extensions/lib/orchestration-run.ts','extensions/lib/orchestration-budget.ts','extensions/lib/orchestration-query.ts','extensions/lib/evidence-store.ts','extensions/lib/workflow-dispatch.ts','extensions/execution-verifier.ts']; for(const p of must) if(!fs.existsSync(p)) throw new Error('missing '+p); console.log('core files present')"
