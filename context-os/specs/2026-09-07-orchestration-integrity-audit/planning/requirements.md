# Requirements

## User intent

在项目生态庞大、潜在冲突成本较高的前提下，不预设瘦身。先证明当前 orchestration 与 workflow 机制完整、真实生效、职责不冲突；只有发现证据支持的冗余、重复注册、死代码或行为冲突，才提出删除或合并。

## Current evidence

- `npm run typecheck` 已通过。
- `npm run eval:orchestration` 已通过：独立任务并发、资源冲突分波、预算超限取消均通过；该评估不覆盖 provider-backed 六模式用户价值。
- Bun 原生定向回归已通过：23 tests pass, 0 fail。
- `createOrchestrationRun` 已接入 TEAM、CHAIN、PIPELINE、subagent、compose、tool caller、execution verifier、dispatch runtime 和 toolkit runtime。
- `workflow-dispatch.ts` 是模式与 canonical subagent dispatcher 的运行时桥，不等同于可选 `workflow-support.ts`。
- `workflow-support.ts` 是可选辅助层，提供 advice、context、monitoring、approval、retrospective、eval 工具；其开关来自 `AGENT_PI_CONFIG.workflowSupport` 与 `PI_WORKFLOW_SUPPORT`。
- `orchestration-dashboard.ts` 与 renderer 只读取事件和预算状态，不参与分派、调度、恢复或预算决策。

## Required audit

1. 绘制六种模式与入口、共享状态、dispatcher、RunContext、事件、预算、恢复、验证器的依赖关系。
2. 检查是否存在重复执行器、重复状态源、重复预算/事件记录、未接入的 facade 或死注册。
3. 验证核心路径的确定性测试和完整测试基线。
4. 明确删除 Activity、workflow-support 或外围扩展的实际影响；不得因“看起来复杂”直接删除。
5. 若没有证据证明冗余或冲突，结论必须是不删除，并记录理由。
